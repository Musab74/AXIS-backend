import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CbtPracticalService } from './cbt-practical.service';
import { SavePracticalDto } from '../cbtSessions/cbt-sessions.dto';

@Controller('cbt/sessions/:id')
@UseGuards(JwtAuthGuard)
export class CbtPracticalController {
  constructor(private readonly svc: CbtPracticalService) {}

  @Post('practical')
  save(@CurrentUser('id') userId: string, @Param('id') id: string, @Body() dto: SavePracticalDto) {
    return this.svc.save(userId, id, dto);
  }
}
