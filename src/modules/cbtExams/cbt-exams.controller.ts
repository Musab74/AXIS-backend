import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CbtExamsService } from './cbt-exams.service';
import { SaveAnswerDto } from '../cbtSessions/cbt-sessions.dto';

@Controller('cbt/sessions/:id')
@UseGuards(JwtAuthGuard)
export class CbtExamsController {
  constructor(private readonly svc: CbtExamsService) {}

  @Get('paper')
  paper(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.svc.getPaper(userId, id);
  }

  @Post('answers')
  save(@CurrentUser('id') userId: string, @Param('id') id: string, @Body() dto: SaveAnswerDto) {
    return this.svc.saveAnswer(userId, id, dto);
  }
}
