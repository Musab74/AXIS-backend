import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  AccountStatus,
  CertType,
  ExamSessionStatus,
  PenaltyStatus,
  Prisma,
  RegistrationStatus,
  Role,
  UserPenalty,
} from '@prisma/client';
import * as bcrypt from 'bcrypt';
import ExcelJS from 'exceljs';
import { PrismaService } from '../../common/prisma.service';
import { AuthenticatedUser } from '../../common/types/authenticated-user';
import { maskBirthDate, maskPhone } from '../../common/utils/pii-mask.util';
import { RedisService } from '../../integrations/redis/redis.service';
import { AuthSessionService } from '../auth/auth-session.service';
import { LoginAuditService } from '../auth/login-audit.service';
import { MAX_ATTEMPTS } from '../cbtSessions/exam-spec';
import { getBonusAttempts, MAX_BONUS_ATTEMPTS } from '../cbtSessions/registration-bonus-attempts';
import { CertificatesService } from '../certificates/certificates.service';
import { isDemoPayment } from '../payments/portone-payment.types';
import { SearchUsersDto } from './dto/search-users.dto';
import {
  SearchExamineesDto,
  ExamineeStatus,
  PaymentStatusFilter,
} from './dto/search-examinees.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { IssuePenaltyDto } from './dto/issue-penalty.dto';
import { CreateExpertDto } from './dto/create-expert.dto';
import {
  ExpertSummary,
  ExamSessionSummary,
  ExamineeCertificate,
  ExamineeDetail,
  ExamineeListPayment,
  ExamineeListRow,
  ExamineeListSchedule,
  ExamineeListSession,
  ExamineeListResult,
  ExamineeListCounts,
  ExamineeRegistrationDetail,
  IssuedPenalty,
  MemberProfile,
  MemberIdentityHistory,
  AccountLinkage,
  IdentityVerificationAttemptSummary,
  CarrierVerificationEntry,
  RegistrationSummary,
  SearchUsersResult,
  UserActivity,
  UserDetail,
  UserPenaltySummary,
  UserRoleSummary,
  UserSummary,
} from './admin-users.types';

export interface ExamineeExportFile {
  buffer: Buffer;
  fileName: string;
  contentType: string;
}

// Local audit-action enum. The Prisma `AuditAction` enum / `AdminAuditLog`
// model were removed from the schema, so we record audit events to the Nest
// logger (-> pm2 logs) instead of a DB table. Adding the table back would
// require a production migration, which is out of scope here.
const AuditAction = {
  ROLE_GRANTED: 'ROLE_GRANTED',
  ROLE_REVOKED: 'ROLE_REVOKED',
  PENALTY_ISSUED: 'PENALTY_ISSUED',
  PENALTY_RELEASED: 'PENALTY_RELEASED',
  PASSWORD_RESET: 'PASSWORD_RESET',
  PII_REVEALED: 'PII_REVEALED',
} as const;
type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];

interface AuditLogParams {
  actorUser: AuthenticatedUser;
  action: AuditAction;
  targetId: string;
  targetName: string;
  before?: object;
  after?: object;
  ip: string;
  userAgent?: string;
}

/**
 * Logical examinee statuses whose source-of-truth lives on the Registration
 * row itself; we can DB-filter these directly. Anything else requires a
 * post-filter pass after we've joined the matching ExamSession + certificate.
 */
const REGISTRATION_DRIVEN_STATUSES: ReadonlyMap<
  ExamineeStatus,
  RegistrationStatus[]
> = new Map([
  ['NOT_STARTED', [RegistrationStatus.PAID]],
  ['PENDING_PAYMENT', [RegistrationStatus.PENDING_PAYMENT]],
  ['CANCELLED', [RegistrationStatus.CANCELLED]],
  ['REFUNDED', [RegistrationStatus.REFUNDED]],
]);

/** Payment filters for the registrations screen → registration.status groups. */
const PAYMENT_STATUS_TO_REG: ReadonlyMap<PaymentStatusFilter, RegistrationStatus[]> = new Map([
  ['PENDING', [RegistrationStatus.PENDING_PAYMENT]],
  ['CONFIRMED', [RegistrationStatus.PAID, RegistrationStatus.EXAM_COMPLETED]],
  ['REFUNDED', [RegistrationStatus.REFUNDED]],
]);

/**
 * Statuses that are visible in the Examinees screen by default. We exclude
 * raw cancelled/refunded only when the admin asks for them via the filter.
 * `EXAM_COMPLETED` is always visible because it represents finished sessions.
 */
const DEFAULT_REGISTRATION_STATUSES: RegistrationStatus[] = [
  RegistrationStatus.PENDING_PAYMENT,
  RegistrationStatus.PAID,
  RegistrationStatus.EXAM_COMPLETED,
  RegistrationStatus.CANCELLED,
  RegistrationStatus.REFUNDED,
];

/** Pre-filter window when status requires a session/cert-level post-filter. */
const POST_FILTER_FETCH_CAP = 1_000;

/** Hard cap for Excel export rows. */
const EXPORT_FETCH_CAP = 5_000;

const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** True iff the candidate has started or finished the exam (used by refund gating). */
function isStartedSessionStatus(s: ExamSessionStatus): boolean {
  return (
    s === ExamSessionStatus.IN_PROGRESS ||
    s === ExamSessionStatus.SUBMITTED ||
    s === ExamSessionStatus.GRADED ||
    s === ExamSessionStatus.TERMINATED
  );
}

@Injectable()
export class AdminUsersService {
  private readonly auditLogger = new Logger('AdminAudit');

  constructor(
    private readonly prisma: PrismaService,
    private readonly certificates: CertificatesService,
    private readonly loginAudit: LoginAuditService,
    private readonly redis: RedisService,
    private readonly authSessions: AuthSessionService,
  ) {}

