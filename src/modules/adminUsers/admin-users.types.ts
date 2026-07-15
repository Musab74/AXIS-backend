import {
  AccountStatus,
  CertLevel,
  CertType,
  ExamSessionStatus,
  PaymentMethod,
  PaymentStatus,
  PenaltyStatus,
  RegistrationStatus,
  Role,
  ScheduleStatus,
  UserPenalty,
} from '@prisma/client';
import { ExamineeStatus } from './dto/search-examinees.dto';

export interface UserSummary {
  id: string;
  userId: string;
  name: string;
  email: string | null;
  phone: string;
  accountStatus: AccountStatus;
  niceVerified: boolean;
  roles: Role[];
  activePenaltyCount: number;
  createdAt: Date;
  lastLoginAt: Date | null;
}

export interface ExpertSummary {
  id: string;
  userId: string;
  name: string;
  email: string | null;
  phone: string;
  accountStatus: AccountStatus;
  competencies: CertType[];
  activePenaltyCount: number;
  createdAt: Date;
  lastLoginAt: Date | null;
}

export interface RegistrationSummary {
  id: string;
  certType: CertType;
  level: CertLevel;
  status: RegistrationStatus;
  registrationNumber: string | null;
  createdAt: Date;
}

export interface ExamSessionSummary {
  id: string;
  certType: CertType;
  level: CertLevel;
  status: ExamSessionStatus;
  attemptNo: number;
  startedAt: Date | null;
  submittedAt: Date | null;
  passed: boolean | null;
}

export interface UserRoleSummary {
  role: Role;
  grantedAt: Date;
  grantedBy: string | null;
}

export interface UserPenaltySummary {
  id: string;
  reason: string;
  status: PenaltyStatus;
  startAt: Date;
  endAt: Date;
  releasedAt: Date | null;
  releaseReason: string | null;
  sessionId: string | null;
  decidedBy: string | null;
}

export interface UserDetail extends UserSummary {
  birthDate: string | null;
  gender: string | null;
  rolesDetail: UserRoleSummary[];
  penalties: UserPenaltySummary[];
  registrations: RegistrationSummary[];
  examSessions: ExamSessionSummary[];
}

export interface SearchUsersResult {
  items: UserSummary[];
  total: number;
  page: number;
  limit: number;
}

export type IssuedPenalty = UserPenalty;

// ─── Examinee management (admin-side) ──────────────────────────────────────

export interface ExamineeListUser {
  id: string;
  userId: string;
  name: string;
  phone: string;
  email: string | null;
}

export interface ExamineeListSchedule {
  id: string;
  certType: CertType;
  level: CertLevel;
  year: number;
  roundNumber: number;
  examDate: Date;
  examStartTime: string;
  status: ScheduleStatus;
  venue: string;
}

export interface ExamineeListPayment {
  id: string;
  amount: number;
  status: PaymentStatus;
  method: PaymentMethod | null;
  approvedAt: Date | null;
  refundAmount: number | null;
  /** True when paid via TEST_PAYMENT /payment/test-confirm (no real PG money). */
  isDemo: boolean;
}

export interface ExamineeListSession {
  id: string;
  status: ExamSessionStatus;
  attemptNo: number;
  startedAt: Date | null;
  submittedAt: Date | null;
  passed: boolean | null;
  totalScore: number | null;
  writtenScore: number | null;
  practicalScore: number | null;
  failReason: string | null;
  proctorWarnings: number;
}

/** One row per registration with derived examinee status + refundability. */
export interface ExamineeListRow {
  registrationId: string;
  registrationNumber: string | null;
  registrationStatus: RegistrationStatus;
  registrationCreatedAt: Date;
  user: ExamineeListUser;
  schedule: ExamineeListSchedule;
  latestPayment: ExamineeListPayment | null;
  session: ExamineeListSession | null;
  /** Mapped logical status (see {@link ExamineeStatus}). */
  examineeStatus: ExamineeStatus;
  /** A certificate row already exists for the linked session. */
  certified: boolean;
  /** Refund button should be enabled. PAID + no started session. */
  refundable: boolean;
}

