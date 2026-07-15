import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CertLevel, CertType, Prisma, RegistrationStatus, ScheduleStatus } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { RedisService } from '../../integrations/redis/redis.service';
import { isSeriesSuspended } from '../cbtSessions/exam-spec';

/** Redis key for admin-managed L3/on-demand slot defaults. */
const ON_DEMAND_SETTINGS_KEY = 'schedules:on-demand-settings';

export interface OnDemandSettings {
  /** Inclusive start hour (local) for virtual slots — default 9. */
  businessHoursStart: number;
  /** Exclusive end hour (local) for virtual slots — default 18. */
  businessHoursEnd: number;
  /** Default capacity for newly materialized / virtual on-demand slots. */
  defaultSlotCapacity: number;
  slotUnitMinutes: number;
}

const DEFAULT_ON_DEMAND_SETTINGS: OnDemandSettings = {
  businessHoursStart: 9,
  businessHoursEnd: 18,
  defaultSlotCapacity: 9999,
  slotUnitMinutes: 60,
};

/** Conservative upper bound for marking a session COMPLETED after exam start. */
const EXAM_DURATION_MINUTES: Record<string, number> = {
  L3: 90,
  L2: 120,
  L1: 150,
};

/**
 * True when the error is Prisma's unique-constraint violation. Prisma's
 * `upsert` is not atomic on MySQL — it issues SELECT then INSERT/UPDATE, so
 * concurrent callers targeting the same key can both miss the SELECT and then
 * race on INSERT. The loser surfaces P2002 even though the row now exists.
 */
function isUniqueViolation(err: unknown): err is Prisma.PrismaClientKnownRequestError {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

export interface CreateOnDemandScheduleDto {
  certType: CertType;
  level: CertLevel;
  examDate: string;      // ISO date-time string (e.g., "2026-05-10T14:00:00Z")
  examStartTime?: string; // e.g., "14:00"
  capacity?: number;      // defaults to 100 for online
  venue?: string;         // defaults to "ONLINE_CBT"
}

/** Admin manual exam-round registration (full registration window + capacity). */
export interface CreateAdminScheduleDto {
  certType: CertType;
  level: CertLevel;
  examDate: string; // YYYY-MM-DD or ISO datetime
  examStartTime: string; // HH:mm
  registrationStart: string; // YYYY-MM-DD or ISO datetime
  registrationEnd: string; // YYYY-MM-DD or ISO datetime
  capacity?: number;
  venue?: string;
  venueDetail?: string;
  status?: ScheduleStatus;
  roundNumber?: number;
}

/** Admin partial update of an existing exam round. */
export type UpdateAdminScheduleDto = Partial<CreateAdminScheduleDto>;

export interface ListSchedulesQuery {
  certType?: CertType;
  level?: CertLevel;
  status?: ScheduleStatus;
  upcomingOnly?: boolean;
}

export interface ListRegisteredExamsQuery {
  certType?: CertType;
  level?: CertLevel;
  scheduleStatus?: ScheduleStatus;
}

const L3_SLOT_UNIT_MINUTES = 60;

/**
 * L3 is on-demand: candidates can book any business-hour slot Mon-Fri,
 * 09:00 through 18:00 (start hours 9..17 inclusive — last slot starts at 17,
 * runs until 18). Virtual slots are synthesized by getCalendar/getSlots and
 * materialized into real ExamSchedule rows lazily on registration.
 */
const L3_BUSINESS_HOURS_START = 9;
const L3_BUSINESS_HOURS_END = 18; // exclusive — slot start hours are [9..17]
/** Official rounds use 1–3; L3 hourly slots use 1001–9999 (see seed-l3-slots.ts). */
const L3_SLOT_ROUND_BASE = 1001;
const L3_SLOTS_PER_DAY = L3_BUSINESS_HOURS_END - L3_BUSINESS_HOURS_START;

/**
 * L1/L2 rolling availability. Like L3 these are online proctored exams, but the
 * registration UI shows a flat session-card list (not a slot picker), so instead
 * of virtual slots we lazily keep a rolling window of real future online rounds
 * so the list never runs dry. Rounds are date-derived (base 5001+) so they never
 * collide with the official 1–3 or L3's 1001+ rounds, and upserts are idempotent.
 */
const ROLLING_ROUND_BASE = 5001;
const ROLLING_WEEKS_AHEAD = 8;
const ROLLING_START_HOUR: Record<string, number> = { L1: 10, L2: 14 };

/** Next weekday on-or-after (today + weekOffset weeks), at the given hour. */
function nextRollingSessionDate(base: Date, weekOffset: number, hour: number): Date {
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate());
  d.setDate(d.getDate() + weekOffset * 7);
  while (!isWeekday(d)) d.setDate(d.getDate() + 1);
  d.setHours(hour, 0, 0, 0);
  return d;
}