  async searchUsers(dto: SearchUsersDto): Promise<SearchUsersResult> {
    const page = dto.page ?? 1;
    const limit = dto.limit ?? 20;
    const where = this.buildSearchWhere(dto);
    // KPI breakdown respects q/role but ignores accountStatus so cards stay meaningful while filtering.
    const kpiBase = this.buildSearchWhere({ ...dto, accountStatus: undefined });

    const [rows, total, active, suspended, withPenalty] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        include: {
          roles: { where: { revokedAt: null } },
          penalties: { where: { status: PenaltyStatus.ACTIVE } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.user.count({ where }),
      this.prisma.user.count({
        where: { ...kpiBase, accountStatus: AccountStatus.ACTIVE },
      }),
      this.prisma.user.count({
        where: { ...kpiBase, accountStatus: AccountStatus.SUSPENDED },
      }),
      this.prisma.user.count({
        where: {
          ...kpiBase,
          penalties: { some: { status: PenaltyStatus.ACTIVE } },
        },
      }),
    ]);

    return {
      items: rows.map((u) => this.toSummary(u, u.roles.map((r) => r.role), u.penalties.length)),
      total,
      page,
      limit,
      counts: { active, suspended, withPenalty },
    };
  }

  /**
   * Excel export of the filtered member list (same filters as searchUsers,
   * up to {@link EXPORT_FETCH_CAP} rows).
   */
  async exportUsers(dto: SearchUsersDto): Promise<ExamineeExportFile> {
    const where = this.buildSearchWhere(dto);
    const rows = await this.prisma.user.findMany({
      where,
      include: {
        roles: { where: { revokedAt: null } },
        penalties: { where: { status: PenaltyStatus.ACTIVE } },
      },
      orderBy: { createdAt: 'desc' },
      take: EXPORT_FETCH_CAP,
      skip: 0,
    });

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Members');
    ws.columns = [
      { header: '회원ID', key: 'userId', width: 18 },
      { header: '이름', key: 'name', width: 22 },
      { header: '이메일', key: 'email', width: 28 },
      { header: '전화번호', key: 'phone', width: 14 },
      { header: '계정상태', key: 'status', width: 12 },
      { header: '본인인증', key: 'nice', width: 10 },
      { header: '역할', key: 'roles', width: 28 },
      { header: '활성제재', key: 'penalties', width: 10 },
      { header: '가입일', key: 'joined', width: 14 },
      { header: '최근로그인', key: 'lastLogin', width: 18 },
    ];
    const header = ws.getRow(1);
    header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    header.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF1E293B' },
    };

    for (const u of rows) {
      ws.addRow({
        userId: u.userId,
        name: u.name,
        email: u.email ?? '—',
        phone: maskPhone(u.phone),
        status: u.accountStatus,
        nice: u.niceVerified ? 'Y' : 'N',
        roles: u.roles.map((r) => r.role).join(', '),
        penalties: u.penalties.length,
        joined: this.fmtExportDate(u.createdAt),
        lastLogin: u.lastLoginAt ? this.fmtExportDateTime(u.lastLoginAt) : '—',
      });
    }
    ws.addRow([]);
    const foot = ws.addRow([`총 ${rows.length}건`]);
    foot.font = { italic: true, color: { argb: 'FF64748B' } };

