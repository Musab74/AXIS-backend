/**
 * AXIS Question Bank CSV Importer
 * 
 * Usage:
 *   npm run db:seed:questions              # Import all CSV files
 *   npm run db:seed:questions -- --dry-run # Parse only, no DB writes
 * 
 * Imports multiple-choice questions and practical tasks from CSV files
 * in the questions/ directory into the database.
 */

import { PrismaClient, CertType, CertLevel, QuestionType, ExamPart } from '@prisma/client';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const prisma = new PrismaClient();

// ─────────────────────────────────────────────────────────────────────────────
// CSV PARSING (handles quoted fields with newlines, commas, and escaped quotes)
// ─────────────────────────────────────────────────────────────────────────────

function parseCSV(content: string): Record<string, string>[] {
  // Join multiline rows (newlines inside quoted fields are part of the content)
  const lines: string[] = [];
  let currentLine = '';
  let inQuotes = false;

  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    const nextChar = content[i + 1];

    if (char === '"') {
      // Handle escaped quotes ("") - just pass through both chars
      if (inQuotes && nextChar === '"') {
        currentLine += '""';
        i++;
      } else {
        inQuotes = !inQuotes;
        currentLine += char;
      }
    } else if ((char === '\n' || (char === '\r' && nextChar === '\n')) && !inQuotes) {
      if (currentLine.trim()) {
        lines.push(currentLine);
      }
      currentLine = '';
      if (char === '\r') i++;
    } else {
      currentLine += char;
    }
  }
  if (currentLine.trim()) {
    lines.push(currentLine);
  }

  if (lines.length === 0) return [];

  const headers = parseCSVLine(lines[0]);
  const rows: Record<string, string>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j] ?? '';
    }
    rows.push(row);
  }

  return rows;
}

