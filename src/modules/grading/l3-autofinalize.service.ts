import { Injectable, Logger } from '@nestjs/common';
import { DecisionStatus, ExamPart, ExamSessionStatus, Prisma, TaskTemplate } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import {
  computeWeightedResult,
  getScoring,
  getTiming,
  isV2OrLater,
  toSpecVersion,
} from '../cbtSessions/exam-spec';
import { CertificatesService } from '../certificates/certificates.service';
import { EssayGradingService } from './essay-grading.service';
import { SessionAggregateService } from './session-aggregate.service';

type SessionWithEssays = Prisma.ExamSessionGetPayload<{ include: { essayAnswers: true } }>;

/** Cap on how long submit waits for AI prescore before deferring L3 to the expert queue. */
const PRESCORE_TIMEOUT_MS = 10_000;

/**
 * POLICY FLAG — semantics depend on the session's exam-spec version:
 *
 *   v1.1 sessions (legacy): auto-finalize issues pass/fail and certificates
 *   with no human touch when the AI first pass is confident
 *   (mandatoryReview=false). Kept for in-flight sessions only.
 *
 *   v2.0 sessions: "auto-AGGREGATE to provisional" — a confident prescore
 *   fully aggregates and stages the result (scores + per-task grading rows)
 *   with decisionStatus=PROVISIONAL so admin confirmation is one click, but
 *   it NEVER issues a certificate or marks the session GRADED. The final
 *   decision is always locked by a human (개발자 통합명세서 v2.0:
 *   final_decision_owner = human_exam_admin_or_review_panel); certificates
 *   are issued only on CONFIRMED_PASS (AdminGradingService.confirmDecision).
 *
 * Set L3_AUTO_FINALIZE=false to skip staging and route every
 * L3-with-practicals session through the expert queue instead. Read at call
 * time so flipping the env var needs no restart.
 */
function isL3AutoFinalizeEnabled(): boolean {
  return (process.env.L3_AUTO_FINALIZE || 'true').toLowerCase() === 'true';
}

/**
 * L3-with-practicals prescore aggregation on submit.
 *
 * After the MCQ auto-grade, the submit path calls this to await the AI prescore
 * (timeout-safe). When the AI is confident (mandatoryReview=false) and every
 * practical task was scored:
 *   - v1.1 session → GRADED + certificate in the same request (legacy).
 *   - v2.0 session → scores staged, decisionStatus=PROVISIONAL, session stays
 *     SUBMITTED awaiting human confirmation.
 * Otherwise the session stays SUBMITTED for the expert queue and the
 * background prescore keeps running past the timeout.
 */
@Injectable()
export class L3AutoFinalizeService {
  private readonly logger = new Logger(L3AutoFinalizeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly essayGrading: EssayGradingService,
    private readonly certificates: CertificatesService,
    private readonly aggregates: SessionAggregateService,
  ) {}

  /** Returns true iff the session was auto-finalized/staged in this request. */
  async tryFinalizeOnSubmit(
    sessionId: string,
    tasks: TaskTemplate[],
    writtenPct: number,
  ): Promise<boolean> {
    if (!isL3AutoFinalizeEnabled()) {
      // Auto-finalize disabled by policy: run the AI prescore in the background
      // and leave the session SUBMITTED for the expert queue (same as L1/L2).
      void this.essayGrading
        .aiPrescoreSession(sessionId)
        .catch((err) =>
          this.logger.warn(`AI prescore failed for session ${sessionId}: ${(err as Error).message}`),
        );
      this.logger.log(
        JSON.stringify({ msg: 'l3_autofinalize_deferred', sessionId, reason: 'disabled_by_policy' }),
      );
      return false;
    }
    const outcome = await this.racePrescore(sessionId);
    if (outcome !== 'done') {
      this.logger.log(JSON.stringify({ msg: 'l3_autofinalize_deferred', sessionId, reason: outcome }));
      return false;
    }

    // Re-read now that prescore has written aiPreScore/earnedPoints + mandatoryReview.
    const session = await this.prisma.examSession.findUnique({
      where: { id: sessionId },
      include: { essayAnswers: true },
    });
    if (!session) return false;

    const allScored =
      session.essayAnswers.length > 0 && session.essayAnswers.every((a) => a.earnedPoints != null);
    if (session.mandatoryReview || !allScored) {
      this.logger.log(
        JSON.stringify({
          msg: 'l3_autofinalize_skipped',
          sessionId,
          mandatoryReview: session.mandatoryReview,
          allScored,
        }),
      );
      return false;
    }

    // v2.0+ stages PROVISIONAL (human locks the decision); only v1.1 takes the
    // legacy GRADED + auto-certificate path.
    if (isV2OrLater(toSpecVersion(session.specVersion))) {
      await this.stageProvisional(session, tasks, writtenPct);
    } else {
      await this.gradeGraded(session, tasks, writtenPct);
    }
    return true;
  }

