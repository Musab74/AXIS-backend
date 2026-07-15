-- ─────────────────────────────────────────────────────────────────────────
-- Manual migration: schedule-level results announcement timestamp.
-- ─────────────────────────────────────────────────────────────────────────
--
-- Purpose:
--   Admin "합격 발표 공개" sets results_announced_at. Public pass lists and
--   /results treat a round as announced only when this is set.
--   status=COMPLETED remains "exam window ended" (cron) and must not alone
--   mean results are public.
--
--   Backfill: existing COMPLETED rounds were already treated as announced —
--   copy updated_at so production visibility does not regress.
--   Additive-only. Run once via npm run db:apply-migrations.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE `exam_schedules`
  ADD COLUMN `results_announced_at` DATETIME(3) NULL;

UPDATE `exam_schedules`
  SET `results_announced_at` = COALESCE(`updated_at`, CURRENT_TIMESTAMP(3))
  WHERE `status` = 'COMPLETED'
    AND `results_announced_at` IS NULL;

CREATE INDEX `exam_schedules_results_announced_at_idx`
  ON `exam_schedules` (`results_announced_at`);
