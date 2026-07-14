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
// EXPECTED COUNTS — single source of truth, shared with the v3 conformance smoke
// test (src/smoke-test-v3-conformance.ts) so the DB check (what the database
// holds) and the shipped-bank check (what the YAML contains) cannot drift apart.
import { EXPECTED_MC, EXPECTED_PRACTICAL } from '../src/modules/cbtSessions/bank-expectations';

const prisma = new PrismaClient();

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

// Entry-point guard: EXPECTED_MC/EXPECTED_PRACTICAL are imported by the v3
// conformance smoke test (which must not open a DB connection), so only run the
// validation when this file is executed directly.
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
