-- ─────────────────────────────────────────────────────────────────────────
-- Manual migration: per-series expert grading competencies.
-- ─────────────────────────────────────────────────────────────────────────
--
-- Purpose:
--   Adds the `expert_competencies` table that scopes an EXPERT grader to one
--   or more series (AXIS / AXIS_C / AXIS_H). The admin grading queue filters
--   rows by the viewer's competencies so a coding expert only sees AXIS_C
--   tasks, a healthcare expert only AXIS_H, etc. SUPER_ADMIN / GRADING_ADMIN
--   are unconstrained. Additive-only; no existing tables touched.
--
--   Applied manually (not via `prisma db push`) for the same reason as the
--   other manual migrations: the live DB carries unrelated legacy tables that
--   `db push` wants to drop. Run once — MySQL has no CREATE TABLE IF NOT
--   EXISTS semantics for indexes, so re-running errors on already-present
--   objects (harmless to ignore).
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE `expert_competencies` (
  `id`         VARCHAR(191) NOT NULL,
  `user_id`    VARCHAR(191) NOT NULL,
  `cert_type`  ENUM('AXIS','AXIS_C','AXIS_H') NOT NULL,
  `granted_by` VARCHAR(191) NULL,
  `granted_at` DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `expert_competencies_user_id_cert_type_key` (`user_id`, `cert_type`),
  KEY `expert_competencies_cert_type_idx` (`cert_type`),
  CONSTRAINT `expert_competencies_user_id_fkey`
    FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
