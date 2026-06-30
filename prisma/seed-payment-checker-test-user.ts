/**
 * Idempotent: creates or updates the internal payment-QA account.
 * Run on dev/staging only: `npm run db:seed:payment-checker`
 *
 * Login ID: test000
 * Password: supplied via env var PAYMENT_CHECKER_PASSWORD (no default — the
 * script refuses to run if it is unset). Never hardcode the password here.
 *   e.g. PAYMENT_CHECKER_PASSWORD='...' npm run db:seed:payment-checker
 */
import { PrismaClient, Role } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

const USER_ID = process.env.PAYMENT_CHECKER_USER_ID ?? 'test000';
const PASSWORD = process.env.PAYMENT_CHECKER_PASSWORD;
const ROLES: Role[] = [Role.EXAMINEE, Role.EXAM_ADMIN];

async function main() {
  // Safety: this creates an admin-capable QA account — never run it in prod.
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'Refusing to run payment-checker seed in production (NODE_ENV=production).',
    );
  }
  if (!PASSWORD) {
    throw new Error(
      'PAYMENT_CHECKER_PASSWORD env var is required (no hardcoded default). ' +
        "Set it to a strong value, e.g. PAYMENT_CHECKER_PASSWORD='...' npm run db:seed:payment-checker",
    );
  }

  const passwordHash = await bcrypt.hash(PASSWORD, 12);

  const user = await prisma.user.upsert({
    where: { userId: USER_ID },
    update: {
      passwordHash,
      accountStatus: 'ACTIVE',
      name: 'Payment checker (test)',
    },
    create: {
      userId: USER_ID,
      passwordHash,
      name: 'Payment checker (test)',
      phone: '010-0000-0000',
      email: null,
      niceVerified: false,
    },
  });

  for (const role of ROLES) {
    await prisma.userRole.upsert({
      where: {
        userId_role: {
          userId: user.id,
          role,
        },
      },
      update: { revokedAt: null },
      create: {
        userId: user.id,
        role,
      },
    });
  }

  console.log(
    `OK — userId=${USER_ID} (db id=${user.id}), roles=${ROLES.join(', ')}. Password set to test value.`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
