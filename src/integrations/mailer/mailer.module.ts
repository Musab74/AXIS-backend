import { Global, Module } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { MailerService } from './mailer.service';

/**
 * Global, like RedisModule — payments, registrations and the expiry crons all mail.
 *
 * PrismaService is provided here explicitly: it is NOT a global provider in this
 * codebase (each module lists it), and MailerService needs it to claim the
 * email_logs dedupe row.
 */
@Global()
@Module({
  providers: [MailerService, PrismaService],
  exports: [MailerService],
})
export class MailerModule {}
