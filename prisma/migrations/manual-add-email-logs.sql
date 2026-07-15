-- ─────────────────────────────────────────────────────────────────────────
-- Manual migration: transactional email delivery log.
-- ─────────────────────────────────────────────────────────────────────────
--
-- Purpose:
--   Backs MailerService. One row per email we intended to send.
--
--   `dedupe_key` (UNIQUE) is the idempotency guard, not just an audit field.
--   The paid-money path is reached by three independent triggers — the browser
--   /payment/confirm call, the PortOne webhook, and the 5-minute reconciliation
--   cron — and the expiry sweeps re-scan the same rows on every run. MailerService
--   INSERTs this row before calling SES, so a duplicate trigger hits the unique
--   index (P2002), short-circuits, and the candidate is mailed exactly once.
--
--   Deliberately no FK-less orphan rows: ON DELETE CASCADE follows the user.
--   Additive-only. Run once.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE `email_logs` (
  `id`         VARCHAR(191) NOT NULL,
  `user_id`    VARCHAR(191) NOT NULL,
  `to_email`   VARCHAR(191) NOT NULL,
  `template`   ENUM(
                 'PAYMENT_SUCCESS',
                 'PAYMENT_FAILED',
                 'SEAT_HOLD_EXPIRED',
                 'EXAM_DEADLINE_REMINDER',
                 'EXAM_DEADLINE_EXPIRED',
                 'CERT_EXPIRY_REMINDER'
               ) NOT NULL,
  `dedupe_key` VARCHAR(191) NOT NULL,
  `status`     ENUM('PENDING', 'SENT', 'FAILED', 'SKIPPED') NOT NULL DEFAULT 'PENDING',
  `detail`     TEXT NULL,
  `sent_at`    DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  UNIQUE KEY `email_logs_dedupe_key_key` (`dedupe_key`),
  KEY `email_logs_user_id_idx` (`user_id`),
  KEY `email_logs_template_status_idx` (`template`, `status`),
  CONSTRAINT `email_logs_user_id_fkey`
    FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
