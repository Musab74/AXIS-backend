import { Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { GradingService } from './grading.service';

@Controller('cbt/sessions/:id')
@UseGuards(JwtAuthGuard)
export class GradingController {
  constructor(private readonly svc: GradingService) {}

  @Post('submit')
  submit(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.svc.submit(userId, id);
  }

  @Get('result')
  result(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.svc.getResult(userId, id);
  }
}