/** Stable per-year round number for a rolling session (same date → same round). */
function computeRollingRoundNumber(examDate: Date): number {
  const year = examDate.getFullYear();
  const startOfYear = new Date(year, 0, 1);
  const dayOfYear = Math.round(
    (new Date(year, examDate.getMonth(), examDate.getDate()).getTime() - startOfYear.getTime()) /
      86_400_000,
  );
  return ROLLING_ROUND_BASE + dayOfYear;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function isWeekday(d: Date): boolean {
  const day = d.getDay();
  return day >= 1 && day <= 5;
}

function toLocalIsoDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * On-demand levels: L1/L2/L3 are all online proctored exams booked via the
 * calendar + hourly slot picker. (Official scheduled rounds, if any, still
 * coexist as real ExamSchedule rows.)
 */
const ON_DEMAND_LEVELS: ReadonlySet<CertLevel> = new Set([
  CertLevel.L1,
  CertLevel.L2,
  CertLevel.L3,
]);
export function isOnDemandLevel(level?: CertLevel | null): boolean {
  return !!level && ON_DEMAND_LEVELS.has(level);
}

function buildVirtualSlotId(level: CertLevel, certType: CertType, dateIso: string, hour: number): string {
  return `virtual:${level}:${certType}:${dateIso}:${pad2(hour)}`;
}

const VIRTUAL_SLOT_ID_RE = /^virtual:(L1|L2|L3):(AXIS|AXIS_C|AXIS_H):(\d{4}-\d{2}-\d{2}):(\d{2})$/;

export function parseVirtualSlotId(
  id: string,
): { level: CertLevel; certType: CertType; dateIso: string; hour: number } | null {
  const m = id.match(VIRTUAL_SLOT_ID_RE);
  if (!m) return null;
  const hour = parseInt(m[4], 10);
  if (hour < L3_BUSINESS_HOURS_START || hour >= L3_BUSINESS_HOURS_END) return null;
  return { level: m[1] as CertLevel, certType: m[2] as CertType, dateIso: m[3], hour };
}

/**
 * Stable roundNumber for an on-demand hourly slot — same (date, hour) always
 * maps to the same round within a year so concurrent materialization can upsert
 * safely. `level` is part of the schedule's unique key, so the same numeric
 * round across levels never collides.
 */
export function computeSlotRoundNumber(_level: CertLevel, dateIso: string, hour: number): number {
  const parts = dateIso.split('-').map((v) => parseInt(v, 10));
  if (parts.length !== 3 || parts.some(isNaN)) {
    throw new BadRequestException('Invalid dateIso');
  }
  if (hour < L3_BUSINESS_HOURS_START || hour >= L3_BUSINESS_HOURS_END) {
    throw new BadRequestException('Hour outside business hours');
  }
  const year = parts[0];
  const slotDay = new Date(year, parts[1] - 1, parts[2]);
  const startOfYear = new Date(year, 0, 1);
  const dayOfYear = Math.round((slotDay.getTime() - startOfYear.getTime()) / 86_400_000);
  const hourIndex = hour - L3_BUSINESS_HOURS_START;
  return L3_SLOT_ROUND_BASE + dayOfYear * L3_SLOTS_PER_DAY + hourIndex;
}

/** Back-compat wrapper (L3) used by tests and the legacy hybrid API. */
export function computeL3SlotRoundNumber(dateIso: string, hour: number): number {
  return computeSlotRoundNumber(CertLevel.L3, dateIso, hour);
}

@Injectable()
export class SchedulesService implements OnModuleInit {
  private readonly logger = new Logger(SchedulesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Catch up immediately on boot (cron also runs every minute).
    void this.advanceScheduleStatuses();
  }

  async getOnDemandSettings(): Promise<OnDemandSettings> {
    const raw = await this.redis.get(ON_DEMAND_SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_ON_DEMAND_SETTINGS };
    try {
      const parsed = JSON.parse(raw) as Partial<OnDemandSettings>;
      return {
        businessHoursStart:
          typeof parsed.businessHoursStart === 'number'
            ? parsed.businessHoursStart
            : DEFAULT_ON_DEMAND_SETTINGS.businessHoursStart,
        businessHoursEnd:
          typeof parsed.businessHoursEnd === 'number'
            ? parsed.businessHoursEnd
            : DEFAULT_ON_DEMAND_SETTINGS.businessHoursEnd,
        defaultSlotCapacity:
          typeof parsed.defaultSlotCapacity === 'number'
            ? parsed.defaultSlotCapacity
            : DEFAULT_ON_DEMAND_SETTINGS.defaultSlotCapacity,
        slotUnitMinutes:
          typeof parsed.slotUnitMinutes === 'number'
            ? parsed.slotUnitMinutes
            : DEFAULT_ON_DEMAND_SETTINGS.slotUnitMinutes,
      };
    } catch {
      return { ...DEFAULT_ON_DEMAND_SETTINGS };
    }
  }

  async updateOnDemandSettings(patch: Partial<OnDemandSettings>): Promise<OnDemandSettings> {
    const current = await this.getOnDemandSettings();
    const next: OnDemandSettings = {
      businessHoursStart: patch.businessHoursStart ?? current.businessHoursStart,
      businessHoursEnd: patch.businessHoursEnd ?? current.businessHoursEnd,
      defaultSlotCapacity: patch.defaultSlotCapacity ?? current.defaultSlotCapacity,
      slotUnitMinutes: patch.slotUnitMinutes ?? current.slotUnitMinutes,
    };
    if (
      !Number.isInteger(next.businessHoursStart) ||
      !Number.isInteger(next.businessHoursEnd) ||
      next.businessHoursStart < L3_BUSINESS_HOURS_START ||
      next.businessHoursEnd > L3_BUSINESS_HOURS_END ||
      next.businessHoursStart >= next.businessHoursEnd
    ) {
      throw new BadRequestException(
        `business hours must be within ${L3_BUSINESS_HOURS_START}–${L3_BUSINESS_HOURS_END} (end exclusive) with start < end`,
      );
    }
    if (
      !Number.isInteger(next.defaultSlotCapacity) ||
      next.defaultSlotCapacity < 1 ||
      next.defaultSlotCapacity > 99999
    ) {
      throw new BadRequestException('defaultSlotCapacity must be an integer between 1 and 99999');
    }
    if (![30, 60].includes(next.slotUnitMinutes)) {
      throw new BadRequestException('slotUnitMinutes must be 30 or 60');
    }
    await this.redis.set(ON_DEMAND_SETTINGS_KEY, JSON.stringify(next));
    return next;
  }

  /**
   * Advance schedule lifecycle by wall-clock:
   * Upcoming → Open → Closed → In Progress → Ended (COMPLETED).
   * Runs every minute so test-taker availability reflects registration/exam windows.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async advanceScheduleStatuses(): Promise<void> {
    const now = new Date();
    try {
      const opened = await this.prisma.examSchedule.updateMany({
        where: {
          status: ScheduleStatus.UPCOMING,
          registrationStart: { lte: now },
        },
        data: { status: ScheduleStatus.REGISTRATION_OPEN },
      });

      // End sessions whose exam window is fully past (per-level duration).
      let completed = 0;
      for (const [level, minutes] of Object.entries(EXAM_DURATION_MINUTES)) {
        const cutoff = new Date(now.getTime() - minutes * 60_000);
        const res = await this.prisma.examSchedule.updateMany({
          where: {
            level: level as CertLevel,
            status: {
              in: [
                ScheduleStatus.REGISTRATION_OPEN,
                ScheduleStatus.REGISTRATION_CLOSED,
                ScheduleStatus.IN_PROGRESS,
              ],
            },
            examDate: { lt: cutoff },
          },
          data: { status: ScheduleStatus.COMPLETED },
        });
        completed += res.count;
      }

      const inProgress = await this.prisma.examSchedule.updateMany({
        where: {
          status: {
            in: [ScheduleStatus.REGISTRATION_OPEN, ScheduleStatus.REGISTRATION_CLOSED],
          },
          examDate: { lte: now },
        },
        data: { status: ScheduleStatus.IN_PROGRESS },
      });

      const closed = await this.prisma.examSchedule.updateMany({
        where: {
          status: ScheduleStatus.REGISTRATION_OPEN,
          registrationEnd: { lt: now },
          examDate: { gt: now },
        },
        data: { status: ScheduleStatus.REGISTRATION_CLOSED },
      });

      if (opened.count || closed.count || inProgress.count || completed) {
        this.logger.log(
          `schedule status advance: open+${opened.count} closed+${closed.count} inProgress+${inProgress.count} completed+${completed}`,
        );
      }
    } catch (err) {
      this.logger.warn(`advanceScheduleStatuses failed: ${(err as Error).message}`);
    }
  }

  async list(q: ListSchedulesQuery = {}) {
    return this.prisma.examSchedule.findMany({
      where: {
        certType: q.certType,
        level: q.level,
        status: q.status,
        examDate: q.upcomingOnly ? { gte: new Date() } : undefined,
      },
      orderBy: [{ examDate: 'asc' }],
    });
  }

  async listRegisteredExams(q: ListRegisteredExamsQuery = {}) {
    return this.prisma.registration.findMany({
      where: {
        certType: q.certType,
        level: q.level,
        schedule: {
          status: q.scheduleStatus,
        },
        status: {
          in: [
            RegistrationStatus.PENDING_PAYMENT,
            RegistrationStatus.PAID,
            RegistrationStatus.EXAM_COMPLETED,
          ],
        },
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            phone: true,
          },
        },
        schedule: {
          select: {
            id: true,
            year: true,
            roundNumber: true,
            examDate: true,
            examStartTime: true,
            status: true,
            venue: true,
          },
        },
      },
      orderBy: [{ schedule: { examDate: 'asc' } }, { createdAt: 'desc' }],
    });
  }

  async getById(id: string) {
    const sched = await this.prisma.examSchedule.findUnique({ where: { id } });
    if (!sched) throw new NotFoundException('Schedule not found');
    return sched;
  }

  /**
   * Returns schedules open for registration with real-time remaining seat count.
   * Remaining seats always come from DB (capacity − currentCount) so they track
   * registrations immediately; Redis is warmed as a write-through cache.
   */
  async getAvailable(certType?: CertType, level?: CertLevel) {
    // AXIS-C / AXIS-H (and any SUSPENDED_SERIES) must not advertise bookable seats.
    if (certType && isSeriesSuspended(certType)) return [];

    // Keep L1/L2 rolling like L3: lazily materialize a window of future online
    // sessions so the registration list never runs dry when seeded rounds lapse.
    if (certType && (level === CertLevel.L1 || level === CertLevel.L2)) {
      await this.ensureRollingOnlineSchedules(certType, level);
    }

    const schedules = await this.prisma.examSchedule.findMany({
      where: {
        status: ScheduleStatus.REGISTRATION_OPEN,
        certType: certType ?? undefined,
        level: level ?? undefined,
        examDate: { gte: new Date() },
        registrationEnd: { gte: new Date() },
      },
      orderBy: [{ examDate: 'asc' }],
    });

    return Promise.all(
      schedules.map(async (s) => {
        const remaining = Math.max(0, s.capacity - s.currentCount);
        // Keep Redis in sync for any other consumers without letting it go stale.
        void this.redis.set(`schedule:seats:${s.id}`, String(remaining), 3600);
        return {
          ...s,
          remainingSeats: remaining,
        };
      }),
    );
  }

  /**
   * Ensure a rolling window of future online REGISTRATION_OPEN sessions exists
   * for an L1/L2 (certType, level). Idempotent: upserts by the unique
   * (certType, level, year, roundNumber) key with date-derived rounds, and
   * never updates existing rows (so admin edits / seat counts are preserved).
   */
  private async ensureRollingOnlineSchedules(certType: CertType, level: CertLevel) {
    const startHour = ROLLING_START_HOUR[level] ?? 10;
    const now = new Date();
    for (let week = 1; week <= ROLLING_WEEKS_AHEAD; week += 1) {
      const examDate = nextRollingSessionDate(now, week, startHour);
      const year = examDate.getFullYear();
      const roundNumber = computeRollingRoundNumber(examDate);
      try {
        await this.prisma.examSchedule.upsert({
          where: {
            certType_level_year_roundNumber: { certType, level, year, roundNumber },
          },
          create: {
            certType,
            level,
            year,
            roundNumber,
            examDate,
            examStartTime: `${pad2(startHour)}:00`,
            registrationStart: now,
            registrationEnd: examDate, // online: register up until exam time
            capacity: 9999,
            venue: 'ONLINE_CBT',
            status: ScheduleStatus.REGISTRATION_OPEN,
          },
          update: {},
        });
      } catch (err) {
        // Two concurrent /schedules/available calls can race the upsert and
        // one loses on the unique key. The row exists now — treat as success.
        if (!isUniqueViolation(err)) throw err;
      }
    }
  }

  /**
   * Returns on-demand time slots for a given cert type, date, and level.
   * Real ExamSchedule rows take precedence; the rest of the business-hour grid
   * is synthesized as virtual slots (materialized on registration). Works the
   * same for L1/L2/L3 — they are all online on-demand exams.
   * Business hours / default capacity come from admin on-demand settings.
   */
  async getSlots(
    certType: CertType,
    date: string,
    level: CertLevel = CertLevel.L3,
    slotUnitMinutes = L3_SLOT_UNIT_MINUTES,
  ) {
    if (isSeriesSuspended(certType)) return [];

    const settings = await this.getOnDemandSettings();
    const hoursStart = settings.businessHoursStart;
    const hoursEnd = settings.businessHoursEnd;
    const defaultCap = settings.defaultSlotCapacity;
    const unit = slotUnitMinutes || settings.slotUnitMinutes || L3_SLOT_UNIT_MINUTES;

    const dayStart = new Date(`${date}T00:00:00.000Z`);
    const dayEnd = new Date(`${date}T23:59:59.999Z`);

    const slots = await this.prisma.examSchedule.findMany({
      where: {
        certType,
        level,
        status: ScheduleStatus.REGISTRATION_OPEN,
        examDate: { gte: dayStart, lte: dayEnd },
      },
      orderBy: [{ examStartTime: 'asc' }],
    });

    const normalized = slots.filter((s) => {
      const [hh, mm] = s.examStartTime.split(':').map((v) => parseInt(v, 10));
      if (isNaN(hh) || isNaN(mm)) return false;
      const total = hh * 60 + mm;
      return total % unit === 0;
    });

    const realSlots = await Promise.all(
      normalized.map(async (s) => {
        const remaining = Math.max(0, s.capacity - s.currentCount);
        void this.redis.set(`schedule:seats:${s.id}`, String(remaining), 3600);
        return {
          id: s.id,
          certType: s.certType,
          level: s.level,
          examDate: s.examDate,
          examStartTime: s.examStartTime,
          capacity: s.capacity,
          currentCount: s.currentCount,
          remainingSeats: remaining,
          venue: s.venue,
          slotUnitMinutes: unit,
        };
      }),
    );

    // Synthesize virtual Mon-Fri hourly slots from admin-configured hours.
    // Real DB rows take precedence at the same start hour.
    const parts = date.split('-').map((v) => parseInt(v, 10));
    if (parts.length !== 3 || parts.some(isNaN)) return realSlots;
    const requested = new Date(parts[0], parts[1] - 1, parts[2]);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (requested < today) return realSlots;
    if (!isWeekday(requested)) return realSlots;

    const realByHour = new Map<number, (typeof realSlots)[number]>();
    for (const s of realSlots) {
      const hh = parseInt(s.examStartTime.split(':')[0] ?? '', 10);
      if (!isNaN(hh)) realByHour.set(hh, s);
    }

    const now = new Date();
    const merged: typeof realSlots = [];
    for (let h = hoursStart; h < hoursEnd; h += 1) {
      const real = realByHour.get(h);
      if (real) {
        merged.push(real);
        continue;
      }
      const slotStart = new Date(parts[0], parts[1] - 1, parts[2], h, 0, 0);
      // Skip slots that already started today.
      if (slotStart.getTime() <= now.getTime()) continue;
      merged.push({
        id: buildVirtualSlotId(level, certType, date, h),
        certType,
        level,
        examDate: slotStart,
        examStartTime: `${pad2(h)}:00`,
        capacity: defaultCap,
        currentCount: 0,
        remainingSeats: defaultCap,
        venue: 'ONLINE_CBT',
        slotUnitMinutes: unit,
      });
    }

    // Include real slots that fall outside configured business hours (admin-created)
    // so they're still bookable.
    for (const s of realSlots) {
      const hh = parseInt(s.examStartTime.split(':')[0] ?? '', 10);
      if (!isNaN(hh) && (hh < hoursStart || hh >= hoursEnd)) {
        merged.push(s);
      }
    }

    merged.sort((a, b) => a.examStartTime.localeCompare(b.examStartTime));
    return merged;
  }

  /**
   * Resolve a (certType, dateIso, hour) tuple to an ExamSchedule row,
   * creating it on demand if it doesn't already exist. Used by the
   * registration path to materialize virtual L3 slots.
   */
  async findOrCreateForSlot(input: {
    certType: CertType;
    level: CertLevel;
    dateIso: string;
    hour: number;
  }) {
    const parts = input.dateIso.split('-').map((v) => parseInt(v, 10));
    if (parts.length !== 3 || parts.some(isNaN)) {
      throw new BadRequestException('Invalid dateIso');
    }
    const examStartTime = `${pad2(input.hour)}:00`;

    const existing = await this.findL3SlotByDateTime(
      input.certType,
      input.level,
      parts[0],
      parts[1],
      parts[2],
      input.hour,
      examStartTime,
    );
    if (existing) return existing;

    return this.materializeSlot({
      certType: input.certType,
      level: input.level,
      dateIso: input.dateIso,
      hour: input.hour,
    });
  }

  private async findL3SlotByDateTime(
    certType: CertType,
    level: CertLevel,
    year: number,
    month: number,
    day: number,
    hour: number,
    examStartTime: string,
  ) {
    const start = new Date(year, month - 1, day, hour, 0, 0);
    const end = new Date(year, month - 1, day, hour, 59, 59, 999);
    return this.prisma.examSchedule.findFirst({
      where: {
        certType,
        level,
        examDate: { gte: start, lte: end },
        examStartTime,
      },
      orderBy: { examDate: 'asc' },
    });
  }

  /**
   * Insert an on-demand slot row idempotently. roundNumber is derived from
   * (level, date, hour) so concurrent callers upsert the same unique key instead
   * of racing on max+1.
   */
  private async materializeSlot(input: {
    certType: CertType;
    level: CertLevel;
    dateIso: string;
    hour: number;
  }) {
    const parts = input.dateIso.split('-').map((v) => parseInt(v, 10));
    const year = parts[0];
    const examDate = new Date(year, parts[1] - 1, parts[2], input.hour, 0, 0);
    const examStartTime = `${pad2(input.hour)}:00`;
    const roundNumber = computeSlotRoundNumber(input.level, input.dateIso, input.hour);
    const registrationStart = new Date();
    const registrationEnd = new Date(Date.now() + 365 * 24 * 60 * 60_000);

    const settings = await this.getOnDemandSettings();
    const uniqueWhere = {
      certType_level_year_roundNumber: {
        certType: input.certType,
        level: input.level,
        year,
        roundNumber,
      },
    } as const;

    let schedule;
    try {
      schedule = await this.prisma.examSchedule.upsert({
        where: uniqueWhere,
        create: {
          certType: input.certType,
          level: input.level,
          year,
          roundNumber,
          examDate,
          examStartTime,
          registrationStart,
          registrationEnd,
          capacity: settings.defaultSlotCapacity,
          venue: 'ONLINE_CBT',
          status: ScheduleStatus.REGISTRATION_OPEN,
        },
        update: {},
      });
    } catch (err) {
      // Concurrent materialization (two candidates picking the same slot at the
      // same moment, retry, StrictMode double-fire, etc.) loses Prisma's
      // non-atomic upsert race. The winning row exists — fetch and return it
      // instead of bubbling a 409 up into the payment screen.
      if (!isUniqueViolation(err)) throw err;
      const existing = await this.prisma.examSchedule.findUnique({ where: uniqueWhere });
      if (!existing) throw err;
      schedule = existing;
    }

    await this.warmSeatCache(schedule.id);
    return schedule;
  }

  /**
   * Returns a calendar map of dates (YYYY-MM-DD) that have available schedules for a given month.
   */
  async getCalendar(
    year: number,
    month: number,
    certType?: CertType,
    level?: CertLevel,
  ) {
    if (certType && isSeriesSuspended(certType)) return [];

    const monthStart = new Date(year, month - 1, 1);
    const monthEnd = new Date(year, month, 0, 23, 59, 59);

    const schedules = await this.prisma.examSchedule.findMany({
      where: {
        status: { in: [ScheduleStatus.REGISTRATION_OPEN, ScheduleStatus.UPCOMING] },
        certType: certType ?? undefined,
        level: level ?? undefined,
        examDate: { gte: monthStart, lte: monthEnd },
      },
      select: {
        examDate: true,
        certType: true,
        level: true,
        status: true,
        capacity: true,
        currentCount: true,
      },
      orderBy: [{ examDate: 'asc' }],
    });

    // Group by date string
    const byDate = new Map<string, { count: number; hasOpen: boolean }>();
    for (const s of schedules) {
      const key = s.examDate.toISOString().slice(0, 10);
      const existing = byDate.get(key) ?? { count: 0, hasOpen: false };
      byDate.set(key, {
        count: existing.count + 1,
        hasOpen: existing.hasOpen || s.status === ScheduleStatus.REGISTRATION_OPEN,
      });
    }

    // On-demand (L1/L2/L3): every weekday in this month from today onward is
    // bookable via virtual hourly slots. Mark them open in the calendar even
    // when no ExamSchedule row exists yet — registration materializes the row
    // lazily. (Requires a specific level; the all-levels view stays DB-only.)
    if (isOnDemandLevel(level)) {
      const settings = await this.getOnDemandSettings();
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const hoursPerDay = settings.businessHoursEnd - settings.businessHoursStart;
      const lastDay = new Date(year, month, 0).getDate();
      for (let day = 1; day <= lastDay; day += 1) {
        const d = new Date(year, month - 1, day);
        if (d < today) continue;
        if (!isWeekday(d)) continue;
        const key = toLocalIsoDate(d);
        const existing = byDate.get(key);
        if (existing) {
          byDate.set(key, { count: existing.count, hasOpen: true });
        } else {
          byDate.set(key, { count: hoursPerDay, hasOpen: true });
        }
      }
    }

    return Array.from(byDate.entries()).map(([date, info]) => ({
      date,
      sessionCount: info.count,
      hasOpen: info.hasOpen,
    }));
  }

  /**
   * Next free per-year round number for an on-demand schedule. Used by
   * `createOnDemand`, which is racy by design — `max(roundNumber) + 1` can
   * collide across concurrent callers, and the loser retries.
   */
  private async nextOnDemandRoundNumber(
    certType: CertType,
    level: CertLevel,
    year: number,
  ): Promise<number> {
    const lastRound = await this.prisma.examSchedule.findFirst({
      where: { certType, level, year },
      orderBy: { roundNumber: 'desc' },
      select: { roundNumber: true },
    });
    return (lastRound?.roundNumber ?? 0) + 1;
  }

  /** Warm the Redis seat cache for a schedule (called when a schedule opens). */
  async warmSeatCache(scheduleId: string): Promise<void> {
    const s = await this.prisma.examSchedule.findUnique({ where: { id: scheduleId } });
    if (!s) return;
    const remaining = s.capacity - s.currentCount;
    await this.redis.set(`schedule:seats:${scheduleId}`, String(remaining), 3600);
  }

  /**
   * Admin: create a scheduled exam round with explicit registration window,
   * capacity, venue, and start time. Uses existing ExamSchedule columns only
   * (no schema change). Round number auto-increments when omitted.
   */
  async createAdmin(dto: CreateAdminScheduleDto) {
    if (!dto.certType) throw new BadRequestException('certType is required');
    if (!dto.level) throw new BadRequestException('level is required');
    if (!dto.examDate) throw new BadRequestException('examDate is required');
    if (!dto.examStartTime || !/^\d{2}:\d{2}$/.test(dto.examStartTime)) {
      throw new BadRequestException('examStartTime must be HH:mm');
    }
    if (!dto.registrationStart) throw new BadRequestException('registrationStart is required');
    if (!dto.registrationEnd) throw new BadRequestException('registrationEnd is required');

    const examDate = this.parseAdminDateTime(dto.examDate, dto.examStartTime);
    const registrationStart = this.parseAdminDateTime(dto.registrationStart, '00:00');
    const registrationEnd = this.parseAdminDateTime(dto.registrationEnd, '23:59');

    if (isNaN(examDate.getTime())) throw new BadRequestException('Invalid examDate');
    if (isNaN(registrationStart.getTime())) throw new BadRequestException('Invalid registrationStart');
    if (isNaN(registrationEnd.getTime())) throw new BadRequestException('Invalid registrationEnd');
    if (registrationEnd.getTime() < registrationStart.getTime()) {
      throw new BadRequestException('registrationEnd must be on or after registrationStart');
    }
    if (examDate.getTime() < registrationStart.getTime()) {
      throw new BadRequestException('examDate must be on or after registrationStart');
    }

    const capacity = dto.capacity ?? 300;
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 99999) {
      throw new BadRequestException('capacity must be an integer between 1 and 99999');
    }

    const status = dto.status ?? ScheduleStatus.UPCOMING;
    const allowed: ScheduleStatus[] = [
      ScheduleStatus.UPCOMING,
      ScheduleStatus.REGISTRATION_OPEN,
      ScheduleStatus.REGISTRATION_CLOSED,
    ];
    if (!allowed.includes(status)) {
      throw new BadRequestException('status must be UPCOMING, REGISTRATION_OPEN, or REGISTRATION_CLOSED');
    }

    const year = examDate.getFullYear();
    const venue = dto.venue?.trim() || 'ONLINE_CBT';
    const venueDetail = dto.venueDetail?.trim() || undefined;

    const ROUND_RETRY_LIMIT = 8;
    let roundNumber =
      dto.roundNumber ??
      (await this.nextOnDemandRoundNumber(dto.certType, dto.level, year));

    if (dto.roundNumber != null) {
      if (!Number.isInteger(dto.roundNumber) || dto.roundNumber < 1) {
        throw new BadRequestException('roundNumber must be a positive integer');
      }
      const clash = await this.prisma.examSchedule.findUnique({
        where: {
          certType_level_year_roundNumber: {
            certType: dto.certType,
            level: dto.level,
            year,
            roundNumber: dto.roundNumber,
          },
        },
        select: { id: true },
      });
      if (clash) {
        throw new BadRequestException(
          `Round ${dto.roundNumber} already exists for ${dto.certType} ${dto.level} ${year}`,
        );
      }
    }

    let schedule;
    for (let attempt = 0; ; attempt += 1) {
      try {
        schedule = await this.prisma.examSchedule.create({
          data: {
            certType: dto.certType,
            level: dto.level,
            year,
            roundNumber,
            examDate,
            examStartTime: dto.examStartTime,
            registrationStart,
            registrationEnd,
            capacity,
            venue,
            venueDetail,
            status,
          },
        });
        break;
      } catch (err) {
        if (dto.roundNumber != null || !isUniqueViolation(err) || attempt >= ROUND_RETRY_LIMIT) {
          throw err;
        }
        roundNumber = await this.nextOnDemandRoundNumber(dto.certType, dto.level, year);
      }
    }

    await this.warmSeatCache(schedule.id);
    return schedule;
  }

  /**
   * Admin: update an existing exam round. Validates date window / capacity /
   * unique (cert, level, year, round) the same way as createAdmin.
   */
  async updateAdmin(id: string, dto: UpdateAdminScheduleDto) {
    const existing = await this.prisma.examSchedule.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Schedule not found');

    const certType = dto.certType ?? existing.certType;
    const level = dto.level ?? existing.level;
    const examStartTime = dto.examStartTime ?? existing.examStartTime;
    if (!/^\d{2}:\d{2}$/.test(examStartTime)) {
      throw new BadRequestException('examStartTime must be HH:mm');
    }

    const examDate = dto.examDate
      ? this.parseAdminDateTime(dto.examDate, examStartTime)
      : (() => {
          const d = new Date(existing.examDate);
          const [hh, mm] = examStartTime.split(':');
          d.setHours(Number(hh), Number(mm), 0, 0);
          return d;
        })();
    const registrationStart = dto.registrationStart
      ? this.parseAdminDateTime(dto.registrationStart, '00:00')
      : existing.registrationStart;
    const registrationEnd = dto.registrationEnd
      ? this.parseAdminDateTime(dto.registrationEnd, '23:59')
      : existing.registrationEnd;

    if (isNaN(examDate.getTime())) throw new BadRequestException('Invalid examDate');
    if (isNaN(registrationStart.getTime())) throw new BadRequestException('Invalid registrationStart');
    if (isNaN(registrationEnd.getTime())) throw new BadRequestException('Invalid registrationEnd');
    if (registrationEnd.getTime() < registrationStart.getTime()) {
      throw new BadRequestException('registrationEnd must be on or after registrationStart');
    }
    if (examDate.getTime() < registrationStart.getTime()) {
      throw new BadRequestException('examDate must be on or after registrationStart');
    }

    const capacity = dto.capacity ?? existing.capacity;
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 99999) {
      throw new BadRequestException('capacity must be an integer between 1 and 99999');
    }
    if (capacity < existing.currentCount) {
      throw new BadRequestException(
        `capacity cannot be less than current registrations (${existing.currentCount})`,
      );
    }

    const status = dto.status ?? existing.status;
    const allowed: ScheduleStatus[] = [
      ScheduleStatus.UPCOMING,
      ScheduleStatus.REGISTRATION_OPEN,
      ScheduleStatus.REGISTRATION_CLOSED,
      ScheduleStatus.IN_PROGRESS,
      ScheduleStatus.COMPLETED,
      ScheduleStatus.CANCELLED,
    ];
    if (!allowed.includes(status)) {
      throw new BadRequestException('Invalid schedule status');
    }

    const year = examDate.getFullYear();
    const roundNumber = dto.roundNumber ?? existing.roundNumber;
    if (!Number.isInteger(roundNumber) || roundNumber < 1) {
      throw new BadRequestException('roundNumber must be a positive integer');
    }

    const keyChanged =
      certType !== existing.certType ||
      level !== existing.level ||
      year !== existing.year ||
      roundNumber !== existing.roundNumber;
    if (keyChanged) {
      const clash = await this.prisma.examSchedule.findUnique({
        where: {
          certType_level_year_roundNumber: { certType, level, year, roundNumber },
        },
        select: { id: true },
      });
      if (clash && clash.id !== id) {
        throw new BadRequestException(
          `Round ${roundNumber} already exists for ${certType} ${level} ${year}`,
        );
      }
    }

    const venue = dto.venue !== undefined ? dto.venue.trim() || 'ONLINE_CBT' : existing.venue;
    const venueDetail =
      dto.venueDetail !== undefined
        ? dto.venueDetail.trim() || null
        : existing.venueDetail;

    const schedule = await this.prisma.examSchedule.update({
      where: { id },
      data: {
        certType,
        level,
        year,
        roundNumber,
        examDate,
        examStartTime,
        registrationStart,
        registrationEnd,
        capacity,
        venue,
        venueDetail,
        status,
        cancelledAt:
          status === ScheduleStatus.CANCELLED
            ? existing.cancelledAt ?? new Date()
            : null,
      },
    });

    await this.warmSeatCache(schedule.id);
    return schedule;
  }

  /** Parse YYYY-MM-DD (optional HH:mm) or full ISO into a Date. */
  private parseAdminDateTime(raw: string, defaultTime: string): Date {
    const trimmed = raw.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      const [hh, mm] = defaultTime.split(':');
      const d = new Date(
        Number(trimmed.slice(0, 4)),
        Number(trimmed.slice(5, 7)) - 1,
        Number(trimmed.slice(8, 10)),
        Number(hh),
        Number(mm),
        defaultTime === '23:59' ? 59 : 0,
        0,
      );
      return d;
    }
    return new Date(trimmed);
  }

  /**
   * Create an on-demand schedule for any date/time.
   * Online exams can be scheduled flexibly — no fixed time slots.
   * Registration opens immediately and stays open until exam time.
   * 
   * For immediate start: set examDate to now or a few minutes in the future.
   */
  async createOnDemand(dto: CreateOnDemandScheduleDto) {
    let examDate = new Date(dto.examDate);
    if (isNaN(examDate.getTime())) {
      throw new BadRequestException('Invalid examDate format');
    }

    const isOnlineExam = !dto.venue || dto.venue === 'ONLINE_CBT' || dto.venue === 'ONLINE';
    
    // For online exams, allow immediate start (set exam date to now if in the past)
    if (isOnlineExam && examDate.getTime() < Date.now()) {
      examDate = new Date(); // Start immediately
    } else if (!isOnlineExam && examDate.getTime() < Date.now()) {
      throw new BadRequestException('Exam date must be in the future for physical venues');
    }

    const year = examDate.getFullYear();
    const examStartTime = dto.examStartTime ?? 
      `${String(examDate.getHours()).padStart(2, '0')}:${String(examDate.getMinutes()).padStart(2, '0')}`;

    // Registration opens immediately, closes far in the future for online exams
    const registrationStart = new Date();
    const registrationEnd = isOnlineExam
      ? new Date(Date.now() + 365 * 24 * 60 * 60_000) // 1 year for online
      : new Date(examDate.getTime() - 10 * 60_000);   // 10 min before for physical

    // Pick the next round number for this cert/level/year. The "max+1"
    // computation is inherently racy across concurrent requests, so we
    // tolerate up to a handful of unique-key collisions and bump the counter
    // instead of bubbling the conflict up into the payment UI.
    const ROUND_RETRY_LIMIT = 8;
    let roundNumber = await this.nextOnDemandRoundNumber(
      dto.certType,
      dto.level,
      year,
    );

    let schedule;
    for (let attempt = 0; ; attempt += 1) {
      try {
        schedule = await this.prisma.examSchedule.create({
          data: {
            certType: dto.certType,
            level: dto.level,
            year,
            roundNumber,
            examDate,
            examStartTime,
            registrationStart,
            registrationEnd,
            capacity: dto.capacity ?? 9999, // Large capacity for online
            venue: dto.venue ?? 'ONLINE_CBT',
            status: ScheduleStatus.REGISTRATION_OPEN,
          },
        });
        break;
      } catch (err) {
        if (!isUniqueViolation(err) || attempt >= ROUND_RETRY_LIMIT) throw err;
        roundNumber = await this.nextOnDemandRoundNumber(
          dto.certType,
          dto.level,
          year,
        );
      }
    }

    // Warm the seat cache
    await this.warmSeatCache(schedule.id);

    return schedule;
  }

  /**
   * Find or create a schedule for the requested date/time.
   * For online exams, we auto-create schedules on demand.
   */
  async findOrCreateOnDemand(dto: CreateOnDemandScheduleDto) {
    const examDate = new Date(dto.examDate);
    const dayStart = new Date(examDate);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(examDate);
    dayEnd.setHours(23, 59, 59, 999);

    // Check if there's already a schedule for this cert/level/day with available seats
    const existing = await this.prisma.examSchedule.findFirst({
      where: {
        certType: dto.certType,
        level: dto.level,
        status: ScheduleStatus.REGISTRATION_OPEN,
        examDate: { gte: dayStart, lte: dayEnd },
      },
      orderBy: { examDate: 'asc' },
    });

    if (existing && existing.currentCount < existing.capacity) {
      return { schedule: existing, created: false };
    }

    // Create a new on-demand schedule
    const schedule = await this.createOnDemand(dto);
    return { schedule, created: true };
  }
}
