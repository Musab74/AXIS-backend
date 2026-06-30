/**
 * Seeds L3 on-demand time slots for the next 14 days.
 * Each slot is a regular ExamSchedule row with small capacity (20 seats).
 * roundNumber range 1001–9999 reserved for time slots (1–3 = regular rounds).
 */
import { PrismaClient, CertType, ScheduleStatus } from '@prisma/client';

const prisma = new PrismaClient();

const SLOT_TIMES = ['09:00', '10:00', '13:00', '14:00', '15:00'];
const CERT_TYPES: CertType[] = ['AXIS', 'AXIS_C', 'AXIS_H'];
const SLOT_CAPACITY = 20;

function getUpcomingWorkdays(count: number): Date[] {
  const days: Date[] = [];
  const cursor = new Date();
  cursor.setHours(0, 0, 0, 0);
  cursor.setDate(cursor.getDate() + 1); // start from tomorrow
  while (days.length < count) {
    const dow = cursor.getDay();
    if (dow !== 0 && dow !== 6) days.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

async function main() {
  console.log('Seeding L3 on-demand time slots…');
  const workdays = getUpcomingWorkdays(14);
  let seeded = 0;

  for (const certType of CERT_TYPES) {
    let slotIdx = 1;
    for (const day of workdays) {
      for (const slotTime of SLOT_TIMES) {
        const [h, mi] = slotTime.split(':').map(Number);
        const examDate = new Date(day);
        examDate.setHours(h, mi, 0, 0);

        const registrationStart = new Date(examDate.getTime() - 30 * 24 * 3600 * 1000);
        const registrationEnd = new Date(examDate.getTime() - 30 * 60 * 1000); // 30 min before slot

        // roundNumber: 1000 + slotIdx (unique per cert per year)
        const roundNumber = 1000 + slotIdx;

        await prisma.examSchedule.upsert({
          where: {
            certType_level_year_roundNumber: {
              certType,
              level: 'L3',
              year: examDate.getFullYear(),
              roundNumber,
            },
          },
          update: {
            examDate,
            examStartTime: slotTime,
            registrationStart,
            registrationEnd,
            status: ScheduleStatus.REGISTRATION_OPEN,
          },
          create: {
            certType,
            level: 'L3',
            roundNumber,
            year: examDate.getFullYear(),
            registrationStart,
            registrationEnd,
            examDate,
            examStartTime: slotTime,
            capacity: SLOT_CAPACITY,
            status: ScheduleStatus.REGISTRATION_OPEN,
            venue: 'ONLINE_CBT',
          },
        });
        slotIdx++;
        seeded++;
      }
    }
  }

  console.log(`Seeded ${seeded} L3 time slot schedules.`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
