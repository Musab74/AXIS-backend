-- ─────────────────────────────────────────────────────────────────────────
-- Manual migration: add proctor v2 event types
-- ─────────────────────────────────────────────────────────────────────────
--
-- Purpose:
--   Adds 10 new values to `proctoring_events.event_type` ENUM so the
--   gaze / page-leave events the frontend already sends stop being silently
--   400-rejected by the @IsEnum DTO validator. See AXIS proctor detection
--   gap fix plan, Step 1.
--
-- Safety guarantees:
--   • ADDITIVE ONLY — appends to the END of the ENUM list. MySQL stores
--     ENUMs by ordinal, so any reorder would corrupt every existing row.
--   • The original 12 values are listed FIRST, in the same order, with the
--     same ordinals 1..12. New values are 13..22.
--   • Does NOT change the column default.
--   • Idempotent on re-run? NO — MySQL will warn if values already present
--     when MODIFY COLUMN is run. The script logs a sanity check before/after.
--
-- Pre-flight (run these MANUALLY first to confirm you're on the right DB):
--   SELECT DATABASE();
--   SHOW COLUMNS FROM proctoring_events LIKE 'event_type';
--   SELECT eventType, COUNT(*) FROM ProctoringEvent
--     -- (Prisma maps to `proctoring_events`)
--     GROUP BY eventType;
--
-- Apply:
--   mysql -u <user> -p <db> < prisma/migrations/manual-add-proctor-event-types.sql
--
-- Backout (only safe if NO rows have been written using new values yet):
--   ALTER TABLE proctoring_events
--     MODIFY COLUMN event_type ENUM(
--       'FACE_NOT_DETECTED','MULTIPLE_FACES','PHONE_DETECTED','TAB_SWITCH',
--       'FULLSCREEN_EXIT','COPY_PASTE','RIGHT_CLICK','AI_FLAG',
--       'AI_FLAG_SUSPICIOUS','AI_FLAG_CONFIRMED','AUDIO_HIGH','MANUAL_FLAG'
--     ) NOT NULL;
--
-- After applying:
--   cd axis-backend && npx prisma generate
--   pm2 restart axis-backend
-- ─────────────────────────────────────────────────────────────────────────

-- 1. Sanity check: count rows per existing enum value (informational)
SELECT event_type, COUNT(*) AS row_count
  FROM proctoring_events
 GROUP BY event_type
 ORDER BY row_count DESC;

-- 2. Apply the additive enum extension. NEW values are appended at the end.
ALTER TABLE proctoring_events
  MODIFY COLUMN event_type ENUM(
    -- original 12 (DO NOT REORDER) ------------------------------------
    'FACE_NOT_DETECTED',
    'MULTIPLE_FACES',
    'PHONE_DETECTED',
    'TAB_SWITCH',
    'FULLSCREEN_EXIT',
    'COPY_PASTE',
    'RIGHT_CLICK',
    'AI_FLAG',
    'AI_FLAG_SUSPICIOUS',
    'AI_FLAG_CONFIRMED',
    'AUDIO_HIGH',
    'MANUAL_FLAG',
    -- additive (proctor v2) -------------------------------------------
    'NO_FACE',
    'GAZE_AWAY',
    'EYES_CLOSED',
    'IDENTITY_MISMATCH',
    'WINDOW_BLUR',
    'TAB_HIDDEN',
    'BEFORE_UNLOAD',
    'KEY_BLOCKED',
    'EXTERNAL_DISPLAY',
    'POSSIBLE_MIRROR'
  ) NOT NULL;

-- 3. Verify the column now lists all 22 values.
SHOW COLUMNS FROM proctoring_events LIKE 'event_type';
