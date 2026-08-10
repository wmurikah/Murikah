-- Migration 005: when information was requested, and when it arrived (Build Prompt 52)
--
-- Adds requested_date and received_date to work_paper_requirements. A
-- requirement is a request for information: an auditor asks the auditee for a
-- reconciliation, a policy, a sample. Until now the row recorded only what was
-- asked for and a free-text status, so "what is still outstanding, and how long
-- has it been outstanding?" was a question nobody could answer from the data.
--
-- WHY TWO DATES AND NOT A FLAG. A boolean "received" would answer whether, never
-- when, and the gap between the two dates is the number that matters in an audit
-- file: it is turnaround, it is what a reviewer points at when a fieldwork phase
-- slipped, and it is what an auditee is entitled to see when their responsiveness
-- is questioned. Two dates give the flag for free (received_date IS NULL is
-- outstanding) and the interval as well.
--
-- WHY NOT REUSE due_date. due_date already exists and means something different:
-- the date by which the information is wanted. requested_date is when it was
-- asked for and received_date is when it arrived. Overloading due_date would lose
-- one of the three.
--
-- STATUS STAYS. The status column keeps its meaning and the application keeps it
-- in step with received_date, so an existing row reading 'PENDING' or 'OPEN' is
-- still an outstanding requirement and nothing that reads the column today has to
-- change. The two dates are the record; the status is the label on it.
--
-- Plain ADD COLUMNs: no key change, no table rebuild, no data moves. Existing
-- rows get NULL for both, which reads as "asked for at some point, not yet
-- received" and is the honest answer for a row that never recorded either.
--
-- This is the same change the operator's own `grc-requirements-dates.sql` made.
-- If that has already been applied to the live database, this run fails
-- harmlessly with "duplicate column name" and nothing is altered. It is
-- committed here so the columns are reproducible in a fresh database rather than
-- a change only one database happens to carry.
--
-- HOW TO RUN IT. See grc/docs/deploy.md, "Migration 005":
--
--   turso db shell hassaudit < grc/db/migrations/005-requirement-dates.sql
--
-- Take a backup first (`turso db shell hassaudit .dump > backup.sql`). It is
-- independent of migrations 001 to 004 and can be applied in any order relative
-- to them.

ALTER TABLE work_paper_requirements
  ADD COLUMN requested_date TEXT;

ALTER TABLE work_paper_requirements
  ADD COLUMN received_date TEXT;

-- Verification, to run afterwards.
--
--   -- Both columns are there and every existing row is unset.
--   SELECT sql FROM sqlite_master WHERE name = 'work_paper_requirements';
--
--   -- What is still outstanding, oldest request first: the list the Requirements
--   -- section now puts in front of an auditor.
--   SELECT organization_id, work_paper_id, description, requested_date
--     FROM work_paper_requirements
--    WHERE deleted_at IS NULL AND received_date IS NULL
--    ORDER BY requested_date;
--
--   -- Turnaround on what has arrived, slowest first. Rows recorded before this
--   -- migration have no dates and are excluded rather than counted as instant.
--   SELECT work_paper_id, description, requested_date, received_date,
--          julianday(received_date) - julianday(requested_date) AS days
--     FROM work_paper_requirements
--    WHERE received_date IS NOT NULL AND requested_date IS NOT NULL
--    ORDER BY days DESC;
