-- ─────────────────────────────────────────────────────────────────────────
-- Manual migration: v2.0 session-aggregate records (WP7).
-- ─────────────────────────────────────────────────────────────────────────
--
-- Purpose:
--   One per-examinee aggregate record per session, shaped by the level's
--   AXIS_L*_채점_세션집계_JSON스키마_v1_0.json (stored in `record`, validated
--   by the aggregation service). Key fields are denormalized for the review
--   queue and B2B reports. Additive-only. Run once (or `prisma db push`).
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE `session_aggregates` (
  `id`                      VARCHAR(191) NOT NULL,
  `session_id`              VARCHAR(191) NOT NULL,
  `cert_type`               ENUM('AXIS','AXIS_C','AXIS_H') NOT NULL,
  `level`                   ENUM('L3','L2','L1') NOT NULL,
  `decision_status`         VARCHAR(191) NOT NULL,
  `human_review_required`   BOOLEAN NOT NULL DEFAULT false,
  `schema_valid`            BOOLEAN NOT NULL DEFAULT false,
  `schema_errors`           JSON NULL,
  `record`                  JSON NOT NULL,
  `internal_review_reasons` JSON NULL,
  `aggregated_at`           DATETIME(3) NOT NULL,
  `created_at`              DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`              DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `session_aggregates_session_id_key` (`session_id`),
  INDEX `session_aggregates_level_decision_status_idx` (`level`, `decision_status`),
  INDEX `session_aggregates_human_review_required_idx` (`human_review_required`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
