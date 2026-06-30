-- ─────────────────────────────────────────────────────────────────────────
-- Manual migration: extend question_bank & task_templates with CSV fields
-- ─────────────────────────────────────────────────────────────────────────
--
-- Purpose:
--   The authored AXIS content (questions/*.csv) carries rich authoring
--   metadata that `prisma/seed-questions-csv.ts` already writes, but the
--   live schema lacked the columns — so every upsert failed and the live
--   exam ran on synthetic placeholder data. This adds the missing columns
--   (all nullable / defaulted, additive-only) plus the unique keys the seed
--   uses as its idempotent upsert key.
--
--   Applied manually (not via `prisma db push`) because the live DB carries
--   an unrelated legacy `certificates` table that `db push` wants to drop;
--   this keeps the change scoped to the two question tables.
--
--   Idempotency: run once. MySQL does not support ADD COLUMN IF NOT EXISTS,
--   so re-running will error on already-present columns (harmless to ignore).
-- ─────────────────────────────────────────────────────────────────────────

-- question_bank ────────────────────────────────────────────────────────────
ALTER TABLE `question_bank`
  ADD COLUMN `no`             INT          NULL,
  ADD COLUMN `domain_area`    VARCHAR(191) NULL,
  ADD COLUMN `q_type`         VARCHAR(191) NULL,
  ADD COLUMN `item_purpose`   VARCHAR(191) NULL,
  ADD COLUMN `difficulty`     VARCHAR(191) NULL,
  ADD COLUMN `explanation`    TEXT         NULL,
  ADD COLUMN `source_ref`     VARCHAR(191) NULL,
  ADD COLUMN `shuffle_exempt` TINYINT(1)   NOT NULL DEFAULT 0,
  ADD COLUMN `review_status`  VARCHAR(191) NULL,
  ADD COLUMN `review_comment` VARCHAR(191) NULL,
  ADD COLUMN `created_by`     VARCHAR(191) NULL,
  ADD COLUMN `created_date`   DATETIME(3)  NULL;

CREATE UNIQUE INDEX `question_bank_cert_type_level_no_key`
  ON `question_bank` (`cert_type`, `level`, `no`);

-- task_templates ───────────────────────────────────────────────────────────
ALTER TABLE `task_templates`
  ADD COLUMN `set_no`               INT          NULL,
  ADD COLUMN `task_type`            VARCHAR(191) NULL,
  ADD COLUMN `time_limit`           INT          NULL,
  ADD COLUMN `sample_data`          TEXT         NULL,
  ADD COLUMN `required_structure`   TEXT         NULL,
  ADD COLUMN `forbidden_rules`      TEXT         NULL,
  ADD COLUMN `ai_tool_allowed`      VARCHAR(191) NULL,
  ADD COLUMN `max_score`            INT          NULL,
  ADD COLUMN `model_answer`         TEXT         NULL,
  ADD COLUMN `risk_criteria`        TEXT         NULL,
  ADD COLUMN `benchmark_excellent`  TEXT         NULL,
  ADD COLUMN `benchmark_normal`     TEXT         NULL,
  ADD COLUMN `benchmark_borderline` TEXT         NULL,
  ADD COLUMN `benchmark_fail`       TEXT         NULL,
  ADD COLUMN `ai_prompt_version`    VARCHAR(191) NULL,
  ADD COLUMN `review_status`        VARCHAR(191) NULL,
  ADD COLUMN `review_comment`       VARCHAR(191) NULL,
  ADD COLUMN `version`              INT          NOT NULL DEFAULT 1,
  ADD COLUMN `created_by`           VARCHAR(191) NULL,
  ADD COLUMN `created_date`         DATETIME(3)  NULL,
  ADD COLUMN `is_active`            TINYINT(1)   NOT NULL DEFAULT 1;

CREATE UNIQUE INDEX `task_templates_cert_type_level_set_no_task_type_key`
  ON `task_templates` (`cert_type`, `level`, `set_no`, `task_type`);
