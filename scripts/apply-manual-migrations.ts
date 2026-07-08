/**
 * Applies prisma/migrations/manual-*.sql against DATABASE_URL exactly once
 * each, tracked in a `manual_migrations` table (created on first run).
 *
 * Why not `prisma db push`: the live `certificates` table is intentionally
 * managed by raw SQL in CertificatesService and is NOT in schema.prisma, so
 * db push always wants to DROP it (see the header of
 * manual-add-question-task-csv-fields.sql). This runner is additive-only and
 * never drops anything.
 *
 * Baselining: on a database that predates the tracking table (production),
 * every file is attempted once; statements that fail with "already exists"
 * class MySQL errors are tolerated and logged, then the file is recorded as
 * applied. Any other error aborts with a non-zero exit so a deploy stops
 * before build/restart.
 *
 * Usage: npm run db:apply-migrations   (also runs in .github/workflows/deploy.yml)
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const MIGRATIONS_DIR = join(__dirname, '..', 'prisma', 'migrations');

/** MySQL errnos that mean "this additive DDL was already applied". */
const TOLERATED = new Set([
  1050, // ER_TABLE_EXISTS_ERROR
  1060, // ER_DUP_FIELDNAME       (column already exists)
  1061, // ER_DUP_KEYNAME         (index already exists)
  1091, // ER_CANT_DROP_FIELD_OR_KEY
  1826, // ER_FK_DUP_NAME         (foreign key already exists)
]);

/** Strip -- comment lines, split on ';', drop empties. The manual-*.sql files
 *  are plain DDL — no semicolons inside string literals. */
function splitStatements(sql: string): string[] {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Prisma wraps driver errors (P2010); the MySQL errno lands in meta.code or
 *  the message text. Parse defensively. */
function mysqlErrno(err: unknown): number | null {
  const meta = (err as { meta?: { code?: string | number } })?.meta;
  if (meta?.code != null && !Number.isNaN(Number(meta.code))) return Number(meta.code);
  const msg = err instanceof Error ? err.message : String(err);
  const m = msg.match(/code[:\s]+"?(\d{4})"?/i);
  return m ? Number(m[1]) : null;
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS manual_migrations (
        name       VARCHAR(191) NOT NULL PRIMARY KEY,
        applied_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
      ) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);

    const rows = await prisma.$queryRawUnsafe<{ name: string }[]>(
      'SELECT name FROM manual_migrations',
    );
    const applied = new Set(rows.map((r) => r.name));

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.startsWith('manual-') && f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      if (applied.has(file)) {
        console.log(`skip (already applied): ${file}`);
        continue;
      }
      const statements = splitStatements(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
      console.log(`applying ${file} (${statements.length} statements)`);
      for (const stmt of statements) {
        try {
          await prisma.$executeRawUnsafe(stmt);
        } catch (err) {
          const code = mysqlErrno(err);
          if (code != null && TOLERATED.has(code)) {
            console.log(`  tolerated errno ${code}: ${stmt.slice(0, 70).replace(/\s+/g, ' ')}…`);
            continue;
          }
          console.error(`  FAILED (errno ${code ?? '?'}) in ${file}:\n  ${stmt.slice(0, 200)}`);
          throw err;
        }
      }
      await prisma.$executeRawUnsafe('INSERT INTO manual_migrations (name) VALUES (?)', file);
      console.log(`  recorded ${file}`);
    }
    console.log('manual migrations: up to date.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
