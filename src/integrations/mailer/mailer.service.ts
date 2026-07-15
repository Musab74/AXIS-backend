/**
 * Transactional email via AWS SES v2 (ap-northeast-2).
 *
 * TWO INVARIANTS, both load-bearing:
 *
 * 1. NEVER THROWS. `send()` swallows every failure and returns an outcome. It is
 *    called from inside the paid-money path (`PaymentsService.applyPortOnePaid`) —
 *    if SES is down, or the candidate typo'd their address, the payment must still
 *    be confirmed and the seat still assigned. A receipt is a nice-to-have; the
 *    registration is not. Failures land in `email_logs.status = FAILED` and the
 *    server log, never in the caller's face.
 *
 * 2. EXACTLY-ONCE per dedupeKey. The paid path is reached by three independent
 *    triggers (browser confirm / PortOne webhook / 5-min reconcile cron) and the
 *    expiry crons re-scan the same rows every run. We INSERT the email_logs row
 *    BEFORE calling SES and let the UNIQUE index on dedupe_key reject the retry —
 *    a DB constraint, not an `if` — so no interleaving of concurrent triggers can
 *    double-mail a candidate.
 *
 * MAIL_ENABLED=false (the default) renders the mail and logs it instead of sending.
 * Dev and staging therefore never mail real candidates even with prod data loaded.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { EmailStatus, EmailTemplate, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { MailVars, render } from './mail-templates';

export type MailOutcome = 'SENT' | 'SKIPPED' | 'DUPLICATE' | 'FAILED';

export interface SendMailInput {
  userId: string;
  /** May be null — accounts predating the email gate. Null ⇒ SKIPPED, not an error. */
  toEmail: string | null | undefined;
  template: EmailTemplate;
  /** Stable natural key, e.g. `PAYMENT_SUCCESS:<registrationId>`. Enforced UNIQUE. */
  dedupeKey: string;
  vars: MailVars;
}

@Injectable()
export class MailerService {
  private readonly logger = new Logger(MailerService.name);
  private client: SESv2Client | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private get enabled(): boolean {
    return this.config.get<boolean>('mail.enabled') === true;
  }

  /** Lazy: never construct an SES client (or demand credentials) when disabled. */
  private ses(): SESv2Client {
    if (!this.client) {
      const accessKeyId = this.config.get<string>('aws.accessKeyId') ?? '';
      const secretAccessKey = this.config.get<string>('aws.secretAccessKey') ?? '';
      this.client = new SESv2Client({
        region: this.config.get<string>('aws.region') ?? 'ap-northeast-2',
        // Fall through to the default provider chain (IAM role) when no static
        // keys are configured — prod runs on an instance role.
        ...(accessKeyId && secretAccessKey
          ? { credentials: { accessKeyId, secretAccessKey } }
          : {}),
      });
    }
    return this.client;
  }

  /**
   * Render, claim the dedupe key, send. Returns the outcome; never throws.
   */
  async send(input: SendMailInput): Promise<MailOutcome> {
    try {
      return await this.sendInner(input);
    } catch (err) {
      // Belt-and-braces: sendInner already handles its own failures, so reaching
      // here means something genuinely unexpected (e.g. the DB went away). Still
      // must not propagate — see invariant 1.
      this.logger.error(
        `Mail ${input.template} (${input.dedupeKey}) failed unexpectedly: ${String(err)}`,
      );
      return 'FAILED';
    }
  }

  private async sendInner(input: SendMailInput): Promise<MailOutcome> {
    const { userId, toEmail, template, dedupeKey, vars } = input;

    // Claim the dedupe key first. If another trigger already claimed it, this
    // throws P2002 and we stop — regardless of whether that other attempt
    // ultimately sent, failed, or was skipped. Retrying a FAILED send would
    // require an admin to clear the row; that is deliberate. Silently re-sending
    // on every 5-minute cron sweep is the worse failure mode.
    let logId: string;
    try {
      const row = await this.prisma.emailLog.create({
        data: {
          userId,
          toEmail: toEmail ?? '',
          template,
          dedupeKey,
          status: EmailStatus.PENDING,
        },
        select: { id: true },
      });
      logId = row.id;
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        this.logger.debug(`Mail ${template} already handled for ${dedupeKey} — skipping`);
        return 'DUPLICATE';
      }
      throw err;
    }

    // No address on the account (pre-gate users). Record it so support can see
    // exactly which candidates we could not reach, and why.
    if (!toEmail) {
      await this.finish(logId, EmailStatus.SKIPPED, 'no email address on account');
      this.logger.warn(`Mail ${template} skipped: user=${userId} has no email address`);
      return 'SKIPPED';
    }

    const mail = render(template, vars);

    if (!this.enabled) {
      await this.finish(logId, EmailStatus.SKIPPED, 'MAIL_ENABLED=false');
      this.logger.log(`[mail:dry-run] → ${toEmail} | ${mail.subject}`);
      return 'SKIPPED';
    }

    const from = this.config.get<string>('mail.from') ?? '';
    const fromName = this.config.get<string>('mail.fromName') ?? '';
    const replyTo = this.config.get<string>('mail.replyTo') ?? '';

    try {
      const res = await this.ses().send(
        new SendEmailCommand({
          FromEmailAddress: fromName ? `${fromName} <${from}>` : from,
          Destination: { ToAddresses: [toEmail] },
          ...(replyTo ? { ReplyToAddresses: [replyTo] } : {}),
          Content: {
            Simple: {
              Subject: { Data: mail.subject, Charset: 'UTF-8' },
              Body: {
                Html: { Data: mail.html, Charset: 'UTF-8' },
                Text: { Data: mail.text, Charset: 'UTF-8' },
              },
            },
          },
        }),
      );
      await this.finish(logId, EmailStatus.SENT, res.MessageId ?? null);
      this.logger.log(`Mail ${template} sent → ${toEmail} (${res.MessageId ?? 'no-id'})`);
      return 'SENT';
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await this.finish(logId, EmailStatus.FAILED, reason);
      this.logger.error(`Mail ${template} → ${toEmail} FAILED: ${reason}`);
      return 'FAILED';
    }
  }

  /** Close out the log row. Swallows its own errors — see invariant 1. */
  private async finish(
    id: string,
    status: EmailStatus,
    detail: string | null,
  ): Promise<void> {
    try {
      await this.prisma.emailLog.update({
        where: { id },
        data: {
          status,
          detail,
          sentAt: status === EmailStatus.SENT ? new Date() : null,
        },
      });
    } catch (err) {
      this.logger.error(`Could not finalise email_log ${id}: ${String(err)}`);
    }
  }
}