function parseCSVLine(line: string): string[] {
  const values: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const nextChar = line[i + 1];

    if (char === '"') {
      if (!inQuotes) {
        inQuotes = true;
      } else if (nextChar === '"') {
        // Escaped quote inside field - add single quote
        current += '"';
        i++;
      } else {
        inQuotes = false;
      }
    } else if (char === ',' && !inQuotes) {
      values.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  values.push(current.trim());

  return values;
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function mapCertType(csvValue: string): CertType {
  const v = csvValue.trim().toUpperCase();
  if (v === 'AXIS-C' || v === 'AXIS_C' || v === 'AXISC') return CertType.AXIS_C;
  if (v === 'AXIS-H' || v === 'AXIS_H' || v === 'AXISH') return CertType.AXIS_H;
  return CertType.AXIS;
}

function mapCertLevel(csvValue: string): CertLevel {
  const v = csvValue.trim().toUpperCase();
  if (v === 'L1') return CertLevel.L1;
  if (v === 'L2') return CertLevel.L2;
  return CertLevel.L3;
}

function coerceBool(val: string): boolean {
  const v = val.trim().toUpperCase();
  return v === 'TRUE' || v === '1' || v === 'YES';
}

function coerceInt(val: string, defaultVal: number = 0): number {
  const n = parseInt(val, 10);
  return isNaN(n) ? defaultVal : n;
}

function coerceDate(val: string): Date | null {
  const v = val.trim();
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

function hash(obj: unknown): string {
  return createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 32);
}

function inferExamPart(taskType: string, level: CertLevel): ExamPart {
  const t = taskType.toLowerCase();
  if (t.includes('part_a') || t.includes('deliverable')) return ExamPart.DELIVERABLE;
  if (t.includes('part_b') || t.includes('essay')) return ExamPart.ESSAY;
  return ExamPart.PRACTICAL;
}

// ─────────────────────────────────────────────────────────────────────────────
// LOAD & TRANSFORM
// ─────────────────────────────────────────────────────────────────────────────

interface MCQuestion {
  no: number;
  certType: CertType;
  level: CertLevel;
  subject: string;
  domainArea: string | null;
  qType: string;
  itemPurpose: string | null;
  difficulty: string | null;
  content: string;
  choices: { key: string; text: string }[];
  correctAnswer: string;
  points: number;
  explanation: string;
  sourceRef: string | null;
  shuffleExempt: boolean;
  reviewStatus: string;
  reviewComment: string | null;
  version: number;
  createdBy: string | null;
  createdDate: Date | null;
}

interface PracticalTask {
  setNo: number;
  certType: CertType;
  level: CertLevel;
  taskType: string;
  taskTitle: string;
  timeLimit: number | null;
  scenarioContent: string;
  sampleData: string | null;
  requiredStructure: string;
  forbiddenRules: string | null;
  aiToolAllowed: string | null;
  rubric: string;
  maxScore: number;
  modelAnswer: string;
  riskCriteria: string | null;
  benchmarkExcellent: string | null;
  benchmarkNormal: string | null;
  benchmarkBorderline: string | null;
  benchmarkFail: string | null;
  aiPromptVersion: string | null;
  reviewStatus: string;
  reviewComment: string | null;
  version: number;
  createdBy: string | null;
  createdDate: Date | null;
}

function loadMCQuestions(filePath: string): MCQuestion[] {
  const content = fs.readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '');
  const rows = parseCSV(content);
  
  return rows.map(r => {
    const certType = mapCertType(r.cert_type || '');
    const level = mapCertLevel(r.level || '');
    
    return {
      no: coerceInt(r.no, 0),
      certType,
      level,
      subject: r.subject?.trim() || '',
      domainArea: r.domain_area?.trim() || null,
      qType: r.q_type?.trim() || 'multiple_choice',
      itemPurpose: r.item_purpose?.trim() || null,
      difficulty: r.difficulty?.trim() || null,
      content: r.content?.trim() || '',
      choices: [
        { key: 'A', text: r.option_a?.trim() || '' },
        { key: 'B', text: r.option_b?.trim() || '' },
        { key: 'C', text: r.option_c?.trim() || '' },
        { key: 'D', text: r.option_d?.trim() || '' },
      ],
      correctAnswer: (r.correct_answer?.trim() || 'A').toUpperCase(),
      points: coerceInt(r.points, 2),
      explanation: r.explanation?.trim() || '',
      sourceRef: r.source_ref?.trim() || null,
      shuffleExempt: coerceBool(r.shuffle_exempt || ''),
      reviewStatus: r.review_status?.trim() || 'approved',
      reviewComment: r.review_comment?.trim() || null,
      version: coerceInt(r.version, 1),
      createdBy: r.created_by?.trim() || null,
      createdDate: coerceDate(r.created_date || ''),
    };
  }).filter(q => q.no > 0 && q.content);
}

function loadPracticalTasks(filePath: string): PracticalTask[] {
  const content = fs.readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '');
  const rows = parseCSV(content);
  
  return rows.map(r => ({
    setNo: coerceInt(r.set_no, 0),
    certType: mapCertType(r.cert_type || ''),
    level: mapCertLevel(r.level || ''),
    taskType: r.task_type?.trim() || '',
    taskTitle: r.task_title?.trim() || '',
    timeLimit: coerceInt(r.time_limit, 0) || null,
    scenarioContent: r.scenario_content?.trim() || '',
    sampleData: r.sample_data?.trim() || null,
    requiredStructure: r.required_structure?.trim() || '',
    forbiddenRules: r.forbidden_rules?.trim() || null,
    aiToolAllowed: r.ai_tool_allowed?.trim() || null,
    rubric: r.rubric?.trim() || '',
    maxScore: coerceInt(r.max_score, 0),
    modelAnswer: r.model_answer?.trim() || '',
    riskCriteria: r.risk_criteria?.trim() || null,
    benchmarkExcellent: r.benchmark_excellent?.trim() || null,
    benchmarkNormal: r.benchmark_normal?.trim() || null,
    benchmarkBorderline: r.benchmark_borderline?.trim() || null,
    benchmarkFail: r.benchmark_fail?.trim() || null,
    aiPromptVersion: r.ai_prompt_version?.trim() || null,
    reviewStatus: r.review_status?.trim() || 'approved',
    reviewComment: r.review_comment?.trim() || null,
    version: coerceInt(r.version, 1),
    createdBy: r.created_by?.trim() || null,
    createdDate: coerceDate(r.created_date || ''),
  })).filter(t => t.setNo > 0 && t.taskType && t.scenarioContent);
}

