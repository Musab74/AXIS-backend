/**
 * AXIS DEMO SMOKE TEST — free-demo flow (paper · grading · cert · verify)
 *
 *   npm run smoke:demo
 *
 * Exercises the free-demo backend end-to-end *without writing to the DB*:
 *   1. DemoService.getDemoPaper — 5 MCQs + 1 practical task for AXIS L3
 *   2. DemoService.gradeDemo — totals add up, no persistence
 *   3. DemoService.issueDemoCertificate — stateless DEMO-prefixed cert
 *      (uses an existing user via findUnique; no inserts)
 *   4. CertificatesService.verifyPublic — DEMO- short-circuits BEFORE the
 *      DB query (returns status: 'demo'), and parses 1-token (AXIS) and
 *      2-token (AXIS-C / AXIS-H) tracks correctly
 *   5. Sanity: non-DEMO cert still goes through the normal lookup branch
 *      (returns ok:false for a fabricated number — that's the expected
 *      anti-enumeration response, NOT an error)
 *
 * The certificates table is touched read-only (the service auto-creates the
 * table if missing — that's existing behavior, not a schema change).
 */
import { PrismaClient, CertType, CertLevel } from '@prisma/client';
import { DemoService } from './modules/demo/demo.service';
import { CertificatesService } from './modules/certificates/certificates.service';

const prisma = new PrismaClient();

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

// Cast PrismaClient → the shape the services expect (PrismaService extends it).
const demoSvc = new DemoService(prisma as never);
const certSvc = new CertificatesService(prisma as never);

async function testDemoPaper() {
  console.log('\n📋 1. DemoService.getDemoPaper(AXIS, L3)');
  const paper = await demoSvc.getDemoPaper(CertType.AXIS, CertLevel.L3);

  check('returns 5 MCQs (was 10)', paper.questions.length === 5, `got ${paper.questions.length}`);
  check('durationMin = 10', paper.durationMin === 10);
  check('certType echoed', paper.certType === CertType.AXIS);
  check('level echoed', paper.level === CertLevel.L3);
  check(
    'every question has id/stem/choices/subjectName/points',
    paper.questions.every(
      (q) => q.id && q.stem && Array.isArray(q.choices) && q.choices.length >= 2 && q.subjectName && typeof q.points === 'number',
    ),
  );
  check(
    'NO correctAnswer leaked to client',
    paper.questions.every((q) => !('correctAnswer' in q)),
  );

  // The new v1.1 contract returns `practicalTasks: DemoPracticalTask[]` (up to
  // 4 stratified samples for L3, 0–1 for L1/L2). Older clients consume the
  // deprecated `practicalTask` alias, so both must still be present.
  check('practicalTasks field present (array)', Array.isArray(paper.practicalTasks));
  check('practicalTask alias present (object|null)', 'practicalTask' in paper);

  if (paper.practicalTasks.length > 0) {
    check(
      'every task has id/title/scenario/durationMin/points',
      paper.practicalTasks.every(
        (t) => !!(t.id && t.title && t.scenario && typeof t.durationMin === 'number' && typeof t.points === 'number'),
      ),
    );

    // When the seed-l3-practicals script has run on this DB, L3 should ship
    // exactly 4 tasks covering all canonical types (현업적용·지시설계·분석검증·
    // 리스크판단). If only 1 task came back, the seed hasn't been applied —
    // we still accept that state so smoke can run on un-seeded environments.
    if (paper.practicalTasks.length === 4) {
      const types = new Set(paper.practicalTasks.map((t) => t.taskType ?? '(none)'));
      const expected = ['현업적용형', '지시설계형', '분석검증형', '리스크판단형'];
      check(
        'L3 4-task draw covers all 4 canonical types',
        expected.every((tp) => types.has(tp)),
        Array.from(types).join(', '),
      );
    } else {
      console.log(
        `   ℹ L3 returned ${paper.practicalTasks.length} practical task(s) — run \`pnpm db:seed:l3-practicals\` for the full 4-type stratified set.`,
      );
    }

    check(
      'practicalTask alias matches first array entry',
      paper.practicalTask?.id === paper.practicalTasks[0].id,
    );
  } else {
    console.log('   ℹ practicalTasks is empty for AXIS L3 (no TaskTemplate seeded — acceptable)');
  }

  return paper;
}

