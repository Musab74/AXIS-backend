import { Injectable } from '@nestjs/common';
import { CertType, ExamSessionStatus, Prisma, RegistrationStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../common/prisma.service';
import { isV2OrLater, toSpecVersion } from '../cbtSessions/exam-spec';

// 자격 유효기간: 등급 취득일로부터 2년 (메인 기획서 v2.0 2-5 — AI 기술 변화
// 속도를 반영한 역량 시효). Was 3; corrected to the documented 2 years.
const CERTIFICATE_VALIDITY_YEARS = 2;

interface CertificateRow {
  id: string;
  cert_number: string;
  user_id: string;
  session_id: string;
  registration_id: string | null;
  cert_type: string;
  cert_level: string;
  holder_name: string;
  holder_user_id: string;
  holder_birth_date: string | null;
  issued_at: Date | string;
  valid_until: Date | string;
  total_score: number | null;
  created_at: Date | string;
  updated_at: Date | string;
}

const CERT_ORG_KO = '㈜아이넥스';

export type PublicCertVerifyResponse =
  | { ok: false }
  | {
      ok: true;
      status: 'valid' | 'expired';
      certNo: string;
      holder: string;
      track: string;
      level: string;
      issuedAt: string;
      validUntil: string;
      expiredAt?: string;
      org: string;
    }
  | {
      ok: true;
      status: 'demo';
      certNo: string;
      holder: string;
      track: string;
      level: string;
      org: string;
    };

function formatDateKst(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(date)
    .replace(/-/g, '.');
}

function certTrackLabel(certType: string): string {
  if (certType === 'AXIS_C') return 'AXIS-C';
  if (certType === 'AXIS_H') return 'AXIS-H';
  return 'AXIS';
}

function levelDisplayLabel(level: string): string {
  switch (level) {
    case 'L3':
      return 'L3 Starter';
    case 'L2':
      return 'L2 Practitioner';
    case 'L1':
      return 'L1 Leader';
    default:
      return level;
  }
}

export interface IssuedCertificate {
  id: string;
  certNumber: string;
  userId: string;
  sessionId: string;
  registrationId: string | null;
  certType: string;
  level: string;
  holderName: string;
  holderUserId: string;
  holderBirthDate: string | null;
  issuedAt: Date;
  validUntil: Date;
  totalScore: number | null;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class CertificatesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Public lookup: cert number + holder real name (or login userId, same as printed holder_user_id when applicable).
   * Does not distinguish "wrong number" vs "wrong name" in the response shape (privacy / anti-enumeration).
   */
  async verifyPublic(certNumberRaw: string, holderNameRaw: string): Promise<PublicCertVerifyResponse> {
    let certRaw = certNumberRaw?.trim() ?? '';
    try {
      certRaw = decodeURIComponent(certRaw);
    } catch {
      /* invalid % sequence — use raw */
    }
    const certNumber = certRaw.toUpperCase().replace(/\s+/g, '');
    const holderInput = holderNameRaw.trim().replace(/\s+/g, ' ');
    if (certNumber.length < 8 || holderInput.length < 2) {
      return { ok: false };
    }

    // Stateless 데모 자격증: DB 조회 없이 접두사만 보고 즉시 응답.
    // 형식: DEMO-AXIS[_-]C/H?-L?-YYYY-XXXXXX
    if (certNumber.startsWith('DEMO-')) {
      const parts = certNumber.split('-');
      // ["DEMO", "AXIS"|"AXIS_C"|...,"L3"|"L2"|"L1", "YYYY", "RAND"...] when track has no hyphen,
      // or ["DEMO","AXIS","C","L2","YYYY","RAND"] when track is AXIS-C/AXIS-H.
      const trackToken = parts[1] === 'AXIS' && (parts[2] === 'C' || parts[2] === 'H')
        ? `AXIS-${parts[2]}`
        : parts[1] ?? 'AXIS';
      const levelTokenIdx = trackToken === 'AXIS' ? 2 : 3;
      const levelToken = parts[levelTokenIdx] ?? 'L3';
      return {
        ok: true,
        status: 'demo',
        certNo: certNumber,
        holder: holderInput,
        track: trackToken,
        level: levelDisplayLabel(levelToken),
        org: CERT_ORG_KO,
      };
    }

    try {
      await this.ensureTable();
    } catch {
      return { ok: false };
    }

    let rows: CertificateRow[];
    try {
      rows = await this.prisma.$queryRaw<CertificateRow[]>`
        SELECT *
        FROM certificates
        WHERE cert_number = ${certNumber}
          AND (
            LOWER(TRIM(holder_name)) = LOWER(${holderInput})
            OR LOWER(TRIM(holder_user_id)) = LOWER(${holderInput})
          )
        LIMIT 1
      `;
    } catch {
      return { ok: false };
    }

    const row = rows[0];
    if (!row) {
      return { ok: false };
    }

    const now = new Date();
    const validUntil = new Date(row.valid_until);
    const status: 'valid' | 'expired' = validUntil.getTime() < now.getTime() ? 'expired' : 'valid';

    const certDateStr = formatDateKst(row.valid_until);
    return {
      ok: true,
      status,
      certNo: row.cert_number,
      holder: row.holder_name,
      track: certTrackLabel(row.cert_type),
      level: levelDisplayLabel(row.cert_level),
      issuedAt: formatDateKst(row.issued_at),
      validUntil: certDateStr,
      ...(status === 'expired' ? { expiredAt: certDateStr } : {}),
      org: CERT_ORG_KO,
    };
  }

  async issueForSession(sessionId: string): Promise<IssuedCertificate | null> {
    await this.ensureTable();
    const session = await this.prisma.examSession.findUnique({
      where: { id: sessionId },
      include: {
        user: {
          select: {
            id: true,
            userId: true,
            name: true,
            birthDate: true,
          },
        },
      },
    });

    if (!session) return null;
    if (session.status !== ExamSessionStatus.GRADED || session.passed !== true) return null;
    // v2.0+ (시험 표준 v2.0 WP4) hard guard: the final decision is human-locked —
    // a v2.0/v3.0 session can only yield a certificate once an admin/review
    // panel confirmed it (decision_status = CONFIRMED_PASS). Provisional or
    // in-review states never issue, no matter who calls this.
    if (isV2OrLater(toSpecVersion(session.specVersion)) && session.decisionStatus !== 'CONFIRMED_PASS') {
      return null;
    }
    const registration = session.registrationId
      ? await this.prisma.registration.findUnique({
          where: { id: session.registrationId },
          include: {
            schedule: {
              select: {
                year: true,
                roundNumber: true,
              },
            },
          },
        })
      : null;
    // A refunded/cancelled registration cannot yield a certificate — even if
    // a session under it somehow reached GRADED+passed (defense in depth
    // alongside the cancelWithRefund/adminRefund IN_PROGRESS gates).
    if (
      registration &&
      (registration.status === RegistrationStatus.REFUNDED ||
        registration.status === RegistrationStatus.CANCELLED)
    ) {
      return null;
    }

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.$queryRawUnsafe<CertificateRow[]>(
        'SELECT * FROM certificates WHERE session_id = ? LIMIT 1',
        session.id,
      );
      if (existing.length > 0) return this.mapRow(existing[0]);

      const issuedAt = session.submittedAt ?? new Date();
      const validUntil = new Date(issuedAt);
      validUntil.setFullYear(validUntil.getFullYear() + CERTIFICATE_VALIDITY_YEARS);
      const year = registration?.schedule.year ?? issuedAt.getFullYear();
      const round = registration?.schedule.roundNumber ?? 1;
      const certNumber = await this.generateCertNumber(tx, session.certType, session.level, year, round);

      const certId = randomUUID();
      await tx.$executeRawUnsafe(
        `INSERT INTO certificates (
          id,
          cert_number,
          user_id,
          session_id,
          registration_id,
          cert_type,
          cert_level,
          holder_name,
          holder_user_id,
          holder_birth_date,
          issued_at,
          valid_until,
          total_score,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        certId,
        certNumber,
        session.userId,
        session.id,
        session.registrationId ?? null,
        session.certType,
        session.level,
        session.user.name,
        session.user.userId,
        session.user.birthDate ?? null,
        issuedAt,
        validUntil,
        session.totalScore ?? null,
      );

      const inserted = await tx.$queryRawUnsafe<CertificateRow[]>(
        'SELECT * FROM certificates WHERE id = ? LIMIT 1',
        certId,
      );
      return this.mapRow(inserted[0]);
    });
  }

  async syncPassedCertificatesForUser(userId: string): Promise<IssuedCertificate[]> {
    await this.ensureTable();
    const sessions = await this.prisma.examSession.findMany({
      where: {
        userId,
        status: ExamSessionStatus.GRADED,
        passed: true,
      },
      select: { id: true },
      orderBy: { submittedAt: 'desc' },
    });

    for (const s of sessions) {
      await this.issueForSession(s.id);
    }

    return this.listMine(userId);
  }

  async listMine(userId: string): Promise<IssuedCertificate[]> {
    await this.ensureTable();
    const rows = await this.prisma.$queryRawUnsafe<CertificateRow[]>(
      'SELECT * FROM certificates WHERE user_id = ? ORDER BY issued_at DESC',
      userId,
    );
    return rows.map((row) => this.mapRow(row));
  }

  private async generateCertNumber(
    tx: Prisma.TransactionClient,
    certType: CertType,
    level: string,
    year: number,
    round: number,
  ): Promise<string> {
    const typePart = certType.replace('AXIS_', 'AXIS-');
    const base = `${typePart}-${level}-${year}-${String(round).padStart(3, '0')}`;
    const prefix = `${base}-`;
    const latest = await tx.$queryRawUnsafe<Array<{ cert_number: string }>>(
      'SELECT cert_number FROM certificates WHERE cert_number LIKE ? ORDER BY cert_number DESC LIMIT 1',
      `${prefix}%`,
    );
    const nextSeq = latest.length > 0 ? this.nextSequence(latest[0].cert_number, prefix) : 1;
    return `${base}-${String(nextSeq).padStart(5, '0')}`;
  }

  private nextSequence(certNumber: string, prefix: string): number {
    const seq = certNumber.startsWith(prefix) ? certNumber.slice(prefix.length) : '0';
    const parsed = Number.parseInt(seq, 10);
    if (!Number.isFinite(parsed) || parsed < 0) return 1;
    return parsed + 1;
  }

  private async ensureTable() {
    await this.prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS certificates (
        id VARCHAR(191) PRIMARY KEY,
        cert_number VARCHAR(191) NOT NULL UNIQUE,
        user_id VARCHAR(191) NOT NULL,
        session_id VARCHAR(191) NOT NULL UNIQUE,
        registration_id VARCHAR(191) NULL,
        cert_type VARCHAR(32) NOT NULL,
        cert_level VARCHAR(32) NOT NULL,
        holder_name VARCHAR(191) NOT NULL,
        holder_user_id VARCHAR(191) NOT NULL,
        holder_birth_date VARCHAR(32) NULL,
        issued_at DATETIME NOT NULL,
        valid_until DATETIME NOT NULL,
        total_score INT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_certificates_user_id (user_id),
        INDEX idx_certificates_cert_type_level (cert_type, cert_level)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  private mapRow(row: CertificateRow): IssuedCertificate {
    return {
      id: row.id,
      certNumber: row.cert_number,
      userId: row.user_id,
      sessionId: row.session_id,
      registrationId: row.registration_id,
      certType: row.cert_type,
      level: row.cert_level,
      holderName: row.holder_name,
      holderUserId: row.holder_user_id,
      holderBirthDate: row.holder_birth_date,
      issuedAt: new Date(row.issued_at),
      validUntil: new Date(row.valid_until),
      totalScore: row.total_score,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }
}