// ─────────────────────────────────────────────────────────────────────────────
// UPSERT FUNCTIONS
// ─────────────────────────────────────────────────────────────────────────────

async function upsertMCQuestions(questions: MCQuestion[], dryRun: boolean): Promise<number> {
  let count = 0;

  // Assign subjectIndex by FIRST-APPEARANCE order (blueprint order, sorted by
  // `no`) per (certType, level). This is robust across the three tracks whose
  // subject names differ — unlike the old keyword heuristic, which mis-bucketed
  // e.g. AXIS-H L3 ("의료기관 업무 AI 활용 기초" matched the 윤리/활용 rule),
  // leaving a subject empty so the exam drew too few questions.
  const subjectOrder = new Map<string, Map<string, number>>();
  for (const q of [...questions].sort((a, b) => a.no - b.no)) {
    const groupKey = `${q.certType}|${q.level}`;
    let m = subjectOrder.get(groupKey);
    if (!m) { m = new Map<string, number>(); subjectOrder.set(groupKey, m); }
    if (!m.has(q.subject)) m.set(q.subject, m.size);
  }

  for (const q of questions) {
    const subjectIndex = subjectOrder.get(`${q.certType}|${q.level}`)!.get(q.subject)!;
    const contentObj = { stem: q.content, choices: q.choices };
    const contentHash = hash(contentObj);
    
    if (dryRun) {
      count++;
      continue;
    }
    
    // Try to find existing record by unique constraint
    const existing = await prisma.questionBank.findFirst({
      where: {
        certType: q.certType,
        level: q.level,
        no: q.no,
      },
    });
    
    const data = {
      certType: q.certType,
      level: q.level,
      subjectIndex,
      subjectName: q.subject,
      type: QuestionType.MCQ,
      stem: q.content,
      choices: q.choices,
      correctAnswer: q.correctAnswer,
      points: q.points,
      contentHash,
      active: true,
      no: q.no,
      domainArea: q.domainArea,
      qType: q.qType,
      itemPurpose: q.itemPurpose,
      difficulty: q.difficulty,
      explanation: q.explanation,
      sourceRef: q.sourceRef,
      shuffleExempt: q.shuffleExempt,
      reviewStatus: q.reviewStatus,
      reviewComment: q.reviewComment,
      createdBy: q.createdBy,
      createdDate: q.createdDate,
    };
    
    if (existing) {
      await prisma.questionBank.update({
        where: { id: existing.id },
        data: {
          ...data,
          qVersion: { increment: 1 },
        },
      });
    } else {
      await prisma.questionBank.create({ data });
    }
    
    count++;
  }
  
  return count;
}

