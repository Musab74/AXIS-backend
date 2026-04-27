import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CbtSessionsService } from './cbt-sessions.service';
import { CreateSessionDto } from './cbt-sessions.dto';

@Controller('cbt/sessions')
@UseGuards(JwtAuthGuard)
export class CbtSessionsController {
  constructor(private readonly svc: CbtSessionsService) {}

  @Post()
  create(@CurrentUser('id') userId: string, @Body() dto: CreateSessionDto) {
    return this.svc.create(userId, dto.certType, dto.level);
  }

  @Get('mine')
  mine(@CurrentUser('id') userId: string) {
    return this.svc.listMine(userId);
  }

  @Get(':id')
  get(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.svc.getOwned(userId, id);
  }

  @Post(':id/start')
  start(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.svc.start(userId, id);
  }
}
