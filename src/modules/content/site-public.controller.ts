import { Controller, Get, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ConfigService } from '@nestjs/config';
import { getRequestClientIp } from '../../common/utils/client-ip.util';

/**
 * Public site hints derived from the inbound HTTP connection (no auth).
 * Used for IP-scoped UI such as an admin entry link in the marketing footer.
 */
@Controller('public')
export class PublicSiteController {
  constructor(private readonly config: ConfigService) {}

  @Get('site-context')
  getSiteContext(@Req() req: Request): { footerAdminLink: string | null } {
    const allowedIp = this.config.get<string>('adminFooter.allowedIp') ?? '121.168.121.86';
    const portalUrl = (this.config.get<string>('adminFooter.portalUrl') ?? '').trim();
    const clientIp = getRequestClientIp(req);
    const show = clientIp === allowedIp && portalUrl.length > 0;
    return { footerAdminLink: show ? portalUrl : null };
  }
}
