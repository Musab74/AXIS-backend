/**
 * AXIS Question Bank Validation Script
 * 
 * Usage:
 *   npm run db:validate:questions
 * 
 * Validates the imported question bank data for:
 * - Row counts per certification type and level
 * - Data integrity (correct answers, points, explanations, rubrics)
 */

import { PrismaClient, CertType, CertLevel } from '@prisma/client';

const prisma = new PrismaClient();

// ─────────────────────────────────────────────────────────────────────────────
// EXPECTED COUNTS
// ─────────────────────────────────────────────────────────────────────────────

// AXIS L2/L3 (and L1 MCQ) reflect the v2.0 authored bank imported from
// new_doc_l3/ (import-new-questions.ts) — still growing, so bump these as
// batches land. Other combos are still the legacy CSV bank sizes.
const EXPECTED_MC: Record<string, number> = {
  'AXIS_L3': 409, // 공식은행 400 (승인, 구버전 통합본 HTML→YAML 변환) + 샘플 v5.1 잔여 9 (초안, 비드로어블)
  'AXIS_L2': 320, // 정식 10회분(300) + 파일럿 P001(10) + 샘플 v2.1(10) — 은행확장 마스터플랜 v1.1
  'AXIS_L1': 250,
  'AXIS_C_L3': 200,
  'AXIS_C_L2': 120,
  'AXIS_C_L1': 100,
  'AXIS_H_L3': 200,
  'AXIS_H_L2': 120,
  'AXIS_H_L1': 100,
};

// L1 has 3 task slots per set (part_a + part_b + essay_2) × 4 sets = 12 templates.
// See exam-spec.ts LEVEL_EXAM_SPEC.L1: practicalTaskCount = 3 (1 deliverable + 2 essays).
// AXIS L2 = v2.0 세트형 bank: 20 scenario sets × Task A/B/C.
const EXPECTED_PRACTICAL: Record<string, number> = {
  'AXIS_L3': 40, // 실습은행 정합판 v1.1 (4 유형 × 8 + 세트B 4 + 최초샘플 4)
  'AXIS_L2': 60,
  'AXIS_L1': 60,
  'AXIS_C_L2': 12,
  'AXIS_C_L1': 12,
  'AXIS_H_L2': 12,
  'AXIS_H_L1': 12,
};

// ─────────────────────────────────────────────────────────────────────────────
// VALIDATION FUNCTIONS
// ─────────────────────────────────────────────────────────────────────────────

interface ValidationResult {
  passed: boolean;
  message: string;
}

async function validateMCCounts(): Promise<ValidationResult[]> {
  const results: ValidationResult[] = [];
  
  const counts = await prisma.questionBank.groupBy({
    by: ['certType', 'level'],
    where: { active: true },
    _count: { id: true },
  });
  
  const countMap = new Map<string, number>();
  for (const c of counts) {
    const key = `${c.certType}_${c.level}`;
    countMap.set(key, c._count.id);
  }
  
  for (const [key, expected] of Object.entries(EXPECTED_MC)) {
    const actual = countMap.get(key) ?? 0;
    const passed = actual === expected;
    const [certType, level] = key.split('_L');
    results.push({
      passed,
      message: `questions  ${certType.padEnd(8)} L${level}  ${actual.toString().padStart(4)}  ${passed ? '✓' : `✗ (expected ${expected})`}`,
    });
  }
  
  return results;
}

async function validatePracticalCounts(): Promise<ValidationResult[]> {
  const results: ValidationResult[] = [];
  
  const counts = await prisma.taskTemplate.groupBy({
    by: ['certType', 'level'],
    where: { isActive: true },
    _count: { id: true },
  });
  
  const countMap = new Map<string, number>();
  for (const c of counts) {
    const key = `${c.certType}_${c.level}`;
    countMap.set(key, c._count.id);
  }
  
  for (const [key, expected] of Object.entries(EXPECTED_PRACTICAL)) {
    const actual = countMap.get(key) ?? 0;
    const passed = actual === expected;
    const [certType, level] = key.split('_L');
    results.push({
      passed,
      message: `pract.tasks ${certType.padEnd(8)} L${level}  ${actual.toString().padStart(4)}  ${passed ? '✓' : `✗ (expected ${expected})`}`,
    });
  }
  
  return results;
}

async function validateCorrectAnswers(): Promise<ValidationResult> {
  const badAnswers = await prisma.questionBank.count({
    where: {
      active: true,
      NOT: {
        correctAnswer: { in: ['A', 'B', 'C', 'D'] },
      },
    },
  });
  
  return {
    passed: badAnswers === 0,
    message: `Bad correct_answer values: ${badAnswers}  ${badAnswers === 0 ? '✓' : '✗'}`,
  };
}

