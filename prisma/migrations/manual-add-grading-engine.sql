-- ─────────────────────────────────────────────────────────────────────────
-- Manual migration: hybrid grading engine (AI first-pass, calibration,
-- adjudication, audit) — brief milestones 4–7.
-- ─────────────────────────────────────────────────────────────────────────
--
-- Purpose:
--   Adds the structured AI grading fields to essay_answers and the four new
--   tables backing calibration, per-grader expert scoring records, and the
--   append-only audit trail. Additive-only; existing columns/data untouched.
--
--   Applied manually (not via `prisma db push`) for the same reason as the
--   other manual migrations: the live DB carries unrelated legacy tables that
--   `db push` wants to drop. Run once — MySQL has no ADD COLUMN IF NOT EXISTS,
--   so re-running errors on already-present objects (harmless to ignore).
-- ─────────────────────────────────────────────────────────────────────────

-- essay_answers: structured AI first-pass verdict + audit fields ────────────
ALTER TABLE `essay_answers`
  ADD COLUMN `ai_criterion_scores` JSON         NULL,
  ADD COLUMN `ai_risk_flags`       JSON         NULL,
  ADD COLUMN `ai_band`             VARCHAR(191) NULL,
  ADD COLUMN `ai_confidence`       DOUBLE       NULL,
  ADD COLUMN `ai_model`            VARCHAR(191) NULL,
  ADD COLUMN `ai_prompt_hash`      VARCHAR(191) NULL,
  ADD COLUMN `ai_latency_ms`       INT          NULL,
  ADD COLUMN `ai_scored_at`        DATETIME(3)  NULL;

-- calibration_runs ──────────────────────────────────────────────────────────
CREATE TABLE `calibration_runs` (
  `id`               VARCHAR(191) NOT NULL,
  `task_id`          VARCHAR(191) NOT NULL,
  `status`           ENUM('PENDING','PASSED','FAILED') NOT NULL DEFAULT 'PENDING',
  `expert_variance`  DOUBLE       NULL,
  `ai_expert_delta`  DOUBLE       NULL,
  `confidence_avg`   DOUBLE       NULL,
  `tolerance_passed` TINYINT(1)   NOT NULL DEFAULT 0,
  `flag_recall_ok`   TINYINT(1)   NOT NULL DEFAULT 0,
  `notes`            TEXT         NULL,
  `created_at`       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  INDEX `calibration_runs_task_id_idx` (`task_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- calibration_scores ────────────────────────────────────────────────────────
CREATE TABLE `calibration_scores` (
  `id`          VARCHAR(191) NOT NULL,
  `run_id`      VARCHAR(191) NOT NULL,
  `rater_type`  VARCHAR(191) NOT NULL,
  `rater_id`    VARCHAR(191) NULL,
  `anchor_band` VARCHAR(191) NOT NULL,
  `total`       INT          NOT NULL,
  `flagged`     TINYINT(1)   NOT NULL DEFAULT 0,
  `created_at`  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  INDEX `calibration_scores_run_id_idx` (`run_id`),
  CONSTRAINT `calibration_scores_run_id_fkey`
    FOREIGN KEY (`run_id`) REFERENCES `calibration_runs` (`id`) ON DELETE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- expert_scoring_records ─────────────────────────────────────────────────────
CREATE TABLE `expert_scoring_records` (
  `id`                   VARCHAR(191) NOT NULL,
  `session_id`           VARCHAR(191) NOT NULL,
  `task_id`              VARCHAR(191) NOT NULL,
  `rater_id`             VARCHAR(191) NOT NULL,
  `scoring_round`        ENUM('FIRST','SECOND','ADJUST') NOT NULL,
  `criterion_scores`     JSON         NOT NULL,
  `total`                INT          NOT NULL,
  `risk_flags_detected`  JSON         NULL,
  `confidence_comment`   TEXT         NULL,
  `adjudication_required` TINYINT(1)  NOT NULL DEFAULT 0,
  `final_decision`       VARCHAR(191) NULL,
  `final_authority`      VARCHAR(191) NULL,
  `created_at`           DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  INDEX `expert_scoring_records_session_id_idx` (`session_id`),
  INDEX `expert_scoring_records_session_id_task_id_idx` (`session_id`, `task_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- audit_logs ────────────────────────────────────────────────────────────────
CREATE TABLE `audit_logs` (
  `id`          VARCHAR(191) NOT NULL,
  `actor_id`    VARCHAR(191) NOT NULL,
  `action`      VARCHAR(191) NOT NULL,
  `entity_type` VARCHAR(191) NOT NULL,
  `entity_id`   VARCHAR(191) NOT NULL,
  `before`      JSON         NULL,
  `after`       JSON         NULL,
  `reason`      TEXT         NULL,
  `created_at`  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  INDEX `audit_logs_entity_type_entity_id_idx` (`entity_type`, `entity_id`),
  INDEX `audit_logs_actor_id_idx` (`actor_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
