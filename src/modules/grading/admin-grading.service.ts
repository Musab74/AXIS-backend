import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { CertLevel, CertType, ExamPart, ExamSessionStatus, Prisma, ScoringRound } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma.service';
import { NcObjectStorageService } from '../../integrations/ncObjectStorage/nc-object-storage.service';
import { getTiming, getScoring, computeWeightedResult } from '../cbtSessions/exam-spec';
import { CertificatesService, IssuedCertificate } from '../certificates/certificates.service';
import { CbtSessionsService } from '../cbtSessions/cbt-sessions.service';
import { FinalizeSessionDto } from './dto/finalize-session.dto';
import { ExpertScoreDto } from './dto/expert-score.dto';
import { GRADING_CONFIG } from './grading-config';
import { parseExpertCertScopes } from './expert-scopes';
import { parseL3Reference } from './rubric';
import { anyAnswerEscalated, isScoreDisputed } from './review-triggers';
import {
  attachmentFileNameFromKey,
  encodeDeliverableReview,
  parseDeliverableReview,
  type DeliverableReview,
} from './deliverable-review';

const GRADING_SLA_DAYS = 14;

export type GradingQueueStatus =
  | 'all'
  | 'auto_done'
  | 'ai_graded'
  | 'reviewing'
  | 'final'
  | 'overdue';

export type PracticalState = 'auto' | 'ai_graded' | 'expert_reviewing' | 'final' | 'expert_disputed';

/** Who is viewing the queue — used to scope EXPERT graders to their series. */
export interface GradingViewer {
  id: string;
  roles: string[];
}

/**
 * Pure decision for which series a viewer may see in the grading queue.
 *   - Admins (SUPER_ADMIN / GRADING_ADMIN / EXAM_ADMIN) → `null` (no filter).
 *   - EXPERT with declared competencies → exactly those series.
 *   - EXPERT with NO declared competencies → `null` (all series — the legacy
 *     behavior, kept as the default so an unconfigured deployment never locks
 *     graders out; competencies come from EXPERT_CERT_SCOPES, see expert-scopes.ts).
 *   - anyone else → `[]` (sees nothing).
 * Extracted so it can be unit/smoke-tested without a DB.
 */
export function resolveAllowedCertTypes(
  roles: string[],
  competencies: CertType[],
): CertType[] | null {
  const isAdmin = roles.some(
    (r) => r === 'SUPER_ADMIN' || r === 'GRADING_ADMIN' || r === 'EXAM_ADMIN',
  );
  if (isAdmin) return null;
  if (roles.includes('EXPERT')) return competencies.length > 0 ? competencies : null;
  return [];
}

export interface GradingQueueRow {
  sessionId: string;
  candidate: string;
  certType: string;
  level: CertLevel;
  roundNumber: number | null;
  writtenScore: number | null;
  practicalState: PracticalState;
  result: 'pass' | 'fail' | null;
  dueDate: string;
  daysToDue: number;
  overdue: boolean;
  assignedExpertId: string | null;
  assignedExpert: string | null;
  mandatoryReview: boolean;
}

export interface FinalizedSessionResult {
  sessionId: string;
  status: ExamSessionStatus;
  writtenScore: number | null;
  practicalScore: number;
  totalScore: number;
  passed: boolean;
  failReason: string | null;
  certificate: IssuedCertificate | null;
}

export interface ExpertScoreSavedResult {
  ok: true;
  sessionId: string;
  scoredTasks: number;
  mandatoryReviewCleared: boolean;
}

@Injectable()
export class AdminGradingService {
  private readonly logger = new Logger(AdminGradingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly certificates: CertificatesService,
    private readonly cbtSessions: CbtSessionsService,
    private readonly ncp: NcObjectStorageService,
    private readonly config: ConfigService,
  ) {}

  /** Grading queue scope — `null` means all cert series (admins + unscoped experts). */
  private async allowedCertTypes(viewer?: GradingViewer): Promise<CertType[] | null> {
    if (!viewer) return null;
    const scopes = parseExpertCertScopes(
      this.config.get<string>('grading.expertCertScopes') ?? process.env.EXPERT_CERT_SCOPES,
    );
    return resolveAllowedCertTypes(viewer.roles, scopes.get(viewer.id) ?? []);
  }

  /** Throws when a non-admin actor's competency scope excludes the session's series. */
  private async assertWithinCertScope(
    actorId: string,
    actorRoles: string[],
    certType: CertType,
  ): Promise<void> {
    const allowed = await this.allowedCertTypes({ id: actorId, roles: actorRoles });
    if (allowed && !allowed.includes(certType)) {
      throw new ForbiddenException(
        'This session is outside your grading scope (cert series competency).',
      );
    }
  }

