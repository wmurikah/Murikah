-- Migration 007: reconcile requirement_submissions.round_number (Build Prompt 61)
--
-- The code reads `requirement_submissions.round_number`; the live table does not
-- have it, so `/api/sidebar-counts` answers 500 with `no such column:
-- sub.round_number` and the requirements screens fail with it.
--
-- HOW THE TWO SHAPES DIVERGED. The operator's own `grc-requirements-workflow.sql`
-- created the table without the column and ordered a requirement's rounds by
-- `submitted_at`; migration 006 in this repository created it with the column
-- and ordered by that. The operator's script is the one that was applied. Both
-- are defensible designs and only one of them is in the database, which is the
-- whole fault: a shape agreed in two places drifts, and the code shipped
-- reading the half that is not there.
--
-- WHY THE COLUMN AND NOT THE TIMESTAMP. Ordering by `submitted_at` is right up
-- to the moment two rounds share a timestamp, which a batch insert or a
-- second-resolution clock produces readily, and then the trail silently reorders
-- itself between two page loads. A round is an ordinal in an audit file, quoted
-- in correspondence as "round 2", so it is stored rather than recomputed on
-- every read. The timestamp still decides what the ordinal is; it just decides
-- it once.
--
-- THE BACKFILL is exactly that rule applied to the rows already there: a row's
-- round number is how many rows of the same requirement were submitted no later
-- than it. Ties resolve by the row's own id so the numbering is total and
-- repeatable rather than arbitrary, and a row with no timestamp at all sorts
-- first, because it is older than anything that recorded one.
--
-- Plain ADD COLUMN and one UPDATE: no key change, no table rebuild, no data
-- moves, and nothing is deleted. Running it twice is safe: the second run fails
-- harmlessly with "duplicate column name", and the UPDATE is idempotent.
--
-- HOW TO RUN IT. See grc/docs/deploy.md, "Migration 007":
--
--   turso db shell hassaudit < grc/db/migrations/007-requirement-round-number.sql
--
-- Take a backup first (`turso db shell hassaudit .dump > backup.sql`). Apply it
-- before or with the release: until it is applied, the requirements module and
-- the sidebar counts fail on the missing column.

ALTER TABLE requirement_submissions
  ADD COLUMN round_number INTEGER;

-- Number every existing round in submission order, per requirement.
UPDATE requirement_submissions
   SET round_number = (
     SELECT COUNT(*)
       FROM requirement_submissions earlier
      WHERE earlier.requirement_id = requirement_submissions.requirement_id
        AND (
          COALESCE(earlier.submitted_at, '') < COALESCE(requirement_submissions.submitted_at, '')
          OR (COALESCE(earlier.submitted_at, '') = COALESCE(requirement_submissions.submitted_at, '')
              AND earlier.submission_id <= requirement_submissions.submission_id)
        )
   );

-- Verification, to run afterwards.
--
--   -- The column is there, and every row carries a number.
--   SELECT COUNT(*) AS unnumbered FROM requirement_submissions WHERE round_number IS NULL;
--
--   -- Each requirement numbers from one, with no gaps and no repeats.
--   SELECT requirement_id, COUNT(*) AS rounds, MIN(round_number) AS first,
--          MAX(round_number) AS last, COUNT(DISTINCT round_number) AS distinct_numbers
--     FROM requirement_submissions
--    GROUP BY requirement_id
--   HAVING first <> 1 OR last <> rounds OR distinct_numbers <> rounds;
--   -- (no rows is the correct answer)
--
--   -- The trail as the screen reads it.
--   SELECT round_number, submitted_by_name, submitted_at, review_status
--     FROM requirement_submissions
--    WHERE requirement_id = 'REQ-1'
--    ORDER BY round_number;