    const data = await wb.xlsx.writeBuffer();
    const stamp = new Date().toISOString().slice(0, 10);
    return {
      buffer: Buffer.from(data),
      fileName: `members_${stamp}.xlsx`,
      contentType: XLSX_MIME,
    };
  }

  async getUserDetail(targetId: string): Promise<UserDetail> {
    const user = await this.prisma.user.findUnique({
      where: { id: targetId },
      include: {
        roles: { where: { revokedAt: null }, orderBy: { grantedAt: 'desc' } },
        penalties: { orderBy: { createdAt: 'desc' } },
        registrations: { orderBy: { createdAt: 'desc' }, take: 5 },
        examSessions: { orderBy: { createdAt: 'desc' }, take: 5 },
      },
    });
    if (!user) {
      throw new NotFoundException('사용자를 찾을 수 없습니다');
    }

    const activeRoles = user.roles.map((r) => r.role);
    const activePenaltyCount = user.penalties.filter(
      (p) => p.status === PenaltyStatus.ACTIVE,
    ).length;

    const summary = this.toSummary(user, activeRoles, activePenaltyCount);

    return {
      ...summary,
      birthDate: maskBirthDate(user.birthDate),
      gender: user.gender,
      rolesDetail: user.roles.map<UserRoleSummary>((r) => ({
        role: r.role,
        grantedAt: r.grantedAt,
        grantedBy: r.grantedBy,
      })),
      penalties: user.penalties.map<UserPenaltySummary>((p) => ({
        id: p.id,
        reason: p.reason,
        status: p.status,
        startAt: p.startAt,
        endAt: p.endAt,
        releasedAt: p.releasedAt,
        releaseReason: p.releaseReason,
        sessionId: p.sessionId,
        decidedBy: p.decidedBy,
      })),
      registrations: user.registrations.map<RegistrationSummary>((r) => ({
        id: r.id,
        certType: r.certType,
        level: r.level,
        status: r.status,
        registrationNumber: r.registrationNumber,
        createdAt: r.createdAt,
      })),
      examSessions: user.examSessions.map<ExamSessionSummary>((s) => ({
        id: s.id,
        certType: s.certType,
        level: s.level,
        status: s.status,
        attemptNo: s.attemptNo,
        startedAt: s.startedAt,
        submittedAt: s.submittedAt,
        passed: s.passed,
      })),
    };
  }

  async updateRole(
    actorUser: AuthenticatedUser,
    targetId: string,
    dto: UpdateRoleDto,
    ip: string,
  ): Promise<void> {
    if (actorUser.id === targetId) {
      throw new ForbiddenException('본인의 권한은 수정할 수 없습니다');
    }
    const target = await this.prisma.user.findUnique({ where: { id: targetId } });
    if (!target) {
      throw new NotFoundException('사용자를 찾을 수 없습니다');
    }

    if (dto.grant) {
      await this.grantRole(actorUser, targetId, dto.role);
    } else {
      await this.revokeRole(targetId, dto.role);
    }

    await this.writeAuditLog({
      actorUser,
      action: dto.grant ? AuditAction.ROLE_GRANTED : AuditAction.ROLE_REVOKED,
      targetId,
      targetName: target.name,
      before: { role: dto.role, active: !dto.grant },
      after: { role: dto.role, active: dto.grant },
      ip,
    });
  }

  async issuePenalty(
    actorUser: AuthenticatedUser,
    targetId: string,
    dto: IssuePenaltyDto,
    ip: string,
  ): Promise<IssuedPenalty> {
    const startAt = new Date(dto.startAt);
    const endAt = new Date(dto.endAt);
    if (endAt <= startAt) {
      throw new BadRequestException('종료일은 시작일보다 이후여야 합니다');
    }

    const target = await this.prisma.user.findUnique({ where: { id: targetId } });
    if (!target) {
      throw new NotFoundException('사용자를 찾을 수 없습니다');
    }

    const existing = await this.prisma.userPenalty.findFirst({
      where: { userId: targetId, status: PenaltyStatus.ACTIVE },
    });
    if (existing) {
      throw new ConflictException('이미 활성 제재가 있습니다');
    }

    const penalty = await this.prisma.$transaction(async (tx) => {
      const created = await tx.userPenalty.create({
        data: {
          userId: targetId,
          reason: dto.reason,
          startAt,
          endAt,
          sessionId: dto.relatedSessionId,
          decidedBy: actorUser.id,
          status: PenaltyStatus.ACTIVE,
        },
      });
      await tx.user.update({
        where: { id: targetId },
        data: { accountStatus: AccountStatus.SUSPENDED },
      });
      return created;
    });

    await this.writeAuditLog({
      actorUser,
      action: AuditAction.PENALTY_ISSUED,
      targetId,
      targetName: target.name,
      before: { accountStatus: target.accountStatus },
      after: { accountStatus: AccountStatus.SUSPENDED, penaltyId: penalty.id },
      ip,
    });

    return penalty;
  }

  async releasePenalty(
    actorUser: AuthenticatedUser,
    targetId: string,
    penaltyId: string,
    releaseReason: string,
    ip: string,
  ): Promise<void> {
    const target = await this.prisma.user.findUnique({ where: { id: targetId } });
    if (!target) {
      throw new NotFoundException('사용자를 찾을 수 없습니다');
    }
    const penalty = await this.prisma.userPenalty.findFirst({
      where: { id: penaltyId, userId: targetId, status: PenaltyStatus.ACTIVE },
    });
    if (!penalty) {
      throw new NotFoundException('활성 제재를 찾을 수 없습니다');
    }

    const accountRestored = await this.prisma.$transaction(async (tx) => {
      await tx.userPenalty.update({
        where: { id: penaltyId },
        data: {
          status: PenaltyStatus.RELEASED,
          releasedAt: new Date(),
          releaseReason,
        },
      });
      const remaining = await tx.userPenalty.count({
        where: { userId: targetId, status: PenaltyStatus.ACTIVE },
      });
      if (remaining === 0) {
        await tx.user.update({
          where: { id: targetId },
          data: { accountStatus: AccountStatus.ACTIVE },
        });
        return true;
      }
      return false;
    });

    await this.writeAuditLog({
      actorUser,
      action: AuditAction.PENALTY_RELEASED,
      targetId,
      targetName: target.name,
      before: { penaltyId, status: PenaltyStatus.ACTIVE },
      after: {
        penaltyId,
        status: PenaltyStatus.RELEASED,
        accountStatus: accountRestored ? AccountStatus.ACTIVE : target.accountStatus,
      },
      ip,
    });
  }

  // ─── Password reset (admin-forced) ───────────────────────────────────────

  /**
   * Fixed temp password assigned by an admin reset. The account is flagged
   * with `mustChangePassword` so the portal forces a change on next login.
   */
  static readonly TEMP_PASSWORD = 'aa123';

  async resetPassword(
    actorUser: AuthenticatedUser,
    targetId: string,
    ip: string,
  ): Promise<{ ok: true; tempPassword: string }> {
    if (actorUser.id === targetId) {
      throw new ForbiddenException('본인 계정은 이 기능으로 초기화할 수 없습니다');
    }
    const target = await this.prisma.user.findUnique({ where: { id: targetId } });
    if (!target) {
      throw new NotFoundException('사용자를 찾을 수 없습니다');
    }

    const passwordHash = await bcrypt.hash(AdminUsersService.TEMP_PASSWORD, 12);
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: targetId },
        data: { passwordHash, mustChangePassword: true },
      }),
      this.prisma.auditLog.create({
        data: {
          actorId: actorUser.id,
          action: AuditAction.PASSWORD_RESET,
          entityType: 'USER',
          entityId: targetId,
          after: { mustChangePassword: true },
        },
      }),
    ]);
    // Kick any live session — the target must sign back in with the temp password.
    await this.authSessions.revokeSession(targetId);

    await this.writeAuditLog({
      actorUser,
      action: AuditAction.PASSWORD_RESET,
      targetId,
      targetName: target.name,
      after: { mustChangePassword: true },
      ip,
    });

    return { ok: true, tempPassword: AdminUsersService.TEMP_PASSWORD };
  }

  // ─── Audited PII reveal ──────────────────────────────────────────────────

  /**
   * Return the raw phone / birth date that list and detail endpoints mask.
   * The audit row (with the admin's reason) is written first — if it cannot
   * be persisted, the reveal is refused.
   */
  async revealPii(
    actorUser: AuthenticatedUser,
    targetId: string,
    reason: string,
    ip: string,
  ): Promise<{ phone: string; birthDate: string | null }> {
    // DTO MinLength doesn't trim — a whitespace-only reason would produce a
    // meaningless audit trail, so reject it here.
    const trimmedReason = reason.trim();
    if (trimmedReason.length < 2) {
      throw new BadRequestException('열람 사유를 입력해주세요');
    }
    const target = await this.prisma.user.findUnique({
      where: { id: targetId },
      select: { id: true, name: true, phone: true, birthDate: true },
    });
    if (!target) {
      throw new NotFoundException('사용자를 찾을 수 없습니다');
    }

    await this.prisma.auditLog.create({
      data: {
        actorId: actorUser.id,
        action: AuditAction.PII_REVEALED,
        entityType: 'USER',
        entityId: targetId,
        reason: trimmedReason,
        after: { fields: ['phone', 'birthDate'] },
      },
    });
    await this.writeAuditLog({
      actorUser,
      action: AuditAction.PII_REVEALED,
      targetId,
      targetName: target.name,
      after: { fields: ['phone', 'birthDate'], reason: trimmedReason },
      ip,
    });

    return { phone: target.phone, birthDate: target.birthDate };
  }

  // ─── Expert (grader) management ──────────────────────────────────────────

  /**
   * Create an EXPERT grader account directly (no NICE 본인인증 — staff are
   * vouched for by the admin). Assigns the EXPERT role and the series the
   * expert may grade, all in one transaction.
   */
  async createExpert(
    actorUser: AuthenticatedUser,
    dto: CreateExpertDto,
    ip: string,
  ): Promise<ExpertSummary> {
    const existingByUserId = await this.prisma.user.findUnique({
      where: { userId: dto.userId },
    });
    if (existingByUserId) {
      throw new ConflictException('이미 사용중인 아이디입니다');
    }
    if (dto.email) {
      const existingByEmail = await this.prisma.user.findUnique({
        where: { email: dto.email },
      });
      if (existingByEmail) {
        throw new ConflictException('이미 사용중인 이메일입니다');
      }
    }

    const passwordHash = await bcrypt.hash(dto.password, 12);
    const competencies = Array.from(new Set(dto.competencies));

    const created = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          userId: dto.userId,
          email: dto.email || null,
          passwordHash,
          name: dto.name,
          phone: dto.phone.replace(/\D/g, ''),
          niceVerified: false,
          accountStatus: AccountStatus.ACTIVE,
        },
      });
      await tx.userRole.create({
        data: { userId: user.id, role: Role.EXPERT, grantedBy: actorUser.id },
      });
      await tx.expertCompetency.createMany({
        data: competencies.map((certType) => ({
          userId: user.id,
          certType,
          grantedBy: actorUser.id,
        })),
      });
      return user;
    });

    await this.writeAuditLog({
      actorUser,
      action: AuditAction.ROLE_GRANTED,
      targetId: created.id,
      targetName: created.name,
      after: { role: Role.EXPERT, competencies },
      ip,
    });

    return {
      id: created.id,
      userId: created.userId,
      name: created.name,
      email: created.email,
      phone: maskPhone(created.phone),
      accountStatus: created.accountStatus,
      competencies,
      activePenaltyCount: 0,
      createdAt: created.createdAt,
      lastLoginAt: created.lastLoginAt,
    };
  }

  /**
   * Replace an expert's series competencies entirely. Deletes existing rows
   * and inserts the new set in one transaction — idempotent and safe to call
   * multiple times.
   */
  async updateExpertCompetencies(
    actor: AuthenticatedUser,
    targetId: string,
    competencies: string[],
  ): Promise<ExpertSummary> {
    const target = await this.prisma.user.findUnique({
      where: { id: targetId },
      include: {
        roles: { where: { role: Role.EXPERT, revokedAt: null } },
        expertCompetencies: true,
        penalties: { where: { status: PenaltyStatus.ACTIVE } },
      },
    });
    if (!target || target.roles.length === 0) {
      throw new NotFoundException('Expert user not found or no active EXPERT role.');
    }
    const cleaned = Array.from(new Set(competencies)) as CertType[];
    await this.prisma.$transaction(async (tx) => {
      await tx.expertCompetency.deleteMany({ where: { userId: targetId } });
      if (cleaned.length > 0) {
        await tx.expertCompetency.createMany({
          data: cleaned.map((certType) => ({
            userId: targetId,
            certType,
            grantedBy: actor.id,
          })),
        });
      }
    });
    await this.writeAuditLog({
      actorUser: actor,
      action: AuditAction.ROLE_GRANTED,
      targetId,
      targetName: target.name,
      after: { competencies: cleaned },
      ip: 'api',
    });
    return {
      id: target.id,
      userId: target.userId,
      name: target.name,
      email: target.email,
      phone: maskPhone(target.phone),
      accountStatus: target.accountStatus,
      competencies: cleaned,
      activePenaltyCount: target.penalties.length,
      createdAt: target.createdAt,
      lastLoginAt: target.lastLoginAt,
    };
  }

  /** List every EXPERT grader with their series competencies. */
  async listExperts(): Promise<ExpertSummary[]> {
    const users = await this.prisma.user.findMany({
      where: { roles: { some: { role: Role.EXPERT, revokedAt: null } } },
      include: {
        expertCompetencies: true,
        penalties: { where: { status: PenaltyStatus.ACTIVE } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return users.map((u) => ({
      id: u.id,
      userId: u.userId,
      name: u.name,
      email: u.email,
      phone: maskPhone(u.phone),
      accountStatus: u.accountStatus,
      competencies: u.expertCompetencies.map((c) => c.certType),
      activePenaltyCount: u.penalties.length,
      createdAt: u.createdAt,
      lastLoginAt: u.lastLoginAt,
    }));
  }

  /** Series an expert is allowed to grade. Empty = no scope assigned yet. */
  async expertCertTypes(userId: string): Promise<CertType[]> {
    const rows = await this.prisma.expertCompetency.findMany({
      where: { userId },
      select: { certType: true },
    });
    return rows.map((r) => r.certType);
  }

  private buildSearchWhere(dto: SearchUsersDto): Prisma.UserWhereInput {
    const where: Prisma.UserWhereInput = {};
    if (dto.q && dto.q.trim().length > 0) {
      const q = dto.q.trim();
      where.OR = [
        { name: { contains: q } },
        { userId: { contains: q } },
        { email: { contains: q } },
        { phone: { contains: q } },
      ];
    }
    if (dto.accountStatus) {
      where.accountStatus = dto.accountStatus;
    }
    if (dto.role) {
      where.roles = { some: { role: dto.role, revokedAt: null } };
    }
    return where;
  }

  private toSummary(
    user: {
      id: string;
      userId: string;
      name: string;
      email: string | null;
      phone: string;
      accountStatus: AccountStatus;
      niceVerified: boolean;
      createdAt: Date;
      lastLoginAt: Date | null;
    },
    roles: Role[],
    activePenaltyCount: number,
  ): UserSummary {
    return {
      id: user.id,
      userId: user.userId,
      name: user.name,
      email: user.email,
      phone: maskPhone(user.phone),
      accountStatus: user.accountStatus,
      niceVerified: user.niceVerified,
      roles,
      activePenaltyCount,
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt,
    };
  }

  private async grantRole(
    actorUser: AuthenticatedUser,
    targetId: string,
    role: Role,
  ): Promise<void> {
    const existing = await this.prisma.userRole.findUnique({
      where: { userId_role: { userId: targetId, role } },
    });
    if (existing) {
      if (existing.revokedAt === null) {
        return;
      }
      await this.prisma.userRole.update({
        where: { id: existing.id },
        data: { revokedAt: null, grantedBy: actorUser.id, grantedAt: new Date() },
      });
      return;
    }
    await this.prisma.userRole.create({
      data: { userId: targetId, role, grantedBy: actorUser.id },
    });
  }

  private async revokeRole(targetId: string, role: Role): Promise<void> {
    const active = await this.prisma.userRole.findFirst({
      where: { userId: targetId, role, revokedAt: null },
    });
    if (!active) {
      throw new NotFoundException('활성 권한을 찾을 수 없습니다');
    }
    await this.prisma.userRole.update({
      where: { id: active.id },
      data: { revokedAt: new Date() },
    });
  }

  // Records an admin action to the application log (pm2 picks it up). The
  // structured single-line JSON makes it greppable for compliance review and
  // easy to ship to a log aggregator later. We deliberately avoid throwing —
  // a logger failure must never roll back the underlying admin action.
  private async writeAuditLog(params: AuditLogParams): Promise<void> {
    try {
      this.auditLogger.log(
        JSON.stringify({
          ts: new Date().toISOString(),
          actorId: params.actorUser.id,
          actorName: params.actorUser.name,
          action: params.action,
          targetId: params.targetId,
          targetName: params.targetName,
          before: params.before ?? null,
          after: params.after ?? null,
          ip: params.ip,
          userAgent: params.userAgent ?? null,
        }),
      );
    } catch {
      /* swallow */
    }
  }

  // ─── Examinee management ─────────────────────────────────────────────────

  /**
   * Admin examinee/registration list.
   *
   * Status filtering:
   * - registration-driven (PENDING_PAYMENT / CANCELLED / REFUNDED / NOT_STARTED→PAID)
   *   and paymentStatus (PENDING / CONFIRMED / REFUNDED) paginate at the DB
   * - session/cert-driven (IN_PROGRESS / SUBMITTED / …) are post-filtered in JS
   *   because `ExamSession.registrationId` is a plain column without a
   *   Prisma relation arrow on the Registration side. We bound the candidate
   *   fetch at {@link POST_FILTER_FETCH_CAP} rows to keep memory predictable.
   */
  async listExaminees(dto: SearchExamineesDto): Promise<ExamineeListResult> {
    const page = dto.page ?? 1;
    const limit = dto.limit ?? 20;
    const wantedStatus = dto.status;
    const paymentStatus = dto.paymentStatus;
    const isPostFilterStatus =
      !paymentStatus && !!wantedStatus && !REGISTRATION_DRIVEN_STATUSES.has(wantedStatus);

    const where = this.buildExamineeWhere(dto);
    const counts = await this.countExamineeKpis(dto);

    const fetchTake = isPostFilterStatus ? POST_FILTER_FETCH_CAP : limit;
    const fetchSkip = isPostFilterStatus ? 0 : (page - 1) * limit;

    const [rows, totalAtDb] = await this.prisma.$transaction([
      this.prisma.registration.findMany({
        where,
        include: {
          user: { select: { id: true, userId: true, name: true, phone: true, email: true } },
          schedule: true,
          payments: { orderBy: { createdAt: 'desc' }, take: 1 },
        },
        orderBy: [{ createdAt: 'desc' }],
        take: fetchTake,
        skip: fetchSkip,
      }),
      this.prisma.registration.count({ where }),
    ]);

    if (rows.length === 0) {
      return { items: [], total: totalAtDb, page, limit, counts };
    }

    const mapped = await this.mapRegistrationRows(rows);

    if (isPostFilterStatus && wantedStatus) {
      const filtered = mapped.filter((row) => row.examineeStatus === wantedStatus);
      const total = filtered.length;
      const start = (page - 1) * limit;
      const items = filtered.slice(start, start + limit);
      return { items, total, page, limit, counts };
    }

    return { items: mapped, total: totalAtDb, page, limit, counts };
  }

  /**
   * Excel export of the filtered examinee/registration list (same filters as
   * list, up to {@link EXPORT_FETCH_CAP} rows).
   */
  async exportExaminees(dto: SearchExamineesDto): Promise<ExamineeExportFile> {
    const where = this.buildExamineeWhere(dto);
    const isPostFilterStatus =
      !dto.paymentStatus && !!dto.status && !REGISTRATION_DRIVEN_STATUSES.has(dto.status);

    const rows = await this.prisma.registration.findMany({
      where,
      include: {
        user: { select: { id: true, userId: true, name: true, phone: true, email: true } },
        schedule: true,
        payments: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
      orderBy: [{ createdAt: 'desc' }],
      take: EXPORT_FETCH_CAP,
      skip: 0,
    });

    let mapped = await this.mapRegistrationRows(rows);
    if (isPostFilterStatus && dto.status) {
      mapped = mapped.filter((row) => row.examineeStatus === dto.status);
    }

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Registrations');
    ws.columns = [
      { header: '접수번호', key: 'reg', width: 24 },
      { header: '이름', key: 'name', width: 20 },
      { header: '이메일', key: 'email', width: 28 },
      { header: '전화번호', key: 'phone', width: 14 },
      { header: '자격', key: 'cert', width: 10 },
      { header: '등급', key: 'level', width: 8 },
      { header: '회차', key: 'round', width: 10 },
      { header: '접수일', key: 'regDate', width: 14 },
      { header: '결제금액', key: 'amount', width: 12 },
      { header: '결제방법', key: 'method', width: 12 },
      { header: '결제상태', key: 'payStatus', width: 14 },
      { header: '접수상태', key: 'regStatus', width: 16 },
      { header: '데모', key: 'demo', width: 8 },
    ];
    const header = ws.getRow(1);
    header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    header.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF1E293B' },
    };

    for (const r of mapped) {
      const pay = r.latestPayment;
      ws.addRow({
        reg: r.registrationNumber ?? '—',
        name: r.user.name,
        email: r.user.email ?? '—',
        phone: r.user.phone ?? '—',
        cert:
          r.schedule.certType === 'AXIS_C'
            ? 'AXIS-C'
            : r.schedule.certType === 'AXIS_H'
              ? 'AXIS-H'
              : 'AXIS',
        level: r.schedule.level,
        round: r.schedule.roundNumber,
        regDate: this.fmtExportDate(r.registrationCreatedAt),
        amount: pay?.amount ?? '',
        method: pay?.method ?? '—',
        payStatus: pay?.status ?? '—',
        regStatus: r.registrationStatus,
        demo: pay?.isDemo ? 'Y' : '',
      });
    }
    ws.addRow([]);
    const foot = ws.addRow([`총 ${mapped.length}건`]);
    foot.font = { italic: true, color: { argb: 'FF64748B' } };

    const data = await wb.xlsx.writeBuffer();
    const stamp = new Date().toISOString().slice(0, 10);
    return {
      buffer: Buffer.from(data),
      fileName: `registrations_${stamp}.xlsx`,
      contentType: XLSX_MIME,
    };
  }

  private buildExamineeWhere(dto: SearchExamineesDto): Prisma.RegistrationWhereInput {
    const where: Prisma.RegistrationWhereInput = {};
    if (dto.certType) where.certType = dto.certType;
    if (dto.level) where.level = dto.level;
    if (dto.q && dto.q.trim().length > 0) {
      const q = dto.q.trim();
      where.OR = [
        { user: { name: { contains: q } } },
        { user: { phone: { contains: q } } },
        { user: { email: { contains: q } } },
        { registrationNumber: { contains: q } },
      ];
    }

    if (dto.paymentStatus && PAYMENT_STATUS_TO_REG.has(dto.paymentStatus)) {
      where.status = { in: PAYMENT_STATUS_TO_REG.get(dto.paymentStatus) };
    } else if (dto.status && REGISTRATION_DRIVEN_STATUSES.has(dto.status)) {
      where.status = { in: REGISTRATION_DRIVEN_STATUSES.get(dto.status) };
    } else {
      where.status = { in: DEFAULT_REGISTRATION_STATUSES };
    }
    return where;
  }

  /** KPI counts scoped to q/cert/level only (ignore status / paymentStatus). */
  private async countExamineeKpis(dto: SearchExamineesDto): Promise<ExamineeListCounts> {
    const base: Prisma.RegistrationWhereInput = {};
    if (dto.certType) base.certType = dto.certType;
    if (dto.level) base.level = dto.level;
    if (dto.q && dto.q.trim().length > 0) {
      const q = dto.q.trim();
      base.OR = [
        { user: { name: { contains: q } } },
        { user: { phone: { contains: q } } },
        { user: { email: { contains: q } } },
        { registrationNumber: { contains: q } },
      ];
    }

    const [pending, paid, refunded] = await this.prisma.$transaction([
      this.prisma.registration.count({
        where: { ...base, status: RegistrationStatus.PENDING_PAYMENT },
      }),
      this.prisma.registration.count({
        where: {
          ...base,
          status: { in: [RegistrationStatus.PAID, RegistrationStatus.EXAM_COMPLETED] },
        },
      }),
      this.prisma.registration.count({
        where: { ...base, status: RegistrationStatus.REFUNDED },
      }),
    ]);
    return { pending, paid, refunded };
  }

  private async mapRegistrationRows(
    rows: Prisma.RegistrationGetPayload<{
      include: {
        user: { select: { id: true; userId: true; name: true; phone: true; email: true } };
        schedule: true;
        payments: true;
      };
    }>[],
  ): Promise<ExamineeListRow[]> {
    const regIds = rows.map((r) => r.id);
    const sessions =
      regIds.length === 0
        ? []
        : await this.prisma.examSession.findMany({
            where: { registrationId: { in: regIds } },
            orderBy: [{ attemptNo: 'desc' }, { createdAt: 'desc' }],
          });
    const sessionByReg = new Map<string, (typeof sessions)[number]>();
    for (const s of sessions) {
      if (!s.registrationId) continue;
      if (!sessionByReg.has(s.registrationId)) {
        sessionByReg.set(s.registrationId, s);
      }
    }

    const sessionIds = sessions.map((s) => s.id);
    const certifiedSessionIds = sessionIds.length
      ? await this.fetchCertifiedSessionIds(sessionIds)
      : new Set<string>();

    return rows.map((r) =>
      this.toExamineeRow(r, sessionByReg.get(r.id) ?? null, certifiedSessionIds),
    );
  }

  private fmtExportDate(iso: string | Date): string {
    const d = typeof iso === 'string' ? new Date(iso) : iso;
    if (Number.isNaN(d.getTime())) return '—';
    return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
  }

  private fmtExportDateTime(iso: string | Date): string {
    const d = typeof iso === 'string' ? new Date(iso) : iso;
    if (Number.isNaN(d.getTime())) return '—';
    return `${this.fmtExportDate(d)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  async getExamineeDetail(userId: string): Promise<ExamineeDetail> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        penalties: { orderBy: { createdAt: 'desc' } },
        registrations: {
          orderBy: { createdAt: 'desc' },
          include: {
            schedule: true,
            payments: { orderBy: { createdAt: 'desc' }, take: 1 },
          },
        },
      },
    });
    if (!user) throw new NotFoundException('사용자를 찾을 수 없습니다');

    const regIds = user.registrations.map((r) => r.id);
    const sessions = regIds.length
      ? await this.prisma.examSession.findMany({
          where: { OR: [{ registrationId: { in: regIds } }, { userId }] },
          orderBy: [{ attemptNo: 'desc' }, { createdAt: 'desc' }],
        })
      : [];

    const sessionsByReg = new Map<string, typeof sessions>();
    for (const s of sessions) {
      if (!s.registrationId) continue;
      const list = sessionsByReg.get(s.registrationId);
      if (list) list.push(s);
      else sessionsByReg.set(s.registrationId, [s]);
    }

    const certifiedSessionIds = sessions.length
      ? await this.fetchCertifiedSessionIds(sessions.map((s) => s.id))
      : new Set<string>();

    const certificates = await this.certificates.listMine(userId);

    const registrations: ExamineeRegistrationDetail[] = await Promise.all(
      user.registrations.map(async (r) => {
        const regSessions = (sessionsByReg.get(r.id) ?? []).map((s) =>
          this.toExamineeSession(s),
        );
        const latestPayment = r.payments[0] ? this.toExamineePayment(r.payments[0]) : null;
        const refundable =
          r.status === RegistrationStatus.PAID &&
          !latestPayment?.isDemo &&
          !regSessions.some((s) => isStartedSessionStatus(s.status));
        const attemptStats = await this.buildRegistrationAttemptStats(
          r.id,
          r.status,
          regSessions,
        );
        return {
          id: r.id,
          registrationNumber: r.registrationNumber,
          status: r.status,
          certType: r.certType,
          level: r.level,
          partialExempt: r.partialExempt,
          cancelledAt: r.cancelledAt,
          createdAt: r.createdAt,
          examDeadline: r.examDeadline,
          schedule: this.toExamineeSchedule(r.schedule),
          latestPayment,
          sessions: regSessions,
          refundable,
          ...attemptStats,
        };
      }),
    );

    const mappedCerts: ExamineeCertificate[] = certificates.map((c) => ({
      id: c.id,
      certNumber: c.certNumber,
      certType: c.certType,
      level: c.level,
      issuedAt: c.issuedAt,
      validUntil: c.validUntil,
      totalScore: c.totalScore,
      sessionId: c.sessionId,
    }));

    void certifiedSessionIds;

    return {
      user: {
        id: user.id,
        userId: user.userId,
        name: user.name,
        phone: maskPhone(user.phone),
        email: user.email,
        accountStatus: user.accountStatus,
        niceVerified: user.niceVerified,
        birthDate: maskBirthDate(user.birthDate),
        gender: user.gender,
        createdAt: user.createdAt,
        lastLoginAt: user.lastLoginAt,
      },
      registrations,
      certificates: mappedCerts,
      penalties: user.penalties.map<UserPenaltySummary>((p) => ({
        id: p.id,
        reason: p.reason,
        status: p.status,
        startAt: p.startAt,
        endAt: p.endAt,
        releasedAt: p.releasedAt,
        releaseReason: p.releaseReason,
        sessionId: p.sessionId,
        decidedBy: p.decidedBy,
      })),
      activePenaltyCount: user.penalties.filter((p) => p.status === PenaltyStatus.ACTIVE).length,
    };
  }

  async getMemberProfile(userId: string): Promise<MemberProfile> {
    const [detail, user, identityHistory] = await Promise.all([
      this.getExamineeDetail(userId),
      this.prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          niceVerified: true,
          ci: true,
          referenceFaceUpdatedAt: true,
          roles: { where: { revokedAt: null }, orderBy: { grantedAt: 'desc' } },
        },
      }),
      this.getMemberIdentityHistory(userId),
    ]);
    if (!user) throw new NotFoundException('사용자를 찾을 수 없습니다');

    const accountLinkage: AccountLinkage = {
      integrated: true,
      portals: ['axisexam.com', 'cbt.axisexam.com'],
      niceVerified: user.niceVerified,
      carrierIdentityBound: !!user.ci,
      // referenceFaceUpdatedAt is set atomically with the selfie blob — never load the blob here.
      hasReferenceFace: !!user.referenceFaceUpdatedAt,
      referenceFaceUpdatedAt: user.referenceFaceUpdatedAt,
      idImageStored: false,
    };

    return {
      ...detail,
      roles: user.roles.map((r) => r.role),
      rolesDetail: user.roles.map<UserRoleSummary>((r) => ({
        role: r.role,
        grantedAt: r.grantedAt,
        grantedBy: r.grantedBy,
      })),
      accountLinkage,
      identityHistory,
    };
  }

  async getMemberIdentityHistory(userId: string): Promise<MemberIdentityHistory> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, phone: true },
    });
    if (!user) throw new NotFoundException('사용자를 찾을 수 없습니다');

    const [attempts, niceSessions] = await Promise.all([
      this.prisma.identityVerificationAttempt.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      user.phone
        ? this.prisma.niceSession.findMany({
            where: { resultData: { contains: user.phone } },
            orderBy: { createdAt: 'desc' },
            take: 20,
            select: {
              authType: true,
              status: true,
              ipAddress: true,
              createdAt: true,
              completedAt: true,
            },
          })
        : Promise.resolve([]),
    ]);

    return {
      carrier: niceSessions.map<CarrierVerificationEntry>((n) => ({
        authType: n.authType,
        status: n.status,
        ipAddress: n.ipAddress,
        createdAt: n.createdAt,
        completedAt: n.completedAt,
      })),
      attempts: attempts.map<IdentityVerificationAttemptSummary>((a) => ({
        id: a.id,
        examSessionId: a.examSessionId,
        verdict: a.verdict,
        reasons: Array.isArray(a.reasons) ? (a.reasons as string[]) : [],
        idType: a.idType,
        ocrConfidence: a.ocrConfidence,
        nameMatched: a.nameMatched,
        birthDateMatched: a.birthDateMatched,
        faceDecision: a.faceDecision,
        faceSimilarity: a.faceSimilarity,
        createdAt: a.createdAt,
      })),
    };
  }

  async getUserActivity(userId: string): Promise<UserActivity> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, lastLoginAt: true, phone: true },
    });
    if (!user) throw new NotFoundException('사용자를 찾을 수 없습니다');

    const [loginHistory, consentLogs] = await Promise.all([
      this.loginAudit.getLoginHistory(userId),
      this.prisma.consentLog.findMany({
        where: { userId },
        orderBy: { consentedAt: 'desc' },
        take: 20,
        select: {
          consentType: true,
          ipAddress: true,
          userAgent: true,
          consentedAt: true,
        },
      }),
    ]);

    const niceIps = user.phone
      ? await this.prisma.niceSession.findMany({
          where: { resultData: { contains: user.phone } },
          orderBy: { createdAt: 'desc' },
          take: 10,
          select: {
            authType: true,
            ipAddress: true,
            createdAt: true,
            completedAt: true,
          },
        })
      : [];

    return {
      lastLoginAt: user.lastLoginAt,
      loginHistory,
      consentIps: consentLogs.map((c) => ({
        consentType: c.consentType,
        ipAddress: c.ipAddress,
        userAgent: c.userAgent,
        consentedAt: c.consentedAt,
      })),
      niceIps: niceIps.map((n) => ({
        authType: n.authType,
        ipAddress: n.ipAddress,
        createdAt: n.createdAt,
        completedAt: n.completedAt,
      })),
    };
  }

  // ─── Examinee mapping helpers ────────────────────────────────────────────

  private toExamineeRow(
    r: Prisma.RegistrationGetPayload<{
      include: {
        user: { select: { id: true; userId: true; name: true; phone: true; email: true } };
        schedule: true;
        payments: true;
      };
    }>,
    session: Prisma.ExamSessionGetPayload<true> | null,
    certifiedSessionIds: ReadonlySet<string>,
  ): ExamineeListRow {
    const certified = !!session && certifiedSessionIds.has(session.id);
    const examineeStatus = this.deriveExamineeStatus(r.status, session, certified);
    const latestPayment = r.payments[0] ? this.toExamineePayment(r.payments[0]) : null;
    const refundable =
      r.status === RegistrationStatus.PAID &&
      !latestPayment?.isDemo &&
      (!session || !isStartedSessionStatus(session.status));
    return {
      registrationId: r.id,
      registrationNumber: r.registrationNumber,
      registrationStatus: r.status,
      registrationCreatedAt: r.createdAt,
      user: {
        id: r.user.id,
        userId: r.user.userId,
        name: r.user.name,
        phone: maskPhone(r.user.phone),
        email: r.user.email,
      },
      schedule: this.toExamineeSchedule(r.schedule),
      latestPayment,
      session: session ? this.toExamineeSession(session) : null,
      examineeStatus,
      certified,
      refundable,
    };
  }

  private toExamineeSchedule(
    s: Prisma.ExamScheduleGetPayload<true>,
  ): ExamineeListSchedule {
    return {
      id: s.id,
      certType: s.certType,
      level: s.level,
      year: s.year,
      roundNumber: s.roundNumber,
      examDate: s.examDate,
      examStartTime: s.examStartTime,
      status: s.status,
      venue: s.venue,
    };
  }

  private toExamineePayment(
    p: Prisma.PaymentGetPayload<true>,
  ): ExamineeListPayment {
    return {
      id: p.id,
      amount: p.amount,
      status: p.status,
      method: p.method,
      approvedAt: p.approvedAt,
      refundAmount: p.refundAmount,
      isDemo: isDemoPayment(p),
    };
  }

  private toExamineeSession(
    s: Prisma.ExamSessionGetPayload<true>,
  ): ExamineeListSession {
    return {
      id: s.id,
      status: s.status,
      attemptNo: s.attemptNo,
      startedAt: s.startedAt,
      submittedAt: s.submittedAt,
      passed: s.passed,
      totalScore: s.totalScore,
      writtenScore: s.writtenScore,
      practicalScore: s.practicalScore,
      failReason: s.failReason,
      proctorWarnings: s.proctorWarnings,
    };
  }

  private terminalSessionCount(sessions: Array<{ status: ExamSessionStatus }>): number {
    return sessions.filter(
      (s) =>
        s.status === ExamSessionStatus.SUBMITTED ||
        s.status === ExamSessionStatus.GRADED ||
        s.status === ExamSessionStatus.TERMINATED,
    ).length;
  }

  private async buildRegistrationAttemptStats(
    registrationId: string,
    regStatus: RegistrationStatus,
    sessions: ExamineeListSession[],
  ): Promise<{
    attemptsUsed: number;
    maxAttempts: number;
    attemptsLeft: number;
    attemptsExhausted: boolean;
    canGrantAttempt: boolean;
  }> {
    const bonus = await getBonusAttempts(this.redis, registrationId);
    const maxAttempts = MAX_ATTEMPTS + bonus;
    const attemptsUsed = sessions.reduce((max, s) => Math.max(max, s.attemptNo), 0);
    const terminalCount = this.terminalSessionCount(sessions);
    const passed = sessions.some((s) => s.passed === true);
    const attemptsExhausted = terminalCount >= maxAttempts || attemptsUsed >= maxAttempts;
    const attemptsLeft = Math.max(0, maxAttempts - attemptsUsed);
    const canGrantAttempt =
      !passed &&
      regStatus !== RegistrationStatus.CANCELLED &&
      regStatus !== RegistrationStatus.REFUNDED &&
      bonus < MAX_BONUS_ATTEMPTS &&
      (regStatus === RegistrationStatus.EXAM_COMPLETED || attemptsExhausted) &&
      !sessions.some((s) => s.status === ExamSessionStatus.IN_PROGRESS);
    return { attemptsUsed, maxAttempts, attemptsLeft, attemptsExhausted, canGrantAttempt };
  }

  private deriveExamineeStatus(
    regStatus: RegistrationStatus,
    session: Prisma.ExamSessionGetPayload<true> | null,
    certified: boolean,
  ): ExamineeStatus {
    if (regStatus === RegistrationStatus.REFUNDED) return 'REFUNDED';
    if (regStatus === RegistrationStatus.CANCELLED) return 'CANCELLED';
    if (regStatus === RegistrationStatus.PENDING_PAYMENT) return 'PENDING_PAYMENT';

    if (!session || session.status === ExamSessionStatus.CREATED) {
      return 'NOT_STARTED';
    }
    if (session.status === ExamSessionStatus.IN_PROGRESS) return 'IN_PROGRESS';
    if (session.status === ExamSessionStatus.SUBMITTED) return 'SUBMITTED';
    if (session.status === ExamSessionStatus.TERMINATED) return 'TERMINATED';
    if (session.status === ExamSessionStatus.GRADED) {
      if (certified) return 'CERTIFIED';
      return session.passed ? 'GRADED_PASSED' : 'GRADED_FAILED';
    }
    return 'NOT_STARTED';
  }

  /**
   * Bulk lookup of session ids that already have an issued certificate.
   * Uses a raw query because the `certificates` table is managed by
   * CertificatesService (not in the Prisma schema).
   */
  private async fetchCertifiedSessionIds(
    sessionIds: string[],
  ): Promise<Set<string>> {
    if (sessionIds.length === 0) return new Set();
    try {
      // Best-effort — the table may not exist on first run; the certificates
      // service will create it on its first access.
      const rows = await this.prisma.$queryRawUnsafe<Array<{ session_id: string }>>(
        `SELECT session_id FROM certificates WHERE session_id IN (${sessionIds
          .map(() => '?')
          .join(',')})`,
        ...sessionIds,
      );
      return new Set(rows.map((r) => r.session_id));
    } catch {
      // If the table doesn't exist yet, treat as "no certificates issued".
      return new Set();
    }
  }
}
