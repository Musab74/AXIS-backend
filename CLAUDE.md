# AXIS Series Certification System — Engineering Guide

This file is the source of truth for working on the AXIS codebase. It is read by Claude Code and by every new engineer joining the task force. Keep it updated.

---

## 1. Project overview

AiNex Inc. is building a Korean private certification platform for **practical AI competency**. The product is not "people who build AI"; it is "people who apply generative AI to work and deliver results." The certifications are registered with KRIVET PQI.

**Three certifications × three levels**, launching simultaneously on **April 30, 2026**:

- **AXIS** — General (all professionals) — "Can you deliver work results with AI?"
- **AXIS-C** — Coding & Automation — "Can you complete a working program with AI?"
- **AXIS-H** — Healthcare (non-clinical staff) — "Can you innovate hospital work with AI?"

Levels: **L3 Starter (₩100K) → L2 Practitioner (₩150K) → L1 Leader (₩200K)**

Two systems, same server, shared account, separate apps:
- `axisexam.com` — main site (light theme, CompTIA-benchmarked)
- `cbt.axisexam.com` — exam-only site (dark theme, Fullscreen-locked)

**Team:** 1 PM + 2 full-stack devs + 2 designers. **Timeline:** Feb 23 – Apr 30, 2026 (~10 weeks, 5 sprints).

---

## 2. Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Runtime | **Node.js 20 LTS** | |
| Backend | **NestJS 10** | Module-per-domain, DI everywhere |
| ORM | **Prisma 5** | MySQL provider |
| Database | **MySQL 8.0** | utf8mb4 collation, JSON columns for snapshots/logs |
| Cache / pub-sub | **Redis 7** | Sessions, BullMQ backing, proctor real-time, rate limits |
| Queue | **BullMQ** | Async grading, PDF gen, notifications, snapshot processing |
| WebSocket | **Socket.io** (NestJS Gateway) | Redis adapter for multi-node scaling |
| Frontend | **React 18 + Vite** | TypeScript, TanStack Query, Zustand for state |
| CSS | **Tailwind CSS** | Per-series brand colors as CSS vars |
| File storage | **Naver Cloud Object Storage** | PIPA-compliant (Korea-based) for sensitive files |
| PDF | **Puppeteer** | Isolated worker for certificate rendering |
| Code sandbox | **Judge0** self-hosted | Separate server, Docker-isolated, read-only FS |
| Error tracking | **Sentry** | Both backend + frontend |
| CI/CD | **GitHub Actions** | Test → build → deploy staging → manual prod |

**Do not swap the stack without a written RFC.** The 10-week timeline has no room for framework drift.

---

## 3. Directory structure

```
axis-backend/
├── src/
│   ├── main.ts
│   ├── app.module.ts
│   ├── modules/              ← one folder per business domain
│   │   ├── auth/
│   │   ├── users/
│   │   ├── certifications/
│   │   ├── schedules/
│   │   ├── registrations/
│   │   ├── payments/
│   │   ├── cbt-sessions/
│   │   ├── cbt-exams/
│   │   ├── cbt-practical/
│   │   ├── sandbox/
│   │   ├── proctoring/
│   │   ├── grading/
│   │   ├── results/
│   │   ├── certificates/
│   │   ├── questions/        ← admin question bank
│   │   ├── tasks/            ← admin practical task templates
│   │   ├── admin-users/
│   │   ├── admin-monitor/
│   │   ├── notices/
│   │   ├── inquiries/
│   │   ├── stats/
│   │   └── notifications/
│   ├── integrations/         ← external API wrappers (see §10)
│   │   ├── toss-payments/
│   │   ├── clova-ocr/
│   │   ├── aws-rekognition/
│   │   ├── anthropic/
│   │   ├── openai/
│   │   ├── judge0/
│   │   ├── copyleaks/
│   │   ├── aligo-sms/
│   │   ├── aws-ses/
│   │   ├── nc-object-storage/
│   │   ├── nice-auth/
│   │   └── oauth/            ← kakao, naver, google
│   ├── queue/                ← BullMQ processors
│   │   ├── grading.processor.ts
│   │   ├── snapshot.processor.ts
│   │   ├── notification.processor.ts
│   │   └── certificate.processor.ts
│   ├── websocket/
│   │   ├── proctor.gateway.ts    ← candidate → server
│   │   └── admin.gateway.ts      ← server → admin dashboard
│   ├── common/
│   │   ├── guards/           ← JwtGuard, RoleGuard, SessionGuard
│   │   ├── decorators/       ← @CurrentUser, @Roles, @Public
│   │   ├── interceptors/     ← LoggingInterceptor, TransformInterceptor
│   │   ├── filters/          ← GlobalExceptionFilter, PrismaExceptionFilter
│   │   └── pipes/            ← ValidationPipe config
│   └── config/               ← Joi-validated env config
├── prisma/
│   ├── schema.prisma
│   └── migrations/
├── test/                     ← e2e
└── CLAUDE.md                 ← this file
```