async function upsertPracticalTasks(tasks: PracticalTask[], dryRun: boolean): Promise<number> {
  let count = 0;
  
  for (const t of tasks) {
    const part = inferExamPart(t.taskType, t.level);
    
    // Parse rubric text to JSON format
    let rubricJson: { criteria: string[]; maxPerCriterion?: number } | { raw: string };
    try {
      const rubricItems = t.rubric.split('\n').filter(line => line.trim());
      if (rubricItems.length > 0) {
        rubricJson = {
          criteria: rubricItems.map(item => item.trim()),
          maxPerCriterion: Math.floor(t.maxScore / Math.max(rubricItems.length, 1)),
        };
      } else {
        rubricJson = { raw: t.rubric };
      }
    } catch {
      rubricJson = { raw: t.rubric };
    }
    
    if (dryRun) {
      count++;
      continue;
    }
    
    // Try to find existing record
    const existing = await prisma.taskTemplate.findFirst({
      where: {
        certType: t.certType,
        level: t.level,
        setNo: t.setNo,
        taskType: t.taskType,
      },
    });
    
    const data = {
      certType: t.certType,
      level: t.level,
      part,
      title: t.taskTitle,
      scenario: t.scenarioContent,
      rubric: rubricJson,
      durationMin: t.timeLimit ?? 15,
      points: t.maxScore,
      orderIndex: t.taskType === 'task_a' || t.taskType === 'part_a' ? 0 : 
                  t.taskType === 'task_b' || t.taskType === 'part_b' ? 1 : 2,
      setNo: t.setNo,
      taskType: t.taskType,
      timeLimit: t.timeLimit,
      sampleData: t.sampleData,
      requiredStructure: t.requiredStructure,
      forbiddenRules: t.forbiddenRules,
      aiToolAllowed: t.aiToolAllowed,
      maxScore: t.maxScore,
      modelAnswer: t.modelAnswer,
      riskCriteria: t.riskCriteria,
      benchmarkExcellent: t.benchmarkExcellent,
      benchmarkNormal: t.benchmarkNormal,
      benchmarkBorderline: t.benchmarkBorderline,
      benchmarkFail: t.benchmarkFail,
      aiPromptVersion: t.aiPromptVersion,
      reviewStatus: t.reviewStatus,
      reviewComment: t.reviewComment,
      version: t.version,
      createdBy: t.createdBy,
      createdDate: t.createdDate,
      isActive: true,
    };
    
    if (existing) {
      await prisma.taskTemplate.update({
        where: { id: existing.id },
        data: {
          ...data,
          version: { increment: 1 },
        },
      });
    } else {
      await prisma.taskTemplate.create({ data });
    }
    
    count++;
  }
  
  return count;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────

export async function main(opts: { dryRun?: boolean } = {}) {
  const args = process.argv.slice(2);
  const dryRun = opts.dryRun ?? args.includes('--dry-run');
  
  const questionsDir = path.join(__dirname, '..', 'questions');
  
  if (!fs.existsSync(questionsDir)) {
    console.error(`Questions directory not found: ${questionsDir}`);
    process.exit(1);
  }
  
  const files = fs.readdirSync(questionsDir).filter(f => f.endsWith('.csv'));
  
  console.log(`\n📂 Found ${files.length} CSV files in ${questionsDir}`);
  console.log(dryRun ? '🔍 DRY RUN MODE - no database writes\n' : '💾 IMPORT MODE - writing to database\n');
  
  let totalMC = 0;
  let totalPractical = 0;
  
  // Process MC question files: AXIS_L3_200.csv, AXISC_L2_120.csv, etc. (excluding 실기)
  const mcFiles = files.filter(f => 
    /_L[123]_\d+\.csv$/.test(f) && !f.includes('실기')
  );
  
  for (const file of mcFiles) {
    const filePath = path.join(questionsDir, file);
    try {
      const questions = loadMCQuestions(filePath);
      const count = await upsertMCQuestions(questions, dryRun);
      console.log(`[MC]  ${file.padEnd(45)} ${count.toString().padStart(4)} rows ${dryRun ? '(parsed)' : '✓ upserted'}`);
      totalMC += count;
    } catch (err) {
      console.error(`[MC]  ${file.padEnd(45)} ERROR: ${err}`);
    }
  }
  
  // Process practical task files (실기)
  const practicalFiles = files.filter(f => f.includes('실기'));
  
  for (const file of practicalFiles) {
    const filePath = path.join(questionsDir, file);
    try {
      const tasks = loadPracticalTasks(filePath);
      const count = await upsertPracticalTasks(tasks, dryRun);
      console.log(`[PR]  ${file.padEnd(45)} ${count.toString().padStart(4)} rows ${dryRun ? '(parsed)' : '✓ upserted'}`);
      totalPractical += count;
    } catch (err) {
      console.error(`[PR]  ${file.padEnd(45)} ERROR: ${err}`);
    }
  }
  
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`Done. MC questions: ${totalMC}  |  Practical tasks: ${totalPractical}`);
  console.log(`Total: ${totalMC + totalPractical} items`);
  
  if (dryRun) {
    console.log('\n💡 Run without --dry-run to actually import the data.');
  }
}

// Only auto-run when invoked directly (e.g. `npm run db:seed:questions`).
// When imported by prisma/seed.ts, the caller invokes main() explicitly.
if (require.main === module) {
  main()
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
