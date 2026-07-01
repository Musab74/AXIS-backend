import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CertLevel, CertType, ExamSessionStatus, Prisma, ProctorEventType, RegistrationStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../common/prisma.service';
import { getTiming, getExamSpec, MAX_ATTEMPTS } from './exam-spec';
import { getBonusAttempts } from './registration-bonus-attempts';
import type { ConsentDto } from './cbt-sessions.dto';
import {
  AdminMonitorGateway,
  LAST_SCREEN_FRAME_KEY,
  LAST_WEBCAM_FRAME_KEY,
} from '../adminMonitor/admin-monitor.gateway';
import { MonitorHeartbeatService } from '../adminMonitor/monitor-heartbeat.service';
import { AdminNotificationsService } from '../adminNotifications/admin-notifications.service';
import { RedisService } from '../../integrations/redis/redis.service';
import { NcObjectStorageService } from '../../integrations/ncObjectStorage/nc-object-storage.service';
import { assertIdentityVerifiedForSession } from './exam-identity-guard';
import { assertRegistrationActiveForSession } from './registration-active-guard';

const ENTRY_WINDOW_BEFORE_MS = 30 * 60_000; // opens 30 min before exam start
const ENTRY_WINDOW_AFTER_MS = 10 * 60_000;  // closes 10 min after exam start

// For online exams, allow flexible entry (no time window restriction)
const ONLINE_VENUES = ['ONLINE_CBT', 'ONLINE', 'REMOTE'];

const FULLSCREEN_WARNING_THRESHOLD = 3;

/**
 * Strike weight per proctor event type — Article 28 termination at 3 strikes.
 *
 * Rationale (proctor v2 hybrid policy):
 *   • FULLSCREEN_EXIT, TAB_SWITCH, FACE_NOT_DETECTED, NO_FACE, GAZE_AWAY,
 *     EYES_CLOSED, MULTIPLE_FACES, IDENTITY_MISMATCH, PHONE_DETECTED → 1 strike
 *     (terminates on the 3rd offence — the standard rule).
 *   • WINDOW_BLUR, TAB_HIDDEN, BEFORE_UNLOAD → 2 strikes
 *     (terminates on the 2nd offence — Cmd+Tab, macOS Space-swipe, attempting
 *     to navigate away mid-exam are treated as more deliberate cheating
 *     attempts than briefly leaving fullscreen).
 *
 * Any event type NOT in this map is persisted for audit but does NOT advance
 * the strike counter. That covers AI_FLAG_SUSPICIOUS (suspected but not
 * confirmed by Claude), KEY_BLOCKED (informational), EXTERNAL_DISPLAY (the
 * client modal already blocks the exam UI on a second monitor), AUDIO_HIGH
 * (voice events use their own mic-strike system), etc.
 */
const STRIKE_WEIGHT_BY_TYPE: ReadonlyMap<ProctorEventType, number> = new Map([
  [ProctorEventType.FULLSCREEN_EXIT, 1],
  [ProctorEventType.TAB_SWITCH, 1],
  [ProctorEventType.FACE_NOT_DETECTED, 1],
  [ProctorEventType.NO_FACE, 1],
  [ProctorEventType.GAZE_AWAY, 1],
  [ProctorEventType.EYES_CLOSED, 1],
  [ProctorEventType.MULTIPLE_FACES, 1],
  [ProctorEventType.IDENTITY_MISMATCH, 1],
  [ProctorEventType.PHONE_DETECTED, 1],
  [ProctorEventType.AI_FLAG_CONFIRMED, 1],
  // Hybrid policy — leave-class events count double
  [ProctorEventType.WINDOW_BLUR, 2],
  [ProctorEventType.TAB_HIDDEN, 2],
  [ProctorEventType.BEFORE_UNLOAD, 2],
]);

const COUNTED_WARNING_TYPES: ReadonlySet<ProctorEventType> = new Set(
  STRIKE_WEIGHT_BY_TYPE.keys(),
);

/**
 * Heuristic events that should have the latest cached webcam + screen frame
 * attached as evidence so the admin "Cheating evidence" modal can render a
 * thumbnail per event. Includes two distinct flavors:
 *
 *   1. Webcam-meaningful heuristics — FACE_NOT_DETECTED, NO_FACE, GAZE_AWAY,
 *      EYES_CLOSED, MULTIPLE_FACES, IDENTITY_MISMATCH, PHONE_DETECTED. Here
 *      the webcam frame literally shows the violation (who/what the camera
 *      saw at the moment of the strike).
 *
 *   2. Page-leave events — FULLSCREEN_EXIT, TAB_SWITCH, WINDOW_BLUR,
 *      TAB_HIDDEN, BEFORE_UNLOAD. Here the proof is intentionally captured
 *      from BOTH sides: the webcam frame shows what the candidate was
 *      physically doing the instant they left the exam window (looking down
 *      at a phone, talking to someone off-frame, etc.), and the screen
 *      frame shows whatever was on their primary display at that moment
 *      (e.g. the destination they Ctrl/Cmd+Tabbed to). Without these
 *      thumbnails the admin sees only "FULLSCREEN_EXIT at 11:23:04" with
 *      no context — which is exactly what the user complained about.
 *
 * EXTERNAL_DISPLAY is deliberately still omitted: it's detected purely from
 * the OS screen-enumeration API on the client and the proof is in the
 * detection metadata, not anything happening on camera.
 */
const VISUAL_HEURISTIC_EVENTS: ReadonlySet<ProctorEventType> = new Set([
  ProctorEventType.FACE_NOT_DETECTED,
  ProctorEventType.NO_FACE,
  ProctorEventType.GAZE_AWAY,
  ProctorEventType.EYES_CLOSED,
  ProctorEventType.MULTIPLE_FACES,
  ProctorEventType.IDENTITY_MISMATCH,
  ProctorEventType.PHONE_DETECTED,
  // Page-leave class — capture webcam + screen at the moment of the leave.
  ProctorEventType.FULLSCREEN_EXIT,
  ProctorEventType.TAB_SWITCH,
  ProctorEventType.WINDOW_BLUR,
  ProctorEventType.TAB_HIDDEN,
  ProctorEventType.BEFORE_UNLOAD,
]);

const PROCTOR_EVENT_RETAIN_DAYS = 90;
const FRAME_AGE_HARD_CAP_MS = 60_000;

@Injectable()
export class CbtSessionsService {
  private readonly logger = new Logger(CbtSessionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly adminMonitor: AdminMonitorGateway,
    private readonly notifications: AdminNotificationsService,
    private readonly heartbeat: MonitorHeartbeatService,
    private readonly redis: RedisService,
    private readonly ncp: NcObjectStorageService,
    private readonly config: ConfigService,
  ) {}

