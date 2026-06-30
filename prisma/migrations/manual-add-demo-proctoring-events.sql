-- ─────────────────────────────────────────────────────────────────────────
-- Manual migration: add demo_proctoring_events table
-- ─────────────────────────────────────────────────────────────────────────
--
-- Purpose:
--   Persist proctoring evidence captured during DEMO runs so users can see
--   their own screenshots / voice clips from MyPage. Demo runs aren't tied
--   to an ExamSession row (sessionId 'demo'), so they cannot reuse the
--   `proctoring_events` table — that column is a required FK to
--   `exam_sessions`. We keep demo data in its own table.
--
-- Apply:
--   mysql -u <user> -p <db> < prisma/migrations/manual-add-demo-proctoring-events.sql
--
-- After applying:
--   cd axis-backend && npx prisma generate
--   pm2 restart axis-backend
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS demo_proctoring_events (
  id              VARCHAR(191)  NOT NULL,
  user_id         VARCHAR(191)  NOT NULL,
  kind            VARCHAR(64)   NOT NULL,
  severity        VARCHAR(191)  NOT NULL DEFAULT 'warning',
  caption_ko      TEXT          NULL,
  caption_en      TEXT          NULL,
  evidence_url    TEXT          NULL,
  video_clip_url  TEXT          NULL,
  retain_until    DATETIME(3)   NULL,
  metadata        JSON          NULL,
  created_at      DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (id),
  INDEX demo_proctoring_events_user_id_idx (user_id),
  CONSTRAINT demo_proctoring_events_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users(id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- Verify
SHOW CREATE TABLE demo_proctoring_events;
