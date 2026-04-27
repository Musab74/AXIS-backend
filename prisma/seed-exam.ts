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
        { name: 'AI Fundamentals & Tools', qs: 20, pts: 2 },
        { name: 'Prompt Design & Output Quality', qs: 20, pts: 2 },
        { name: 'AI Ethics & Practical Application', qs: 10, pts: 2 },
      ],
    },
    L2: {
      written: [
        { name: 'AI Tool Selection & Strategy', qs: 15, pts: 4 },
        { name: 'Advanced Prompt Design', qs: 10, pts: 3 },
        { name: 'AI Ethics & Security Practice', qs: 5, pts: 2 },
      ],
      practical: [
        { part: ExamPart.PRACTICAL, title: 'Task 1: Draft a marketing email with an AI tool', durationMin: 15, points: 35, scenario: 'Use the in-platform AI chat to produce a 200-word marketing email for a new fitness app launch. Include subject line, body, and CTA.' },
        { part: ExamPart.PRACTICAL, title: 'Task 2: Summarize a meeting transcript', durationMin: 15, points: 35, scenario: 'Given a 1,200-word meeting transcript, use AI to produce a 5-bullet summary plus a list of action items.' },
        { part: ExamPart.PRACTICAL, title: 'Task 3: Build a simple data report', durationMin: 15, points: 30, scenario: 'Use AI to draft a one-page sales report from the provided CSV snippet. Include 1 chart description and 3 insights.' },
      ],
    },
    L1: {
      written: [
        { name: 'AI Transformation (AX) Strategy', qs: 15, pts: 4 },
        { name: 'AI Governance & Risk Management', qs: 10, pts: 4 },
      ],
      practical: [
        { part: ExamPart.DELIVERABLE, title: 'Part A: AX initiative planning document', durationMin: 40, points: 60, scenario: 'You lead a 50-person product org. Draft a 1-page AX adoption plan: scope, KPIs, risks, 90-day milestones. Use the in-platform AI tool; the chat log will be reviewed.' },
        { part: ExamPart.ESSAY, title: 'Part B: 3 leadership scenario essays', durationMin: 20, points: 40, scenario: 'Answer all three: (1) How would you handle an executive pushing to ship an AI feature without bias review? (2) Describe a governance structure for AI experimentation. (3) An AI vendor leak just exposed customer data — your first 24 hours?' },
      ],
    },
  },
  AXIS_C: {
    L3: {
      written: [
        { name: 'AI Coding Concepts & Tools', qs: 20, pts: 2 },
        { name: 'Prompt-to-Code & Automation Basics', qs: 20, pts: 2 },
        { name: 'AI Coding Ethics & Safety', qs: 10, pts: 2 },
      ],
    },
    L2: {
      written: [
        { name: 'AI Coding Tool Selection & Strategy', qs: 15, pts: 4 },
        { name: 'AI Coding & Automation Practice', qs: 10, pts: 3 },
        { name: 'Coding Governance & Security', qs: 5, pts: 2 },
      ],
      practical: [
        { part: ExamPart.PRACTICAL, title: 'Task 1: Generate a Python script with AI', durationMin: 15, points: 35, scenario: 'Use AI to generate a Python script that reads a CSV of orders and outputs total revenue per customer.' },
        { part: ExamPart.PRACTICAL, title: 'Task 2: Automate a workflow', durationMin: 15, points: 35, scenario: 'Design a no-code automation: trigger when a Slack message contains "INC-", create a Linear issue, and reply with the issue link.' },
        { part: ExamPart.PRACTICAL, title: 'Task 3: Debug AI-generated code', durationMin: 15, points: 30, scenario: 'The AI produced a buggy quicksort implementation (provided). Identify the bug, prompt the AI to fix it, and verify with two test cases.' },
      ],
    },
    L1: {
      written: [
        { name: 'AI Coding & Automation Adoption Strategy', qs: 15, pts: 4 },
        { name: 'AI Coding Governance & Security Management', qs: 10, pts: 4 },
      ],
      practical: [
        { part: ExamPart.DELIVERABLE, title: 'Part A: AI coding adoption plan', durationMin: 40, points: 60, scenario: 'Draft a plan to roll out AI pair-programming across a 30-engineer team. Include tool choice, security guardrails, training, and success metrics.' },
        { part: ExamPart.ESSAY, title: 'Part B: 3 governance scenario essays', durationMin: 20, points: 40, scenario: 'Answer all three: (1) An engineer commits AI-generated code containing a GPL snippet — your response? (2) Define a code-review policy for AI-authored PRs. (3) How do you measure productivity gains without optimising for line-count?' },
      ],
    },
  },
  AXIS_H: {
    L3: {
      written: [
        { name: 'AI Concepts & Healthcare Digital Transformation', qs: 15, pts: 2 },
        { name: 'Generative AI Working Principles', qs: 15, pts: 2 },
        { name: 'Healthcare AI Tool Ecosystem & Application', qs: 20, pts: 2 },
      ],
    },
    L2: {
      written: [
        { name: 'Healthcare AI Tool Selection & Strategy', qs: 15, pts: 4 },
        { name: 'Clinical AI Prompt Design & Application', qs: 10, pts: 3 },
        { name: 'Healthcare AI Ethics, Privacy & Security', qs: 5, pts: 2 },
      ],
      practical: [
        { part: ExamPart.PRACTICAL, title: 'Task 1: Patient discharge summary draft', durationMin: 15, points: 35, scenario: 'Use AI to draft a patient discharge summary from the supplied (synthetic) clinical notes. Avoid PHI exposure in the prompt.' },
        { part: ExamPart.PRACTICAL, title: 'Task 2: Hospital scheduling optimization', durationMin: 15, points: 35, scenario: 'Use AI to propose an OR scheduling rearrangement given the supplied 1-week schedule with 3 conflicts.' },
        { part: ExamPart.PRACTICAL, title: 'Task 3: Patient FAQ chatbot prompt', durationMin: 15, points: 30, scenario: 'Design a system prompt for a patient-facing FAQ chatbot covering pre-op fasting rules. Include 3 safety guardrails.' },
      ],
    },
    L1: {
      written: [
        { name: 'Healthcare AX Strategy', qs: 15, pts: 4 },
        { name: 'Healthcare AI Governance & Risk Management', qs: 10, pts: 4 },
      ],
      practical: [
        { part: ExamPart.DELIVERABLE, title: 'Part A: Hospital AX roadmap', durationMin: 40, points: 60, scenario: 'Draft a 12-month AX roadmap for a 500-bed hospital. Include 3 use cases, PIPA compliance plan, vendor risk register, and ROI model.' },
        { part: ExamPart.ESSAY, title: 'Part B: 3 healthcare AI governance essays', durationMin: 20, points: 40, scenario: 'Answer all three: (1) An AI triage tool flags a wrong diagnosis — accountability? (2) Design an IRB-style review for clinical AI pilots. (3) Patient consent for AI-assisted diagnosis: what does informed consent look like?' },
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
