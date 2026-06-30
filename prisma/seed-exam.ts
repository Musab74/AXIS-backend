import { PrismaClient, CertType, CertLevel, QuestionType, ExamPart } from '@prisma/client';
import { createHash } from 'crypto';

const prisma = new PrismaClient();

type SubjectSpec = { name: string; qs: number; pts: number };
type LevelSpec = {
  written: SubjectSpec[];
  practical?: { part: ExamPart; title: string; durationMin: number; points: number; scenario: string }[];
};

const SPEC: Record<CertType, Record<CertLevel, LevelSpec>> = {
  AXIS: {
    L3: {
      written: [
        { name: 'AI Fundamentals', qs: 15, pts: 2 },
        { name: 'AI Tool Usage Basics', qs: 15, pts: 2 },
        { name: 'Prompt Basics', qs: 10, pts: 2 },
        { name: 'AI Ethics & Literacy', qs: 10, pts: 2 },
      ],
    },
    L2: {
      written: [
        { name: 'AI Tool Selection & Strategy', qs: 15, pts: 4 },
        { name: 'Advanced Prompt Design', qs: 10, pts: 3 },
        { name: 'AI Ethics & Security Practice', qs: 5, pts: 2 },
      ],
      practical: [
        { part: ExamPart.PRACTICAL, title: 'Task A: Draft a business deliverable with AI', durationMin: 20, points: 25, scenario: 'Use the in-platform AI chat to produce a 200-word marketing email for a new fitness app launch. Include subject line, body, and CTA.' },
        { part: ExamPart.PRACTICAL, title: 'Task B: Summarize & verify source material', durationMin: 20, points: 25, scenario: 'Given a 1,200-word meeting transcript, use AI to produce a 5-bullet summary plus a list of action items, and flag anything that needs verification.' },
        { part: ExamPart.PRACTICAL, title: 'Task C: Improve a workflow with AI', durationMin: 20, points: 20, scenario: 'Use AI to draft a one-page sales report from the provided CSV snippet. Include 1 chart description and 3 insights.' },
      ],
    },
    L1: {
      written: [
        { name: 'AI Transformation (AX) Strategy', qs: 15, pts: 4 },
        { name: 'AI Governance & Risk Management', qs: 10, pts: 4 },
      ],
      practical: [
        { part: ExamPart.DELIVERABLE, title: 'Part B: Organizational AX execution plan', durationMin: 60, points: 55, scenario: 'You lead a 50-person product org. Using the fixed execution-plan template, draft an AX adoption plan: org diagnosis, candidate tasks, prioritization, 30/90/180-day roadmap, governance, data/tool policy, risk control, change management, KPIs, post-monitoring. Use the in-platform AI tool; the chat log will be reviewed.' },
        { part: ExamPart.ESSAY, title: 'Part C-1: Risk & incident response essay', durationMin: 15, points: 10, scenario: 'An AI vendor leak just exposed customer data. Describe your first 24 hours: containment, scope assessment, reporting chain, recurrence prevention, and accountability.' },
        { part: ExamPart.ESSAY, title: 'Part C-2: Change & performance management essay', durationMin: 15, points: 10, scenario: 'Staff resist a new AI workflow. Describe your change-management plan: stakeholder analysis, training, pilot/rollout, KPIs, and communication cadence.' },
      ],
    },
  },
  AXIS_C: {
    L3: {
      written: [
        { name: 'AI Coding Fundamentals', qs: 15, pts: 2 },
        { name: 'AI Coding Tool Usage Basics', qs: 15, pts: 2 },
        { name: 'Prompt-to-Code Basics', qs: 10, pts: 2 },
        { name: 'AI Coding Ethics & Licensing', qs: 10, pts: 2 },
      ],
    },
    L2: {
      written: [
        { name: 'AI Coding Tool Selection & Strategy', qs: 15, pts: 4 },
        { name: 'AI Coding & Automation Practice', qs: 10, pts: 3 },
        { name: 'Coding Governance & Security', qs: 5, pts: 2 },
      ],
      practical: [
        { part: ExamPart.PRACTICAL, title: 'Task A: Implement an automation script with AI', durationMin: 30, points: 30, scenario: 'Use AI to generate a Python script that reads a CSV of orders and outputs total revenue per customer. Do not output raw personal data columns.' },
        { part: ExamPart.PRACTICAL, title: 'Task B: Debug & improve AI-generated code', durationMin: 30, points: 20, scenario: 'The AI produced a buggy quicksort implementation (provided). Identify the bug, prompt the AI to fix it, and explain the fix.' },
        { part: ExamPart.PRACTICAL, title: 'Task C: Test, verify & document', durationMin: 30, points: 20, scenario: 'Write test cases for the corrected script, verify expected outputs, and produce a short execution guide.' },
      ],
    },
    L1: {
      written: [
        { name: 'AI Coding & Automation Adoption Strategy', qs: 15, pts: 4 },
        { name: 'AI Coding Governance & Security Management', qs: 10, pts: 4 },
      ],
      practical: [
        { part: ExamPart.DELIVERABLE, title: 'Part B: AI coding & automation operating-model design', durationMin: 60, points: 55, scenario: 'Using the fixed execution-plan template, design an operating model to roll out AI pair-programming across a 30-engineer team: citizen-developer permissions, code-review, test/deploy approval, API-key & secret management, license & security policy, roadmap, KPIs, and post-monitoring.' },
        { part: ExamPart.ESSAY, title: 'Part C-1: Security & licensing incident essay', durationMin: 15, points: 10, scenario: 'An engineer commits AI-generated code containing a GPL snippet that shipped to production. Describe your response: containment, license remediation, recurrence prevention, and accountability.' },
        { part: ExamPart.ESSAY, title: 'Part C-2: Code-quality governance essay', durationMin: 15, points: 10, scenario: 'Define a code-review and quality policy for AI-authored PRs, and explain how you measure productivity gains without optimising for line-count.' },
      ],
    },
  },
  AXIS_H: {
    L3: {
      written: [
        { name: 'Healthcare AI Fundamentals', qs: 15, pts: 2 },
        { name: 'Healthcare AI Tool Usage Basics', qs: 15, pts: 2 },
        { name: 'Clinical Prompt Basics', qs: 10, pts: 2 },
        { name: 'Healthcare AI Ethics & Privacy', qs: 10, pts: 2 },
      ],
    },
    L2: {
      written: [
        { name: 'Healthcare AI Tool Selection & Strategy', qs: 15, pts: 4 },
        { name: 'Clinical AI Prompt Design & Application', qs: 10, pts: 3 },
        { name: 'Healthcare AI Ethics, Privacy & Security', qs: 5, pts: 2 },
      ],
      practical: [
        { part: ExamPart.PRACTICAL, title: 'Task A: Draft a non-clinical patient notice', durationMin: 20, points: 25, scenario: 'Use AI to draft a patient appointment-reminder notice from the supplied (synthetic) administrative notes. Strip all patient-identifying information before prompting; avoid any diagnosis/treatment wording.' },
        { part: ExamPart.PRACTICAL, title: 'Task B: Summarize & verify administrative material', durationMin: 20, points: 25, scenario: 'Use AI to summarize the supplied hospital administrative document, and flag any expression that could be mistaken for medical advice or false reassurance.' },
        { part: ExamPart.PRACTICAL, title: 'Task C: Improve a non-clinical workflow', durationMin: 20, points: 20, scenario: 'Design a non-clinical FAQ workflow for pre-op fasting *administrative* guidance. Include 3 safety guardrails ensuring no clinical judgement is implied.' },
      ],
    },
    L1: {
      written: [
        { name: 'Healthcare AX Strategy', qs: 15, pts: 4 },
        { name: 'Healthcare AI Governance & Risk Management', qs: 10, pts: 4 },
      ],
      practical: [
        { part: ExamPart.DELIVERABLE, title: 'Part B: Hospital AI adoption & compliance plan', durationMin: 60, points: 55, scenario: 'Using the fixed execution-plan template, draft a non-clinical AI adoption & operating plan for a 500-bed hospital: non-clinical scope boundary, patient-information de-identification standard, medical-misinterpretation safeguards, departmental approval/review structure, PIPA compliance, roadmap, KPIs, and post-monitoring.' },
        { part: ExamPart.ESSAY, title: 'Part C-1: Compliance & incident response essay', durationMin: 15, points: 10, scenario: 'A non-clinical AI notice was published containing language that could be read as a diagnosis. Describe your response: containment, patient communication, accountability, and recurrence prevention.' },
        { part: ExamPart.ESSAY, title: 'Part C-2: Change management essay', durationMin: 15, points: 10, scenario: 'Departments resist a new non-clinical AI workflow over liability fears. Describe your change-management plan: stakeholder analysis, training, pilot/rollout, KPIs, and communication.' },
      ],
    },
  },
};

