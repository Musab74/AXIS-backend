import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Roles, RolesGuard } from '../../common/guards/roles.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../common/types/authenticated-user';
import { AdminGradingService, GradingQueueStatus } from './admin-grading.service';
import { BaselineGateService } from './baseline-gate.service';
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
    private readonly baselineGates: BaselineGateService,
  ) {}

  @Get('queue')
  @ApiOperation({ summary: 'Admin grading queue (all cert series for experts)' })
  queue(@CurrentUser() viewer: AuthenticatedUser, @Query('status') status?: string) {
    const valid: GradingQueueStatus[] = [
      'all',
      'auto_done',
      'ai_graded',
      'reviewing',
      'final',
      'overdue',
      'terminated',
    ];
    if (status != null && status !== '' && !valid.includes(status as GradingQueueStatus)) {
      throw new BadRequestException(
        `Invalid status "${status}". Expected one of: ${valid.join(', ')}`,
      );
    }
    const s = ((status || 'all') as GradingQueueStatus);
    return this.svc.listQueue(s, { id: viewer.id, roles: viewer.roles });
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

  /**
   * v2.0 human lock: confirm a staged provisional/in-review session. Recomputes
   * the weighted total + hard cuts from the persisted scores, locks the
   * decision (confirmed_pass/confirmed_fail), and issues the certificate only
   * on a pass — 최종 판정 권한은 항상 사람에게 있다 (개발자 통합명세서 v2.0).
   */
  @Post('sessions/:id/confirm')
  @ApiOperation({ summary: 'Confirm (human-lock) a v2.0 provisional session decision' })
  confirm(@CurrentUser() actor: AuthenticatedUser, @Param('id') sessionId: string) {
    return this.svc.confirmDecision(actor.id, actor.roles, sessionId);
  }

  /** v2.0 ops helper: one-click confirm of every CLEAN provisional session. */
  @Post('confirm-provisional-bulk')
  @Roles('SUPER_ADMIN', 'GRADING_ADMIN', 'EXAM_ADMIN')
  @ApiOperation({ summary: 'Bulk-confirm clean v2.0 provisional sessions (no review triggers)' })
  confirmBulk(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() body: { sessionIds?: string[]; certType?: string; level?: string },
  ) {
    return this.svc.bulkConfirmProvisional(actor.id, actor.roles, {
      sessionIds: body.sessionIds,
      certType: body.certType as never,
      level: body.level as never,
    });
  }

  /**
   * v2.0 게이트 확정 (L3 선택-근거 일치 게이트): the reviewing expert confirms
   * the AI-nominated contradiction — the affected selection field scores 0 and
   * the answer's expert score is recomputed.
   */
  @Post('sessions/:id/tasks/:taskId/confirm-gate')
  @ApiOperation({ summary: 'Confirm a triggered gate: zero the contradicted selection field' })
  confirmGate(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') sessionId: string,
    @Param('taskId') taskId: string,
    @Body() body: { fieldKey: string },
  ) {
    return this.svc.confirmGateZero(actor.id, actor.roles, sessionId, taskId, body.fieldKey);
  }

  /** v2.0 terminal state: invalidate a session decision (부정행위 등). Admin only. */
  @Post('sessions/:id/invalidate')
  @Roles('SUPER_ADMIN', 'GRADING_ADMIN')
  @ApiOperation({ summary: 'Invalidate a v2.0 session decision (requires reason)' })
  invalidate(
    @CurrentUser('id') actorId: string,
    @Param('id') sessionId: string,
    @Body() body: { reason: string },
  ) {
    return this.svc.invalidateDecision(actorId, sessionId, body.reason);
  }

  /** v2.0 (WP8): AI-grading baseline gates — what is live vs shadow, per (level, taskType, promptVersion). */
  @Get('baseline-gates')
  @Roles('SUPER_ADMIN', 'GRADING_ADMIN', 'EXAM_ADMIN')
  @ApiOperation({ summary: 'List AI-grading baseline gates (live vs shadow)' })
  listBaselineGates(@Query('level') level?: string) {
    return this.baselineGates.list(level as never);
  }

  /** v2.0 (WP8): record a baseline outcome for one (level, taskType, promptVersion). */
  @Post('baseline-gates')
  @Roles('SUPER_ADMIN', 'GRADING_ADMIN')
  @ApiOperation({ summary: 'Upsert an AI-grading baseline gate result' })
  upsertBaselineGate(
    @Body()
    body: {
      level: string;
      taskType: string;
      promptVersion: string;
      passed: boolean;
      aiExcludedCriteria?: string[];
      notes?: string;
    },
  ) {
    return this.baselineGates.upsert({
      level: body.level as never,
      taskType: body.taskType,
      promptVersion: body.promptVersion,
      passed: body.passed,
      aiExcludedCriteria: body.aiExcludedCriteria,
      notes: body.notes,
    });
  }
}