async function validatePoints(): Promise<ValidationResult> {
  const badPoints = await prisma.questionBank.count({
    where: {
      active: true,
      points: { lt: 1 },
    },
  });
  
  return {
    passed: badPoints === 0,
    message: `Bad points values:         ${badPoints}  ${badPoints === 0 ? '✓' : '✗'}`,
  };
}

async function validateExplanations(): Promise<ValidationResult> {
  const missingExplanations = await prisma.questionBank.count({
    where: {
      active: true,
      OR: [
        { explanation: null },
        { explanation: '' },
      ],
    },
  });
  
  return {
    passed: missingExplanations === 0,
    message: `Missing explanations:      ${missingExplanations}  ${missingExplanations === 0 ? '✓' : '✗'}`,
  };
}

async function validateRubrics(): Promise<ValidationResult> {
  const tasks = await prisma.taskTemplate.findMany({
    where: { isActive: true },
    select: { id: true, rubric: true },
  });
  
  let missingRubrics = 0;
  for (const t of tasks) {
    const rubric = t.rubric as Record<string, unknown> | null;
    if (!rubric || (typeof rubric === 'object' && Object.keys(rubric).length === 0)) {
      missingRubrics++;
    }
  }
  
  return {
    passed: missingRubrics === 0,
    message: `Missing rubrics:           ${missingRubrics}  ${missingRubrics === 0 ? '✓' : '✗'}`,
  };
}

async function validateChoices(): Promise<ValidationResult> {
  const questions = await prisma.questionBank.findMany({
    where: { active: true },
    select: { id: true, choices: true },
  });
  
  let badChoices = 0;
  for (const q of questions) {
    const choices = q.choices as { key: string; text: string }[] | null;
    if (!choices || !Array.isArray(choices) || choices.length !== 4) {
      badChoices++;
      continue;
    }
    const hasAllKeys = ['A', 'B', 'C', 'D'].every(k => 
      choices.some(c => c.key === k && c.text && c.text.trim())
    );
    if (!hasAllKeys) {
      badChoices++;
    }
  }
  
  return {
    passed: badChoices === 0,
    message: `Bad/missing choices:       ${badChoices}  ${badChoices === 0 ? '✓' : '✗'}`,
  };
}

async function getSummaryStats(): Promise<void> {
  const totalMC = await prisma.questionBank.count({ where: { active: true } });
  const totalPractical = await prisma.taskTemplate.count({ where: { isActive: true } });
  
  const difficultyBreakdown = await prisma.questionBank.groupBy({
    by: ['difficulty'],
    where: { active: true },
    _count: { id: true },
  });
  
  console.log('\n📊 Summary Statistics:');
  console.log(`   Total MC questions:     ${totalMC}`);
  console.log(`   Total practical tasks:  ${totalPractical}`);
  console.log(`   Grand total:            ${totalMC + totalPractical}`);
  
  console.log('\n   Difficulty distribution:');
  for (const d of difficultyBreakdown) {
    console.log(`     ${(d.difficulty ?? 'null').padEnd(12)} ${d._count.id}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n🔍 AXIS Question Bank Validation\n');
  console.log('═'.repeat(60));
  
  let allPassed = true;
  
  // Row count validation
  console.log('\n📝 Row Counts:\n');
  
  const mcResults = await validateMCCounts();
  for (const r of mcResults) {
    console.log(`   ${r.message}`);
    if (!r.passed) allPassed = false;
  }
  
  console.log();
  
  const practicalResults = await validatePracticalCounts();
  for (const r of practicalResults) {
    console.log(`   ${r.message}`);
    if (!r.passed) allPassed = false;
  }
  
  // Integrity checks
  console.log('\n✅ Integrity Checks:\n');
  
  const integrityChecks = [
    await validateCorrectAnswers(),
    await validatePoints(),
    await validateExplanations(),
    await validateRubrics(),
    await validateChoices(),
  ];
  
  for (const r of integrityChecks) {
    console.log(`   ${r.message}`);
    if (!r.passed) allPassed = false;
  }
  
  // Summary
  await getSummaryStats();
  
  console.log('\n' + '═'.repeat(60));
  if (allPassed) {
    console.log('✅ All checks passed!\n');
  } else {
    console.log('❌ Some checks FAILED — review above\n');
    process.exit(1);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
