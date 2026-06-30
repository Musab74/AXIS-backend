-- ─────────────────────────────────────────────────────────────────────────
-- Manual migration: expert grading assignment + mandatory-review flag.
-- ─────────────────────────────────────────────────────────────────────────
--
-- Purpose:
--   Adds the two columns that turn the grading queue into a real workflow:
--     • assigned_expert_id — the EXPERT (users.id) assigned to score a session's
--       practical (drives the queue's "assignee" column + the expert's own list).
--     • mandatory_review — set by the AI prescore when a spec trigger fires
--       (AI confidence < floor, risk flag, or boundary score) so graders
--       prioritize sessions that need human scrutiny.
--   Additive-only. Run once.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE `exam_sessions`
  ADD COLUMN `assigned_expert_id` VARCHAR(191) NULL,
  ADD COLUMN `mandatory_review`   TINYINT(1)   NOT NULL DEFAULT 0;
