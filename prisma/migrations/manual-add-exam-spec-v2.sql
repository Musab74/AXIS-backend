-- ─────────────────────────────────────────────────────────────────────────
-- Manual migration: 시험 표준 v2.0 (2026-07-05) session + AI-grading fields.
-- ─────────────────────────────────────────────────────────────────────────
--
-- Purpose:
--   WP1/WP2: `spec_version` — exam standard the session was created under.
--     Existing rows default to '1.1' and keep pre-v2.0 behavior (timing,
--     floors); new sessions are stamped '2.0' at creation.
--   WP4: human-locked decision state machine (provisional → in_review →
--     confirmed_pass | confirmed_fail | invalidated). NULL for v1.1 sessions.
--     Certificates are only issued on CONFIRMED_PASS for v2.0 sessions.
--   WP5: L2 audit fields — embedded-AI version fixed per round, prompt-log
--     ref + SHA-256 hash of the applicant↔embedded-AI transcript.
--   WP6: v2.0 AI grading contract on essay_answers — gate verdict JSON,
--     critical-fail candidates (schema enum strings), injection suspicion,
--     explicit prompt/rubric version strings.
--   Additive-only. Run once (or use `prisma db push`).
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE `exam_sessions`
  ADD COLUMN `spec_version`        VARCHAR(191) NOT NULL DEFAULT '1.1',
  ADD COLUMN `decision_status`     ENUM('PROVISIONAL','IN_REVIEW','CONFIRMED_PASS','CONFIRMED_FAIL','INVALIDATED') NULL,
  ADD COLUMN `confirmed_at`        DATETIME(3)  NULL,
  ADD COLUMN `confirmed_by_ref`    VARCHAR(191) NULL,
  ADD COLUMN `embedded_ai_version` VARCHAR(191) NULL,
  ADD COLUMN `prompt_log_ref`      VARCHAR(191) NULL,
  ADD COLUMN `prompt_log_hash`     VARCHAR(191) NULL;

CREATE INDEX `exam_sessions_decision_status_idx` ON `exam_sessions` (`decision_status`);

ALTER TABLE `essay_answers`
  ADD COLUMN `ai_gate`                JSON         NULL,
  ADD COLUMN `ai_critical_fails`      JSON         NULL,
  ADD COLUMN `ai_injection_suspected` BOOLEAN      NOT NULL DEFAULT false,
  ADD COLUMN `ai_prompt_version`      VARCHAR(191) NULL,
  ADD COLUMN `ai_rubric_version`      VARCHAR(191) NULL;
