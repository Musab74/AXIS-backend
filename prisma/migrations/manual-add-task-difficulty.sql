-- ─────────────────────────────────────────────────────────────────────────
-- Manual migration: task_templates.difficulty (시험 표준 v2.0).
-- ─────────────────────────────────────────────────────────────────────────
--   L3 실습형 난이도 고정 (중·중·상·상) — the 1-per-type draw prefers an item
--   whose difficulty matches the type's required band. NULL = untagged.
--   Additive-only. Duplicate-column (errno 1060) is tolerated by the runner,
--   so re-running is safe.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE `task_templates`
  ADD COLUMN `difficulty` VARCHAR(191) NULL;
