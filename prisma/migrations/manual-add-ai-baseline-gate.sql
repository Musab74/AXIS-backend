-- ─────────────────────────────────────────────────────────────────────────
-- Manual migration: v2.0 AI-grading baseline validation (WP8).
-- ─────────────────────────────────────────────────────────────────────────
--
-- Purpose:
--   Formal baseline protocol (기획서 9-1/9-4/11-3): 20+ anchor answers per
--   task type, 2–3 independent experts, per-criterion pass rule
--   |AI − expert| ≤ expert-expert variance. AI-assisted grading runs LIVE
--   only for (level, task_type, prompt_version) rows with passed=true;
--   otherwise the grader is in SHADOW mode (scores stored as reference, all
--   tasks to the expert queue). Failed criteria are excluded from AI scoring
--   (ai_excluded_criteria) and expert-scored directly.
--   Additive-only. Run once (or `prisma db push`).
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE `calibration_runs`
  ADD COLUMN `criterion_results` JSON NULL;

ALTER TABLE `calibration_scores`
  ADD COLUMN `criterion_scores` JSON NULL;

CREATE TABLE `ai_baseline_gates` (
  `id`                    VARCHAR(191) NOT NULL,
  `level`                 ENUM('L3','L2','L1') NOT NULL,
  `task_type`             VARCHAR(191) NOT NULL,
  `prompt_version`        VARCHAR(191) NOT NULL,
  `passed`                BOOLEAN NOT NULL DEFAULT false,
  `ai_excluded_criteria`  JSON NULL,
  `notes`                 TEXT NULL,
  `validated_at`          DATETIME(3) NULL,
  `created_at`            DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`            DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `ai_baseline_gates_level_task_type_prompt_version_key` (`level`, `task_type`, `prompt_version`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
