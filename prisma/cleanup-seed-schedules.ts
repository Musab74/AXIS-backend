/**
 * Cleanup script to remove all seeded exam schedules from the database.
 * 
 * Usage:
 *   npx ts-node prisma/cleanup-seed-schedules.ts
 *   
 * Or add to package.json scripts:
 *   "db:cleanup:schedules": "ts-node prisma/cleanup-seed-schedules.ts"
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🧹 Cleaning up seeded exam schedules...\n');

  // First, check how many schedules exist
  const totalBefore = await prisma.examSchedule.count();
  console.log(`Total schedules before cleanup: ${totalBefore}`);

  // Check for registrations linked to these schedules
  const schedulesWithRegistrations = await prisma.examSchedule.findMany({
    where: {
      registrations: { some: {} },
    },
    select: {
      id: true,
      certType: true,
      level: true,
      roundNumber: true,
      _count: { select: { registrations: true } },
    },
  });

  if (schedulesWithRegistrations.length > 0) {
    console.log('\n⚠️  The following schedules have registrations and will NOT be deleted:\n');
    for (const s of schedulesWithRegistrations) {
      console.log(`  - ${s.certType} ${s.level} R${s.roundNumber}: ${s._count.registrations} registration(s)`);
    }
    console.log('\n');
  }

  // Delete schedules that have NO registrations (safe to delete)
  const deleteResult = await prisma.examSchedule.deleteMany({
    where: {
      registrations: { none: {} },
    },
  });

  console.log(`✅ Deleted ${deleteResult.count} exam schedules (with no registrations)`);

  const totalAfter = await prisma.examSchedule.count();
  console.log(`\nTotal schedules remaining: ${totalAfter}`);

  if (schedulesWithRegistrations.length > 0) {
    console.log(`\n💡 ${schedulesWithRegistrations.length} schedule(s) were kept because they have registrations.`);
    console.log('   To delete those, first delete/refund the associated registrations.');
  }
}

main()
  .catch((e) => {
    console.error('Error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
