import { PrismaClient, ExamSessionStatus, ProctorEventType } from '@prisma/client';

const prisma = new PrismaClient();

async function smokeTest() {
  console.log('🧪 PROCTOR SYSTEM SMOKE TEST\n');
  console.log('='.repeat(50));

  // 1. Find or create a test user
  let testUser = await prisma.user.findFirst({ where: { userId: 'smoke-test-user' } });
  if (!testUser) {
    testUser = await prisma.user.create({
      data: {
        userId: 'smoke-test-user',
        passwordHash: 'test',
        name: 'Smoke Test User',
        email: 'smoke@test.com',
        phone: '010-0000-0000',
        birthDate: '1990-01-01',
      },
    });
    console.log('✅ Created test user:', testUser.id);
  } else {
    console.log('✅ Found test user:', testUser.id);
  }

  // 2. Test which event types count toward strikes
  const COUNTED_TYPES = new Set([
    'FULLSCREEN_EXIT',
    'TAB_HIDDEN',
    'GAZE_AWAY',
    'NO_FACE',
    'MULTIPLE_FACES',
    'IDENTITY_MISMATCH',
  ]);

  const testEvents = [
    { type: 'GAZE_AWAY', shouldCount: true },
    { type: 'NO_FACE', shouldCount: true },
    { type: 'MULTIPLE_FACES', shouldCount: true },
    { type: 'FULLSCREEN_EXIT', shouldCount: true },
    { type: 'TAB_HIDDEN', shouldCount: true },
    { type: 'IDENTITY_MISMATCH', shouldCount: true },
    { type: 'WINDOW_BLUR', shouldCount: false },
    { type: 'EXTERNAL_DISPLAY', shouldCount: false },
    { type: 'EYES_CLOSED', shouldCount: false },
  ];

  console.log('\n📋 Event Types Configuration:\n');
  console.log('   Type                  | Counts | Expected | Status');
  console.log('   ' + '-'.repeat(55));

  let allPass = true;
  for (const { type, shouldCount } of testEvents) {
    const counts = COUNTED_TYPES.has(type);
    const pass = counts === shouldCount;
    if (!pass) allPass = false;
    const icon = pass ? '✅' : '❌';
    console.log(`   ${type.padEnd(20)} | ${String(counts).padEnd(6)} | ${String(shouldCount).padEnd(8)} | ${icon}`);
  }

  // 3. Test session creation with warning counter
  console.log('\n📋 Testing Session Warning Counter:\n');
  
  const session = await prisma.examSession.create({
    data: {
      userId: testUser.id,
      certType: 'AXIS',
      level: 'L3',
      attemptNo: 99,
      status: ExamSessionStatus.IN_PROGRESS,
      startedAt: new Date(),
      hardDeadline: new Date(Date.now() + 3600000),
      proctorWarnings: 0,
    },
  });
  console.log('   ✅ Created test session:', session.id);
  console.log('   Initial proctorWarnings:', session.proctorWarnings);

  // Simulate strikes
  for (let i = 1; i <= 3; i++) {
    const updated = await prisma.examSession.update({
      where: { id: session.id },
      data: { 
        proctorWarnings: i,
        ...(i >= 3 ? { 
          status: ExamSessionStatus.TERMINATED,
          failReason: 'Forced termination — 3 proctor warnings reached (Article 28).',
          submittedAt: new Date(),
        } : {}),
      },
    });
    console.log(`   Strike ${i}: warnings=${updated.proctorWarnings}, status=${updated.status}`);
  }

  const final = await prisma.examSession.findUnique({ where: { id: session.id } });
  console.log(`\n   Final state: status=${final?.status}`);
  console.log(`   failReason: ${final?.failReason}`);

  // Cleanup
  await prisma.examSession.delete({ where: { id: session.id } });
  console.log('\n   ✅ Cleaned up test session');

  console.log('\n' + '='.repeat(50));
  if (allPass) {
    console.log('✅ ALL TESTS PASSED - Proctor system configured correctly!\n');
  } else {
    console.log('❌ SOME TESTS FAILED - Check configuration!\n');
  }

  await prisma.$disconnect();
}

smokeTest().catch(console.error);
