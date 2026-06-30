/**
 * Simple-math seed used while real curriculum content is still under
 * production. Every cert/level combination gets a handful of MCQs so the
 * Demo flow + CBT flow always have *something* to render. L1/L2 also get
 * one or two practical "show your work" task templates so the grading
 * queue has rows to display.
 *
 * Usage: pnpm seed:math (or npm run db:seed:math)
 */
import {
  PrismaClient,
  CertType,
  CertLevel,
  QuestionType,
  ExamPart,
} from '@prisma/client';
import { createHash } from 'crypto';

const prisma = new PrismaClient();

interface MathQ {
  stem: string;
  choices: { key: string; text: string }[];
  answerKey: string;
  points?: number;
}

interface PracTask {
  part: ExamPart;
  title: string;
  scenario: string;
  durationMin: number;
  points: number;
}

const SUBJECTS_FOR_LEVEL: Record<CertLevel, string[]> = {
  L3: ['Mental math · Addition', 'Mental math · Multiplication', 'Mental math · Word problems'],
  L2: ['Applied math · Averages', 'Applied math · Percentages'],
  L1: ['Reasoning · Sequences', 'Reasoning · Geometry'],
};

function mcq(stem: string, correct: number, distractors: number[]): MathQ {
  const all = [correct, ...distractors];
  const keys = ['A', 'B', 'C', 'D'];
  const choices = all.map((v, i) => ({ key: keys[i], text: String(v) }));
  return { stem, choices, answerKey: choices[0].key };
}

function shuffleChoices(q: MathQ): MathQ {
  const { choices, answerKey } = q;
  const correctText = choices.find((c) => c.key === answerKey)!.text;
  const shuffled = [...choices].sort(() => Math.random() - 0.5);
  const keys = ['A', 'B', 'C', 'D'];
  const reKeyed = shuffled.map((c, i) => ({ key: keys[i], text: c.text }));
  const newAnswerKey = reKeyed.find((c) => c.text === correctText)!.key;
  return { stem: q.stem, choices: reKeyed, answerKey: newAnswerKey, points: q.points };
}

const QUESTIONS_BY_LEVEL: Record<CertLevel, MathQ[]> = {
  L3: [
    mcq('What is 3 + 4?', 7, [6, 8, 9]),
    mcq('What is 12 - 5?', 7, [6, 8, 9]),
    mcq('What is 6 × 4?', 24, [18, 22, 26]),
    mcq('What is 9 + 8?', 17, [15, 16, 18]),
    mcq('What is 10 ÷ 2?', 5, [4, 6, 8]),
    mcq('What is 7 × 8?', 56, [54, 58, 60]),
  ],
  L2: [
    mcq('What is the average of [2, 4, 6, 8, 10]?', 6, [5, 7, 8]),
    mcq('What is 15% of 200?', 30, [25, 35, 45]),
    mcq('If 3 items cost ₩9,000, how much do 5 cost?', 15000, [12000, 18000, 21000]),
    mcq('What is 144 ÷ 12?', 12, [10, 14, 16]),
    mcq('Which is larger: 3/4 or 5/8?', 75, [62, 80, 50]),
  ],
  L1: [
    mcq('What is the next number in 2, 4, 8, 16, ?', 32, [24, 28, 36]),
    mcq('Area of a 6×8 rectangle?', 48, [42, 50, 56]),
    mcq('If x + 7 = 15, what is x?', 8, [6, 7, 9]),
    mcq('Sum of angles in a triangle (degrees)?', 180, [90, 270, 360]),
  ],
};

const PRACTICAL_TASKS_BY_LEVEL: Partial<Record<CertLevel, PracTask[]>> = {
  L2: [
    {
      part: ExamPart.PRACTICAL,
      title: 'Compute averages, show your work',
      scenario:
        'Compute the average of [2, 4, 6, 8, 10] and the average of [3, 7, 11]. Show each step (sum, count, division). Submit a short note explaining your method.',
      durationMin: 15,
      points: 30,
    },
  ],
  L1: [
    {
      part: ExamPart.DELIVERABLE,
      title: 'Word-problem walkthrough',
      scenario:
        'A train leaves city A at 09:00 going 60 km/h. Another leaves city B at 10:00 going 80 km/h toward A. Cities are 280 km apart. When and where do they meet? Show the equations and reasoning.',
      durationMin: 25,
      points: 40,
    },
  ],
};

function hash(obj: unknown): string {
  return createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 32);
}

async function seedForCertLevel(certType: CertType, level: CertLevel): Promise<{ qs: number; tasks: number }> {
  const subjects = SUBJECTS_FOR_LEVEL[level];
  const baseQs = QUESTIONS_BY_LEVEL[level];

  // Wipe only this cert+level slice so re-runs are idempotent.
  await prisma.questionBank.deleteMany({ where: { certType, level } });
  await prisma.taskTemplate.deleteMany({ where: { certType, level } });

  let qCount = 0;
  for (let i = 0; i < baseQs.length; i++) {
    const subjIdx = i % subjects.length;
    const q = shuffleChoices(baseQs[i]);
    const content = { stem: q.stem, choices: q.choices };
    await prisma.questionBank.create({
      data: {
        certType,
        level,
        subjectIndex: subjIdx,
        subjectName: subjects[subjIdx],
        type: QuestionType.MCQ,
        stem: q.stem,
        choices: q.choices,
        correctAnswer: q.answerKey,
        points: q.points ?? 2,
        contentHash: hash(content),
      },
    });
    qCount++;
  }

  let tCount = 0;
  const tasks = PRACTICAL_TASKS_BY_LEVEL[level] ?? [];
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    await prisma.taskTemplate.create({
      data: {
        certType,
        level,
        part: t.part,
        title: t.title,
        scenario: t.scenario,
        rubric: { criteria: ['Method clarity', 'Numerical correctness', 'Explanation'], maxPerCriterion: Math.floor(t.points / 3) },
        durationMin: t.durationMin,
        points: t.points,
        orderIndex: i,
      },
    });
    tCount++;
  }
  return { qs: qCount, tasks: tCount };
}

async function main() {
  const certs: CertType[] = [CertType.AXIS, CertType.AXIS_C, CertType.AXIS_H];
  const levels: CertLevel[] = [CertLevel.L3, CertLevel.L2, CertLevel.L1];

  let totalQs = 0;
  let totalTasks = 0;
  for (const c of certs) {
    for (const lvl of levels) {
      const { qs, tasks } = await seedForCertLevel(c, lvl);
      totalQs += qs;
      totalTasks += tasks;
      console.log(`  ${c} ${lvl}: ${qs} MCQs, ${tasks} tasks`);
    }
  }
  console.log(`Seeded ${totalQs} math MCQs and ${totalTasks} practical tasks total.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