export interface ExamineeListResult {
  items: ExamineeListRow[];
  total: number;
  page: number;
  limit: number;
}

export interface ExamineeRegistrationDetail {
  id: string;
  registrationNumber: string | null;
  status: RegistrationStatus;
  certType: CertType;
  level: CertLevel;
  partialExempt: boolean;
  cancelledAt: Date | null;
  createdAt: Date;
  examDeadline: Date | null;
  schedule: ExamineeListSchedule;
  latestPayment: ExamineeListPayment | null;
  /** Sessions tied to this specific registration (usually 0..1). */
  sessions: ExamineeListSession[];
  refundable: boolean;
  attemptsUsed: number;
  maxAttempts: number;
  attemptsLeft: number;
  attemptsExhausted: boolean;
  canGrantAttempt: boolean;
}

export interface ExamineeCertificate {
  id: string;
  certNumber: string;
  certType: string;
  level: string;
  issuedAt: Date;
  validUntil: Date;
  totalScore: number | null;
  sessionId: string;
}

export interface ExamineeDetail {
  user: ExamineeListUser & {
    accountStatus: AccountStatus;
    niceVerified: boolean;
    birthDate: string | null;
    gender: string | null;
    createdAt: Date;
    lastLoginAt: Date | null;
  };
  registrations: ExamineeRegistrationDetail[];
  certificates: ExamineeCertificate[];
  penalties: UserPenaltySummary[];
  activePenaltyCount: number;
}

/** Member 360° profile — enriched examinee detail + role metadata. */
export interface MemberProfile extends ExamineeDetail {
  roles: Role[];
  rolesDetail: UserRoleSummary[];
  /** axisexam.com ↔ cbt.axisexam.com share one User row (integrated account). */
  accountLinkage: AccountLinkage;
  /** Carrier (NICE) + ID OCR + face-match history. Never includes image bytes. */
  identityHistory: MemberIdentityHistory;
}

/** Status of the single integrated account used by both public site and CBT. */
export interface AccountLinkage {
  /** Always true — axisexam and CBT share the same User / JWT. */
  integrated: true;
  portals: ['axisexam.com', 'cbt.axisexam.com'];
  niceVerified: boolean;
  /** Carrier identity (CI) is bound — without exposing the CI value. */
  carrierIdentityBound: boolean;
  /** Live selfie reference exists for in-exam checks (ID card image is never stored). */
  hasReferenceFace: boolean;
  referenceFaceUpdatedAt: Date | null;
  /** Explicit policy flag for admin UI — ID card images are never persisted. */
  idImageStored: false;
}

export interface IdentityVerificationAttemptSummary {
  id: string;
  examSessionId: string | null;
  verdict: string;
  reasons: string[];
  idType: string;
  ocrConfidence: number;
  nameMatched: boolean;
  birthDateMatched: boolean | null;
  faceDecision: string;
  faceSimilarity: number;
  createdAt: Date;
}

export interface CarrierVerificationEntry {
  authType: string;
  status: string;
  ipAddress: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

export interface MemberIdentityHistory {
  carrier: CarrierVerificationEntry[];
  attempts: IdentityVerificationAttemptSummary[];
}

export interface ConsentIpEntry {
  consentType: string;
  ipAddress: string | null;
  userAgent: string | null;
  consentedAt: Date;
}

export interface NiceIpEntry {
  authType: string;
  ipAddress: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

export interface UserActivity {
  lastLoginAt: Date | null;
  loginHistory: Array<{
    at: string;
    ip: string;
    userAgent: string | null;
    source: 'web' | 'admin';
  }>;
  consentIps: ConsentIpEntry[];
  niceIps: NiceIpEntry[];
}
