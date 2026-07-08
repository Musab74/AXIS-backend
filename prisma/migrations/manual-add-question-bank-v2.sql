-- ─────────────────────────────────────────────────────────────────────────
-- Manual migration: v2.0 question-bank & authoring infrastructure (WP10).
-- ─────────────────────────────────────────────────────────────────────────
--
-- Purpose:
--   Item lifecycle states (초안→1차검수→2차검수→사전검증→승인→비활성→폐기;
--   NULL = legacy row treated as 승인 alongside `active`), pretest (비채점)
--   embedding, stratified-generation metadata tags, anchor items with
--   exposure tracking, and tech-assumption review fields. Content production
--   is out of scope — this is the data model + selection logic.
--   Additive-only. Run once (or `prisma db push`).
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE `question_bank`
  ADD COLUMN `lifecycle_status`     VARCHAR(191) NULL,
  ADD COLUMN `question_type_tag`    VARCHAR(191) NULL,
  ADD COLUMN `business_context_tag` VARCHAR(191) NULL,
  ADD COLUMN `risk_tag`             VARCHAR(191) NULL,
  ADD COLUMN `is_anchor`            BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `exposure_count`       INT NOT NULL DEFAULT 0,
  ADD COLUMN `tech_assumption_type` VARCHAR(191) NULL,
  ADD COLUMN `next_review_at`       DATETIME(3) NULL,
  ADD COLUMN `pretest_stats`        JSON NULL;

CREATE INDEX `question_bank_cert_type_level_lifecycle_status_idx`
  ON `question_bank` (`cert_type`, `level`, `lifecycle_status`);

ALTER TABLE `task_templates`
  ADD COLUMN `lifecycle_status`     VARCHAR(191) NULL,
  ADD COLUMN `is_anchor`            BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `exposure_count`       INT NOT NULL DEFAULT 0,
  ADD COLUMN `tech_assumption_type` VARCHAR(191) NULL,
  ADD COLUMN `next_review_at`       DATETIME(3) NULL,
  ADD COLUMN `pretest_stats`        JSON NULL;

ALTER TABLE `answers`
  ADD COLUMN `is_pretest` BOOLEAN NOT NULL DEFAULT false;
