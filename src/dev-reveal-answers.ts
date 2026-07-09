/**
 * DEV/QA ONLY — reveal the correct answers for one exam session so a tester who
 * does not read Korean can complete the exam and pass, then exercise the
 * grading → provisional → confirm → certificate flow.
 *
 *   npx ts-node src/dev-reveal-answers.ts <sessionId>
 *   npx ts-node src/dev-reveal-answers.ts --user <userId>   # latest session for a user
 *   npx ts-node src/dev-reveal-answers.ts --latest          # most recent session
 *
 * Reads the DATABASE the .env DATABASE_URL points at (dev/staging/prod). This
 * is a local script against the DB — NOT an API endpoint — so candidates can
 * never reach it. It only READS; it changes nothing.
 *
 * MCQ: prints the correct option letter per question (in exam order).
 * L3 practical: prints the answer-key selections + a ready-to-paste Korean reason.
 * L1/L2 practical/essay: AI-graded, so a letter can't guarantee a pass — the
 *   model answer (if seeded) is printed to paste as a strong answer.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function resolveSessionId(): Promise<string | null> {
  const positional = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : undefined;
  if (positional) return positional;
  const userId = arg('--user');
  if (userId) {
    const s = await prisma.examSession.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    return s?.id ?? null;
  }
  if (process.argv.includes('--latest')) {
    const s = await prisma.examSession.findFirst({ orderBy: { createdAt: 'desc' }, select: { id: true } });
    return s?.id ?? null;
  }
  return null;
}

interface Choice { key: string; text: string }
interface Snap { stem?: string; choices?: Choice[]; correctAnswerKey?: string; subjectName?: string }

async function main() {
  const sessionId = await resolveSessionId();
  if (!sessionId) {
    console.log('Usage: npx ts-node src/dev-reveal-answers.ts <sessionId> | --user <userId> | --latest');
    process.exit(1);
  }
  const session = await prisma.examSession.findUnique({
    where: { id: sessionId },
    include: {
      user: { select: { name: true, userId: true } },
      answers: { orderBy: { orderIndex: 'asc' } },
      essayAnswers: { orderBy: { part: 'asc' } },
    },
  });
  if (!session) {
    console.log(`No session found for id "${sessionId}".`);
    process.exit(1);
  }

  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(`  ANSWER KEY — ${session.certType} ${session.level} · ${session.user?.name ?? '?'} (${session.user?.userId ?? '?'})`);
  console.log(`  session ${session.id} · status ${session.status}`);
  console.log('══════════════════════════════════════════════════════════════');

  // ── MCQ (written) ──────────────────────────────────────────────────────
  if (session.answers.length) {
    console.log(`\n▶ 객관식 / MCQ — pick these letters (in order):\n`);
    const letters: string[] = [];
    for (const a of session.answers) {
      const snap = (a.contentSnapshot ?? {}) as Snap;
      const key = snap.correctAnswerKey ?? '(?)';
      letters.push(key);
      const correctText = snap.choices?.find((c) => c.key === key)?.text ?? '';
      const n = String(a.orderIndex + 1).padStart(2, ' ');
      console.log(`  Q${n}: ${key}${a.isPretest ? '  (pretest — not scored)' : ''}  ${correctText ? '→ ' + correctText.slice(0, 40) : ''}`);
    }
    console.log(`\n  Quick sequence: ${letters.join(' ')}`);
  } else {
    console.log('\n(No MCQ answers on this session yet — start the exam first, then re-run.)');
  }

  // ── Practical / essay ──────────────────────────────────────────────────
  if (session.essayAnswers.length) {
    const tasks = await prisma.taskTemplate.findMany({
      where: { id: { in: session.essayAnswers.map((e) => e.taskId) } },
    });
    const byId = new Map(tasks.map((t) => [t.id, t]));
    console.log(`\n▶ 실습형/서술형 / Practical — per task:\n`);
    for (const ea of session.essayAnswers) {
      const t = byId.get(ea.taskId);
      const rub = (t?.rubric ?? {}) as Record<string, unknown>;
      const ak = (rub.answerKey ?? {}) as Record<string, unknown>;
      console.log(`  • [${ea.part}] ${t?.title ?? ea.taskId}`);
      if (Object.keys(ak).length) {
        // L3 structured selections
        for (const [field, val] of Object.entries(ak)) {
          if (field === 'key_reason' || field === 'example_prompt') continue;
          const picks = Array.isArray(val) ? val.join(', ') : String(val);
          console.log(`      select ${field}: ${picks}`);
        }
        const reason = typeof ak.key_reason === 'string' ? ak.key_reason : '';
        if (reason) console.log(`      근거(reason) to paste (80–150자):\n        "${reason.slice(0, 150)}"`);
      } else if (t?.modelAnswer) {
        console.log(`      모범답안(model answer) to paste as a strong answer:\n        "${String(t.modelAnswer).slice(0, 400)}${t.modelAnswer.length > 400 ? '…' : ''}"`);
      } else {
        console.log('      (AI-graded free text — paste any coherent, on-topic Korean answer to pass.)');
      }
    }
    console.log('\n  Note: L1/L2 essays & deliverables are AI-graded, so they need a plausible answer,');
    console.log('  not just a letter. L3 practicals pass deterministically from the selections above.');
  }

  console.log('\n──────────────────────────────────────────────────────────────');
  console.log('  Enter these in the exam UI and submit → you will pass, then you can');
  console.log('  test grading, provisional/confirm, and the certificate flow.');
  console.log('──────────────────────────────────────────────────────────────\n');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
