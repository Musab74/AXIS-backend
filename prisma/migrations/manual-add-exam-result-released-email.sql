-- ─────────────────────────────────────────────────────────────────────────
-- Manual migration: add the EXAM_RESULT_RELEASED email template.
-- ─────────────────────────────────────────────────────────────────────────
--
-- Purpose:
--   Adds a new value to the `email_logs`.`template` ENUM so MailerService can
--   log the neutral "your exam results are now available" notice that fires
--   when an expert confirms a decision (CONFIRMED_PASS / CONFIRMED_FAIL).
--
--   The new value is APPENDED to the END of the ENUM so the ordinals of every
--   existing template value (and therefore every existing row) are preserved.
--   Do NOT reorder — mirrors manual-add-proctor-event-types.sql.
--
--   Additive and idempotent: re-running MODIFY with the same definition is a
--   no-op. Run once (tracked by apply-manual-migrations.ts).
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE `email_logs`
  MODIFY COLUMN `template` ENUM(
    'PAYMENT_SUCCESS',
    'PAYMENT_FAILED',
    'SEAT_HOLD_EXPIRED',
    'EXAM_DEADLINE_REMINDER',
    'EXAM_DEADLINE_EXPIRED',
    'CERT_EXPIRY_REMINDER',
    'EXAM_RESULT_RELEASED'
  ) NOT NULL;
