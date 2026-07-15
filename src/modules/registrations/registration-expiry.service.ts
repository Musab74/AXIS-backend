/**
 * The expiry sweeps. Before this service, AXIS had no scheduled job for any of
 * them — a lapsed seat hold sat in `ExamSchedule.currentCount` forever unless a
 * request path happened to trigger the lazy release, and a lapsed `examDeadline`
 * left the registration PAID with the candidate never told they had lost their
 * money.
 *
 * Three sweeps:
 *  - Seat holds (every 5 min): drives RegistrationsService.releaseExpiredSeatHolds
 *    on a clock instead of on traffic, and mails the candidate. Also fixes the
 *    stale-capacity bug above.
 *  - Exam deadline (daily 09:00 KST): D-N warning, then a notice once it lapses.
 *  - Certificate validity (daily 09:00 KST): D-N warning before a cert goes stale.
 *
 * Deadline sweeps are DAILY, not hourly, and at a civil hour — these mails carry
 * bad news, and waking someone at 03:00 KST to say their exam window closed is
 * worse than telling them at 09:00.
 *
 * Every mail is deduped by MailerService on a natural key, so re-running a sweep
 * (or running two instances) cannot double-notify. That is what lets these sweeps
 * be plain "scan and mail" with no `notified` bookkeeping column.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { RegistrationStatus } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { RedisService } from '../../integrations/redis/redis.service';
import { MailerService } from '../../integrations/mailer/mailer.service';
import { courseLabel } from '../../common/utils/course-label.util';
import { daysUntil } from '../../common/utils/date-kst.util';
import { RegistrationsService } from './registrations.service';

const SEAT_HOLD_LOCK = 'registrations:seat-hold-sweep:lock';
const SEAT_HOLD_LOCK_TTL_SEC = 240;
const DEADLINE_LOCK = 'registrations:deadline-sweep:lock';
const CERT_LOCK = 'certificates:expiry-sweep:lock';
/** Comfortably shorter than the 24h cadence, long enough to cover a slow sweep. */
const DAILY_LOCK_TTL_SEC = 6 * 3600;
const BATCH = 200;

interface CertExpiryRow {
  id: string;
  cert_number: string;
  user_id: string;
  cert_type: string;
  cert_level: string;
  holder_name: string;
  valid_until: Date | string;
  email: string | null;
}

@Injectable()
export class RegistrationExpiryService {
  private readonly logger = new Logger(RegistrationExpiryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly redis: RedisService,
    private readonly mailer: MailerService,
    private readonly registrations: RegistrationsService,
  ) {}

  private get frontendUrl(): string {
    return this.config.get<string>('frontendUrl') ?? '';
  }

  /**
   * Best-effort cross-instance lock. Not released on completion — the TTL lapses
   * before the next cadence, matching PaymentsReconciliationService. When Redis
   * is down we run anyway (fail-open): a missed deadline warning is worse than a
   * duplicate sweep, and MailerService's unique key makes the duplicate harmless.
   */
  private async claim(key: string, ttl: number): Promise<boolean> {
    if (!this.redis.isReady()) return true;
    return this.redis.setNxEx(key, ttl);
  }

  // ─── Seat holds: 30-minute unpaid reservations ───────────────────────────

  @Cron(CronExpression.EVERY_5_MINUTES)
  async sweepSeatHolds(): Promise<void> {
    if (!(await this.claim(SEAT_HOLD_LOCK, SEAT_HOLD_LOCK_TTL_SEC))) return;
    try {
      const released = await this.registrations.releaseExpiredSeatHolds();
      if (released > 0) {
        this.logger.log(`Seat-hold sweep: released ${released} expired hold(s)`);
      }
    } catch (err) {
      this.logger.error(`Seat-hold sweep failed: ${String(err)}`);
    }
  }

  // ─── Exam deadline: N days after payment ────────────────────────────────

  @Cron('0 9 * * *', { timeZone: 'Asia/Seoul' })
  async sweepExamDeadlines(): Promise<void> {
    if (!(await this.claim(DEADLINE_LOCK, DAILY_LOCK_TTL_SEC))) return;
    try {
      await this.remindExamDeadlines();
      await this.notifyExpiredExamDeadlines();
    } catch (err) {
      this.logger.error(`Exam-deadline sweep failed: ${String(err)}`);
    }
  }

