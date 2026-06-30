/**
 * One-off repair: the SUBMITTED session cmpqtiae702dwb3st46u135vm (AXIS L2, 김진경)
 * has 12 EssayAnswer rows pointing to task IDs that no longer exist after the
 * question bank was re-seeded. All content is empty (0 chars). This script:
 *   1. Deletes the 12 orphaned EssayAnswer rows.
 *   2. Picks the first set of AXIS L2 tasks from the current bank.
 *   3. Creates 3 fresh EssayAnswer rows (matching LEVEL_EXAM_SPEC.L2.practicalTaskCount).
 *
 * Safe to run: no content is lost (all were empty). The session stays SUBMITTED.
 * Run with:  npx ts-node prisma/repair-submitted-session.ts
 */
import { PrismaClient } from '@prisma/client';

const SESSION_ID = 'cmpqtiae702dwb3st46u135vm';
const PRACTICAL_TASK_COUNT = 3; // LEVEL_EXAM_SPEC.L2.practicalTaskCount

async function main() {
  const p = new PrismaClient();

  const session = await p.examSession.findUnique({ where: { id: SESSION_ID } });
  if (!session) { console.error('Session not found'); process.exit(1); }
  console.log(`Session: ${session.certType} ${session.level} | status: ${session.status}`);

  // Fetch current task bank for this cert+level, sorted by setNo + orderIndex
  const allTasks = await p.taskTemplate.findMany({
    where: { certType: session.certType, level: session.level },
    orderBy: [{ setNo: 'asc' }, { orderIndex: 'asc' }],
  });
  if (allTasks.length === 0) {
    console.error('No TaskTemplate rows found for this cert+level. Seed tasks first.');
    process.exit(1);
  }

  // Group by setNo — pick set 1 (the first coherent set)
  const bySet = new Map<number, typeof allTasks>();
  for (const t of allTasks) {
    const key = t.setNo ?? 0;
    bySet.set(key, [...(bySet.get(key) ?? []), t]);
  }
  const firstSet = Array.from(bySet.values())[0];
  const chosenTasks = firstSet.slice(0, PRACTICAL_TASK_COUNT);

  console.log(`Chosen tasks (set ${chosenTasks[0].setNo ?? 0}):`);
  for (const t of chosenTasks) {
    console.log(`  - [${t.part}] ${t.title} (${t.points}pts)`);
  }

  await p.$transaction(async (tx) => {
    // 1. Delete all orphaned EssayAnswer rows for this session
    const deleted = await tx.essayAnswer.deleteMany({ where: { sessionId: SESSION_ID } });
    console.log(`\nDeleted ${deleted.count} orphaned EssayAnswer rows`);

    // 2. Create fresh EssayAnswer rows for the chosen tasks
    await tx.essayAnswer.createMany({
      data: chosenTasks.map((t) => ({
        sessionId: SESSION_ID,
        taskId: t.id,
        part: t.part,
        contentText: '',
        version: 0,
        aiPreScore: null,
        aiRationale: 'Pending review — repaired by repair-submitted-session.ts',
      })),
    });
    console.log(`Created ${chosenTasks.length} fresh EssayAnswer rows`);
  });

  console.log('\nRepair complete. Session is ready to be graded in the expert portal.');
  await p.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
