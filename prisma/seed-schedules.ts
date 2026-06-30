import { PrismaClient, CertType, CertLevel, ScheduleStatus } from '@prisma/client';

const prisma = new PrismaClient();

interface ScheduleSpec {
  certType: CertType;
  level: CertLevel;
  roundNumber: number;
  year: number;
  monthsAhead: number;
  examStartTime: string;
  capacity: number;
  status?: ScheduleStatus;
}

const SCHEDULES: ScheduleSpec[] = [
  // Past completed rounds (used for "Taken" / "Scores" history)
  { certType: 'AXIS',   level: 'L3', roundNumber: 1, year: 2026, monthsAhead: -3, examStartTime: '10:00', capacity: 200, status: 'COMPLETED' },
  { certType: 'AXIS',   level: 'L2', roundNumber: 1, year: 2026, monthsAhead: -2, examStartTime: '14:00', capacity: 150, status: 'COMPLETED' },

  // Currently open registrations / upcoming
  { certType: 'AXIS',   level: 'L3', roundNumber: 2, year: 2026, monthsAhead: 1,  examStartTime: '10:00', capacity: 300, status: 'REGISTRATION_OPEN' },
  { certType: 'AXIS',   level: 'L2', roundNumber: 2, year: 2026, monthsAhead: 1,  examStartTime: '14:00', capacity: 200, status: 'REGISTRATION_OPEN' },
  { certType: 'AXIS',   level: 'L1', roundNumber: 2, year: 2026, monthsAhead: 2,  examStartTime: '10:00', capacity: 100, status: 'REGISTRATION_OPEN' },

  { certType: 'AXIS_C', level: 'L3', roundNumber: 1, year: 2026, monthsAhead: 1,  examStartTime: '10:00', capacity: 200, status: 'REGISTRATION_OPEN' },
  { certType: 'AXIS_C', level: 'L2', roundNumber: 1, year: 2026, monthsAhead: 2,  examStartTime: '14:00', capacity: 150, status: 'UPCOMING' },

  { certType: 'AXIS_H', level: 'L3', roundNumber: 1, year: 2026, monthsAhead: 1,  examStartTime: '10:00', capacity: 200, status: 'REGISTRATION_OPEN' },
  { certType: 'AXIS_H', level: 'L3', roundNumber: 2, year: 2026, monthsAhead: 3,  examStartTime: '10:00', capacity: 200, status: 'UPCOMING' },

  // Far-future round
  { certType: 'AXIS',   level: 'L3', roundNumber: 3, year: 2026, monthsAhead: 4,  examStartTime: '10:00', capacity: 300, status: 'UPCOMING' },
];

async function main() {
  console.log('Seeding exam schedules…');
  const now = new Date();

  for (const s of SCHEDULES) {
    const examDate = new Date(now.getFullYear(), now.getMonth() + s.monthsAhead, 15, ...s.examStartTime.split(':').map(Number) as [number, number]);
    const registrationStart = new Date(examDate.getTime() - 60 * 24 * 3600 * 1000); // 60 days before
    const registrationEnd   = new Date(examDate.getTime() - 7  * 24 * 3600 * 1000); // 7  days before

    await prisma.examSchedule.upsert({
      where: {
        certType_level_year_roundNumber: {
          certType: s.certType,
          level: s.level,
          year: s.year,
          roundNumber: s.roundNumber,
        },
      },
      update: {
        registrationStart,
        registrationEnd,
        examDate,
        examStartTime: s.examStartTime,
        capacity: s.capacity,
        status: s.status ?? 'UPCOMING',
      },
      create: {
        certType: s.certType,
        level: s.level,
        roundNumber: s.roundNumber,
        year: s.year,
        registrationStart,
        registrationEnd,
        examDate,
        examStartTime: s.examStartTime,
        capacity: s.capacity,
        status: s.status ?? 'UPCOMING',
        venue: 'ONLINE_CBT',
      },
    });
  }

  const count = await prisma.examSchedule.count();
  console.log(`Seeded ${count} exam schedules.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
