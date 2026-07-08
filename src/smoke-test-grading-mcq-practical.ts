/**
 * AXIS GRADING · MCQ + L3 PRACTICAL (deterministic) SMOKE TEST
 *
 *   npx ts-node src/smoke-test-grading-mcq-practical.ts
 *
 * Exercises the two DETERMINISTIC graders end to end with realistic inputs and
 * asserts exact scores — no API, no DB:
 *   1. computeWrittenScoring  (MCQ answer-key match, shuffle, pretest, subjects)
 *   2. L3PracticalGraderService (answer-key + partial credit + 위험통제 penalty +
 *      rationale band + selection-reason gate + PII flag)
 *
 * The AI-assisted layer (L1/L2 essays, L3 rationale hybrid) is covered live by
 * smoke-test-grading-adversarial.ts.
 */
import { computeWrittenScoring, WrittenAnswerLike, WrittenBankRow } from './modules/grading/written-scoring';
import { L3PracticalGraderService, parseL3Submission } from './modules/grading/l3-practical-grader.service';
import type { L3GradeTask } from './modules/grading/l3-practical-grader.types';

let pass = 0,
  fail = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail = '') {
  if (ok) {
    pass++;
    console.log(`      ✅ ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    fail++;
    failures.push(label);
    console.log(`      ❌ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

// ══════════════════════════════════════════════════════════════════════════
//  1. MCQ SCORING
// ══════════════════════════════════════════════════════════════════════════

function mcqBank(): Map<string, WrittenBankRow> {
  // 4 questions: 2 in subject 0 (1.5 pts), 2 in subject 1 (1.5 pts).
  return new Map<string, WrittenBankRow>([
    ['q1', { id: 'q1', correctAnswer: 'B', subjectIndex: 0, subjectName: 'S0', points: 1.5 }],
    ['q2', { id: 'q2', correctAnswer: 'A', subjectIndex: 0, subjectName: 'S0', points: 1.5 }],
    ['q3', { id: 'q3', correctAnswer: 'C', subjectIndex: 1, subjectName: 'S1', points: 1.5 }],
    ['q4', { id: 'q4', correctAnswer: 'D', subjectIndex: 1, subjectName: 'S1', points: 1.5 }],
  ]);
}
const ans = (id: string, q: string, sel: string | null, extra: Partial<WrittenAnswerLike> = {}): WrittenAnswerLike => ({
  id,
  questionId: q,
  selectedChoice: sel,
  contentSnapshot: null,
  ...extra,
});

function mcqTests() {
  console.log('\n▶ MCQ · all correct');
  let r = computeWrittenScoring(
    [ans('a1', 'q1', 'B'), ans('a2', 'q2', 'A'), ans('a3', 'q3', 'C'), ans('a4', 'q4', 'D')],
    mcqBank(),
  );
  check('full score 6/6', r.writtenEarned === 6 && r.writtenTotal === 6, `${r.writtenEarned}/${r.writtenTotal}`);
  check('100%', r.writtenPct === 100);
  check('all four marked correct', r.perAnswer.every((p) => p.correct));

  console.log('\n▶ MCQ · mix of correct / wrong / blank');
  r = computeWrittenScoring(
    [ans('a1', 'q1', 'B'), ans('a2', 'q2', 'C' /*wrong*/), ans('a3', 'q3', null /*blank*/), ans('a4', 'q4', 'D')],
    mcqBank(),
  );
  check('earned 3/6 (2 correct)', r.writtenEarned === 3, `${r.writtenEarned}/6`);
  check('wrong answer earns 0', r.perAnswer.find((p) => p.answerId === 'a2')!.earned === 0);
  check('blank answer earns 0 & marked incorrect', (() => { const p = r.perAnswer.find((x) => x.answerId === 'a3')!; return p.earned === 0 && !p.correct; })());
  check('50%', r.writtenPct === 50, `${r.writtenPct}%`);

  console.log('\n▶ MCQ · shuffled choices (snapshot key overrides bank)');
  // Per-candidate the correct letter was shuffled to 'A'; bank still says 'B'.
  r = computeWrittenScoring(
    [ans('a1', 'q1', 'A', { contentSnapshot: { correctAnswerKey: 'A' } })],
    mcqBank(),
  );
  check('scored against snapshot key, not bank', r.writtenEarned === 1.5, `${r.writtenEarned}`);
  // Same shuffled question but candidate picked the bank's original 'B' → wrong now.
  r = computeWrittenScoring(
    [ans('a1', 'q1', 'B', { contentSnapshot: { correctAnswerKey: 'A' } })],
    mcqBank(),
  );
  check('stale bank letter is now wrong', r.writtenEarned === 0);

  console.log('\n▶ MCQ · pretest item excluded from totals & gates');
  r = computeWrittenScoring(
    [
      ans('a1', 'q1', 'B'), // scored, correct
      ans('a2', 'q2', 'A'), // scored, correct
      ans('a3', 'q3', 'C', { isPretest: true }), // pretest, correct but 0 & excluded
    ],
    mcqBank(),
  );
  check('pretest not added to total (total=3, not 4.5)', r.writtenTotal === 3, `total=${r.writtenTotal}`);
  check('pretest earns 0 but correctness recorded', (() => { const p = r.perAnswer.find((x) => x.answerId === 'a3')!; return p.earned === 0 && p.correct; })());
  check('pct unaffected by pretest (100%)', r.writtenPct === 100, `${r.writtenPct}%`);
  check('pretest not in any subject aggregate', !r.subjectAgg.has(1));

  console.log('\n▶ MCQ · unknown question is skipped');
  r = computeWrittenScoring([ans('a1', 'qX', 'B'), ans('a2', 'q1', 'B')], mcqBank());
  check('only the known question counts', r.writtenTotal === 1.5 && r.writtenEarned === 1.5, `${r.writtenEarned}/${r.writtenTotal}`);

  console.log('\n▶ MCQ · subject aggregation');
  r = computeWrittenScoring(
    [ans('a1', 'q1', 'B'), ans('a2', 'q2', 'C' /*wrong*/), ans('a3', 'q3', 'C'), ans('a4', 'q4', 'D')],
    mcqBank(),
  );
  check('subject 0 = 1.5/3', r.subjectAgg.get(0)!.earned === 1.5 && r.subjectAgg.get(0)!.total === 3);
  check('subject 1 = 3/3', r.subjectAgg.get(1)!.earned === 3 && r.subjectAgg.get(1)!.total === 3);
}

// ══════════════════════════════════════════════════════════════════════════
//  2. L3 PRACTICAL SCORING (deterministic answer-key layer)
// ══════════════════════════════════════════════════════════════════════════

const svc = new L3PracticalGraderService();

/** Real bank item shape (AXIS-L3-P1-002, 현업적용형): 4/2/2/2 split, must-not-choose. */
function l3Item(): L3GradeTask {
  return {
    points: 10,
    rubric: {
      practiceType: '현업적용형',
      fieldPoints: { tasks: 4, excluded_materials: 1, review_point: 1 },
      riskControl: { points: 2, penaltyPerHit: 1 },
      mustNotChoose: ['T1', 'T3', 'T5'],
      answerKey: {
        tasks: ['T2', 'T4'],
        excluded_materials: ['M2', 'M5'],
        review_point: ['R1'],
        key_reason:
          '금액란과 수신자란이 비워진 서식과 게시된 절차 문서, 날짜만 담긴 일정표는 입력 가능하다. 확정 전 금액표와 이름·연락처가 담긴 담당자 파일은 지침의 금지 범주이며 최종 확인은 사람의 책임이다.',
      },
      rubric: [
        { criterion: '핵심 판단', points: 4 },
        { criterion: '자료·절차', points: 2 },
        { criterion: '위험통제', points: 2 },
        { criterion: '근거', points: 2 },
      ],
    },
  };
}

function sub(selects: Record<string, unknown>, reason: string) {
  return parseL3Submission(JSON.stringify({ version: 1, selects, shortReason: reason }))!;
}

const GOOD_REASON =
  '확정 전 금액표와 담당자 연락처 파일은 회사 지침이 금지한 개인정보·미확정 정보이므로 입력할 수 없고, 금액과 수신 대상의 최종 일치는 사람이 발송 전에 반드시 확인해야 하기 때문입니다.';

function l3Tests() {
  console.log('\n▶ L3 · perfect selections + strong rationale');
  let r = svc.gradeL3Practical(
    l3Item(),
    sub({ tasks: ['T2', 'T4'], excluded_materials: ['M2', 'M5'], review_point: ['R1'] }, GOOD_REASON),
  );
  check('near-full score (≥9/10)', r.earnedPoints >= 9, `${r.earnedPoints}/10 (${r.pct}%)`);
  check('no must-not-choose flag', !r.riskFlags.some((f) => f.code === 'must_not_choose_selected'));
  check('gate not triggered', !r.gate.triggered);
  check('objective fields honor 4/2/2 split', (() => {
    const d = r.breakdown.details;
    return d.find((x) => x.key === 'tasks')?.points === 4 && d.find((x) => x.key === 'risk_control')?.points === 2;
  })());

  console.log('\n▶ L3 · half the tasks correct → partial credit');
  r = svc.gradeL3Practical(
    l3Item(),
    sub({ tasks: ['T2'], excluded_materials: ['M2', 'M5'], review_point: ['R1'] }, GOOD_REASON),
  );
  const tasksDetail = r.breakdown.details.find((x) => x.key === 'tasks')!;
  check('tasks field earns partial (< 4, > 0)', tasksDetail.earned > 0 && tasksDetail.earned < 4, `tasks=${tasksDetail.earned}/4`);
  check('total below perfect', r.earnedPoints < 9, `${r.earnedPoints}/10`);

  console.log('\n▶ L3 · must-not-choose penalty (선택 금지 옵션)');
  r = svc.gradeL3Practical(
    l3Item(),
    // Picked T3 (banned) instead of T4.
    sub({ tasks: ['T2', 'T3'], excluded_materials: ['M2', 'M5'], review_point: ['R1'] }, GOOD_REASON),
  );
  const rc = r.breakdown.details.find((x) => x.key === 'risk_control')!;
  check('risk_control docked below max (−1 per hit)', rc.earned < rc.points, `risk_control=${rc.earned}/${rc.points}`);
  check('must_not_choose flag raised', r.riskFlags.some((f) => f.code === 'must_not_choose_selected'), r.riskFlags.map((f) => f.code).join(','));
  check('routes to expert review', r.needsExpertReview);

  console.log('\n▶ L3 · empty rationale → rationale criterion 0');
  r = svc.gradeL3Practical(
    l3Item(),
    sub({ tasks: ['T2', 'T4'], excluded_materials: ['M2', 'M5'], review_point: ['R1'] }, ''),
  );
  const rat = r.breakdown.details.find((x) => x.key === 'rationale')!;
  check('rationale earns 0 on empty', rat.earned === 0, `rationale=${rat.earned}`);
  check('objective still scored', r.breakdown.objectiveScore > 0);

  console.log('\n▶ L3 · selection-reason contradiction → gate');
  r = svc.gradeL3Practical(
    l3Item(),
    // Correct selections, but the reason argues the OPPOSITE (says forbidden data is fine).
    sub(
      { tasks: ['T2', 'T4'], excluded_materials: ['M2', 'M5'], review_point: ['R1'] },
      '확정 전 금액표와 담당자 연락처 파일도 편의를 위해 그대로 외부 도구에 입력해도 전혀 문제가 없으며 사람이 다시 확인할 필요도 없다고 판단했기 때문입니다 절대적으로 안전합니다.',
    ),
  );
  check('gate triggered (reason vs selection)', r.gate.triggered, r.gate.contradiction ?? '');
  check('contradiction flag + review', r.needsExpertReview && r.riskFlags.some((f) => f.code === 'rationale_contradiction'));

  console.log('\n▶ L3 · PII in rationale → 개인정보 flag + review');
  r = svc.gradeL3Practical(
    l3Item(),
    sub(
      { tasks: ['T2', 'T4'], excluded_materials: ['M2', 'M5'], review_point: ['R1'] },
      '담당자 김민수(주민번호 900101-1234567, 010-1234-5678)의 정보를 근거로 판단했습니다. 확정 전 금액표는 입력 금지 대상이며 사람이 최종 확인해야 합니다 반드시요.',
    ),
  );
  check('개인정보 입력 flag raised', r.riskFlags.some((f) => f.code === '개인정보 입력'), r.riskFlags.map((f) => f.code).join(','));
  check('CRITICAL severity + review', r.needsExpertReview && r.riskFlags.some((f) => f.severity === 'CRITICAL'));

  console.log('\n▶ L3 · low practical score routes to review (boundary/floor)');
  r = svc.gradeL3Practical(
    l3Item(),
    sub({ tasks: [], excluded_materials: [], review_point: [] }, ''),
  );
  check('near-zero total', r.pct <= 20, `${r.pct}%`);
  check('below-floor → expert review', r.needsExpertReview);
}

function main() {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  AXIS GRADING · MCQ + L3 PRACTICAL (deterministic) SMOKE TEST');
  console.log('══════════════════════════════════════════════════════════════');
  mcqTests();
  l3Tests();
  console.log('\n──────────────────────────────────────────────────────────────');
  console.log(`  RESULT: ${pass} passed · ${fail} failed`);
  if (fail > 0) console.log(`  Failed: ${failures.join(' · ')}`);
  console.log('──────────────────────────────────────────────────────────────\n');
  process.exit(fail > 0 ? 1 : 0);
}

main();
