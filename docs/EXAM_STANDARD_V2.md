# 시험 표준 v2.0 (2026-07-05) — 구현 노트

Backend implementation of the v2.0 exam standard (`new_doc_l3/` 기획서·스키마).
Every rule keys off **the session's `specVersion`** (`exam_sessions.spec_version`,
`"1.1"` | `"2.0"`) — never a global constant alone — so in-flight sessions keep
the rules they started under. New sessions are stamped with
`currentSpecVersion()` (env `EXAM_SPEC_VERSION`, default `2.0`).

## What changed per version

| Rule | v1.1 (legacy) | v2.0 |
|---|---|---|
| L3 timing | 60분 (객관식 40분 + 실습 20분) | **70분 (객관식 50분 + 실습 20분)**; legacy MCQ-only 모드는 60분 유지 |
| L3 hard cuts | 총점 70 + 실습 24/40 | 총점 70 + **객관식 30/60** + 실습 24/40 (`objective_score_min_30` 신설) |
| L2 hard cuts | 동일 (70 / 15/30 / 42/70) | 동일 — gate keys `objective_score_min_15`, `practice_score_min_42` |
| L1 hard cuts | 총점 70 + Part B 33/55 + **Part C 12/20** | 총점 70 + **Part A 13/25 신설** + Part B 33/55; **Part C 하드컷 제거** (Part C <12는 검수 트리거 "Part C 12점 미만" — 스키마 enum 외 internal reason) |
| 경계밴드 | generic ±5pp | 명시적 per-level 밴드 (`review-bands.ts`) — 총점 65~74, L3 실습 22~26, L2 객관식 13~17·실습 38~45·단일 과제 40% 미만, L1 Part A 11~15·Part B 30~36 |
| 판정 | GRADED + 즉시 자격증 | **human-locked**: provisional → in_review → confirmed_pass/confirmed_fail/invalidated; 자격증은 CONFIRMED_PASS에서만 (CertificatesService 하드가드) |

Per-subject 40% written fail floor: unchanged in both versions.

## Env flags

| Flag | Default | Semantics |
|---|---|---|
| `EXAM_SPEC_VERSION` | `2.0` | Version stamped on NEW sessions (rollout escape hatch only). |
| `L3_PRACTICALS_ENABLED` | `true` | Unchanged. `false` = deprecated legacy MCQ-only L3 (60분, v1.1 scoring even on v2.0 sessions). |
| `L3_AUTO_FINALIZE` | `true` | **Semantics changed for v2.0 sessions**: was "auto-grade + auto-certificate"; now "auto-AGGREGATE to provisional". A confident prescore stages scores + `decisionStatus=PROVISIONAL` so admin confirmation is one click, but never issues certificates or marks GRADED. v1.1 sessions keep the legacy behavior. `false` = defer everything to the expert queue. |
| `AI_GRADING_BASELINE_ENFORCED` | `false` | WP8 gate. `true` (REQUIRED in production for v2.0): AI-assisted grading runs live only for `(level, taskType, promptVersion)` combos with a passed `AiBaselineGate` row; otherwise SHADOW mode — AI scores stored as reference (no `earnedPoints` prefill), every task to the expert queue. |
| `EMBEDDED_AI_VERSION` | `claude-sonnet-4-6` | L2 round-fixed embedded-AI version string recorded on v2.0 L2 sessions at start. |

## Decision state machine (WP4)

- Prescore completion → `PROVISIONAL` (clean) or `IN_REVIEW` (any trigger). Never regresses a confirmed/invalidated decision.
- Human lock: `POST /admin/grading/sessions/:id/confirm` (recomputes gates from staged scores), `POST /admin/grading/confirm-provisional-bulk` (clean provisionals only), `POST /admin/grading/sessions/:id/invalidate` (reason required). L1/L2 `finalize` remains the human lock and now also persists `decisionStatus/confirmedAt/confirmedByRef`.
- 게이트 확정: `POST /admin/grading/sessions/:id/tasks/:taskId/confirm-gate {fieldKey}` — zeroes the contradicted selection field onto `expertScore` (AI record untouched).

## AI grading contract (WP6)

`ClaudeEssayGraderService`: temperature 0, tool-forced JSON, ONE retry on
parse/validation failure then human-queue fallback. Output adds
`gate {triggered, rule, contradiction}`, `criticalFailCandidates` (exact
schema enum strings; off-enum values dropped), `injectionSuspected`,
per-criterion `rationale`/`evidenceQuote`. Risk flags are controlled-vocabulary
tags (L1/L2 11종, L3 10종 — L3's own phrasing); **severity is assigned
system-side** (`grading-config.ts severityForRiskTag`). Prompt/rubric version
strings persist on every AI result (`ai_prompt_version`, `ai_rubric_version`).

## Session aggregate (WP7)

`SessionAggregateService` builds one record per examinee shaped by
`AXIS_L*_채점_세션집계_JSON스키마_v1_0.json` (embedded verbatim in
`session-aggregate-schemas.ts`), validates with ajv, and upserts
`session_aggregates` at prescore-complete / staging / finalize / confirm /
gate-zero / invalidate. Read via `GET /admin/sessions/:id/aggregate`
(+ `POST .../aggregate/rebuild`). Reasons not in the schema enum (e.g.
"Part C 12점 미만") live in `internal_review_reasons`, never in
`record.review.review_reasons`.

## Question bank (WP10)

Lifecycle `초안→1차검수→2차검수→사전검증→승인→비활성→폐기`
(`question-bank-v2.ts`); NULL = legacy row, drawable via `active` alone.
Only 승인 rows draw as scored items; 사전검증 rows embed as unscored pretest
slots (`answers.is_pretest`, L3 ≤4 / L2 ≤3 / L1 ≤2 per form) excluded from all
score/gate math. Exposure counters increment per draw; answer-position audit +
bank-size floors log warnings at paper generation. Blueprints (난이도/유형
distributions, pretest acceptance stats) are config in `BANK_BLUEPRINTS_V2`.

## Migrations

Additive SQL (also applied by `prisma db push`):
`manual-add-exam-spec-v2.sql`, `manual-add-session-aggregate.sql`,
`manual-add-ai-baseline-gate.sql`, `manual-add-question-bank-v2.sql`.
Nothing retroactive — already-GRADED sessions untouched.