async function testDemoGrading(paper: Awaited<ReturnType<typeof testDemoPaper>>) {
  console.log('\n📋 2. DemoService.gradeDemo (no persistence)');

  // Submit one wrong answer per question (selectedChoice = 'Z' which never matches).
  const allWrong = paper.questions.map((q) => ({ questionId: q.id, selectedChoice: 'Z' as string | null }));
  const wrongResult = await demoSvc.gradeDemo({
    certType: CertType.AXIS,
    level: CertLevel.L3,
    answers: allWrong,
  });
  check('all-wrong → totalEarned = 0', wrongResult.totalEarned === 0, `got ${wrongResult.totalEarned}`);
  check('all-wrong → totalPct = 0', wrongResult.totalPct === 0);
  check('breakdown length matches questions', wrongResult.breakdown.length === paper.questions.length);
  check(
    'breakdown surfaces correctAnswer for review',
    wrongResult.breakdown.every((b) => b.correctAnswer != null && b.correctAnswer.length > 0),
  );

  // Submit nulls — same 0% but with null selectedChoice preserved.
  const allBlank = paper.questions.map((q) => ({ questionId: q.id, selectedChoice: null }));
  const blankResult = await demoSvc.gradeDemo({
    certType: CertType.AXIS,
    level: CertLevel.L3,
    answers: allBlank,
  });
  check('all-blank → totalEarned = 0', blankResult.totalEarned === 0);
  check(
    'all-blank → all isCorrect=false',
    blankResult.breakdown.every((b) => b.isCorrect === false),
  );

  // Cheat one in: submit the correct answer for the first question by reading
  // it from the DB directly (we already trust prisma in this smoke harness).
  const firstQ = await prisma.questionBank.findUnique({
    where: { id: paper.questions[0].id },
    select: { correctAnswer: true, points: true },
  });
  if (firstQ?.correctAnswer) {
    const oneRight = paper.questions.map((q, i) => ({
      questionId: q.id,
      selectedChoice: i === 0 ? firstQ.correctAnswer : 'Z',
    }));
    const mixedResult = await demoSvc.gradeDemo({
      certType: CertType.AXIS,
      level: CertLevel.L3,
      answers: oneRight,
    });
    check(
      'one-correct → totalEarned > 0',
      mixedResult.totalEarned >= (firstQ.points ?? 0) && mixedResult.totalEarned > 0,
      `got ${mixedResult.totalEarned}`,
    );
    check('one-correct → first breakdown isCorrect=true', mixedResult.breakdown[0].isCorrect === true);
    check(
      'one-correct → others isCorrect=false',
      mixedResult.breakdown.slice(1).every((b) => !b.isCorrect),
    );
  } else {
    console.log('   ⚠ skipping one-correct path: bank row missing correctAnswer');
  }
}

async function testDemoCertificateIssue() {
  console.log('\n📋 3. DemoService.issueDemoCertificate (stateless, no persistence)');

  // Find ANY existing user — read-only. We do NOT create one to honor the
  // "no DB changes in production" rule.
  const user = await prisma.user.findFirst({
    select: { id: true, name: true },
    orderBy: { createdAt: 'asc' },
  });
  if (!user) {
    console.log('   ⚠ no users in DB — skipping cert-issuance test');
    return null;
  }

  const cert = await demoSvc.issueDemoCertificate(user.id, CertType.AXIS, CertLevel.L3);
  check('cert.certNumber starts with "DEMO-"', cert.certNumber.startsWith('DEMO-'));
  check(
    'cert.certNumber matches DEMO-AXIS-L3-YYYY-XXXXXX format',
    /^DEMO-AXIS-L3-\d{4}-[0-9A-F]+$/.test(cert.certNumber),
    cert.certNumber,
  );
  check('holderName = user.name', cert.holderName === user.name);
  const issued = new Date(cert.issuedAt);
  const validUntil = new Date(cert.validUntil);
  const yearDiff = validUntil.getFullYear() - issued.getFullYear();
  check('validUntil is ~3 years after issuedAt', yearDiff === 3, `${yearDiff} years`);

  // Re-issue — must be a fresh random suffix (stateless = different number each time).
  const cert2 = await demoSvc.issueDemoCertificate(user.id, CertType.AXIS, CertLevel.L3);
  check('two issuances produce different cert numbers (truly stateless)', cert.certNumber !== cert2.certNumber);

  // AXIS_C should serialize as DEMO-AXIS-C-L2-...
  const certC = await demoSvc.issueDemoCertificate(user.id, CertType.AXIS_C, CertLevel.L2);
  check(
    'AXIS_C cert number serializes as DEMO-AXIS-C-L2-...',
    /^DEMO-AXIS-C-L2-\d{4}-[0-9A-F]+$/.test(certC.certNumber),
    certC.certNumber,
  );
  const certH = await demoSvc.issueDemoCertificate(user.id, CertType.AXIS_H, CertLevel.L1);
  check(
    'AXIS_H cert number serializes as DEMO-AXIS-H-L1-...',
    /^DEMO-AXIS-H-L1-\d{4}-[0-9A-F]+$/.test(certH.certNumber),
    certH.certNumber,
  );

  return { cert, certC, certH, holderName: user.name };
}

