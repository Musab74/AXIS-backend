-- ─────────────────────────────────────────────────────────────────────────
-- Manual migration: English translations on Notice.
-- ─────────────────────────────────────────────────────────────────────────
--
-- Purpose:
--   Adds optional `title_en`, `content_en`, `tag_en` columns so notices can
--   be authored bilingually. The frontend picks the EN copy when the user
--   is on the English locale, and falls back to the Korean columns when
--   the EN copy is null. Additive-only. Run once.

ALTER TABLE `notices`
  ADD COLUMN `title_en` VARCHAR(191) NULL AFTER `title`,
  ADD COLUMN `content_en` TEXT NULL AFTER `content`,
  ADD COLUMN `tag_en` VARCHAR(191) NULL AFTER `tag`;