  async create(userId: string, certType: CertType, level: CertLevel) {
    const lastAttempt = await this.prisma.examSession.findFirst({
      where: { userId, certType, level },
      orderBy: { attemptNo: 'desc' },
    });
    if ((lastAttempt?.attemptNo ?? 0) >= MAX_ATTEMPTS) {
      throw new BadRequestException(
        `Maximum ${MAX_ATTEMPTS} attempts reached for ${certType} ${level}. No further attempts are allowed.`,
      );
    }
    return this.prisma.examSession.create({
      data: {
        userId,
        certType,
        level,
        attemptNo: (lastAttempt?.attemptNo ?? 0) + 1,
        status: ExamSessionStatus.CREATED,
      },
    });
  }

  /**
   * Create (or resume) a session bound to a paid registration. Enforces:
   *   • registration belongs to user
   *   • registration is PAID (not pending / cancelled / refunded)
   *   • now is inside the entry window (T-30min … T+10min around examDate)
   * If a CREATED/IN_PROGRESS session already exists for this registration, return it
   * (and start it if still CREATED) — re-entry is supported as long as the deadline
   * hasn't passed.
   */
  async createFromRegistration(userId: string, registrationId: string) {
    const registration = await this.prisma.registration.findUnique({
      where: { id: registrationId },
      include: { schedule: true },
    });
    if (!registration) throw new NotFoundException('Registration not found');
    if (registration.userId !== userId) throw new ForbiddenException('Not your registration');
    if (registration.status !== RegistrationStatus.PAID) {
      // EXAM_COMPLETED carries a richer meaning than a raw "not PAID" — the
      // candidate either already passed or burned all 3 attempts. Show a
      // bilingual message that explains *why* they can't enter so support
      // tickets land with the right expectation.
      if (registration.status === RegistrationStatus.EXAM_COMPLETED) {
        throw new ConflictException(
          '이 결제 건은 이미 시험이 종료되었습니다 (합격 또는 응시 횟수 소진). 추가 응시를 원하시면 다시 신청해 주세요. ' +
            '(This registration is already closed — either you passed or used all 3 attempts. Please purchase a new one to retake.)',
        );
      }
      throw new ConflictException(
        `Cannot enter — registration is ${registration.status}. Payment must be confirmed.`,
      );
    }

    // AXIS-C L1 eligibility gate — real exam requires explicit admin/expert
    // APPROVED. AXIS L1 and AXIS-H L1 are unaffected (NOT_REQUIRED by default).
    // Demo exam flow uses a separate entry path and is never gated here.
    if (
      registration.certType === CertType.AXIS_C &&
      registration.level === CertLevel.L1 &&
      registration.eligibilityStatus !== 'APPROVED'
    ) {
      throw new ConflictException(
        registration.eligibilityStatus === 'REJECTED'
          ? '응시자격 서류가 반려되었습니다. 마이페이지에서 서류를 다시 제출해 주세요. (AXIS-C L1 eligibility document was rejected — please re-submit.)'
          : registration.eligibilityStatus === 'PENDING'
            ? '응시자격 서류 승인 대기 중입니다. 승인 전까지는 데모만 응시할 수 있습니다. (AXIS-C L1 eligibility pending review — only the demo is available until approved.)'
            : '응시자격 서류를 제출하고 승인을 받아야 합니다. (AXIS-C L1 requires an approved eligibility document before the real exam.)',
      );
    }

    // Check exam deadline (must complete exam within configured days after payment)
    if (registration.examDeadline && new Date() > registration.examDeadline) {
      throw new BadRequestException(
        `시험 응시 기한이 만료되었습니다. 결제 후 정해진 기간 내에 응시해야 합니다. (만료일: ${registration.examDeadline.toISOString().split('T')[0]})`,
      );
    }

    // For online exams, allow flexible entry (no time window restriction)
    const isOnlineExam = ONLINE_VENUES.includes(registration.schedule.venue);
    
    if (!isOnlineExam) {
      // Physical venue exams have strict entry windows
      const examMs = registration.schedule.examDate.getTime();
      const now = Date.now();
      if (now < examMs - ENTRY_WINDOW_BEFORE_MS) {
        throw new BadRequestException(
          `Entry opens 30 minutes before exam start (${registration.schedule.examDate.toISOString()}).`,
        );
      }
      if (now > examMs + ENTRY_WINDOW_AFTER_MS) {
        throw new BadRequestException('Entry window has closed — exam started more than 10 minutes ago.');
      }
    }
    // Online exams: can start anytime after payment is confirmed

    // Reuse an existing open session, otherwise create a new one
    const existing = await this.prisma.examSession.findFirst({
      where: {
        userId,
        registrationId,
        status: { in: [ExamSessionStatus.CREATED, ExamSessionStatus.IN_PROGRESS] },
      },
      orderBy: { createdAt: 'desc' },
    });

    let session = existing;
    if (!session) {
      // Attempts are scoped to THIS paid registration — each purchase grants
      // its own MAX_ATTEMPTS bucket. Re-buying the same cert+level (a new
      // Registration row) gives the candidate a fresh 3 attempts. Previously
      // we scoped by (userId, certType, level), which permanently capped a
      // user at 3 attempts ever per cert+level even after paying again.
      const lastAttempt = await this.prisma.examSession.findFirst({
        where: { userId, registrationId },
        orderBy: { attemptNo: 'desc' },
      });
      const bonus = await getBonusAttempts(this.redis, registrationId);
      const maxAllowed = MAX_ATTEMPTS + bonus;
      if ((lastAttempt?.attemptNo ?? 0) >= maxAllowed) {
        throw new BadRequestException(
          `이 결제 건에 허용된 최대 ${maxAllowed}회 응시를 모두 사용하셨습니다. 추가 응시를 원하시면 다시 신청해 주세요. ` +
          `(Maximum ${maxAllowed} attempts reached for this paid registration. Please purchase another to continue.)`,
        );
      }
      session = await this.prisma.examSession.create({
        data: {
          userId,
          registrationId,
          certType: registration.certType,
          level: registration.level,
          attemptNo: (lastAttempt?.attemptNo ?? 0) + 1,
          status: ExamSessionStatus.CREATED,
        },
      });
    }

    if (
      session.status === ExamSessionStatus.CREATED &&
      (await this.hasRequiredConsents(userId, session.id))
    ) {
      return this.start(userId, session.id);
    }
    // Awaiting consent — let the client present the consent UI then call
    // POST /cbt/sessions/:id/consent followed by POST /cbt/sessions/:id/start.
    return session;
  }