async function testPublicVerifyDemoBranch(
  fixtures: NonNullable<Awaited<ReturnType<typeof testDemoCertificateIssue>>>,
) {
  console.log('\n📋 4. CertificatesService.verifyPublic — DEMO short-circuit');

  // 4a. AXIS / L3
  const r1 = await certSvc.verifyPublic(fixtures.cert.certNumber, fixtures.holderName);
  check('AXIS L3 demo cert: ok=true', r1.ok === true);
  if (r1.ok) {
    check('AXIS L3 demo cert: status=demo', r1.status === 'demo');
    if (r1.status === 'demo') {
      check('AXIS L3 demo cert: track=AXIS', r1.track === 'AXIS', r1.track);
      check('AXIS L3 demo cert: level label includes L3', r1.level.includes('L3'), r1.level);
      check('AXIS L3 demo cert: holder echoed', r1.holder === fixtures.holderName);
      check('AXIS L3 demo cert: org present', !!r1.org);
    }
  }

  // 4b. AXIS-C / L2 — 2-token track parsing
  const r2 = await certSvc.verifyPublic(fixtures.certC.certNumber, fixtures.holderName);
  check('AXIS-C L2 demo cert: ok=true', r2.ok === true);
  if (r2.ok && r2.status === 'demo') {
    check('AXIS-C track parsed correctly', r2.track === 'AXIS-C', r2.track);
    check('AXIS-C level=L2', r2.level.includes('L2'), r2.level);
  }

  // 4c. AXIS-H / L1
  const r3 = await certSvc.verifyPublic(fixtures.certH.certNumber, fixtures.holderName);
  check('AXIS-H L1 demo cert: ok=true', r3.ok === true);
  if (r3.ok && r3.status === 'demo') {
    check('AXIS-H track parsed correctly', r3.track === 'AXIS-H', r3.track);
    check('AXIS-H level=L1', r3.level.includes('L1'), r3.level);
  }

  // 4d. Lowercase / whitespace normalization — the service uppercases + strips spaces.
  const messy = ` ${fixtures.cert.certNumber.toLowerCase()} `;
  const r4 = await certSvc.verifyPublic(messy, fixtures.holderName);
  check(
    'lowercase + whitespace normalizes to demo branch',
    r4.ok === true && r4.status === 'demo',
  );

  // 4e. Holder name 1 char → rejected (length guard) BEFORE prefix check.
  const r5 = await certSvc.verifyPublic(fixtures.cert.certNumber, 'A');
  check('holder name <2 chars → ok=false', r5.ok === false);
}

async function testPublicVerifyNormalBranch() {
  console.log('\n📋 5. CertificatesService.verifyPublic — non-DEMO sanity');

  // Fabricated non-DEMO cert number → should hit the DB and return ok:false
  // (not crash). This is the existing anti-enumeration response.
  const r = await certSvc.verifyPublic('AXIS-L3-2026-001-99999', '홍길동');
  check('non-existent real cert → ok=false (no exception)', r.ok === false);
}

async function main() {
  console.log('🧪 AXIS DEMO SMOKE TEST (paper · grading · cert · verify)\n' + '='.repeat(60));

  const paper = await testDemoPaper();
  await testDemoGrading(paper);
  const fixtures = await testDemoCertificateIssue();
  if (fixtures) {
    await testPublicVerifyDemoBranch(fixtures);
  } else {
    console.log('\n⚠ skipping verifyPublic DEMO branch — no user available');
  }
  await testPublicVerifyNormalBranch();

  console.log('\n' + '='.repeat(60));
  console.log(`Result: ${passCount} passed, ${failCount} failed`);
  if (failCount === 0) {
    console.log('✅ ALL DEMO SMOKE CHECKS PASSED\n');
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