**Rule:** Business modules never import from `integrations/*` directly — they inject the integration's `*Service`. This keeps vendors swappable.

---

## 4. Coding conventions

### General
- **TypeScript strict mode on.** No `any`. If you need an escape, use `unknown` + narrowing.
- **No default exports** (except Nest-required ones). Named exports only.
- **Functions < 50 lines.** If longer, extract helpers.
- **Files < 300 lines.** If longer, split the module.

### NestJS conventions
- One module per business domain, with `*.module.ts`, `*.controller.ts`, `*.service.ts`, `*.dto.ts`, and optional `*.repository.ts` for complex Prisma queries.
- **Controllers:** only route, validate, call service. No business logic.
- **Services:** all business logic. No direct `@nestjs/common` HTTP imports (throw `BadRequestException` etc., but don't read req/res).
- **DTOs:** use `class-validator` + `class-transformer`. Every input goes through a DTO.
- **Prisma:** inject `PrismaService` (a singleton). Never `new PrismaClient()` inside a module.

### DTO example pattern
```ts
// cbt-exams/dto/submit-answer.dto.ts
import { IsInt, IsString, Min, Max } from 'class-validator';

export class SubmitAnswerDto {
  @IsInt() @Min(1)
  questionId!: number;

  @IsString()
  selectedChoice!: string;

  @IsInt() @Min(0)
  version!: number; // optimistic concurrency — see §9
}
```

### Error handling
- Use Nest's `HttpException` subclasses for expected errors: `BadRequestException`, `UnauthorizedException`, `ForbiddenException`, `NotFoundException`, `ConflictException`.
- Prisma `P2002` (unique constraint) → `ConflictException`, `P2025` (not found) → `NotFoundException`. Handled globally in `PrismaExceptionFilter`.
- Unknown errors bubble to Sentry via `GlobalExceptionFilter`.
- **Never swallow errors.** `catch (e) { console.log(e) }` is an instant PR rejection.

### Naming
- Endpoints: `kebab-case` plural nouns. `/exam-sessions`, not `/examSession`.
- DB tables/columns: `snake_case`. Prisma maps to camelCase in TS.
- Enums: `SCREAMING_SNAKE_CASE` values.
- Roles (6 types from backend spec): `super_admin`, `exam_admin`, `grading_admin`, `proctor`, `expert`, `examinee`.

---

## 5. Database modeling rules (Prisma + MySQL)

Reference: `7_AXIS_CBT_Backend_Design_Core_Requirements.html` — this document is canonical.

### Core entities (do not rename)
`User`, `UserRole`, `UserPenalty`, `ExamSchedule`, `Registration`, `ExamSession`, `QuestionBank`, `TaskTemplate`, `Answer`, `EssayAnswer`, `ProctoringEvent`, `Snapshot`, `GradingResult`, `Certificate`, `Payment`, `Notice`, `Faq`, `Inquiry`.

### Hard rules
1. **Re-exam model is `Registration(1)–ExamSession(N) + attempt_no`** — never store exam state on Registration.
2. **Question snapshots are mandatory.** Every `ExamSession` freezes `q_version` + `content_hash` + `content_snapshot` (JSON) at exam-paper issue time. If the question bank changes mid-round, the candidate still sees the original. Exams are legal documents.
3. **Auto-save uses optimistic concurrency.** `Answer.version` increments on every update. Client sends last-known version; server rejects on mismatch to catch duplicate-tab edits.
4. **Soft-delete for user-facing content** (notices, FAQ, inquiries). Hard-delete only for drafts that were never published.
5. **Sensitive data TTL.** ID photos, webcam snapshots, and face-compare results carry an `expires_at`. A scheduled job in `snapshot.processor.ts` deletes them after the retention window (default: 90 days post-exam, or 2 years if a dispute/penalty is active).
6. **Audit log for admin actions.** Every `super_admin` / `exam_admin` mutation on users, questions, or grades writes to an `AdminAuditLog` table. Include actor, action, target, before/after JSON.

### Prisma schema excerpt (reference)
```prisma
model User {
  id              String        @id @default(cuid())
  email           String        @unique
  passwordHash    String        @map("password_hash")
  name            String
  phone           String?
  accountStatus   AccountStatus @default(ACTIVE) @map("account_status")
  createdAt       DateTime      @default(now()) @map("created_at")
  lastLoginAt     DateTime?     @map("last_login_at")

  roles           UserRole[]
  penalties       UserPenalty[]
  registrations   Registration[]

  @@map("users")
}

enum AccountStatus {
  ACTIVE
  SUSPENDED
  WITHDRAWN
}

model UserRole {
  id         String    @id @default(cuid())
  userId     String    @map("user_id")
  role       Role
  grantedBy  String?   @map("granted_by")
  grantedAt  DateTime  @default(now()) @map("granted_at")
  revokedAt  DateTime? @map("revoked_at")

  user       User      @relation(fields: [userId], references: [id])

  @@index([userId])
  @@map("user_roles")
}

enum Role {
  SUPER_ADMIN
  EXAM_ADMIN
  GRADING_ADMIN
  PROCTOR
  EXPERT
  EXAMINEE
}
```

---

## 6. Complete API endpoint map

All routes prefixed with `/api/v1`. Auth required unless marked **public**.

### 6.1 Auth & Account (`auth`, `users`)
| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/auth/register` | public | Email+password sign-up |
| POST | `/auth/login` | public | Returns access + refresh JWT |
| POST | `/auth/logout` | user | Invalidate refresh token |
| POST | `/auth/refresh` | public(refresh) | Rotate tokens |
| POST | `/auth/verify-email` | public | Email confirm link |
| POST | `/auth/forgot-password` | public | Send reset email |
| POST | `/auth/reset-password` | public(token) | Consume reset token |
| GET | `/auth/me` | user | Current user + roles |
| GET | `/auth/oauth/kakao` | public | Kakao redirect |
| GET | `/auth/oauth/kakao/callback` | public | Kakao callback |
| GET | `/auth/oauth/naver` | public | Naver redirect |
| GET | `/auth/oauth/naver/callback` | public | Naver callback |
| GET | `/auth/oauth/google` | public | Google redirect |
| GET | `/auth/oauth/google/callback` | public | Google callback |
| POST | `/auth/nice/start` | user | Start NICE 본인확인 |
| POST | `/auth/nice/callback` | public | NICE result webhook |
| GET | `/users/profile` | user | Read profile |
| PATCH | `/users/profile` | user | Update profile |
| POST | `/users/password` | user | Change password |
| DELETE | `/users/me` | user | Withdraw (GDPR/PIPA) |

### 6.2 Certifications & Schedules (`certifications`, `schedules`)
| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/certifications` | public | List 3 certs |
| GET | `/certifications/:type` | public | AXIS / AXIS-C / AXIS-H |
| GET | `/certifications/:type/levels/:level` | public | L3 / L2 / L1 detail |
| GET | `/schedules` | public | Upcoming exams (filters: cert, level, month) |
| GET | `/schedules/:id` | public | Single schedule |
| POST | `/schedules` | exam_admin | Create round |
| PATCH | `/schedules/:id` | exam_admin | Update capacity, times |
| DELETE | `/schedules/:id` | exam_admin | Soft-cancel with notification |

### 6.3 Registration & Payment (`registrations`, `payments`)
| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/registrations` | user | Create reg (cert+level+schedule) — holds seat for 15 min |
| GET | `/registrations/mine` | user | My registrations |
| GET | `/registrations/:id` | user | Detail + status |
| DELETE | `/registrations/:id` | user | Cancel (before payment) |
| GET | `/registrations/:id/admission-ticket.pdf` | user | PDF |
| POST | `/payments/ready` | user | Create Toss transaction |
| POST | `/payments/confirm` | user | Confirm after PG redirect |
| POST | `/payments/webhook/toss` | public(signed) | Toss webhook |
| POST | `/payments/:id/refund` | user | Refund request (rules in §8) |
| GET | `/payments/:id/receipt` | user | Receipt PDF |

### 6.4 CBT session lifecycle (`cbt-sessions`, `cbt-exams`, `cbt-practical`, `sandbox`, `proctoring`)
| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/cbt/available-exams` | user | Exams the user can start now |
| POST | `/cbt/sessions` | user | Create session (blocks if not eligible) |
| GET | `/cbt/sessions/:id` | user+session | Session state |
| POST | `/cbt/sessions/:id/env-check` | user+session | Submit browser/webcam/mic check |
| POST | `/cbt/sessions/:id/id-verify` | user+session | Upload ID photo → triggers OCR |
| POST | `/cbt/sessions/:id/face-verify` | user+session | Upload webcam frame → Rekognition compare |
| POST | `/cbt/sessions/:id/consent` | user+session | Record exam-rules consent |
| POST | `/cbt/sessions/:id/start` | user+session | Freeze question paper, start timer |
| GET | `/cbt/sessions/:id/paper` | user+session | Return shuffled MCQ or L2/L1 task |
| POST | `/cbt/sessions/:id/answers` | user+session | Auto-save (send `version`) |
| POST | `/cbt/sessions/:id/essay` | user+session | Save essay (L1) |
| POST | `/cbt/sessions/:id/deliverable` | user+session | Upload L1 deliverable file |
| POST | `/cbt/sessions/:id/ai-chat` | user+session | L2/L1 in-exam AI chat (logged) |
| POST | `/cbt/sessions/:id/code/run` | user+session | Judge0 run (AXIS-C, L2/L1) |
| POST | `/cbt/sessions/:id/code/test` | user+session | Judge0 test against hidden cases |
| POST | `/cbt/sessions/:id/code/submit` | user+session | Final code submission |
| POST | `/cbt/sessions/:id/submit` | user+session | Final submit whole exam |
| POST | `/cbt/sessions/:id/proctor/snapshot` | user+session | Webcam frame (L3 60s, L2 30s, L1 15s) |
| POST | `/cbt/sessions/:id/proctor/event` | user+session | Behavior event (tab-switch, fullscreen-exit, etc.) |
| POST | `/cbt/sessions/:id/network-pause` | user+session | Report disconnect — server decides pause eligibility |

### 6.5 Grading & Results (`grading`, `results`)
| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/grading/queue` | grading_admin | Pending L2/L1 items |
| GET | `/grading/:gradingId` | grading_admin, expert | Detail with AI pre-grade |
| POST | `/grading/:gradingId/ai-pregrade` | grading_admin | Trigger/retrigger Claude grade |
| PATCH | `/grading/:gradingId/expert-review` | expert | Adjust AI score + notes |
| POST | `/grading/:gradingId/finalize` | grading_admin | Lock score, publish result |
| GET | `/results/mine` | user | My results |
| GET | `/results/sessions/:id` | user | Score breakdown |
| GET | `/results/public/:scheduleId` | public | Pass list by round (by reg number) |

### 6.6 Certificates (`certificates`)
| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/certificates/issue/:registrationId` | user | Generate PDF (after pass) |
| GET | `/certificates/:certNumber/download` | user | Download PDF |
| GET | `/certificates/verify/:certNumber` | public | Authenticity check (rate-limited) |
| POST | `/certificates/verify/bulk` | partner(api-key) | Enterprise bulk verify |

### 6.7 Admin — Question Bank (`questions`, `tasks`)
| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/admin/questions` | exam_admin | MCQ list (filters: cert, level, subject, status) |
| POST | `/admin/questions` | exam_admin | Create MCQ |
| PATCH | `/admin/questions/:id` | exam_admin | Update (creates new version if already used) |
| DELETE | `/admin/questions/:id` | exam_admin | Soft-delete (disable if used) |
| POST | `/admin/questions/bulk-upload` | exam_admin | Excel import |
| GET | `/admin/questions/pool-summary` | exam_admin | Per cert/level/subject counts |
| GET | `/admin/tasks` | exam_admin | Practical task list |
| POST | `/admin/tasks` | exam_admin | Create task |
| PATCH | `/admin/tasks/:id` | exam_admin | Update task |
| POST | `/admin/tasks/:id/test-cases` | exam_admin | Add Judge0 test cases (AXIS-C) |

### 6.8 Admin — Users & Monitoring (`admin-users`, `admin-monitor`)
| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/admin/users` | super_admin, exam_admin | Search users |
| GET | `/admin/users/:id` | super_admin | Detail |
| PATCH | `/admin/users/:id/roles` | super_admin | Grant/revoke roles |
| POST | `/admin/users/:id/penalties` | super_admin | Issue suspension |
| PATCH | `/admin/users/:id/penalties/:pid` | super_admin | Release early |
| GET | `/admin/monitor/live` | proctor, exam_admin | Active sessions (WebSocket upgrade) |
| GET | `/admin/monitor/sessions/:id` | proctor | Per-candidate detail |
| GET | `/admin/monitor/sessions/:id/snapshots` | proctor | Webcam thumbnails |
| GET | `/admin/monitor/sessions/:id/events` | proctor | Event timeline |
| POST | `/admin/monitor/sessions/:id/warn` | proctor | Push warning to candidate |
| POST | `/admin/monitor/sessions/:id/terminate` | proctor | Force-end exam |
| POST | `/admin/monitor/sessions/:id/extend` | exam_admin | Grant time extension |
| POST | `/admin/monitor/sessions/:id/pause` | exam_admin | Pause timer (system issue) |

### 6.9 Admin — Notices, FAQ, Inquiries, Stats
| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/notices` | public | List |
| GET | `/notices/:id` | public | Detail |
| POST | `/admin/notices` | exam_admin | Create |
| PATCH | `/admin/notices/:id` | exam_admin | Update |
| DELETE | `/admin/notices/:id` | exam_admin | Soft-delete |
| GET | `/faq` | public | List |
| POST | `/admin/faq` | exam_admin | Create |
| PATCH | `/admin/faq/:id` | exam_admin | Update |
| PATCH | `/admin/faq/reorder` | exam_admin | Drag-drop reorder |
| POST | `/inquiries` | user | 1:1 inquiry |
| GET | `/inquiries/mine` | user | My inquiries |
| GET | `/admin/inquiries` | exam_admin | Admin inbox |
| POST | `/admin/inquiries/:id/reply` | exam_admin | Reply + email |
| GET | `/admin/stats/dashboard` | exam_admin | Top-level KPIs |
| GET | `/admin/stats/pass-rate` | exam_admin | By cert/level/round |
| GET | `/admin/stats/revenue` | super_admin | Revenue breakdown |

### 6.10 WebSocket events (namespace `/ws`)
| Direction | Event | Payload | Purpose |
|---|---|---|---|
| C→S | `proctor:snapshot` | `{sessionId, frameBase64, ts}` | Fallback for REST snapshot |
| C→S | `proctor:event` | `{sessionId, type, detail}` | Real-time behavior event |
| S→C | `exam:warning` | `{level, reason}` | Push warning banner |
| S→C | `exam:force-terminate` | `{reason}` | End exam |
| S→C | `exam:time-extended` | `{seconds}` | Compensate network loss |
| Admin→S | `admin:subscribe` | `{scheduleId}` | Subscribe to round |
| S→Admin | `admin:session-update` | `{sessionId, status, progress}` | Live status tile |
| S→Admin | `admin:alert` | `{sessionId, severity, reason}` | Cheating suspicion |

---

## 7. External integrations

Each folder in `src/integrations/` exposes a Nest module with a service. **Only the service talks to the vendor SDK.**

### 7.1 Toss Payments (`integrations/toss-payments/`)
- Docs: https://docs.tosspayments.com
- Methods: `requestPayment(orderId, amount, method)`, `confirmPayment(paymentKey, orderId, amount)`, `cancelPayment(paymentKey, reason)`, `verifyWebhook(body, signature)`
- Webhook endpoint: `/payments/webhook/toss` — **must verify signature with secret key before trusting**.
- Store `paymentKey`, `orderId`, `method` (card/vbank/kakaopay), `amount`, `approvedAt`, raw response JSON.

### 7.2 CLOVA OCR (`integrations/clova-ocr/`)
- Docs: https://api.ncloud-docs.com/docs/ai-application-service-ocr
- Method: `extractId(imageBase64)` → `{ name, birthDate, idNumber, issueDate, type }`
- Called once per session at ID-verify step. Result cached on session; never re-OCR the same image.
- **PIPA note:** do not log `idNumber`. Mask as `900101-*******` in logs/DB after extraction; store only birthDate + last-digit region code.

### 7.3 AWS Rekognition (`integrations/aws-rekognition/`)
- Docs: https://docs.aws.amazon.com/rekognition/
- Methods: `compareFaces(sourceImg, targetImg)` → similarity score, `detectFaces(img)` → count + landmarks
- Used at ID-verify (compare ID photo to live webcam) and periodically during exam (re-verify, detect multiple people).
- **Threshold:** similarity ≥ 85 passes; 70–85 triggers human review; < 70 rejects.

### 7.4 Anthropic Claude (`integrations/anthropic/`)
- Docs: https://docs.claude.com/en/api
- Model: `claude-opus-4-7` for grading (best reasoning); `claude-sonnet-4-6` for in-exam AI tool (faster, cheaper).
- Method: `grade({ rubric, studentWork, modelAnswer })` → `{ score, rationale, perCriterion }`
- System prompt stored in `grading/prompts/`. Inject rubric + model answer, return JSON.
- **Always** use `tool_use` / structured output for grading. Don't parse free-text scores.

### 7.5 OpenAI (`integrations/openai/`)
- Secondary LLM option for in-exam AI tools. AXIS philosophy is multi-tool — give candidates choice.

### 7.6 Judge0 (`integrations/judge0/`)
- Self-hosted on a separate server. Docker-isolated, no network egress, 1 CPU + 256MB RAM limit, 5s timeout.
- Method: `submit({ sourceCode, language, stdin, expectedOutput })` → `{ status, output, stderr, time, memory }`
- **Never** accept code that imports `os`, `subprocess`, `requests`, etc. — enforce at both client-side lint and server-side AST check before submit to Judge0.

### 7.7 Copyleaks (`integrations/copyleaks/`)
- L1 deliverable similarity check. Async: submit → webhook → score.
- Flag threshold: > 30% similarity queues expert review; > 60% auto-voids with manual confirmation.

### 7.8 Aligo SMS (`integrations/aligo-sms/`)
- Docs: https://smartsms.aligo.in/admin/api/info.html
- Method: `send(phone, text)` — exam D-1 reminder, entry code, password reset, etc.
- Korean character-limit rules differ from ASCII; wrapper handles LMS vs SMS thresholds.

### 7.9 AWS SES (`integrations/aws-ses/`)
- Transactional email: registration confirm, result announcement, certificate issued.
- Templates live in `notifications/templates/`. Use Handlebars.

### 7.10 Naver Cloud Object Storage (`integrations/nc-object-storage/`)
- S3-compatible API — use `@aws-sdk/client-s3` pointed at NCP endpoint.
- Buckets: `axis-id-photos` (encrypted, TTL 90d), `axis-snapshots` (TTL 90d), `axis-deliverables` (TTL 3y — may be contested), `axis-certificates` (permanent).
- Pre-signed URLs for uploads; server never streams user uploads through Node.

### 7.11 NICE 본인확인 (`integrations/nice-auth/`)
- Required for KRIVET-registered certificates to verify real-name identity at registration.
- Returns CI/DI (connecting info / duplicate info) — store these, not RRN.

### 7.12 OAuth (`integrations/oauth/kakao`, `/naver`, `/google`)
- Standard OAuth 2.0. Store provider + providerId in a `UserIdentity` table; one User may have many Identities.

---

## 8. Key business rules (do not skip)

Reference: `3_AXIS_관리운영규정.pdf` — the operations regulations are legally binding.

### Pass criteria
- **L3:** written ≥ 60/100. Any subject < 40% = fail.
- **L2:** written ≥ 60 **and** practical ≥ 60. Any written subject < 40% = fail.
- **L1:** written ≥ 60 **and** practical ≥ 60. Any written subject < 40% = fail.
- **Partial pass:** if one part (written or practical) passes but not both, that part is exempt for **12 months** on a re-registration. Store `partial_exempt` flag + `exempt_source_session_id` on `Registration`.

### Cheating
- **Article 28** defines 5 cheating types. Detection → warning 1 → re-warning 2 → forced termination on 3rd.
- **Article 29:** confirmed cheating = exam voided + **2-year eligibility suspension**. Write a `UserPenalty` row with `start_at`, `end_at`, `related_session_id`, `decided_by`. Block registration and exam entry while `status = active`.
- **Re-exam after forced termination:** allowed **only** if a technical error is acknowledged by admin. Default: blocked.

### Certificate
- Validity **3 years** from issue. After expiration, requires renewal exam or continuing education.
- Certificate number format: `AXIS-{type}-{level}-{YYYY}-{round:3d}-{seq:5d}`. Globally unique. Example: `AXIS-C-L2-2026-001-00123`.

### Refund (Korean law — Act on the Consumer Protection in Electronic Commerce)
- Cancel before exam-paper freeze (`ExamSession.started_at IS NULL`): 100% refund.
- After start: no refund.
- Technical fault (proven): full refund or free re-seat at next round.

### Timer & network
- Timer runs server-side. Client sends heartbeats; server is the authority.
- Network disconnect ≥ 10 seconds: client reports via `/cbt/sessions/:id/network-pause`.
- Only **admin-approved** (not automatic) pauses compensate time. Default: exam continues.

---

## 9. Concurrency, auto-save, real-time

### Auto-save (answers)
Client sends every answer change debounced (500ms) with `{ questionId, choice, version }`. Server:
```
BEGIN;
SELECT version FROM answers WHERE session_id = ? AND question_id = ? FOR UPDATE;
IF db.version != req.version THEN RETURN 409 Conflict;
UPDATE answers SET choice = ?, version = version + 1 WHERE ...;
COMMIT;
```
Return the new version. Client updates local state. This catches duplicate-tab races.

### Proctoring events
- Snapshots: `POST /cbt/.../proctor/snapshot` — multipart. Server signs + uploads to S3, enqueues a BullMQ job on `snapshot` queue for async face-compare (Rekognition) every 5th snapshot.
- Events: `POST /cbt/.../proctor/event` — lightweight JSON. Written to `ProctoringEvent` table immediately + pushed to admin WebSocket via Redis pub/sub.

### Admin live dashboard
- `proctor.gateway` (candidate) publishes to Redis channel `session:{id}:stream`.
- `admin.gateway` subscribes per scheduleId. Fan-out to connected admins via Socket.io rooms.
- Use Redis adapter for Socket.io so the system scales across multiple Node workers without sticky-session headaches.

### Question paper freeze
On `POST /cbt/sessions/:id/start`:
1. Lock the session row.
2. Draw MCQs per subject allocation (AXIS L3: 15+15+10+10).
3. Shuffle questions and choice order using a seed stored on the session.
4. For each question, snapshot `content_hash` + `content_snapshot` (the full stem + choices JSON).
5. Write `Answer` rows with `question_id`, `q_version`, `version = 0`, `choice = null`.
6. Commit transaction, start timer.

If the admin later edits a question in the bank, it gets a new version; in-flight exams keep the snapshot.

---

## 10. Security requirements

**This is a legal exam system. Security bugs = lawsuits.**

### Must-haves
- HTTPS everywhere. HSTS. TLS 1.2+ only.
- JWT access tokens (15 min) + refresh tokens (14 days, httpOnly cookie, rotate on use).
- CSRF protection on state-changing cookie-auth requests.
- Rate limits: login 5/min per IP, password reset 3/hour per email, verification endpoint 60/min per IP.
- Input validation on every DTO. No string concatenation into SQL — Prisma prevents this but raw queries must use parameters.
- **Content Security Policy** on CBT pages — block inline scripts, external AI sites (chat.openai.com, claude.ai, gemini.google.com). See §12 pitfalls.

### PIPA (Korean privacy law)
- Encrypt at rest: ID photos, webcam snapshots, face embeddings, RRN-derived data.
- Data residency: store sensitive files in Korea (Naver Cloud Object Storage). Do not send ID photos to AWS S3 US regions.
- Retention: 90 days default; 2 years if a penalty is active; immediate delete on withdrawal (with exceptions for legally-mandated retention of exam records).
- Consent: every new consent checkbox writes to `ConsentLog` with timestamp, IP, user-agent.

### Code sandbox
Threats: remote code execution, fork bomb, crypto mining, container escape, network exfiltration.
- Judge0 container: no network, 256MB RAM, 1 CPU, 5s wall-time, 10k pids limit, read-only root FS except `/tmp` (64MB).
- Block imports/calls: `os`, `subprocess`, `socket`, `urllib`, `requests`, `fetch`, `eval`, `exec`, file-system writes outside `/tmp`.
- Enforce at two layers: (1) pre-submit AST lint, (2) seccomp + AppArmor profile on the container.
- Run sandbox on a **separate VPS** with no DB access and no credentials.

---

## 11. Testing

- **Unit:** Jest. Every service method with business logic.
- **Integration:** supertest against a Testcontainers MySQL. Cover every controller.
- **E2E:** Playwright on staging. Full candidate flow: register → pay → enter exam → auto-save → submit → grade → certificate.
- **Load:** k6. Simulate 500 concurrent L3 sessions. Must hold.
- **Security:** OWASP ZAP in CI for the main + CBT sites. Manual pentest of code sandbox before launch.

Coverage target: **services ≥ 80%, controllers ≥ 60%, overall ≥ 70%.** CI fails below threshold.

---

## 12. Common pitfalls specific to this project

1. **Don't store RRN (주민등록번호) unmasked.** Extract birthDate + region digit only. Use CI/DI from NICE for uniqueness.
2. **Don't grade L2/L1 synchronously** inside a request handler. Enqueue to BullMQ — grading takes 10–60s per submission.
3. **Don't let candidates access external AI tools during L2/L1** without logging. The CBT page should block clipboard paste from unknown origins, detect opened tabs, and log every in-platform AI chat turn for later review.
4. **Don't trust client timers.** Client shows a countdown for UX; server enforces the real deadline. On submit, check `NOW() <= session.hard_deadline` server-side.
5. **Don't return 500 on Prisma unique errors.** Map P2002 → 409 Conflict with a human message.
6. **Don't forget Korean holidays.** Exam schedules must exclude Seollal, Chuseok, etc. The `ExamSchedule` create endpoint should warn, not silently create.
7. **Don't batch-delete old snapshots without checking penalty status.** If a user has an active `UserPenalty` tied to a session, retain all evidence until `end_at`.
8. **Don't expose question bank to clients in bulk.** Questions are drawn per session. Never list them in any public or user-side endpoint.
9. **Don't send certificate PDFs from the request thread.** Enqueue to `certificate.processor`; email a download link when ready.
10. **The CBT site must run in Fullscreen.** Detect `fullscreenchange` + `Page Visibility API` + `beforeunload`. Exiting any of these = logged event.

---

## 13. Environment variables

All env vars validated by Joi at boot. Fail fast if missing. Template:

```
# Core
NODE_ENV=production
PORT=3000
DATABASE_URL=mysql://...
REDIS_URL=redis://...

# JWT
JWT_ACCESS_SECRET=
JWT_REFRESH_SECRET=
JWT_ACCESS_TTL=15m
JWT_REFRESH_TTL=14d

# Toss Payments
TOSS_CLIENT_KEY=
TOSS_SECRET_KEY=
TOSS_WEBHOOK_SECRET=

# CLOVA OCR
CLOVA_OCR_URL=
CLOVA_OCR_SECRET=

# AWS
AWS_REGION=ap-northeast-2
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_SES_FROM=noreply@axisexam.com

# Naver Cloud Object Storage
NCP_ACCESS_KEY=
NCP_SECRET_KEY=
NCP_BUCKET_ID_PHOTOS=axis-id-photos
NCP_BUCKET_SNAPSHOTS=axis-snapshots
NCP_BUCKET_DELIVERABLES=axis-deliverables
NCP_BUCKET_CERTIFICATES=axis-certificates

# LLM
ANTHROPIC_API_KEY=
OPENAI_API_KEY=

# Judge0
JUDGE0_URL=https://judge0.internal.axisexam.com
JUDGE0_AUTH_TOKEN=

# Copyleaks
COPYLEAKS_EMAIL=
COPYLEAKS_API_KEY=

# Aligo
ALIGO_USER_ID=
ALIGO_API_KEY=
ALIGO_SENDER=

# NICE
NICE_CLIENT_ID=
NICE_CLIENT_SECRET=

# OAuth
KAKAO_CLIENT_ID=
KAKAO_CLIENT_SECRET=
NAVER_CLIENT_ID=
NAVER_CLIENT_SECRET=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

# Sentry
SENTRY_DSN=
```

---

## 14. Sprint checkpoints (from dev plan)

| Date | Checkpoint | Backend must-haves |
|---|---|---|
| Mar 8 | Foundation | DB schema deployed, auth working, API skeletons with Swagger |
| Mar 22 | Mid-review | Registration + Toss Payments integrated, CBT session entry working |
| Apr 5 | Core done | L3 full flow end-to-end, L2 AI practice API, AXIS-C sandbox prototype |
| Apr 19 | Features done | L1 done, admin monitoring live, AI proctoring functional |
| Apr 30 | Launch | QA done, security review done, load test passed, question bank loaded |

---

## 15. When in doubt

1. Search the project knowledge files first (`0_AXIS_CBT_System_Design_Specification_v1.1.html`, `7_AXIS_CBT_Backend_Design_Core_Requirements.html`, the 관리운영규정 PDFs).
2. Business rules > engineering elegance. If a regulation says "2-year suspension," we implement 2-year suspension.
3. Questions about certification policy → PM. Questions about architecture → tech lead. Don't guess on either.

