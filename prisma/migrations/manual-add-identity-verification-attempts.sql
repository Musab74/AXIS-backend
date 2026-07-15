-- ─────────────────────────────────────────────────────────────────────────
-- Manual migration: identity_verification_attempts
-- ─────────────────────────────────────────────────────────────────────────
--
-- Purpose:
--   Persist pre-exam ID OCR + face-match outcomes for admin member review.
--   Intentionally stores NO image blobs — ID card images must never be kept.
--   On PASS the live selfie may still live on users.reference_face_image for
--   in-exam identity checks; that blob is never exposed on admin APIs.
--
-- Apply:
--   npm run db:apply-migrations
--   (or) mysql … < prisma/migrations/manual-add-identity-verification-attempts.sql
--
-- After applying:
--   npx prisma generate
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS identity_verification_attempts (
  id                 VARCHAR(191)  NOT NULL,
  user_id            VARCHAR(191)  NOT NULL,
  exam_session_id    VARCHAR(191)  NULL,
  verdict            VARCHAR(32)   NOT NULL,
  reasons            JSON          NOT NULL,
  id_type            VARCHAR(64)   NOT NULL,
  ocr_confidence     DOUBLE        NOT NULL,
  name_matched       TINYINT(1)    NOT NULL,
  birth_date_matched TINYINT(1)    NULL,
  face_decision      VARCHAR(32)   NOT NULL,
  face_similarity    DOUBLE        NOT NULL,
  created_at         DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (id),
  INDEX identity_verification_attempts_user_id_created_at_idx (user_id, created_at),
  CONSTRAINT identity_verification_attempts_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users(id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
