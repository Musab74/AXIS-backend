import { Body, Controller, Get, Param, Patch, Post, Query, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Roles, RolesGuard } from '../../common/guards/roles.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../common/types/authenticated-user';
import { AdminGradingService, GradingQueueStatus } from './admin-grading.service';
import { EssayGradingService } from './essay-grading.service';
import { FinalizeSessionDto } from './dto/finalize-session.dto';
import { ExpertScoreDto } from './dto/expert-score.dto';

@ApiTags('admin-grading')
@ApiBearerAuth()
@Controller('admin/grading')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('SUPER_ADMIN', 'GRADING_ADMIN', 'EXPERT')
export class AdminGradingController {
  constructor(
    private readonly svc: AdminGradingService,
    private readonly essayGrading: EssayGradingService,
  ) {}

  @Get('queue')
  @ApiOperation({ summary: 'Admin grading queue (all cert series for experts)' })
  queue(@CurrentUser() viewer: AuthenticatedUser, @Query('status') status?: string) {
    const valid: GradingQueueStatus[] = ['all', 'auto_done', 'ai_graded', 'reviewing', 'final', 'overdue', 'terminated'];
    const s = (status ?? 'all') as GradingQueueStatus;
    return this.svc.listQueue(valid.includes(s) ? s : 'all', { id: viewer.id, roles: viewer.roles });
  }

  @Get('queue/counts')
  @ApiOperation({ summary: 'Admin grading queue tab counts' })
  counts(@CurrentUser() viewer: AuthenticatedUser) {
    return this.svc.listCounts({ id: viewer.id, roles: viewer.roles });
  }

  @Get('sessions/:id/detail')
  @ApiOperation({ summary: 'Full grading detail for the scoring screen' })
  detail(@CurrentUser() viewer: AuthenticatedUser, @Param('id') sessionId: string) {
    return this.svc.getGradingDetail(sessionId, { id: viewer.id, roles: viewer.roles });
  }

  /**
   * Admin-only deliverable download. Experts may accept/deny proof uploads but
   * cannot download candidate files (PIPA / grading-integrity policy).
   */
  @Get('sessions/:id/deliverable')
  @Roles('SUPER_ADMIN', 'GRADING_ADMIN', 'EXAM_ADMIN')
  @ApiOperation({ summary: 'Redirect to signed deliverable URL (admins only)' })
  async deliverable(
    @Param('id') sessionId: string,
    @Query('taskId') taskId: string,
    @Res() res: Response,
  ) {
    if (!taskId?.trim()) {
      res.status(400).json({ message: 'taskId query parameter is required' });
      return;
    }
    const url = await this.svc.getDeliverableDownloadUrl(sessionId, taskId.trim());
    res.redirect(302, url);
  }

  @Post('sessions/:id/assign')
  @Roles('SUPER_ADMIN', 'GRADING_ADMIN', 'EXAM_ADMIN')
  @ApiOperation({ summary: 'Assign an expert grader to a session' })
  assign(
    @CurrentUser('id') actorId: string,
    @Param('id') sessionId: string,
    @Body() body: { expertId: string },
  ) {
    return this.svc.assignExpert(actorId, sessionId, body.expertId);
  }

  @Post('assign-bulk')
  @Roles('SUPER_ADMIN', 'GRADING_ADMIN', 'EXAM_ADMIN')
  @ApiOperation({ summary: 'Assign one expert grader to many sessions' })
  assignBulk(
    @CurrentUser('id') actorId: string,
    @Body() body: { sessionIds: string[]; expertId: string },
  ) {
    return this.svc.assignBulk(actorId, body.sessionIds ?? [], body.expertId);
  }

  /**
   * Save expert scores without finalizing the session. The session stays
   * SUBMITTED so a second expert or grading admin can review. Creates
   * `ExpertScoringRecord` rows with `scoringRound: FIRST`. Clears
   * `mandatoryReview` when all tasks have been scored.
   */
  @Patch('sessions/:id/expert-score')
  @ApiOperation({ summary: 'Save expert scores (non-finalizing, writes FIRST round record)' })
  expertScore(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') sessionId: string,
    @Body() dto: ExpertScoreDto,
  ) {
    return this.svc.saveExpertScore(actor.id, actor.roles, sessionId, dto);
  }

  /**
   * Finalize an L2/L1 session. Persists expert practical scores, computes
   * pass/fail, flips the session to GRADED, refreshes the candidate's
   * breakdown, and issues a certificate when the candidate passes. Idempotent.
   *
   * Enforces:
   *   1. Assignment — if `assignedExpertId` is set, only that expert (or admin) may finalize.
   *   2. Mandatory review — blocks finalize if AI prescore is incomplete.
   *   3. Two-rater calibration — creates SECOND/ADJUST round record; throws
   *      ConflictException if scores diverge and actor is not an admin.
   */
  @Post('sessions/:id/finalize')
  @ApiOperation({ summary: 'Finalize an L2/L1 practical and issue certificate when passed' })
  finalize(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') sessionId: string,
    @Body() dto: FinalizeSessionDto,
  ) {
    return this.svc.finalizeSession(actor.id, actor.roles, sessionId, dto);
  }

  /**
   * Run (or re-run) the AI first-pass grader over a session's practical/essay
   * answers. Idempotent; degrades to a no-op when ANTHROPIC_API_KEY is absent
   * so manual grading is never blocked. The AI score is advisory — a human
   * still finalizes.
   */
  @Post('sessions/:id/ai-prescore')
  @ApiOperation({ summary: 'Run AI first-pass grading for a session (advisory)' })
  aiPrescore(@Param('id') sessionId: string) {
    return this.essayGrading.aiPrescoreSession(sessionId);
  }
}
