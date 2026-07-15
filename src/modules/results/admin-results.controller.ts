import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Roles, RolesGuard } from '../../common/guards/roles.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ResultsService } from './results.service';
import { PublishResultsDto } from './dto/publish-results.dto';

@ApiTags('admin-results')
@ApiBearerAuth()
@Controller('admin/results')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('SUPER_ADMIN', 'EXAM_ADMIN', 'GRADING_ADMIN')
export class AdminResultsController {
  constructor(private readonly svc: ResultsService) {}

  @Post('publish')
  @ApiOperation({
    summary: 'Announce results for schedules owning the selected graded sessions',
  })
  publish(@CurrentUser('id') actorId: string, @Body() dto: PublishResultsDto) {
    return this.svc.publishBySessionIds(actorId, dto.sessionIds ?? []);
  }
}