  /** Await prescore, but never hold the submit response longer than the timeout. */
  private async racePrescore(sessionId: string): Promise<'done' | 'timeout' | 'error'> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), PRESCORE_TIMEOUT_MS);
    });
    // On timeout the prescore promise keeps running (it writes scores in the
    // background); the attached handlers prevent an unhandled rejection.
    const run = this.essayGrading
      .aiPrescoreSession(sessionId)
      .then<'done'>(() => 'done')
      .catch((err): 'error' => {
        this.logger.warn(`AI prescore failed for session ${sessionId}: ${(err as Error).message}`);
        return 'error';
      });
    const outcome = await Promise.race([run, timeout]);
    if (timer) clearTimeout(timer);
    return outcome;
  }

  /** Shared per-task aggregation used by both the legacy and v2.0 paths. */
  private aggregate(session: SessionWithEssays, tasks: TaskTemplate[], writtenPct: number) {
    const earnedByTask = new Map(session.essayAnswers.map((a) => [a.taskId, a.earnedPoints ?? 0]));
    let earned = 0;
    let total = 0;
    for (const t of tasks) {
      total += t.points;
      earned += earnedByTask.get(t.id) ?? 0;
    }
    const practicalPct = total > 0 ? Math.round((earned / total) * 100) : 0;
    const specVersion = toSpecVersion(session.specVersion);
    const scoring = getScoring(session.certType, session.level, specVersion);
    const sectionPct = (part: ExamPart): number =>
      part === ExamPart.WRITTEN ? writtenPct : practicalPct;
    const weighted = computeWeightedResult(scoring, sectionPct);
    const subjectFailPct = getTiming(session.certType, session.level, specVersion).subjectFailPct;
    const gradingRows: Prisma.GradingResultCreateManyInput[] = tasks.map((t, idx) => {
      const e = earnedByTask.get(t.id) ?? 0;
      const pct = t.points > 0 ? Math.round((e / t.points) * 100) : 0;
      return {
        sessionId: session.id, part: t.part, subjectIndex: idx, subjectName: t.title,
        earned: e, total: t.points, percentage: pct, subjectFailed: pct < subjectFailPct,
      };
    });
    return { earnedByTask, practicalPct, scoring, sectionPct, weighted, gradingRows };
  }

  /**
   * v2.0: aggregate and STAGE the result as provisional — scores + per-task
   * grading rows persisted, decisionStatus=PROVISIONAL — but do NOT mark
   * GRADED, do NOT set `passed`, and never issue a certificate here. The
   * admin confirm endpoint (bulk-confirmable for clean passes) locks the
   * decision and issues certificates.
   */
  private async stageProvisional(
    session: SessionWithEssays,
    tasks: TaskTemplate[],
    writtenPct: number,
  ): Promise<void> {
    const { practicalPct, weighted, gradingRows } = this.aggregate(session, tasks, writtenPct);

    await this.prisma.$transaction(async (tx) => {
      await tx.gradingResult.deleteMany({
        where: {
          sessionId: session.id,
          part: { in: [ExamPart.PRACTICAL, ExamPart.DELIVERABLE, ExamPart.ESSAY] },
        },
      });
      if (gradingRows.length) await tx.gradingResult.createMany({ data: gradingRows });
      await tx.examSession.update({
        where: { id: session.id },
        data: {
          practicalScore: practicalPct,
          totalScore: weighted.total,
          // passed stays null — final pass/fail exists only after human confirm.
          decisionStatus: DecisionStatus.PROVISIONAL,
          failReason: '채점 완료 — 관리자 확정 대기 중 (provisional).',
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: session.userId,
          action: 'L3_PROVISIONAL_STAGED',
          entityType: 'ExamSession',
          entityId: session.id,
          after: {
            writtenPct,
            practicalPct,
            totalScore: weighted.total,
            gateResults: weighted.gateResults,
            failedGates: weighted.failedGates,
          } as Prisma.InputJsonValue,
        },
      });
    });

    // WP7: staging refreshes the aggregate with the staged scores.
    this.aggregates.rebuildSafely(session.id, 'l3_provisional_staged');

    this.logger.log(
      JSON.stringify({
        msg: 'l3_provisional_staged',
        sessionId: session.id,
        writtenPct,
        practicalPct,
        totalScore: weighted.total,
        failedGates: weighted.failedGates,
      }),
    );
  }

  /** v1.1 legacy path: GRADED + certificate with no human touch. */
  private async gradeGraded(
    session: SessionWithEssays,
    tasks: TaskTemplate[],
    writtenPct: number,
  ): Promise<void> {
    const { practicalPct, scoring, sectionPct, weighted, gradingRows } = this.aggregate(
      session,
      tasks,
      writtenPct,
    );
    const { total: totalScore, passed, floorFailures } = weighted;
    const failReason = passed ? null : buildFailReason(scoring.passTotal, sectionPct, floorFailures, totalScore);

    await this.prisma.$transaction(async (tx) => {
      await tx.gradingResult.deleteMany({
        where: {
          sessionId: session.id,
          part: { in: [ExamPart.PRACTICAL, ExamPart.DELIVERABLE, ExamPart.ESSAY] },
        },
      });
      if (gradingRows.length) await tx.gradingResult.createMany({ data: gradingRows });
      await tx.examSession.update({
        where: { id: session.id },
        data: { status: ExamSessionStatus.GRADED, practicalScore: practicalPct, totalScore, passed, failReason },
      });
      await tx.auditLog.create({
        data: {
          actorId: session.userId,
          action: 'L3_AUTO_FINALIZED',
          entityType: 'ExamSession',
          entityId: session.id,
          after: { writtenPct, practicalPct, totalScore, passed } as Prisma.InputJsonValue,
        },
      });
    });

    if (passed) {
      await this.certificates
        .issueForSession(session.id)
        .catch((err) =>
          this.logger.error(`Certificate issuance failed for session ${session.id}: ${(err as Error).message}`),
        );
    }
    this.logger.log(
      JSON.stringify({ msg: 'l3_auto_finalized', sessionId: session.id, writtenPct, practicalPct, totalScore, passed }),
    );
  }
}

function buildFailReason(
  passTotal: number,
  sectionPct: (part: ExamPart) => number,
  floorFailures: ExamPart[],
  totalScore: number,
): string {
  const parts = floorFailures.map((p) => `${p} below section minimum (${sectionPct(p)}%).`);
  if (totalScore < passTotal) parts.push(`Total below ${passTotal} (${totalScore}/100).`);
  return parts.join(' ');
}
