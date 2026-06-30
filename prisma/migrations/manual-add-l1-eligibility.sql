-- ─────────────────────────────────────────────────────────────────────────
-- Manual migration: L1 eligibility document review.
-- ─────────────────────────────────────────────────────────────────────────
--
-- Purpose:
--   Adds the review state for L1 응시자격 documents. An L1 applicant uploads a
--   proof document (supportDocUrl already exists); these columns capture the
--   declared basis + the reviewer's decision. Entry to the REAL L1 exam is
--   gated on eligibility_status = 'APPROVED'; the demo exam is never gated.
--   Additive-only. Run once.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE `registrations`
  ADD COLUMN `eligibility_type`        VARCHAR(191) NULL,
  ADD COLUMN `eligibility_status`      ENUM('NOT_REQUIRED','PENDING','APPROVED','REJECTED') NOT NULL DEFAULT 'NOT_REQUIRED',
  ADD COLUMN `eligibility_reviewed_by` VARCHAR(191) NULL,
  ADD COLUMN `eligibility_reviewed_at` DATETIME(3)  NULL,
  ADD COLUMN `eligibility_note`        TEXT         NULL;