  /**
   * D-N warning. Scans a WINDOW (now → now+N days), not an exact-day match: if the
   * cron misses a run (deploy, outage), an exact `examDeadline === today + 3` test
   * would silently skip everyone whose warning fell on the missed day. The window
   * re-catches them, and the dedupe key makes the overlap free.
   */
  private async remindExamDeadlines(): Promise<void> {
    const days = this.config.get<number>('mail.examDeadlineReminderDays') ?? 3;
    const now = new Date();
    const horizon = new Date(now.getTime() + days * 86_400_000);

    const rows = await this.prisma.registration.findMany({
      where: {
        status: RegistrationStatus.PAID,
        examDeadline: { gt: now, lte: horizon },
      },
      select: {
        id: true,
        userId: true,
        certType: true,
        level: true,
        examDeadline: true,
        user: { select: { name: true, email: true } },
      },
      take: BATCH,
    });

    for (const r of rows) {
      if (!r.examDeadline) continue;
      // A candidate who already sat the exam has nothing to be reminded about.
      // (status stays PAID until closeRegistrationIfFinished flips it, so PAID
      // alone is not proof they still need to sit it.)
      const sat = await this.prisma.examSession.count({ where: { registrationId: r.id } });
      if (sat > 0) continue;

      await this.mailer.send({
        userId: r.userId,
        toEmail: r.user.email,
        template: 'EXAM_DEADLINE_REMINDER',
        dedupeKey: `EXAM_DEADLINE_REMINDER:${r.id}`,
        vars: {
          name: r.user.name,
          course: courseLabel(r.certType, r.level),
          examDeadline: r.examDeadline,
          daysLeft: Math.max(1, daysUntil(r.examDeadline, now)),
          url: `${this.frontendUrl}/mypage`,
        },
      });
    }
    if (rows.length) this.logger.log(`Exam-deadline reminder: scanned ${rows.length}`);
  }

  /**
   * The deadline has passed and the candidate never sat the exam. We only mail —
   * we deliberately do NOT flip the registration to a terminal status here.
   * `examDeadlineExpired` is computed on read everywhere in the codebase and entry
   * is already blocked in CbtSessionsService; inventing an EXPIRED status in a
   * mail sweep would change refund/reporting semantics that admins depend on.
   * That decision belongs in a product change, not in a notifier.
   */
  private async notifyExpiredExamDeadlines(): Promise<void> {
    const now = new Date();
    // Only look back a bounded window — without it, the first run after deploy
    // would mail every candidate whose deadline lapsed since launch.
    const lookback = new Date(now.getTime() - 7 * 86_400_000);

    const rows = await this.prisma.registration.findMany({
      where: {
        status: RegistrationStatus.PAID,
        examDeadline: { lt: now, gte: lookback },
      },
      select: {
        id: true,
        userId: true,
        certType: true,
        level: true,
        examDeadline: true,
        user: { select: { name: true, email: true } },
      },
      take: BATCH,
    });

    for (const r of rows) {
      if (!r.examDeadline) continue;
      const sat = await this.prisma.examSession.count({ where: { registrationId: r.id } });
      if (sat > 0) continue;

      await this.mailer.send({
        userId: r.userId,
        toEmail: r.user.email,
        template: 'EXAM_DEADLINE_EXPIRED',
        dedupeKey: `EXAM_DEADLINE_EXPIRED:${r.id}`,
        vars: {
          name: r.user.name,
          course: courseLabel(r.certType, r.level),
          examDeadline: r.examDeadline,
          url: `${this.frontendUrl}/support`,
        },
      });
    }
    if (rows.length) this.logger.log(`Exam-deadline expiry: scanned ${rows.length}`);
  }

  // ─── Certificate validity: 2 years from issue ───────────────────────────

  /**
   * `certificates` is a raw-SQL table (not in schema.prisma), so this is a
   * $queryRaw join rather than a Prisma query — matching CertificatesService.
   */
  @Cron('0 9 * * *', { timeZone: 'Asia/Seoul' })
  async sweepCertificateExpiry(): Promise<void> {
    if (!(await this.claim(CERT_LOCK, DAILY_LOCK_TTL_SEC))) return;

    const days = this.config.get<number>('mail.certExpiryReminderDays') ?? 30;
    const now = new Date();
    const horizon = new Date(now.getTime() + days * 86_400_000);

    try {
      const rows = await this.prisma.$queryRaw<CertExpiryRow[]>`
        SELECT c.id, c.cert_number, c.user_id, c.cert_type, c.cert_level,
               c.holder_name, c.valid_until, u.email
        FROM certificates c
        JOIN users u ON u.id = c.user_id
        WHERE c.valid_until > ${now} AND c.valid_until <= ${horizon}
        LIMIT ${BATCH}
      `;

      for (const c of rows) {
        await this.mailer.send({
          userId: c.user_id,
          toEmail: c.email,
          template: 'CERT_EXPIRY_REMINDER',
          dedupeKey: `CERT_EXPIRY_REMINDER:${c.id}`,
          vars: {
            name: c.holder_name,
            course: `${c.cert_type} ${c.cert_level}`,
            certNumber: c.cert_number,
            validUntil: c.valid_until,
            daysLeft: Math.max(1, daysUntil(c.valid_until, now)),
            url: `${this.frontendUrl}/apply`,
          },
        });
      }
      if (rows.length) this.logger.log(`Cert-expiry reminder: scanned ${rows.length}`);
    } catch (err) {
      this.logger.error(`Cert-expiry sweep failed: ${String(err)}`);
    }
  }
}
