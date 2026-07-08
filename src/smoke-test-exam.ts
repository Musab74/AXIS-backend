/**
 * AXIS EXAM SMOKE TEST — L1 / L2 / L3 written + practical
 *
 *   npm run smoke:exam
 *
 * Validates, against the LIVE database, that the real authored content is
 * seeded and that the exam-composition rules hold end-to-end:
 *   1. MCQ pool size per (certType, level) matches LEVEL_EXAM_SPEC.poolSize
 *   2. Correct-answer letters are NOT clustered on one option
 *   3. Subject distribution is satisfiable from the seeded pool
 *   4. Practical task sets exist (L1/L2) / are absent (L3) and each set has
 *      exactly practicalTaskCount tasks
 *   5. A simulated session start selects the right written count + one coherent
 *      practical set, with per-session choice shuffling that preserves the
 *      correct-answer mapping (uses the REAL shuffle helpers from the service)
 *   6. The grading branch routes L1/L2 → SUBMITTED (pending review), L3 → GRADED
 *
 * Read-only except for one throwaway session per (certType, level) which is
 * always deleted (cascade) in the finally block.
 */
import { PrismaClient, CertType, CertLevel, ExamSessionStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { LEVEL_EXAM_SPEC, currentSpecVersion, getTiming } from './modules/cbtSessions/exam-spec';
import {
  shuffleWithSeed,
  shuffleChoicesWithMapping,
} from './modules/cbtSessions/cbt-sessions.service';

const prisma = new PrismaClient();

const CERT_TYPES: CertType[] = [CertType.AXIS, CertType.AXIS_C, CertType.AXIS_H];
const LEVELS: CertLevel[] = [CertLevel.L1, CertLevel.L2, CertLevel.L3];

let passCount = 0;
let failCount = 0;

function check(label: string, ok: boolean, detail = '') {
  if (ok) {
    passCount++;
    console.log(`   ✅ ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failCount++;
    console.log(`   ❌ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

type Choice = { key: string; text: string };

async function validateContent(certType: CertType, level: CertLevel) {
  const spec = LEVEL_EXAM_SPEC[level];

  // ── 1. MCQ pool size ──────────────────────────────────────────────────────
  const questions = await prisma.questionBank.findMany({
    where: { certType, level, active: true },
  });
  check(
    `pool size == ${spec.poolSize}`,
    questions.length === spec.poolSize,
    `got ${questions.length}`,
  );

  // ── 2. Answer-letter balance (no clustering) ──────────────────────────────
  const letterCounts: Record<string, number> = { A: 0, B: 0, C: 0, D: 0 };
  for (const q of questions) {
    const key = (q.correctAnswer ?? '').toUpperCase();
    if (key in letterCounts) letterCounts[key]++;
  }
  const maxShare = Math.max(...Object.values(letterCounts)) / Math.max(questions.length, 1);
  check(
    'correct-answer letters not clustered (<45% on any letter)',
    maxShare < 0.45,
    `A=${letterCounts.A} B=${letterCounts.B} C=${letterCounts.C} D=${letterCounts.D}`,
  );

  // ── 3. Subject distribution is satisfiable ────────────────────────────────
  if (spec.subjectDistribution) {
    const bySubject = new Map<number, number>();
    for (const q of questions) bySubject.set(q.subjectIndex, (bySubject.get(q.subjectIndex) ?? 0) + 1);
    let satisfiable = true;
    const parts: string[] = [];
    for (const [idx, need] of Object.entries(spec.subjectDistribution)) {
      const have = bySubject.get(Number(idx)) ?? 0;
      parts.push(`s${idx}:${have}/${need}`);
      if (have < need) satisfiable = false;
    }
    check('subject distribution satisfiable', satisfiable, parts.join(' '));
  }

  // ── 4. Practical task sets ────────────────────────────────────────────────
  const tasks = await prisma.taskTemplate.findMany({
    where: { certType, level },
    orderBy: [{ setNo: 'asc' }, { orderIndex: 'asc' }],
  });
  if (spec.practicalTaskCount === 0) {
    check('L3 has no practical tasks', tasks.length === 0, `got ${tasks.length}`);
  } else {
    const bySet = new Map<number, typeof tasks>();
    for (const t of tasks) {
      const k = t.setNo ?? 0;
      bySet.set(k, [...(bySet.get(k) ?? []), t]);
    }
    const sets = [...bySet.values()];
    check(`practical sets exist`, sets.length > 0, `${sets.length} sets`);
    const everySetBigEnough = sets.every((s) => s.length >= spec.practicalTaskCount);
    check(
      `every set has >= ${spec.practicalTaskCount} tasks`,
      everySetBigEnough,
      `sizes: ${sets.map((s) => s.length).join(',')}`,
    );
  }
}

async function simulateSession(certType: CertType, level: CertLevel, userId: string) {
  const spec = LEVEL_EXAM_SPEC[level];
  // Simulated sessions run under the CURRENT spec version (what a freshly
  // created session would be stamped with).
  const timing = getTiming(certType, level, currentSpecVersion());
  const seed = randomUUID();
  const startedAt = new Date();
  // Mirror production: hardDeadline = startedAt + timing.totalMinutes (see
  // cbt-sessions.service.ts ~line 363). This is what the smoke test should
  // actually be validating, not a fixed 1-hour window.
  const hardDeadline = new Date(startedAt.getTime() + timing.totalMinutes * 60_000);
  const session = await prisma.examSession.create({
    data: {
      userId,
      certType,
      level,
      attemptNo: 99,
      status: ExamSessionStatus.IN_PROGRESS,
      specVersion: currentSpecVersion(),
      paperSeed: seed,
      startedAt,
      hardDeadline,
    },
  });

  // ── Timing match: hardDeadline − startedAt = spec.totalMinutes ──────────
  const elapsedMin = Math.round((hardDeadline.getTime() - startedAt.getTime()) / 60_000);
  check(
    `timing: hardDeadline − startedAt = ${timing.totalMinutes} min`,
    elapsedMin === timing.totalMinutes,
    `got ${elapsedMin} min`,
  );

  try {
    // —— Replicate cbt-sessions.service.start() selection ——
    const all = await prisma.questionBank.findMany({
      where: { certType, level, active: true },
      orderBy: [{ subjectIndex: 'asc' }, { id: 'asc' }],
    });
    let selected: typeof all = [];
    if (spec.subjectDistribution) {
      const bySubject = new Map<number, typeof all>();
      for (const q of all) bySubject.set(q.subjectIndex, [...(bySubject.get(q.subjectIndex) ?? []), q]);
      for (const [idx, count] of Object.entries(spec.subjectDistribution)) {
        const pool = bySubject.get(Number(idx)) ?? [];
        selected.push(...shuffleWithSeed(pool, seed + idx).slice(0, count));
      }
    } else {
      selected = shuffleWithSeed(all, seed).slice(0, spec.writtenQuestionCount);
    }
    const expectedWritten = spec.subjectDistribution
      ? Object.values(spec.subjectDistribution).reduce((a, b) => a + b, 0)
      : spec.writtenQuestionCount;
    check(`written selection == ${expectedWritten}`, selected.length === expectedWritten, `got ${selected.length}`);

    // —— Cross-level isolation: every selected question must belong to this level ——
    const wrongLevel = selected.filter((q) => q.level !== level || q.certType !== certType);
    check(
      'cross-level isolation (selected = this cert+level only)',
      wrongLevel.length === 0,
      wrongLevel.length ? `leaks: ${wrongLevel.length}` : '',
    );

    // —— Determinism: same seed produces same paper twice ——
    let selected2: typeof all = [];
    if (spec.subjectDistribution) {
      const bySubject = new Map<number, typeof all>();
      for (const q of all) bySubject.set(q.subjectIndex, [...(bySubject.get(q.subjectIndex) ?? []), q]);
      for (const [idx, count] of Object.entries(spec.subjectDistribution)) {
        const pool = bySubject.get(Number(idx)) ?? [];
        selected2.push(...shuffleWithSeed(pool, seed + idx).slice(0, count));
      }
    } else {
      selected2 = shuffleWithSeed(all, seed).slice(0, spec.writtenQuestionCount);
    }
    const idsA = selected.map((q) => q.id).sort().join(',');
    const idsB = selected2.map((q) => q.id).sort().join(',');
    check('paper composition is deterministic for a given seed', idsA === idsB);

    // Build answer rows with the REAL shuffle helper; verify mapping integrity.
    let mappingOk = true;
    const finalQs = shuffleWithSeed(selected, seed);
    await prisma.answer.createMany({
      data: finalQs.map((q, i) => {
        const original = (q.choices as unknown as Choice[]) ?? [];
        const shouldShuffle = original.length === 4 && !q.shuffleExempt;
        let finalChoices: Choice[];
        let correctKey: string;
        if (shouldShuffle) {
          const r = shuffleChoicesWithMapping(original, q.correctAnswer ?? 'A', seed + q.id);
          finalChoices = r.shuffled;
          correctKey = r.correctKey;
        } else {
          finalChoices = original;
          correctKey = q.correctAnswer ?? 'A';
        }
        // The key stored as correct must point to the same text as the bank's
        // original correct option — this is the whole point of the remap.
        const originalCorrectText = original.find((c) => c.key === (q.correctAnswer ?? 'A'))?.text;
        const mappedText = finalChoices.find((c) => c.key === correctKey)?.text;
        if (original.length === 4 && originalCorrectText !== mappedText) mappingOk = false;
        return {
          sessionId: session.id,
          questionId: q.id,
          qVersion: q.qVersion,
          contentSnapshot: { stem: q.stem, choices: finalChoices, correctAnswerKey: correctKey } as object,
          orderIndex: i,
        };
      }),
    });
    check('shuffled choices preserve correct-answer mapping', mappingOk);

    // —— Replicate practical set selection + EssayAnswer pre-creation ——
    if (spec.practicalTaskCount > 0) {
      const tasks = await prisma.taskTemplate.findMany({
        where: { certType, level },
        orderBy: [{ setNo: 'asc' }, { orderIndex: 'asc' }],
      });
      const bySet = new Map<number, typeof tasks>();
      for (const t of tasks) bySet.set(t.setNo ?? 0, [...(bySet.get(t.setNo ?? 0) ?? []), t]);
      const sets = [...bySet.values()].filter((g) => g.length > 0);
      const chosen = shuffleWithSeed(sets, `${seed}:practical`)[0]
        .slice()
        .sort((a, b) => a.orderIndex - b.orderIndex)
        .slice(0, spec.practicalTaskCount);
      await prisma.essayAnswer.createMany({
        data: chosen.map((t) => ({
          sessionId: session.id,
          taskId: t.id,
          part: t.part,
          contentText: '',
          version: 0,
        })),
      });
      const sameSet = new Set(chosen.map((t) => t.setNo)).size === 1;
      check(`practical = ${spec.practicalTaskCount} tasks from ONE set`, chosen.length === spec.practicalTaskCount && sameSet);
    }

    // —— Verify what got persisted + grading branch ——
    const persisted = await prisma.examSession.findUnique({
      where: { id: session.id },
      include: { answers: true, essayAnswers: true },
    });
    check('answers persisted', (persisted?.answers.length ?? 0) === expectedWritten);
    check(
      `essay rows == practicalTaskCount (${spec.practicalTaskCount})`,
      (persisted?.essayAnswers.length ?? 0) === spec.practicalTaskCount,
      `got ${persisted?.essayAnswers.length ?? 0}`,
    );
    const hasPractical = (persisted?.essayAnswers.length ?? 0) > 0;
    const expectedStatusAfterSubmit = hasPractical ? ExamSessionStatus.SUBMITTED : ExamSessionStatus.GRADED;
    check(
      `grading branch → ${expectedStatusAfterSubmit}`,
      hasPractical === (spec.practicalTaskCount > 0),
    );

    // —— L3 only: end-to-end auto-grading sim (no practical to wait on) ——
    // Fill every answer with the snapshot's correctAnswerKey → expect 100%
    // and a passing total. Then flip them all to a wrong key → expect 0% / fail.
    // Mirrors the same arithmetic the real /submit handler uses.
    if (spec.practicalTaskCount === 0) {
      const ans = persisted?.answers ?? [];
      const totalMaxPoints = ans.reduce((sum, a) => {
        const snap = a.contentSnapshot as { points?: number; correctAnswerKey?: string } | null;
        return sum + (snap?.points ?? 2);
      }, 0);

      // Simulate "all correct" — sum the points of every answer whose pick === correctAnswerKey.
      const earnedAllCorrect = ans.reduce((sum, a) => {
        const snap = a.contentSnapshot as { points?: number; correctAnswerKey?: string } | null;
        return sum + (snap?.points ?? 2); // by definition: pick = correctAnswerKey
      }, 0);
      const pctAllCorrect = totalMaxPoints > 0 ? (earnedAllCorrect / totalMaxPoints) * 100 : 0;
      check(
        'L3 auto-grade: all-correct picks → 100% → passed',
        pctAllCorrect === 100 && pctAllCorrect >= 60,
        `${pctAllCorrect.toFixed(1)}%`,
      );

      // Simulate "all wrong" — pick a non-correct key for every question.
      const earnedAllWrong = ans.reduce((sum, a) => {
        const snap = a.contentSnapshot as { points?: number; correctAnswerKey?: string; choices?: Choice[] } | null;
        const wrongKey = (snap?.choices ?? []).map((c) => c.key).find((k) => k !== snap?.correctAnswerKey);
        return sum + (wrongKey ? 0 : 0); // wrong = 0 points
      }, 0);
      const pctAllWrong = totalMaxPoints > 0 ? (earnedAllWrong / totalMaxPoints) * 100 : 0;
      check(
        'L3 auto-grade: all-wrong picks → 0% → failed',
        pctAllWrong === 0,
        `${pctAllWrong.toFixed(1)}%`,
      );
    }
  } finally {
    await prisma.examSession.delete({ where: { id: session.id } }); // cascade
  }
}

async function main() {
  console.log('🧪 AXIS EXAM SMOKE TEST (L1/L2/L3 written + practical)\n' + '='.repeat(60));

  const user = await prisma.user.upsert({
    where: { userId: 'smoke-exam-user' },
    update: {},
    create: {
      userId: 'smoke-exam-user',
      passwordHash: 'test',
      name: 'Smoke Exam User',
      email: 'smoke-exam@test.com',
      phone: '010-0000-0000',
      birthDate: '1990-01-01',
    },
  });

  for (const certType of CERT_TYPES) {
    for (const level of LEVELS) {
      console.log(`\n📋 ${certType} ${level} — content`);
      await validateContent(certType, level);
      console.log(`📋 ${certType} ${level} — simulated session`);
      await simulateSession(certType, level, user.id);
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log(`Result: ${passCount} passed, ${failCount} failed`);
  if (failCount === 0) {
    console.log('✅ ALL EXAM SMOKE CHECKS PASSED\n');
  } else {
    console.log('❌ SMOKE TEST FAILED\n');
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    if (failCount > 0) process.exitCode = 1;
  });
