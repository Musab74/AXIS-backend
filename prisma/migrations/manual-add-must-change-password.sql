-- ─────────────────────────────────────────────────────────────────────────
-- Manual migration: forced password change after admin reset.
-- ─────────────────────────────────────────────────────────────────────────
--
-- Purpose:
--   A SUPER_ADMIN can reset any staff (expert) account to the fixed temp
--   password. The flag below marks the account so the portal forces a
--   password change on the next login; a successful /auth/change-password
--   (or NICE reset) clears it.
--   Additive-only. Run once.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE `users`
  ADD COLUMN `must_change_password` TINYINT(1) NOT NULL DEFAULT 0;