  async listQueue(
    status: GradingQueueStatus = 'all',
    viewer?: GradingViewer,
  ): Promise<GradingQueueRow[]> {
    const allowed = await this.allowedCertTypes(viewer);
    const isExpertOnly = this.isExpertOnlyViewer(viewer);
    const sessions = await this.prisma.examSession.findMany({
      where: {
        status: { in: [ExamSessionStatus.SUBMITTED, ExamSessionStatus.GRADED] },
        ...(allowed ? { certType: { in: allowed } } : {}),
        // Experts grade any session that HAS a practical section. That is every
        // L1/L2 and — when L3_PRACTICALS_ENABLED — L3-with-practicals too. Legacy
        // MCQ-only L3 (auto-graded at submit, no essay rows) is excluded.
        ...(isExpertOnly ? { essayAnswers: { some: {} } } : {}),
      },
      include: {
        user: { select: { name: true } },
        essayAnswers: { select: { taskId: true, aiPreScore: true, expertScore: true } },
      },
      orderBy: [{ submittedAt: 'desc' }],
    });

    // Task max points, needed to put the expert's raw score and the AI's
    // percentage pre-score on the same 0–100 scale for the dispute check.
    const queueTaskIds = Array.from(
      new Set(sessions.flatMap((s) => s.essayAnswers.map((e) => e.taskId))),
    );
    const queueTasks = queueTaskIds.length
      ? await this.prisma.taskTemplate.findMany({
          where: { id: { in: queueTaskIds } },
          select: { id: true, points: true },
        })
      : [];
    const pointsByTask = new Map(queueTasks.map((t) => [t.id, t.points]));

    const regIds = sessions.map((s) => s.registrationId).filter((r): r is string => !!r);
    const registrations = regIds.length
      ? await this.prisma.registration.findMany({
          where: { id: { in: regIds } },
          include: { schedule: { select: { roundNumber: true } } },
        })
      : [];
    const regById = new Map(registrations.map((r) => [r.id, r]));

    // Resolve assigned-expert names in one query.
    const expertIds = Array.from(
      new Set(sessions.map((s) => s.assignedExpertId).filter((x): x is string => !!x)),
    );
    const experts = expertIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: expertIds } },
          select: { id: true, name: true },
        })
      : [];
    const expertNameById = new Map(experts.map((e) => [e.id, e.name]));

    const now = Date.now();
    const rows: GradingQueueRow[] = sessions.map((s) => {
      const due = new Date((s.submittedAt ?? s.updatedAt).getTime() + GRADING_SLA_DAYS * 86_400_000);
      const overdue = now > due.getTime() && s.status !== ExamSessionStatus.GRADED;
      const reg = s.registrationId ? regById.get(s.registrationId) : null;
      const practicalState = this.derivePracticalState(s, pointsByTask);
      return {
        sessionId: s.id,
        candidate: s.user.name,
        certType: s.certType,
        level: s.level,
        roundNumber: reg?.schedule?.roundNumber ?? null,
        writtenScore: s.writtenScore,
        practicalState,
        result: s.passed === true ? 'pass' : s.passed === false ? 'fail' : null,
        dueDate: due.toISOString(),
        daysToDue: Math.ceil((due.getTime() - now) / 86_400_000),
        overdue,
        assignedExpertId: s.assignedExpertId ?? null,
        assignedExpert: s.assignedExpertId ? expertNameById.get(s.assignedExpertId) ?? null : null,
        mandatoryReview: s.mandatoryReview,
      };
    });

    return rows.filter((r) => this.matchesTab(r, status));
  }

  async listCounts(viewer?: GradingViewer): Promise<{
    all: number;
    autoDone: number;
    aiDone: number;
    reviewing: number;
    final: number;
    overdue: number;
  }> {
    const all = await this.listQueue('all', viewer);
    return {
      all: all.length,
      autoDone: all.filter((r) => this.matchesTab(r, 'auto_done')).length,
      aiDone: all.filter((r) => this.matchesTab(r, 'ai_graded')).length,
      reviewing: all.filter((r) => this.matchesTab(r, 'reviewing')).length,
      final: all.filter((r) => this.matchesTab(r, 'final')).length,
      overdue: all.filter((r) => r.overdue).length,
    };
  }

  private matchesTab(row: GradingQueueRow, tab: GradingQueueStatus): boolean {
    switch (tab) {
      case 'all':
        return true;
      case 'auto_done':
        return row.practicalState === 'auto';
      case 'ai_graded':
        return row.practicalState === 'ai_graded';
      case 'reviewing':
        return row.practicalState === 'expert_reviewing' || row.practicalState === 'expert_disputed';
      case 'final':
        return row.practicalState === 'final';
      case 'overdue':
        return row.overdue;
    }
  }

  /** True when the viewer is an EXPERT without an admin grading role. */
  private isExpertOnlyViewer(viewer?: GradingViewer): boolean {
    if (!viewer) return false;
    if (!viewer.roles.includes('EXPERT')) return false;
    return !viewer.roles.some(
      (r) => r === 'SUPER_ADMIN' || r === 'GRADING_ADMIN' || r === 'EXAM_ADMIN',
    );
  }

  /**
   * L1/L2 sessions appear in the expert queue without admin assignment.
   * First expert to open or score claims the session (optimistic lock).
   */
  private async claimSessionIfUnassigned(
    sessionId: string,
    _level: CertLevel,
    assignedExpertId: string | null,
    viewer: GradingViewer | undefined,
  ): Promise<string | null> {
    if (!viewer || !this.isExpertOnlyViewer(viewer)) return assignedExpertId;
    // Callers reach this only after confirming the session has a practical
    // section (finalize / saveExpertScore guard on essayAnswers), so no
    // level short-circuit is needed — L3-with-practicals claims like L1/L2.
    if (assignedExpertId) return assignedExpertId;

    const updated = await this.prisma.examSession.updateMany({
      where: { id: sessionId, assignedExpertId: null },
      data: { assignedExpertId: viewer.id },
    });
    if (updated.count === 1) {
      await this.writeAudit(viewer.id, 'EXPERT_SELF_CLAIMED', 'ExamSession', sessionId, {
        assignedExpertId: viewer.id,
      });
      return viewer.id;
    }
    const row = await this.prisma.examSession.findUnique({
      where: { id: sessionId },
      select: { assignedExpertId: true },
    });
    return row?.assignedExpertId ?? null;
  }

  // ─── Expert assignment ───────────────────────────────────────────────────

  /**
   * Assign an EXPERT grader to a session's practical review. Any active EXPERT
   * may be assigned regardless of competency series. Records an audit row.
   */
  async assignExpert(actorId: string, sessionId: string, expertId: string): Promise<{ ok: true }> {
    const session = await this.prisma.examSession.findUnique({
      where: { id: sessionId },
      include: { _count: { select: { essayAnswers: true } } },
    });
    if (!session) throw new NotFoundException('Session not found');
    if (session._count.essayAnswers === 0) {
      throw new BadRequestException('This session has no practical section — no expert assignment needed.');
    }
    await this.assertExpertQualified(expertId);

    await this.prisma.examSession.update({
      where: { id: sessionId },
      data: { assignedExpertId: expertId },
    });
    await this.writeAudit(actorId, 'EXPERT_ASSIGNED', 'ExamSession', sessionId, {
      assignedExpertId: expertId,
    });
    return { ok: true };
  }

  /** Assign one expert to many sessions (bulk). Skips ineligible sessions. */
  async assignBulk(
    actorId: string,
    sessionIds: string[],
    expertId: string,
  ): Promise<{ assigned: number; skipped: string[] }> {
    const skipped: string[] = [];
    let assigned = 0;
    for (const sessionId of sessionIds) {
      try {
        await this.assignExpert(actorId, sessionId, expertId);
        assigned += 1;
      } catch {
        skipped.push(sessionId);
      }
    }
    return { assigned, skipped };
  }

  private async assertExpertQualified(expertId: string): Promise<void> {
    const expert = await this.prisma.user.findUnique({
      where: { id: expertId },
      include: {
        roles: { where: { role: 'EXPERT', revokedAt: null } },
      },
    });
    if (!expert || expert.roles.length === 0) {
      throw new BadRequestException('Target user is not an active expert grader.');
    }
  }

  // ─── Grading detail (scoring screen) ─────────────────────────────────────

  /**
   * Full grading detail for one session: written score + per-task template
   * (rubric, points, scenario, anchors) joined with the candidate's answer and
   * the AI first-pass verdict. Backs the admin scoring screen. EXPERT viewers
   * are scoped to their competency.
   */
  async getGradingDetail(sessionId: string, viewer?: GradingViewer) {
    const session = await this.prisma.examSession.findUnique({
      where: { id: sessionId },
      include: { user: { select: { name: true } }, essayAnswers: true },
    });
    if (!session) throw new NotFoundException('Session not found');

    const allowed = await this.allowedCertTypes(viewer);
    if (allowed && !allowed.includes(session.certType)) {
      throw new BadRequestException('This session is outside your grading scope.');
    }

    const assignedExpertId = await this.claimSessionIfUnassigned(
      session.id,
      session.level,
      session.assignedExpertId,
      viewer,
    );

    const proctoringEvents = await this.prisma.proctoringEvent.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    const tasks = await this.prisma.taskTemplate.findMany({
      where: { id: { in: session.essayAnswers.map((e) => e.taskId) } },
    });
    const taskById = new Map(tasks.map((t) => [t.id, t]));

    const cheatingSuspect =
      session.proctorWarnings > 0 ||
      proctoringEvents.some(
        (e) =>
          e.severity === 'HIGH' ||
          e.severity === 'high' ||
          e.eventType === 'AI_FLAG_CONFIRMED' ||
          e.eventType === 'MULTIPLE_FACES' ||
          e.eventType === 'PHONE_DETECTED',
      );

    return {
      sessionId: session.id,
      candidate: session.user.name,
      certType: session.certType,
      level: session.level,
      status: session.status,
      writtenScore: session.writtenScore,
      practicalScore: session.practicalScore,
      totalScore: session.totalScore,
      passed: session.passed,
      mandatoryReview: session.mandatoryReview,
      assignedExpertId,
      proctorWarnings: session.proctorWarnings,
      cheatingSuspect,
      proctoringEvents: proctoringEvents.map((e) => {
        const meta = (e.metadata ?? {}) as Record<string, unknown>;
        const screenEvidenceUrl =
          typeof meta.screenEvidenceUrl === 'string' ? meta.screenEvidenceUrl : null;
        return {
          id: e.id,
          type: e.eventType,
          createdAt: e.createdAt.toISOString(),
          captionKo: e.captionKo,
          captionEn: e.captionEn,
          severity: e.severity,
          hasEvidence: !!(e.evidenceUrl || screenEvidenceUrl || e.videoClipUrl),
        };
      }),
      tasks: session.essayAnswers.map((a) => {
        const t = taskById.get(a.taskId);
        const parsedNotes = parseDeliverableReview(a.expertNotes);
        const hasAttachment = !!a.attachmentUrl;
        return {
          taskId: a.taskId,
          part: a.part,
          title: t?.title ?? '(unknown task)',
          scenario: t?.scenario ?? '',
          maxPoints: t?.points ?? 0,
          rubric: t?.rubric ?? null,
          modelAnswer: t?.modelAnswer ?? null,
          // Item-author review conditions from the L3 seed (rubric JSON) —
          // shown to the reviewer alongside the generic runtime triggers.
          expertReviewTrigger: parseL3Reference(t?.rubric ?? null)?.expertReviewTrigger ?? null,
          contentText: a.contentText,
          hasAttachment,
          attachmentFileName: attachmentFileNameFromKey(a.attachmentUrl),
          deliverableReview: parsedNotes.review,
          aiChatLog: a.aiChatLog,
          aiPreScore: a.aiPreScore,
          aiBand: a.aiBand,
          aiConfidence: a.aiConfidence,
          aiRationale: a.aiRationale,
          aiCriterionScores: a.aiCriterionScores,
          aiRiskFlags: a.aiRiskFlags,
          // Grading provenance for the reviewer UI: which grader produced the
          // first pass ('l3-answer-key' | 'claude-opus-4-8' | 'hybrid-l3+claude'
          // | 'judge0-autotest') and its raw earned points.
          aiModel: a.aiModel,
          earnedPoints: a.earnedPoints,
          expertScore: a.expertScore,
          expertNotes: parsedNotes.notes || null,
        };
      }),
    };
  }

  private mergedExpertNotes(
    existingNotes: string | null | undefined,
    incomingNotes: string | undefined,
    deliverableReview: DeliverableReview | undefined,
  ): string | null {
    const parsed = parseDeliverableReview(existingNotes);
    const review = deliverableReview ?? parsed.review;
    const human = incomingNotes !== undefined ? incomingNotes : parsed.notes;
    return encodeDeliverableReview(review, human);
  }

  /** Signed URL for admin deliverable download — never exposed to EXPERT role. */
  async getDeliverableDownloadUrl(sessionId: string, taskId: string): Promise<string> {
    const answer = await this.prisma.essayAnswer.findUnique({
      where: { sessionId_taskId: { sessionId, taskId } },
    });
    if (!answer?.attachmentUrl) {
      throw new NotFoundException('No deliverable file uploaded for this task.');
    }
    const bucket =
      this.config.get<{ bucketDeliverables: string }>('ncp')?.bucketDeliverables ??
      'axis-deliverables';
    return this.ncp.signedGetUrl(answer.attachmentUrl, 1800, bucket);
  }

  private async writeAudit(
    actorId: string,
    action: string,
    entityType: string,
    entityId: string,
    after: Prisma.InputJsonValue,
  ): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: { actorId, action, entityType, entityId, after },
      });
    } catch (err) {
      this.logger.warn(`audit write failed (${action} ${entityId}): ${(err as Error).message}`);
    }
  }

  /**
   * Save first-expert scores WITHOUT finalizing the session. The session stays
   * SUBMITTED so a second expert or grading admin can review and call finalize.
   * Creates `ExpertScoringRecord` rows with `scoringRound: FIRST`.
   * Clears `mandatoryReview` once all tasks have been scored by this expert.
   *
   * Enforcement: if `session.assignedExpertId` is set and actor role is EXPERT,
   * the actor must be the assigned expert (admins bypass this check).
   */
  async saveExpertScore(
    actorId: string,
    actorRoles: string[],
    sessionId: string,
    dto: ExpertScoreDto,
  ): Promise<ExpertScoreSavedResult> {
    const session = await this.prisma.examSession.findUnique({
      where: { id: sessionId },
      include: { essayAnswers: { select: { id: true, taskId: true, aiPreScore: true } } },
    });
    if (!session) throw new NotFoundException('Session not found');
    if (session.essayAnswers.length === 0) {
      throw new BadRequestException('This session has no practical section — no expert scoring needed.');
    }
    if (session.status !== ExamSessionStatus.SUBMITTED) {
      throw new ConflictException(
        `Cannot score a session in status ${session.status} — it must be SUBMITTED.`,
      );
    }

    const isAdmin = actorRoles.some((r) =>
      r === 'SUPER_ADMIN' || r === 'GRADING_ADMIN' || r === 'EXAM_ADMIN',
    );
    await this.assertWithinCertScope(actorId, actorRoles, session.certType);
    const effectiveAssignee = await this.claimSessionIfUnassigned(
      session.id,
      session.level,
      session.assignedExpertId,
      isAdmin ? undefined : { id: actorId, roles: actorRoles },
    );
    if (!isAdmin && effectiveAssignee && effectiveAssignee !== actorId) {
      throw new ForbiddenException(
        'This session is assigned to a different expert. Only the assigned expert or an admin may score it.',
      );
    }

    // Scope to the tasks actually assigned to this session (frozen at paper-start
    // as EssayAnswer rows) — NOT all tasks for the cert+level, which would cause
    // the practical-score denominator to include unassigned tasks and deflate scores.
    const sessionTaskIds = session.essayAnswers.map((e) => e.taskId);
    const tasks = sessionTaskIds.length
      ? await this.prisma.taskTemplate.findMany({ where: { id: { in: sessionTaskIds } } })
      : [];
    const taskById = new Map(tasks.map((t) => [t.id, t]));

    for (const t of dto.tasks) {
      const tpl = taskById.get(t.taskId);
      if (!tpl) throw new BadRequestException(`Task ${t.taskId} does not belong to this session's paper.`);
      if (t.expertScore > tpl.points) {
        throw new BadRequestException(
          `Score for task "${tpl.title}" exceeds task points (${t.expertScore} > ${tpl.points}).`,
        );
      }
    }

    await this.prisma.$transaction(async (tx) => {
      for (const t of dto.tasks) {
        const tpl = taskById.get(t.taskId)!;
        const existing = await tx.essayAnswer.findUnique({
          where: { sessionId_taskId: { sessionId, taskId: t.taskId } },
        });
        if (existing) {
          await tx.essayAnswer.update({
            where: { id: existing.id },
            data: {
              expertScore: t.expertScore,
              expertNotes: this.mergedExpertNotes(
                existing.expertNotes,
                t.expertNotes,
                t.deliverableReview,
              ),
            },
          });
        } else {
          await tx.essayAnswer.create({
            data: {
              sessionId,
              taskId: t.taskId,
              part: tpl.part,
              contentText: '',
              version: 1,
              expertScore: t.expertScore,
              expertNotes: this.mergedExpertNotes(null, t.expertNotes, t.deliverableReview),
            },
          });
        }

        // Create a FIRST-round scoring record for audit trail.
        // If a FIRST record already exists for this rater, skip (idempotent re-score
        // is handled by the essayAnswer update above; the record is append-only).
        const existingRecord = await tx.expertScoringRecord.findFirst({
          where: { sessionId, taskId: t.taskId, raterId: actorId, scoringRound: ScoringRound.FIRST },
        });
        if (!existingRecord) {
          await tx.expertScoringRecord.create({
            data: {
              sessionId,
              taskId: t.taskId,
              raterId: actorId,
              scoringRound: ScoringRound.FIRST,
              criterionScores: { taskTitle: tpl.title, score: t.expertScore, maxPoints: tpl.points },
              total: t.expertScore,
              confidenceComment: t.expertNotes ?? null,
              adjudicationRequired: false,
            },
          });
        }
      }

      // Clear mandatoryReview once all essay answers for this session have an
      // expert score — EXCEPT for an AXIS-H session carrying a HIGH/CRITICAL
      // medical risk flag: that stays in mandatory review until a GRADING_ADMIN
      // finalizes (severity ladder — 불합격 검토).
      const allAnswers = await tx.essayAnswer.findMany({ where: { sessionId } });
      const allScored = allAnswers.length > 0 && allAnswers.every((a) => a.expertScore != null);
      const escalated =
        session.certType === CertType.AXIS_H && anyAnswerEscalated(allAnswers);
      if (allScored && session.mandatoryReview && !escalated) {
        await tx.examSession.update({
          where: { id: sessionId },
          data: { mandatoryReview: false },
        });
      }
    });

    await this.writeAudit(actorId, 'EXPERT_SCORES_SAVED', 'ExamSession', sessionId, {
      tasks: dto.tasks.map((t) => ({ taskId: t.taskId, expertScore: t.expertScore })),
    });

    const allAnswers = await this.prisma.essayAnswer.findMany({ where: { sessionId } });
    const mandatoryReviewCleared =
      session.mandatoryReview &&
      allAnswers.every((a) => a.expertScore != null) &&
      !(session.certType === CertType.AXIS_H && anyAnswerEscalated(allAnswers));

    return {
      ok: true,
      sessionId,
      scoredTasks: dto.tasks.length,
      mandatoryReviewCleared: !!mandatoryReviewCleared,
    };
  }

  /**
   * Finalize a SUBMITTED L2/L1 session: writes expert practical scores into
   * EssayAnswer rows, recomputes practical %, computes overall pass/fail using
   * `LEVEL_TIMING`, flips the session to `GRADED`, refreshes the practical
   * grading-result rows so the candidate result page shows real numbers, and
   * issues the certificate when the candidate passes.
   *
   * Idempotent: re-finalizing an already-GRADED session updates the scores and
   * re-issues the certificate (the cert insert dedupes on session_id).
   */
  async finalizeSession(
    actorId: string,
    actorRoles: string[],
    sessionId: string,
    dto: FinalizeSessionDto,
  ): Promise<FinalizedSessionResult> {
    const session = await this.prisma.examSession.findUnique({
      where: { id: sessionId },
      include: { essayAnswers: true },
    });
    if (!session) throw new NotFoundException('Session not found');
    if (
      session.status !== ExamSessionStatus.SUBMITTED &&
      session.status !== ExamSessionStatus.GRADED
    ) {
      throw new ConflictException(
        `Cannot finalize a session in status ${session.status} — it must be SUBMITTED first.`,
      );
    }
    // A session with no practical/essay rows has nothing to finalize — its MCQ
    // written section was already auto-graded at submit (legacy MCQ-only L3).
    // L3-with-practicals (L3_PRACTICALS_ENABLED) DOES create practical rows and
    // flows through the same AI-prescore → expert-finalize path as L1/L2.
    if (session.essayAnswers.length === 0) {
      throw new BadRequestException(
        'This session has no practical section to finalize — it was auto-graded at submit time.',
      );
    }

    const isAdmin = actorRoles.some((r) =>
      r === 'SUPER_ADMIN' || r === 'GRADING_ADMIN' || r === 'EXAM_ADMIN',
    );
    await this.assertWithinCertScope(actorId, actorRoles, session.certType);

    // ── Guardrail 0a (AXIS-H): severity-ladder escalation ───────────────────
    // A HIGH/CRITICAL medical risk flag (진단·치료·처방·환자정보) is 불합격 검토
    // territory: only a GRADING_ADMIN (or SUPER_ADMIN) may finalize — not the
    // assigned expert, and not an EXAM_ADMIN.
    const isGradingAdmin = actorRoles.some(
      (r) => r === 'SUPER_ADMIN' || r === 'GRADING_ADMIN',
    );
    if (
      session.certType === CertType.AXIS_H &&
      !isGradingAdmin &&
      anyAnswerEscalated(session.essayAnswers)
    ) {
      throw new ForbiddenException(
        'This AXIS-H session carries a HIGH/CRITICAL medical risk flag (불합격 검토). ' +
          'Only a GRADING_ADMIN may finalize it.',
      );
    }

    // ── Guardrail 0 (L3): auto-finalize territory ────────────────────────────
    // L3-with-practicals auto-finalizes on submit when the AI is confident
    // (mandatoryReview=false). A manual finalize is therefore only allowed when
    // the session genuinely needs review (mandatoryReview=true) or an admin
    // overrides — otherwise an expert could re-open a confident, auto-graded L3.
    if (session.level === CertLevel.L3 && !session.mandatoryReview && !isAdmin) {
      throw new ForbiddenException(
        'This L3 session did not require expert review (auto-graded on submit). ' +
          'Only a grading admin can manually finalize it.',
      );
    }

    // ── Guardrail 1: assignment enforcement ──────────────────────────────────
    // If an expert is assigned, only that expert (or an admin) may finalize.
    const effectiveAssignee = await this.claimSessionIfUnassigned(
      session.id,
      session.level,
      session.assignedExpertId,
      isAdmin ? undefined : { id: actorId, roles: actorRoles },
    );
    if (!isAdmin && effectiveAssignee && effectiveAssignee !== actorId) {
      throw new ForbiddenException(
        'This session is assigned to a different expert. Only the assigned expert or an admin may finalize it.',
      );
    }

    // ── Guardrail 2: mandatory-review block ──────────────────────────────────
    // If AI prescore is required but hasn't completed for at least one task, block.
    if (session.mandatoryReview) {
      const unscored = session.essayAnswers.filter((a) => a.aiPreScore == null);
      if (unscored.length > 0) {
        throw new BadRequestException(
          `AI prescore must complete before this session can be finalized. ` +
            `${unscored.length} task(s) have not been AI-scored yet. ` +
            'Run AI prescore first, or have a GRADING_ADMIN override by re-running prescore.',
        );
      }
    }

    // ── Guardrail 3: two-rater calibration ──────────────────────────────────
    // If a FIRST-round record already exists from a DIFFERENT rater, this actor
    // is the second rater. Create SECOND-round records and check agreement.
    const firstRoundRecords = await this.prisma.expertScoringRecord.findMany({
      where: { sessionId, scoringRound: ScoringRound.FIRST },
    });
    const firstRaterIds = new Set(firstRoundRecords.map((r) => r.raterId));
    const isSecondRater = firstRaterIds.size > 0 && !firstRaterIds.has(actorId);

    if (isSecondRater) {
      // Compute per-task delta between first and second rater
      const firstByTask = new Map(firstRoundRecords.map((r) => [r.taskId, r.total]));
      const scoreByTask = new Map(dto.tasks.map((t) => [t.taskId, t.expertScore]));

      let calibrationFailed = false;
      for (const [taskId, firstScore] of firstByTask) {
        const secondScore = scoreByTask.get(taskId);
        if (secondScore == null) continue;
        if (Math.abs(firstScore - secondScore) > GRADING_CONFIG.CALIBRATION_FLOOR_POINTS) {
          calibrationFailed = true;
          break;
        }
      }

      if (calibrationFailed && !isAdmin) {
        throw new ConflictException(
          'Score calibration required — rater scores differ by more than the allowed threshold ' +
            `(${GRADING_CONFIG.CALIBRATION_FLOOR_POINTS} points). ` +
            'A GRADING_ADMIN must adjudicate and issue the final score.',
        );
      }
    }

    // Scope to the tasks actually assigned to this session (frozen at paper-start
    // as EssayAnswer rows). Loading all cert+level tasks would inflate the
    // denominator — e.g. AXIS L2 has 12 tasks in the bank (4 sets × 3) but each
    // session only gets 3. Using all 12 would cap practical % at 25% for a
    // perfect score, which is wrong.
    const sessionTaskIds = session.essayAnswers.map((e) => e.taskId);
    const tasks = sessionTaskIds.length
      ? await this.prisma.taskTemplate.findMany({
          where: { id: { in: sessionTaskIds } },
          orderBy: [{ part: 'asc' }, { orderIndex: 'asc' }],
        })
      : [];
    if (tasks.length === 0) {
      throw new BadRequestException(
        'No practical tasks found for this session — cannot finalize. Confirm the exam was started correctly.',
      );
    }
    const taskById = new Map(tasks.map((t) => [t.id, t]));

    // Validate every submitted score is for a task that was in this session's paper,
    // and that no expert awarded more points than the task is worth.
    for (const t of dto.tasks) {
      const tpl = taskById.get(t.taskId);
      if (!tpl) {
        throw new BadRequestException(`Task ${t.taskId} was not part of this session's paper.`);
      }
      if (t.expertScore > tpl.points) {
        throw new BadRequestException(
          `Score for task "${tpl.title}" exceeds task points (${t.expertScore} > ${tpl.points}).`,
        );
      }
    }
    const scoreByTask = new Map(dto.tasks.map((t) => [t.taskId, t]));

    const timing = getTiming(session.certType, session.level);

    // Per-part section percentages. WRITTEN comes from the MCQ auto-score; each
    // practical part (PRACTICAL / DELIVERABLE / ESSAY) is summed independently
    // from its expert-scored tasks. Tasks without a submitted score count as 0.
    const writtenPct = session.writtenScore ?? 0;
    const partAgg = new Map<ExamPart, { earned: number; total: number }>();
    for (const t of tasks) {
      const agg = partAgg.get(t.part) ?? { earned: 0, total: 0 };
      agg.total += t.points;
      agg.earned += scoreByTask.get(t.id)?.expertScore ?? 0;
      partAgg.set(t.part, agg);
    }
    const sectionPct = (part: ExamPart): number => {
      if (part === ExamPart.WRITTEN) return writtenPct;
      const agg = partAgg.get(part);
      return agg && agg.total > 0 ? Math.round((agg.earned / agg.total) * 100) : 0;
    };

    // Combined practical % across every non-written task — stored on the
    // session for display continuity (result page's practicalScore field).
    let practicalEarned = 0;
    let practicalTotal = 0;
    for (const t of tasks) {
      practicalTotal += t.points;
      practicalEarned += scoreByTask.get(t.id)?.expertScore ?? 0;
    }
    const practicalPct =
      practicalTotal > 0 ? Math.round((practicalEarned / practicalTotal) * 100) : 0;

    // Weighted 100-point total + section floors (spec §4-4). Pass requires the
    // total to clear passTotal AND every section to clear its floor (과락).
    const scoring = getScoring(session.certType, session.level);
    const { total: totalScore, passed, floorFailures } = computeWeightedResult(
      scoring,
      sectionPct,
    );

    const failReasonAuto = (() => {
      if (passed) return null;
      const parts: string[] = floorFailures.map(
        (part) => `${part} below section minimum (${sectionPct(part)}%).`,
      );
      if (totalScore < scoring.passTotal) {
        parts.push(`Total below ${scoring.passTotal} (${totalScore}/100).`);
      }
      return parts.join(' ');
    })();
    const failReason = passed ? null : dto.failReason ?? failReasonAuto;

    await this.prisma.$transaction(async (tx) => {
      for (const t of dto.tasks) {
        const tpl = taskById.get(t.taskId)!;
        const existing = await tx.essayAnswer.findUnique({
          where: { sessionId_taskId: { sessionId, taskId: t.taskId } },
        });
        if (existing) {
          await tx.essayAnswer.update({
            where: { id: existing.id },
            data: {
              expertScore: t.expertScore,
              expertNotes: this.mergedExpertNotes(
                existing.expertNotes,
                t.expertNotes,
                t.deliverableReview,
              ),
              earnedPoints: t.expertScore,
            },
          });
        } else {
          // Candidate skipped this task entirely; create a placeholder row so
          // downstream queries (ResultsService, AdminGradingService.listQueue)
          // see a complete picture.
          await tx.essayAnswer.create({
            data: {
              sessionId,
              taskId: t.taskId,
              part: tpl.part,
              contentText: '',
              version: 1,
              expertScore: t.expertScore,
              expertNotes: this.mergedExpertNotes(null, t.expertNotes, t.deliverableReview),
              earnedPoints: t.expertScore,
              aiRationale: 'No submission — scored by expert.',
            },
          });
        }
      }

      // Replace placeholder practical grading rows with the real numbers so
      // the candidate's result page breakdown shows the expert's scoring.
      await tx.gradingResult.deleteMany({
        where: {
          sessionId,
          part: { in: [ExamPart.PRACTICAL, ExamPart.DELIVERABLE, ExamPart.ESSAY] },
        },
      });
      const practicalRows: Prisma.GradingResultCreateManyInput[] = tasks.map((t, idx) => {
        const earned = scoreByTask.get(t.id)?.expertScore ?? 0;
        const pct = t.points > 0 ? Math.round((earned / t.points) * 100) : 0;
        return {
          sessionId,
          part: t.part,
          subjectIndex: idx,
          subjectName: t.title,
          earned,
          total: t.points,
          percentage: pct,
          subjectFailed: pct < timing.subjectFailPct,
        };
      });
      if (practicalRows.length > 0) {
        await tx.gradingResult.createMany({ data: practicalRows });
      }

      await tx.examSession.update({
        where: { id: sessionId },
        data: {
          status: ExamSessionStatus.GRADED,
          practicalScore: practicalPct,
          totalScore,
          passed,
          failReason,
          submittedAt: session.submittedAt ?? new Date(),
        },
      });

      // Persist the expert's scoring as an auditable per-task record.
      // `boundary` flags a result within ±BOUNDARY_BAND_PCT of the pass line.
      const boundary = Math.abs(totalScore - scoring.passTotal) <= GRADING_CONFIG.BOUNDARY_BAND_PCT;
      // Determine the scoring round for this actor:
      //   - No prior records → FIRST
      //   - Prior records from a different rater → SECOND
      //   - Admin finalizing over a dispute → ADJUST
      const scoringRound =
        firstRoundRecords.length === 0
          ? ScoringRound.FIRST
          : isSecondRater
            ? ScoringRound.SECOND
            : ScoringRound.ADJUST;
      for (const t of dto.tasks) {
        const tpl = taskById.get(t.taskId)!;
        await tx.expertScoringRecord.create({
          data: {
            sessionId,
            taskId: t.taskId,
            raterId: actorId,
            scoringRound,
            criterionScores: { taskTitle: tpl.title, score: t.expertScore, maxPoints: tpl.points },
            total: t.expertScore,
            confidenceComment: t.expertNotes ?? null,
            adjudicationRequired: boundary,
            finalDecision: passed ? 'pass' : 'fail',
            finalAuthority: actorId,
          },
        });
      }
      await tx.auditLog.create({
        data: {
          actorId,
          action: 'SESSION_FINALIZED',
          entityType: 'ExamSession',
          entityId: sessionId,
          after: { writtenPct, practicalPct, totalScore, passed, boundary } as Prisma.InputJsonValue,
          reason: failReason,
        },
      });
    });

    let certificate: IssuedCertificate | null = null;
    if (passed) {
      try {
        certificate = await this.certificates.issueForSession(sessionId);
      } catch (err) {
        // Cert issuance failure must not roll back the grading — admin can
        // re-trigger by re-finalizing (idempotent) or via dashboard sync.
        this.logger.error(
          `Certificate issuance failed for session ${sessionId}: ${(err as Error).message}`,
        );
      }
    }

    this.logger.log(
      JSON.stringify({
        msg: 'session_finalized',
        actorId,
        sessionId,
        writtenScore: writtenPct,
        practicalScore: practicalPct,
        totalScore,
        passed,
        certNumber: certificate?.certNumber ?? null,
      }),
    );

    // Once the expert lands a pass/fail decision the candidate has either
    // cleared the bar (close the registration immediately even if attempts
    // remain — they don't need them) or burned an attempt (close if all 3
    // are now used up). Either path delegates to the shared helper so the
    // candidate path (GradingService.submit) and the proctor-termination
    // path stay in sync. Fire-and-forget — never roll back the finalize.
    void this.cbtSessions.closeRegistrationIfFinished(
      session.registrationId ?? null,
      sessionId,
      'finalize',
    );

    return {
      sessionId,
      status: ExamSessionStatus.GRADED,
      writtenScore: session.writtenScore,
      practicalScore: practicalPct,
      totalScore,
      passed,
      failReason,
      certificate,
    };
  }

  private derivePracticalState(
    s: {
      level: CertLevel;
      status: ExamSessionStatus;
      mandatoryReview: boolean;
      essayAnswers: { taskId: string; aiPreScore: number | null; expertScore: number | null }[];
    },
    pointsByTask: ReadonlyMap<string, number>,
  ): PracticalState {
    // No practical section (legacy MCQ-only L3) → auto-graded at submit.
    // L3-with-practicals has essay rows and flows through the AI/expert states.
    if (s.essayAnswers.length === 0) {
      return s.status === ExamSessionStatus.GRADED ? 'final' : 'auto';
    }
    const anyAi = s.essayAnswers.some((e) => e.aiPreScore != null);
    const anyExpert = s.essayAnswers.some((e) => e.expertScore != null);
    const allExpert = s.essayAnswers.every((e) => e.expertScore != null);
    // Expert raw points vs AI percentage — normalized inside isScoreDisputed.
    const disputed = s.essayAnswers.some((e) =>
      isScoreDisputed(e.expertScore, e.aiPreScore, pointsByTask.get(e.taskId)),
    );
    // GRADED is terminal. L3 can reach GRADED via auto-finalize WITHOUT expert
    // scores (AI-confident), so don't require allExpert for L3.
    if (s.status === ExamSessionStatus.GRADED && (allExpert || s.level === CertLevel.L3)) return 'final';
    if (disputed) return 'expert_disputed';
    if (anyExpert) return 'expert_reviewing';
    if (anyAi) return 'ai_graded';
    // Still flagged for mandatory review but no AI/expert scores yet → pending
    // review, not "auto done" (keeps it out of the auto_done queue tab).
    if (s.mandatoryReview) return 'ai_graded';
    return 'auto';
  }
}

export type _AdminGradingPrismaShape = Prisma.ExamSessionGetPayload<{
  include: {
    user: { select: { name: true } };
    essayAnswers: { select: { taskId: true; aiPreScore: true; expertScore: true } };
  };
}>;