const OPS = ['+', '-', '*'] as const;

function genMcq(seed: number): { stem: string; choices: { key: string; text: string }[]; answerKey: string } {
  const rng = mulberry32(seed);
  const a = Math.floor(rng() * 40) + 10;
  const b = Math.floor(rng() * 40) + 10;
  const op = OPS[Math.floor(rng() * OPS.length)];
  const correct = op === '+' ? a + b : op === '-' ? a - b : a * b;
  const distractors = new Set<number>();
  while (distractors.size < 3) {
    const delta = Math.floor(rng() * 20) - 10;
    const cand = correct + (delta === 0 ? 7 : delta);
    if (cand !== correct) distractors.add(cand);
  }
  const all = [correct, ...distractors].sort(() => rng() - 0.5);
  const keys = ['A', 'B', 'C', 'D'];
  const choices = all.map((v, i) => ({ key: keys[i], text: String(v) }));
  const answerKey = choices.find((c) => Number(c.text) === correct)!.key;
  return { stem: `[Sample math placeholder] What is ${a} ${op} ${b}?`, choices, answerKey };
}

function mulberry32(seed: number) {
  return function () {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(obj: unknown): string {
  return createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 32);
}

async function main() {
  console.log('Wiping existing exam content…');
  await prisma.questionBank.deleteMany({});
  await prisma.taskTemplate.deleteMany({});

  let seed = 1;
  for (const certKey of Object.keys(SPEC) as CertType[]) {
    for (const levelKey of Object.keys(SPEC[certKey]) as CertLevel[]) {
      const spec = SPEC[certKey][levelKey];
      for (let si = 0; si < spec.written.length; si++) {
        const subj = spec.written[si];
        for (let q = 0; q < subj.qs; q++) {
          const mcq = genMcq(seed++);
          const content = { stem: mcq.stem, choices: mcq.choices };
          await prisma.questionBank.create({
            data: {
              certType: certKey,
              level: levelKey,
              subjectIndex: si,
              subjectName: subj.name,
              type: QuestionType.MCQ,
              stem: mcq.stem,
              choices: mcq.choices,
              correctAnswer: mcq.answerKey,
              points: subj.pts,
              contentHash: hash(content),
            },
          });
        }
      }
      if (spec.practical) {
        for (let ti = 0; ti < spec.practical.length; ti++) {
          const t = spec.practical[ti];
          await prisma.taskTemplate.create({
            data: {
              certType: certKey,
              level: levelKey,
              part: t.part,
              title: t.title,
              scenario: t.scenario,
              rubric: { criteria: ['Clarity', 'Correctness', 'AI usage process'], maxPerCriterion: Math.floor(t.points / 3) },
              durationMin: t.durationMin,
              points: t.points,
              orderIndex: ti,
            },
          });
        }
      }
    }
  }
  const qCount = await prisma.questionBank.count();
  const tCount = await prisma.taskTemplate.count();
  console.log(`Seeded ${qCount} MCQs and ${tCount} task templates.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