  async listMine(userId: string) {
    return this.prisma.examSession.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  async getOwned(userId: string, sessionId: string) {
    const s = await this.prisma.examSession.findUnique({ where: { id: sessionId } });
    if (!s) throw new NotFoundException('Session not found');
    if (s.userId !== userId) throw new ForbiddenException('Not your session');
    return s;
  }

  /**
   * Record exam-rules consent + AI-review consent. Both are mandatory; the
   * DTO already enforces booleans must be `true`. Writes a ConsentLog row and
   * stamps the session — `start()` rejects until both stamps are present.
   */
  async recordConsent(
    userId: string,
    sessionId: string,
    _dto: ConsentDto,
    meta: { ip: string | null; userAgent: string | null },
  ) {
    const session = await this.getOwned(userId, sessionId);
    if (session.status !== ExamSessionStatus.CREATED) {
      throw new ConflictException(
        `Cannot consent on a session in status ${session.status}`,
      );
    }
    // ConsentLog schema only stores: userId, consentType, agreed, ipAddress,
    // userAgent, consentedAt. We tag the consentType with the session id so
    // start() can later verify a fresh consent exists for THIS session
    // without requiring a sessionId column on the table.
    const now = new Date();
    await this.prisma.consentLog.createMany({
      data: [
        {
          userId,
          consentType: `EXAM_RULES:${sessionId}`,
          agreed: true,
          ipAddress: meta.ip ?? undefined,
          userAgent: meta.userAgent ?? undefined,
          consentedAt: now,
        },
        {
          userId,
          consentType: `AI_REVIEW:${sessionId}`,
          agreed: true,
          ipAddress: meta.ip ?? undefined,
          userAgent: meta.userAgent ?? undefined,
          consentedAt: now,
        },
      ],
    });
    return {
      sessionId,
      rulesConsentAt: now,
      aiReviewConsentAt: now,
    };
  }

  /**
   * Returns true when both the EXAM_RULES and AI_REVIEW consent rows have been
   * recorded for this session. Source of truth is the ConsentLog table since
   * the ExamSession model does not carry consent timestamps.
   */
  private async hasRequiredConsents(userId: string, sessionId: string): Promise<boolean> {
    const rows = await this.prisma.consentLog.findMany({
      where: {
        userId,
        agreed: true,
        consentType: { in: [`EXAM_RULES:${sessionId}`, `AI_REVIEW:${sessionId}`] },
      },
      select: { consentType: true },
    });
    const types = new Set(rows.map((r) => r.consentType));
    return types.has(`EXAM_RULES:${sessionId}`) && types.has(`AI_REVIEW:${sessionId}`);
  }

  async start(userId: string, sessionId: string) {
    const s = await this.getOwned(userId, sessionId);
    if (s.status !== ExamSessionStatus.CREATED) {
      if (s.status === ExamSessionStatus.IN_PROGRESS) return s;
      throw new BadRequestException(`Cannot start a session in status ${s.status}`);
    }
    await assertRegistrationActiveForSession(this.prisma, s.registrationId);
    if (!(await this.hasRequiredConsents(userId, sessionId))) {
      throw new BadRequestException(
        'AI 감독 동의가 필요합니다. 시험을 시작하기 전에 동의해주세요.',
      );
    }

    await assertIdentityVerifiedForSession(
      this.prisma,
      this.skipIdentityCheck(),
      userId,
      sessionId,
    );

    const seed = randomUUID();
    const timing = getTiming(s.certType, s.level);
    const startedAt = new Date();
    const hardDeadline = new Date(startedAt.getTime() + timing.totalMinutes * 60_000);

    const updated = await this.prisma.$transaction(async (tx) => {
      const examSpec = getExamSpec(s.certType, s.level);
      
      // Load all questions grouped by subject
      const allQuestions = await tx.questionBank.findMany({
        where: {
          certType: s.certType,
          level: s.level,
          active: true,
        },
        orderBy: [{ subjectIndex: 'asc' }, { id: 'asc' }],
      });
      
      if (allQuestions.length === 0) {
        throw new BadRequestException('Question bank empty for this exam — run db:seed:questions first.');
      }
      
      // Select questions respecting subject distribution
      let selectedQuestions: typeof allQuestions = [];
      
      if (examSpec.subjectDistribution) {
        // Group questions by subject
        const bySubject = new Map<number, typeof allQuestions>();
        for (const q of allQuestions) {
          const list = bySubject.get(q.subjectIndex) ?? [];
          list.push(q);
          bySubject.set(q.subjectIndex, list);
        }
        
        // Select required count from each subject
        for (const [subjectIndex, count] of Object.entries(examSpec.subjectDistribution)) {
          const subjectQuestions = bySubject.get(Number(subjectIndex)) ?? [];
          const shuffledSubject = shuffleWithSeed(subjectQuestions, seed + subjectIndex);
          selectedQuestions.push(...shuffledSubject.slice(0, count));
        }
      } else {
        // Fallback: random selection from entire pool
        const shuffled = shuffleWithSeed(allQuestions, seed);
        selectedQuestions = shuffled.slice(0, examSpec.writtenQuestionCount);
      }
      
      // Final shuffle of all selected questions
      const finalQuestions = shuffleWithSeed(selectedQuestions, seed);
      
      await tx.answer.createMany({
        data: finalQuestions.map((q, i) => {
          const originalChoices = (q.choices as unknown as Choice[]) ?? [];
          // Shuffle the 4 options per-session (so the correct answer isn't always
          // in the same position), unless the question is explicitly exempt
          // (e.g. "모두 옳다" / "정답 없음" style options that must keep order).
          const shouldShuffle = originalChoices.length === 4 && !q.shuffleExempt;
          
          let finalChoices: Choice[];
          let correctAnswerKey: string;
          
          if (shouldShuffle) {
            const { shuffled, correctKey } = shuffleChoicesWithMapping(
              originalChoices, 
              q.correctAnswer ?? 'A', 
              seed + q.id
            );
            finalChoices = shuffled;
            correctAnswerKey = correctKey;
          } else {
            finalChoices = originalChoices;
            correctAnswerKey = q.correctAnswer ?? 'A';
          }
          
          return {
            sessionId,
            questionId: q.id,
            qVersion: q.qVersion,
            contentSnapshot: { 
              stem: q.stem, 
              choices: finalChoices,
              subjectName: q.subjectName, 
              points: q.points,
              correctAnswerKey,
            } as unknown as Prisma.InputJsonValue,
            orderIndex: i,
          };
        }),
      });

      // ── Practical (실기) section ──────────────────────────────────────────
      // L1/L2 add a practical part after the written MCQs. Mirror the MCQ flow:
      // pick ONE coherent task set (so a scenario's Part A/B/C stay together),
      // then pre-create one EssayAnswer row per task — the practical analogue of
      // the pre-created Answer rows. getPaper/grading both read the session's
      // selected set from these rows (never the full task bank).
      if (examSpec.practicalTaskCount > 0) {
        const allTasks = await tx.taskTemplate.findMany({
          where: { certType: s.certType, level: s.level },
          orderBy: [{ setNo: 'asc' }, { orderIndex: 'asc' }],
        });

        let chosenTasks: typeof allTasks = [];

        if (s.level === 'L3') {
          // L3 운영기획서: 4 실습형 must be one-per-type (현업적용·지시설계·
          // 분석검증·리스크판단). Stratify by `taskType` and pick a different
          // task per type using a type-scoped seed so two candidates in the
          // same round don't always get the same 4 items.
          const byType = new Map<string, typeof allTasks>();
          for (const t of allTasks) {
            if (!t.taskType) continue;
            const key = t.taskType;
            const list = byType.get(key) ?? [];
            list.push(t);
            byType.set(key, list);
          }
          const wantedTypes = ['현업적용형', '지시설계형', '분석검증형', '리스크판단형'];
          for (const type of wantedTypes) {
            const pool = byType.get(type);
            if (pool && pool.length > 0) {
              const pick = shuffleWithSeed(pool, `${seed}:practical:${type}`)[0];
              chosenTasks.push(pick);
            }
          }
          // Defensive fallback: if any type was missing from the DB (e.g. flag
          // was flipped before seeding finished), back-fill with whatever we
          // have so the candidate still gets practicalTaskCount tasks rather
          // than an empty practical section.
          if (chosenTasks.length < examSpec.practicalTaskCount) {
            const chosenIds = new Set(chosenTasks.map((t) => t.id));
            const remaining = allTasks.filter((t) => !chosenIds.has(t.id));
            const filler = shuffleWithSeed(remaining, `${seed}:practical:filler`).slice(
              0,
              examSpec.practicalTaskCount - chosenTasks.length,
            );
            chosenTasks.push(...filler);
          }
        } else {
          // L1/L2 path — pick ONE coherent task set so a scenario's Part A/B/C
          // stay together; preserves the existing behaviour exactly.
          const bySet = new Map<number, typeof allTasks>();
          for (const t of allTasks) {
            const key = t.setNo ?? 0;
            const group = bySet.get(key) ?? [];
            group.push(t);
            bySet.set(key, group);
          }
          const sets = Array.from(bySet.values()).filter((g) => g.length > 0);
          if (sets.length > 0) {
            const chosenSet = shuffleWithSeed(sets, `${seed}:practical`)[0];
            chosenTasks = [...chosenSet]
              .sort((a, b) => a.orderIndex - b.orderIndex)
              .slice(0, examSpec.practicalTaskCount);
          }
        }

        if (chosenTasks.length > 0) {
          await tx.essayAnswer.createMany({
            data: chosenTasks.map((t) => ({
              sessionId,
              taskId: t.id,
              part: t.part,
              contentText: '',
              version: 0,
              aiPreScore: null,
              aiRationale: 'Pending review.',
            })),
          });
        }
      }

      return tx.examSession.update({
        where: { id: sessionId },
        data: { status: ExamSessionStatus.IN_PROGRESS, paperSeed: seed, startedAt, hardDeadline },
      });
    });

    const candidate = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { name: true },
    });
    const examName = `${updated.certType.replace('_', '-')} ${updated.level}`;
    void this.adminMonitor.emitSessionUpdate({
      sessionId: updated.id,
      status: 'normal',
      progressPct: 0,
      warnings: 0,
      candidateName: candidate?.name ?? 'Unknown',
      examName,
    });
    void this.adminMonitor.broadcastLiveStatus();
    void this.notifications.notify({
      category: 'EXAM_START',
      titleKo: '시험 시작',
      titleEn: 'Exam started',
      bodyKo: `${candidate?.name ?? '응시자'}님이 ${examName} 시험을 시작했습니다.`,
      bodyEn: `${candidate?.name ?? 'Candidate'} started the ${examName} exam.`,
      severity: 'INFO',
      href: '/monitoring',
      meta: { sessionId: updated.id },
    });
    return updated;
  }

  /**
   * Record a proctor behavior event (fullscreen-exit, tab-hidden, etc.).
   * For warning-class events (FULLSCREEN_EXIT) the session's `proctorWarnings`
   * counter is incremented; reaching the 3rd strike force-terminates the session
   * (Article 28 — see CLAUDE.md §8). Non-counted types are still persisted as
   * evidence but do not advance the strike counter.
   */
  async recordProctorEvent(
    userId: string,
    sessionId: string,
    type: ProctorEventType,
    detail?: Record<string, unknown>,
    frames?: { webcamFrameBase64?: string; screenFrameBase64?: string },
  ) {
    return this.recordProctorEventInternal({
      sessionId,
      type,
      detail,
      source: 'CLIENT',
      requireUserId: userId,
      frames,
    });
  }

  /**
   * Server-side entry point — used by `AiProctorService` when Gemini/Claude
   * confirms a phone (or other counted offence) and we need the strike counter
   * to advance. No `userId` check because the actor is the server, not the
   * candidate. The audit row's `metadata.source` distinguishes 'SERVER' from
   * 'CLIENT' for downstream querying.
   */
  async recordSystemProctorEvent(
    sessionId: string,
    type: ProctorEventType,
    detail?: Record<string, unknown>,
  ) {
    return this.recordProctorEventInternal({
      sessionId,
      type,
      detail,
      source: 'SERVER',
      requireUserId: null,
    });
  }

  private async recordProctorEventInternal(opts: {
    sessionId: string;
    type: ProctorEventType;
    detail: Record<string, unknown> | undefined;
    source: 'CLIENT' | 'SERVER';
    requireUserId: string | null;
    frames?: { webcamFrameBase64?: string; screenFrameBase64?: string };
  }) {
    const { sessionId, type, detail, source, requireUserId, frames } = opts;
    void this.heartbeat.markAlive(sessionId);
    const result = await this.prisma.$transaction(async (tx) => {
      const session = await tx.examSession.findUnique({ where: { id: sessionId } });
      if (!session) throw new NotFoundException('Session not found');
      if (requireUserId !== null && session.userId !== requireUserId) {
        throw new ForbiddenException('Not your session');
      }

      const created = await tx.proctoringEvent.create({
        data: {
          sessionId,
          eventType: type,
          metadata: (detail
            ? { ...detail, source }
            : { source }) as Prisma.InputJsonValue,
        },
      });

      const weight = STRIKE_WEIGHT_BY_TYPE.get(type) ?? 0;
      if (weight === 0 || session.status !== ExamSessionStatus.IN_PROGRESS) {
        return {
          eventId: created.id,
          type,
          warningCount: session.proctorWarnings,
          threshold: FULLSCREEN_WARNING_THRESHOLD,
          terminated: session.status === ExamSessionStatus.TERMINATED,
          status: session.status,
          action: session.proctorWarnings >= 2 ? 'ADMIN_ALERTED' : 'WARNING',
        };
      }

      const newCount = session.proctorWarnings + weight;
      const shouldTerminate = newCount >= FULLSCREEN_WARNING_THRESHOLD;
      const updated = await tx.examSession.update({
        where: { id: sessionId },
        data: {
          proctorWarnings: newCount,
          ...(shouldTerminate
            ? {
                status: ExamSessionStatus.TERMINATED,
                submittedAt: new Date(),
                failReason: `Forced termination — ${FULLSCREEN_WARNING_THRESHOLD} proctor warnings reached (Article 28). Final violation: ${type}.`,
              }
            : {}),
        },
      });

      if (newCount >= 2) {
        const examName = `${updated.certType.replace('_', '-')} ${updated.level}`;
        void this.adminMonitor.emitSessionUpdate({
          sessionId: updated.id,
          status: shouldTerminate ? 'terminated' : 'warning',
          progressPct: 0,
          warnings: newCount,
          candidateName: '',
          examName,
        });
        void this.notifications.notify({
          category: 'CHEATING',
          titleKo: shouldTerminate ? '시험 강제 종료' : '부정행위 경고',
          titleEn: shouldTerminate ? 'Exam force-terminated' : 'Cheating warning',
          bodyKo: shouldTerminate
            ? `${examName} — ${newCount}회 경고 누적으로 시험이 강제 종료되었습니다. (${type})`
            : `${examName} — ${newCount}회 경고가 누적되었습니다. (${type})`,
          bodyEn: shouldTerminate
            ? `${examName} — exam force-terminated after ${newCount} warnings (${type}).`
            : `${examName} — ${newCount} warning(s) accumulated (${type}).`,
          severity: shouldTerminate ? 'HIGH' : 'MEDIUM',
          href: '/monitoring',
          meta: { sessionId: updated.id, eventType: type, warnings: newCount },
        });
      }
      if (shouldTerminate) {
        // Clear the in-memory heartbeat so the sweeper doesn't keep treating
        // this session as a candidate for disconnect detection.
        void this.heartbeat.clear(updated.id);
      }

      return {
        eventId: created.id,
        type,
        warningCount: updated.proctorWarnings,
        threshold: FULLSCREEN_WARNING_THRESHOLD,
        terminated: shouldTerminate,
        status: updated.status,
        action: shouldTerminate ? 'TERMINATED' : newCount >= 2 ? 'ADMIN_ALERTED' : 'WARNING',
      };
    });

    // After the strike-counter transaction commits, asynchronously enrich
    // the just-created proctoringEvent row with cached webcam + screen frames
    // so the admin "Cheating evidence" modal has thumbnails for face/eye/
    // identity/phone heuristics. The frame cache is populated by the live
    // monitor (webcam-thumb / screen-thumb endpoints) every 3s during the
    // exam, so a freshly fired GAZE_AWAY event has a frame waiting in
    // Redis. Fire-and-forget — never block the candidate response on this.
    if (result.eventId) {
      const hasClientFrame = !!(frames?.webcamFrameBase64 || frames?.screenFrameBase64);
      if (hasClientFrame) {
        // Capture-on-violation: the client sent the exact frame(s) at the
        // moment of the offence — attach them directly, for ANY event type
        // (incl. EXTERNAL_DISPLAY / AUDIO_HIGH), independent of live monitoring.
        void this.attachClientFramesToEvent(sessionId, result.eventId, frames!);
      } else if (VISUAL_HEURISTIC_EVENTS.has(type)) {
        // Fallback for older clients: attach the latest live-monitor frame.
        void this.attachCachedFramesToEvent(sessionId, result.eventId, type, detail);
      }
    }

    // If this strike forced a TERMINATED transition the candidate just used
    // up an attempt of their paid registration. Re-evaluate whether the
    // registration as a whole is now finished (3 attempts used or any prior
    // session passed) and flip to EXAM_COMPLETED if so. Fire-and-forget so
    // a stuck DB query can never delay the candidate's strike response.
    if (result.terminated) {
      void this.closeRegistrationIfFinished(null, sessionId, 'strike-threshold');
    }

    // Strip the internal eventId before returning to the controller — the
    // public response shape is unchanged from before the evidence-attach
    // wiring was added.
    const { eventId: _ignored, ...publicResult } = result;
    void _ignored;
    return publicResult;
  }

  /**
   * Hard-violation handler — the candidate's microphone has been unplugged or
   * stopped delivering audio for longer than the grace window. There is no
   * legitimate reason to lose the mic mid-exam (it's a Article 28 setup
   * requirement), so this fires immediate termination on the first report
   * rather than counting toward the strike threshold.
   *
   * Persisted as a `AUDIO_HIGH` proctor event with metadata
   * `{ kind: 'MIC_DISCONNECTED', reason, ... }` so existing audit/admin
   * tooling renders it without needing a Prisma enum addition. Idempotent —
   * a second report on an already-terminated session is a no-op.
   */
  async terminateForMicDisconnect(
    userId: string,
    sessionId: string,
    payload: { reason?: string; detail?: Record<string, unknown> },
  ) {
    void this.heartbeat.markAlive(sessionId);
    const reason = payload.reason ?? 'ENDED';
    const failReason = `Forced termination — microphone disconnected mid-exam (Article 28). Trigger: ${reason}.`;

    const result = await this.prisma.$transaction(async (tx) => {
      const session = await tx.examSession.findUnique({ where: { id: sessionId } });
      if (!session) throw new NotFoundException('Session not found');
      if (session.userId !== userId) throw new ForbiddenException('Not your session');

      const meta: Record<string, unknown> = {
        kind: 'MIC_DISCONNECTED',
        reason,
        terminate: true,
        source: 'CLIENT',
        ...(payload.detail ?? {}),
      };

      // Always persist the audit row so the admin sees the trigger, even on
      // a duplicate report against an already-terminated session.
      const created = await tx.proctoringEvent.create({
        data: {
          sessionId,
          eventType: ProctorEventType.AUDIO_HIGH,
          metadata: meta as Prisma.InputJsonValue,
        },
      });

      if (session.status !== ExamSessionStatus.IN_PROGRESS) {
        return {
          eventId: created.id,
          terminated: session.status === ExamSessionStatus.TERMINATED,
          status: session.status,
          warningCount: session.proctorWarnings,
          threshold: FULLSCREEN_WARNING_THRESHOLD,
          failReason: session.failReason,
          alreadyEnded: true,
        };
      }

      const updated = await tx.examSession.update({
        where: { id: sessionId },
        data: {
          status: ExamSessionStatus.TERMINATED,
          submittedAt: new Date(),
          failReason,
          // Saturate the strike counter to the threshold so result-page logic
          // and the admin badge both render this as "max strikes / forced
          // termination" without inventing a new failure code path.
          proctorWarnings: Math.max(session.proctorWarnings, FULLSCREEN_WARNING_THRESHOLD),
        },
      });

      void this.adminMonitor.emitSessionUpdate({
        sessionId: updated.id,
        status: 'terminated',
        progressPct: 0,
        warnings: updated.proctorWarnings,
        candidateName: '',
        examName: `${updated.certType.replace('_', '-')} ${updated.level}`,
      });
      void this.heartbeat.clear(updated.id);

      return {
        eventId: created.id,
        terminated: true,
        status: updated.status,
        warningCount: updated.proctorWarnings,
        threshold: FULLSCREEN_WARNING_THRESHOLD,
        failReason: updated.failReason,
        alreadyEnded: false,
      };
    });

    // After a hard termination, the candidate has burned an attempt of this
    // paid registration. Re-evaluate whether the registration as a whole is
    // now finished (passed OR 3 attempts used) and flip it to EXAM_COMPLETED
    // if so — that single status change drops the registration off the
    // candidate's "active exams" list and blocks any future entry attempts.
    void this.closeRegistrationIfFinished(null, sessionId, 'mic-disconnected');

    return {
      type: 'MIC_DISCONNECTED' as const,
      terminated: result.terminated,
      status: result.status,
      warningCount: result.warningCount,
      threshold: result.threshold,
      failReason: result.failReason,
      action: 'TERMINATED' as const,
    };
  }

  /**
   * Voice-strike threshold reached — the candidate produced enough sustained
   * voice bursts during the exam to exhaust the audio strike budget (the
   * client-side `useMicMonitor` debounces each burst and the host page tracks
   * the running count). Each individual burst is already audited as an
   * `AUDIO_HIGH` evidence row by the voice-clip upload pipeline, so we do
   * NOT advance the global `proctorWarnings` counter through the standard
   * STRIKE_WEIGHT_BY_TYPE map (which deliberately omits AUDIO_HIGH for
   * exactly that reason — see the comment on the map). This handler exists
   * solely to flip the session row from IN_PROGRESS → TERMINATED with a
   * voice-specific failReason so the admin dashboard and the candidate
   * result page agree on what happened. Idempotent — a second report on an
   * already-terminated session is a no-op (returns the existing terminal
   * status without writing a new row).
   */
  async terminateForVoiceStrikes(
    userId: string,
    sessionId: string,
    payload: { strikes?: number; detail?: Record<string, unknown> },
  ) {
    void this.heartbeat.markAlive(sessionId);
    const strikes = payload.strikes ?? FULLSCREEN_WARNING_THRESHOLD;
    const failReason = `Forced termination — voice/noise strike threshold reached (Article 28). Strikes: ${strikes}.`;

    const result = await this.prisma.$transaction(async (tx) => {
      const session = await tx.examSession.findUnique({ where: { id: sessionId } });
      if (!session) throw new NotFoundException('Session not found');
      if (session.userId !== userId) throw new ForbiddenException('Not your session');

      const meta: Record<string, unknown> = {
        kind: 'VOICE_STRIKE_THRESHOLD',
        strikes,
        terminate: true,
        source: 'CLIENT',
        ...(payload.detail ?? {}),
      };

      // Always persist the audit row so the admin sees the trigger, even on
      // a duplicate report against an already-terminated session. We reuse
      // the AUDIO_HIGH event type so the existing admin "Cheating evidence"
      // pipeline renders this without needing a Prisma enum addition.
      const created = await tx.proctoringEvent.create({
        data: {
          sessionId,
          eventType: ProctorEventType.AUDIO_HIGH,
          metadata: meta as Prisma.InputJsonValue,
        },
      });

      if (session.status !== ExamSessionStatus.IN_PROGRESS) {
        return {
          eventId: created.id,
          terminated: session.status === ExamSessionStatus.TERMINATED,
          status: session.status,
          warningCount: session.proctorWarnings,
          threshold: FULLSCREEN_WARNING_THRESHOLD,
          failReason: session.failReason,
          alreadyEnded: true,
        };
      }

      const updated = await tx.examSession.update({
        where: { id: sessionId },
        data: {
          status: ExamSessionStatus.TERMINATED,
          submittedAt: new Date(),
          failReason,
          // Saturate the strike counter to the threshold so result-page logic
          // and the admin badge both render this as "max strikes / forced
          // termination" without inventing a separate failure code path —
          // matches the mic-disconnect handler's behavior exactly.
          proctorWarnings: Math.max(session.proctorWarnings, FULLSCREEN_WARNING_THRESHOLD),
        },
      });

      void this.adminMonitor.emitSessionUpdate({
        sessionId: updated.id,
        status: 'terminated',
        progressPct: 0,
        warnings: updated.proctorWarnings,
        candidateName: '',
        examName: `${updated.certType.replace('_', '-')} ${updated.level}`,
      });
      void this.heartbeat.clear(updated.id);

      return {
        eventId: created.id,
        terminated: true,
        status: updated.status,
        warningCount: updated.proctorWarnings,
        threshold: FULLSCREEN_WARNING_THRESHOLD,
        failReason: updated.failReason,
        alreadyEnded: false,
      };
    });

    if (result.terminated) {
      void this.closeRegistrationIfFinished(null, sessionId, 'strike-threshold');
    }

    return {
      type: 'VOICE_STRIKE_THRESHOLD' as const,
      terminated: result.terminated,
      status: result.status,
      warningCount: result.warningCount,
      threshold: result.threshold,
      failReason: result.failReason,
      action: 'TERMINATED' as const,
    };
  }

  /**
   * Re-evaluate a paid registration after one of its sessions reaches a
   * terminal state and flip to `EXAM_COMPLETED` when no further attempts
   * make sense. Two close conditions:
   *
   *   1. **Pass:** any session under this registration has `passed=true`.
   *      The candidate cleared the bar — additional attempts would be
   *      wasted slots and admins want the seat closed out cleanly.
   *
   *   2. **Exhausted:** terminal sessions (SUBMITTED + GRADED + TERMINATED)
   *      reached `MAX_ATTEMPTS`. The candidate burned all 3 chances.
   *
   * Idempotent and safe to call from the candidate path or the admin path
   * after grading. Never overwrites CANCELLED/REFUNDED/EXAM_COMPLETED — only
   * a still-PAID registration is touched. Accepts EITHER a registrationId
   * directly OR a sessionId (which is resolved to a registrationId so the
   * existing terminate/submit call sites don't need a second DB round-trip).
   *
   * Logs the close decision (or the no-op reason) for audit. Always wrapped
   * in a try/catch so an internal failure never propagates back to the
   * candidate's submit/terminate response.
   */
  async closeRegistrationIfFinished(
    registrationId: string | null,
    sessionId: string | null,
    trigger: 'submit' | 'finalize' | 'strike-threshold' | 'mic-disconnected',
  ): Promise<{ closed: boolean; reason?: 'PASSED' | 'EXHAUSTED'; registrationId?: string }> {
    try {
      let regId = registrationId;
      if (!regId && sessionId) {
        const s = await this.prisma.examSession.findUnique({
          where: { id: sessionId },
          select: { registrationId: true },
        });
        regId = s?.registrationId ?? null;
      }
      if (!regId) {
        // Admin-only sessions (CbtSessionsService.create) aren't tied to a
        // registration. Nothing to flip — just exit silently.
        return { closed: false };
      }

      const reg = await this.prisma.registration.findUnique({
        where: { id: regId },
        select: { id: true, status: true },
      });
      if (!reg) return { closed: false };
      if (reg.status !== RegistrationStatus.PAID) {
        // Already EXAM_COMPLETED / CANCELLED / REFUNDED / PENDING_PAYMENT —
        // never overwrite a non-PAID terminal status.
        return { closed: false, registrationId: regId };
      }

      // Pull every session under this registration in one query so we can
      // check both close conditions without a transaction (status flip is a
      // single row update; race with a parallel close is fine because the
      // flip is idempotent).
      const sessions = await this.prisma.examSession.findMany({
        where: { registrationId: regId },
        select: { id: true, status: true, passed: true },
      });

      const passed = sessions.some((s) => s.passed === true);
      const terminalCount = sessions.filter(
        (s) =>
          s.status === ExamSessionStatus.SUBMITTED ||
          s.status === ExamSessionStatus.GRADED ||
          s.status === ExamSessionStatus.TERMINATED,
      ).length;
      const bonus = await getBonusAttempts(this.redis, regId);
      const exhausted = terminalCount >= MAX_ATTEMPTS + bonus;

      if (!passed && !exhausted) {
        return { closed: false, registrationId: regId };
      }

      const reason: 'PASSED' | 'EXHAUSTED' = passed ? 'PASSED' : 'EXHAUSTED';
      await this.prisma.registration.update({
        where: { id: regId },
        data: { status: RegistrationStatus.EXAM_COMPLETED },
      });
      this.logger.log(
        `[reg-close] ${regId} → EXAM_COMPLETED (reason=${reason}, trigger=${trigger}, terminalCount=${terminalCount})`,
      );
      return { closed: true, reason, registrationId: regId };
    } catch (err) {
      // Never let registration-close failures bubble out of the submit/
      // terminate path — the candidate's primary action already succeeded.
      this.logger.warn(
        `[reg-close] failed for registration=${registrationId} session=${sessionId}: ${
          (err as Error).message
        }`,
      );
      return { closed: false };
    }
  }

  /**
   * Best-effort: fetch the latest cached webcam + screen frame for this
   * session from Redis, upload them as JPEG snapshots to NCP, then patch
   * the proctoringEvent row with the resulting object keys. Both failure
   * modes (Redis miss, NCP put failure) leave the row's evidenceUrl as
   * null — the modal will simply render "(no snapshot)" for that event,
   * which is the existing fallback path.
   */
  /**
   * Attach client-supplied frames captured at the moment of a violation. Unlike
   * `attachCachedFramesToEvent` (which reads the live-monitor Redis cache), these
   * arrive on the event report itself, so every flagged event gets a snapshot
   * regardless of whether an admin was watching. Webcam → `evidenceUrl`, screen
   * → `metadata.screenEvidenceUrl`, matching the existing storage convention.
   * Never throws — the strike has already counted.
   */
  private async attachClientFramesToEvent(
    sessionId: string,
    eventId: string,
    frames: { webcamFrameBase64?: string; screenFrameBase64?: string },
  ): Promise<void> {
    try {
      const webcam = decodeBase64Image(frames.webcamFrameBase64);
      const screen = decodeBase64Image(frames.screenFrameBase64);
      if (!webcam && !screen) return;

      const tsNow = Date.now();
      const bucket = this.ncp.bucketSnapshots();
      const retainUntil = new Date(tsNow + PROCTOR_EVENT_RETAIN_DAYS * 86_400_000);

      let webcamKey: string | null = null;
      if (webcam) {
        const key = `proctor/${sessionId}/violation/${tsNow}-${randomUUID()}.jpg`;
        try {
          await this.ncp.put(bucket, key, webcam, 'image/jpeg', PROCTOR_EVENT_RETAIN_DAYS);
          webcamKey = key;
        } catch (err) {
          this.logger.warn(
            `[violation-evidence] webcam put failed for ${sessionId}/${eventId}: ${(err as Error).message}`,
          );
        }
      }

      let screenKey: string | null = null;
      if (screen) {
        const key = `proctor/${sessionId}/violation-screen/${tsNow}-${randomUUID()}.jpg`;
        try {
          await this.ncp.put(bucket, key, screen, 'image/jpeg', PROCTOR_EVENT_RETAIN_DAYS);
          screenKey = key;
        } catch (err) {
          this.logger.warn(
            `[violation-evidence] screen put failed for ${sessionId}/${eventId}: ${(err as Error).message}`,
          );
        }
      }

      if (!webcamKey && !screenKey) return;

      const current = await this.prisma.proctoringEvent.findUnique({ where: { id: eventId } });
      const baseMeta = (current?.metadata ?? {}) as Record<string, unknown>;
      const mergedMeta: Record<string, unknown> = {
        ...baseMeta,
        evidenceSource: 'client-violation-frame',
        ...(screenKey ? { screenEvidenceUrl: screenKey } : {}),
      };
      await this.prisma.proctoringEvent.update({
        where: { id: eventId },
        data: {
          ...(webcamKey ? { evidenceUrl: webcamKey } : {}),
          retainUntil,
          metadata: mergedMeta as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      this.logger.warn(
        `[violation-evidence] attach failed for ${sessionId}/${eventId}: ${(err as Error).message}`,
      );
    }
  }

  private async attachCachedFramesToEvent(
    sessionId: string,
    eventId: string,
    type: ProctorEventType,
    detail: Record<string, unknown> | undefined,
  ): Promise<void> {
    try {
      const [webcamRaw, screenRaw] = await Promise.all([
        this.redis.get(LAST_WEBCAM_FRAME_KEY(sessionId)),
        this.redis.get(LAST_SCREEN_FRAME_KEY(sessionId)),
      ]);
      const webcamFrame = decodeCachedFrame(webcamRaw);
      const screenFrame = decodeCachedFrame(screenRaw);
      if (!webcamFrame && !screenFrame) {
        return;
      }
      const tsNow = Date.now();
      const bucket = this.ncp.bucketSnapshots();
      const retainUntil = new Date(tsNow + PROCTOR_EVENT_RETAIN_DAYS * 86_400_000);

      let webcamKey: string | null = null;
      if (webcamFrame) {
        const key = `proctor/${sessionId}/heuristic/${tsNow}-${randomUUID()}.jpg`;
        try {
          await this.ncp.put(bucket, key, webcamFrame.buffer, 'image/jpeg', PROCTOR_EVENT_RETAIN_DAYS);
          webcamKey = key;
        } catch (err) {
          this.logger.warn(
            `[heuristic-evidence] webcam NCP put failed for ${sessionId}/${eventId}: ${(err as Error).message}`,
          );
        }
      }

      let screenKey: string | null = null;
      if (screenFrame) {
        const key = `proctor/${sessionId}/heuristic-screen/${tsNow}-${randomUUID()}.jpg`;
        try {
          await this.ncp.put(bucket, key, screenFrame.buffer, 'image/jpeg', PROCTOR_EVENT_RETAIN_DAYS);
          screenKey = key;
        } catch (err) {
          this.logger.warn(
            `[heuristic-evidence] screen NCP put failed for ${sessionId}/${eventId}: ${(err as Error).message}`,
          );
        }
      }

      if (!webcamKey && !screenKey) {
        return;
      }

      // Re-read the row's existing metadata so we can merge in the screen
      // key + frame age without trampling whatever the original write set
      // (source, sustainedMs, etc.).
      const current = await this.prisma.proctoringEvent.findUnique({ where: { id: eventId } });
      const baseMeta = (current?.metadata ?? {}) as Record<string, unknown>;
      const mergedMeta: Record<string, unknown> = {
        ...baseMeta,
        evidenceSource: 'cached-live-frame',
        ...(screenKey ? { screenEvidenceUrl: screenKey } : {}),
        ...(webcamFrame ? { webcamFrameAgeMs: tsNow - webcamFrame.ts } : {}),
        ...(screenFrame ? { screenFrameAgeMs: tsNow - screenFrame.ts } : {}),
      };
      await this.prisma.proctoringEvent.update({
        where: { id: eventId },
        data: {
          ...(webcamKey ? { evidenceUrl: webcamKey } : {}),
          retainUntil,
          metadata: mergedMeta as Prisma.InputJsonValue,
        },
      });
      void detail;
      void type;
    } catch (err) {
      // Never let evidence-attach throw — the strike already counted.
      this.logger.warn(
        `[heuristic-evidence] attach failed for ${sessionId}/${eventId}: ${(err as Error).message}`,
      );
    }
  }

  private skipIdentityCheck(): boolean {
    return this.config.get<boolean>('cbt.skipIdentityCheck') === true;
  }
}

/**
 * Cached frame format is `<unixMs>|<base64>`. Returns null on parse failure
 * or when the cached frame is older than `FRAME_AGE_HARD_CAP_MS` (so we
 * don't attach a stale shot from before the violation).
 */
function decodeCachedFrame(raw: string | null): { ts: number; buffer: Buffer } | null {
  if (!raw) return null;
  const sep = raw.indexOf('|');
  if (sep <= 0) return null;
  const tsStr = raw.slice(0, sep);
  const b64 = raw.slice(sep + 1);
  const ts = Number(tsStr);
  if (!Number.isFinite(ts) || !b64) return null;
  if (Date.now() - ts > FRAME_AGE_HARD_CAP_MS) return null;
  try {
    return { ts, buffer: Buffer.from(b64, 'base64') };
  } catch {
    return null;
  }
}

/**
 * Decode a client-supplied base64 image (with or without a `data:image/…;base64,`
 * prefix) into a Buffer. Returns null for empty/invalid input or implausibly
 * large payloads (guards against an oversized POST body).
 */
const MAX_FRAME_BYTES = 3_000_000; // ~3MB decoded ceiling per frame
function decodeBase64Image(input: string | null | undefined): Buffer | null {
  if (!input) return null;
  const comma = input.indexOf(',');
  const b64 = input.startsWith('data:') && comma >= 0 ? input.slice(comma + 1) : input;
  if (!b64) return null;
  try {
    const buf = Buffer.from(b64, 'base64');
    if (buf.length === 0 || buf.length > MAX_FRAME_BYTES) return null;
    return buf;
  } catch {
    return null;
  }
}

export function shuffleWithSeed<T>(items: T[], seed: string): T[] {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    h = (h * 1103515245 + 12345) & 0x7fffffff;
    const j = h % (i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

interface Choice {
  key: string;
  text: string;
}

interface ShuffleResult {
  shuffled: Choice[];
  correctKey: string;
}

export function shuffleChoicesWithMapping(
  choices: Choice[],
  originalCorrectKey: string,
  seed: string
): ShuffleResult {
  if (!choices || choices.length === 0) {
    return { shuffled: [], correctKey: originalCorrectKey };
  }
  
  // Find the correct answer text before shuffling
  const correctChoice = choices.find(c => c.key === originalCorrectKey);
  const correctText = correctChoice?.text ?? '';
  
  // Shuffle the choices
  const shuffled = shuffleWithSeed([...choices], seed);
  
  // Reassign keys A, B, C, D and find the new correct key
  let newCorrectKey = originalCorrectKey;
  const result = shuffled.map((c, i) => {
    const newKey = String.fromCharCode(65 + i); // A=65, B=66, C=67, D=68
    if (c.text === correctText) {
      newCorrectKey = newKey;
    }
    return { key: newKey, text: c.text };
  });
  
  return { shuffled: result, correctKey: newCorrectKey };
}
