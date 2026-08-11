-- Migration 006: requirement owners, submissions and the review loop (Build Prompt 58)
--
-- A requirement is a request for information: the auditor asks the auditee for a
-- reconciliation, a policy, a sample. Migration 005 gave the row the two dates
-- that say where it stands. What it never had was the other half of the
-- transaction: who has to provide the information, what they provided, and
-- whether audit accepted it or asked for more.
--
-- Until now that half lived in email. The request was typed into a row, the
-- answer arrived as an attachment in somebody's inbox, and the decision existed
-- only as a reply. None of it was in the audit file, so "what did we ask for,
-- what came back, and why did we go round again?" could not be answered from the
-- system at all.
--
-- WHY A JUNCTION FOR OWNERS. A requirement routinely lands on more than one
-- person: the reconciliation from finance, the policy from HR. A single
-- owner_id column would force a choice between naming one of them and inventing
-- a comma-separated list, and the second is not a list a query can join. The
-- junction mirrors `action_plan_owners`, which the same argument produced there.
--
-- WHY SUBMISSIONS ARE A TABLE AND NOT COLUMNS. The exchange iterates: the owner
-- provides something, audit reads it and asks for more, the owner provides
-- again. Columns on the requirement would hold the latest round and silently
-- overwrite the previous one, which is precisely the history an audit file
-- exists to keep. One row per round, with its review beside it, makes the
-- back-and-forth the record rather than a casualty of it.
--
-- WHY THE REVIEW LIVES ON THE SUBMISSION. A decision is about a specific answer,
-- not about the requirement in general: "this is not what we asked for" belongs
-- to the thing that was not what we asked for. Keeping the decision, its
-- comment and the further request on the submission row is what lets the trail
-- read as pairs (what was given, what audit said) instead of two lists a reader
-- has to zip together by date.
--
-- WHY THE FILE IS A REFERENCE AND NOT A BLOB. Evidence bytes belong in the
-- organisation's own evidence store through the storage connector (Build Prompt
-- 51), recorded in `files` and `file_attachments` like every other attachment,
-- so retention, legal hold and deletion keep working on them. The submission
-- carries the `file_id`, which is the same id the storage key is built from.
--
-- CLOSE STATE ON THE REQUIREMENT. `closed_at` and `closed_by` record the
-- acceptance that ended the ask, and `last_reviewed_date` records when audit
-- last looked at it, which is the field a reviewer asks for when a requirement
-- has been open for weeks. The `status` column keeps its meaning and the
-- application keeps it in step with these, exactly as it already does with
-- `received_date`: the dates are the record, the status is the label on it.
--
-- The two new tables are creates, and the three columns are plain ADD COLUMNs:
-- no key change, no table rebuild, no data moves. Existing requirements get NULL
-- for all three, which reads as "never reviewed, never closed" and is the honest
-- answer for a row that predates the loop.
--
-- This is the same change the operator's own `grc-requirements-workflow.sql`
-- made. If that has already been applied to the live database, this run fails
-- harmlessly with "table already exists" or "duplicate column name" and nothing
-- is altered. It is committed here so the shape is reproducible in a fresh
-- database rather than a change only one database happens to carry.
--
-- HOW TO RUN IT. See grc/docs/deploy.md, "Migration 006":
--
--   turso db shell hassaudit < grc/db/migrations/006-requirements-workflow.sql
--
-- Take a backup first (`turso db shell hassaudit .dump > backup.sql`). It is
-- independent of migrations 001 to 005 and can be applied in any order relative
-- to them, except that it assumes migration 005 has added the requirement dates.

CREATE TABLE IF NOT EXISTS requirement_owners (
  requirement_id TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  added_at       TEXT,
  added_by       TEXT,
  PRIMARY KEY (requirement_id, user_id)
);

CREATE TABLE IF NOT EXISTS requirement_submissions (
  submission_id           TEXT PRIMARY KEY,
  requirement_id          TEXT NOT NULL,
  organization_id         TEXT NOT NULL,
  round_number            INTEGER NOT NULL DEFAULT 1,
  submitted_by            TEXT,
  submitted_by_name       TEXT,
  submission_note         TEXT,
  file_id                 TEXT,
  submitted_at            TEXT,
  review_status           TEXT,
  review_comment          TEXT,
  additional_info_request TEXT,
  reviewed_by             TEXT,
  reviewed_by_name        TEXT,
  reviewed_at             TEXT
);

-- The owner portal's only query is "the requirements I own", and the trail is
-- always read for one requirement in round order. Both are covered here rather
-- than left to a table scan that grows with the audit file.
CREATE INDEX IF NOT EXISTS idx_requirement_owners_user
  ON requirement_owners (user_id);
CREATE INDEX IF NOT EXISTS idx_requirement_submissions_requirement
  ON requirement_submissions (requirement_id, round_number);

ALTER TABLE work_paper_requirements
  ADD COLUMN last_reviewed_date TEXT;

ALTER TABLE work_paper_requirements
  ADD COLUMN closed_at TEXT;

ALTER TABLE work_paper_requirements
  ADD COLUMN closed_by TEXT;

-- Verification, to run afterwards.
--
--   -- The shapes are there.
--   SELECT sql FROM sqlite_master
--    WHERE name IN ('requirement_owners', 'requirement_submissions', 'work_paper_requirements');
--
--   -- What each owner still has to provide, oldest ask first: the table the
--   -- owner portal puts in front of them.
--   SELECT o.user_id, r.requirement_id, r.description, r.due_date, r.status
--     FROM work_paper_requirements r
--     JOIN requirement_owners o ON o.requirement_id = r.requirement_id
--    WHERE r.deleted_at IS NULL AND r.closed_at IS NULL
--    ORDER BY r.requested_date;
--
--   -- The rounds a requirement went through, and what audit said to each: the
--   -- trail the detail screen renders.
--   SELECT round_number, submitted_by_name, submitted_at, review_status,
--          review_comment, additional_info_request, reviewed_at
--     FROM requirement_submissions
--    WHERE requirement_id = 'REQ-1'
--    ORDER BY round_number;
--
--   -- How long audit took to answer, slowest first. A requirement waiting on
--   -- audit is not the auditee's fault, and this is the number that shows it.
--   SELECT requirement_id, round_number,
--          julianday(reviewed_at) - julianday(submitted_at) AS days_to_review
--     FROM requirement_submissions
--    WHERE reviewed_at IS NOT NULL
--    ORDER BY days_to_review DESC;
