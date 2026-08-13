-- Migration 009: the auditee response loop (Build Prompt 68)
--
-- A finding sent to the auditee already had rounds (`auditee_responses`), a
-- responsible list (`work_paper_responsibles`) and a copy list
-- (`work_paper_cc_recipients`). What it had no record of was WHO ON THE AUDITEE
-- SIDE IS HOLDING IT. A unit manager who hands the drafting to a depot
-- supervisor, and audit waiting on a response, were the same state as far as the
-- database was concerned: "sent to auditee, nothing back yet". So nobody could
-- see whether the delay was audit's, the manager's or the supervisor's, and the
-- supervisor had no standing in the system at all.
--
-- Two things fix that, and nothing else changes.
--
-- 1. `work_papers.auditee_stage` says which side of the auditee handover the
--    finding is on: WITH_AUDITEE (the responsibles hold it), DELEGATED (a
--    delegate is drafting), WITH_UNIT_MANAGER (the delegate handed it back),
--    WITH_AUDIT (released for review), CLOSED (audit accepted it). It is a
--    sub-state of the finding's own `status`, never a replacement for it: the
--    status still moves through `status_transitions` exactly as before.
--
-- 2. `auditee_delegations` records each handover: who delegated, to whom, the
--    instructions they gave, and the return. It is the delegate's whole standing
--    in the product. Staff act by being named on a live delegation, not by
--    holding an audit permission, in the same way a responsible acts by being
--    named on the finding.
--
-- HOW TO RUN IT. See grc/docs/deploy.md, "Migration 009":
--
--   turso db shell hassaudit < grc/db/migrations/009-auditee-response-loop.sql
--
-- Take a backup first (`turso db shell hassaudit .dump > backup.sql`). The table
-- is guarded by IF NOT EXISTS and is safe to re-run. The ALTER is not: SQLite
-- has no "ADD COLUMN IF NOT EXISTS", so running it twice reports a duplicate
-- column, which is a harmless error to see and means the column is already
-- there. Check first with `PRAGMA table_info(work_papers);` if in doubt.

-- Who on the auditee side is holding the finding.
ALTER TABLE work_papers ADD COLUMN auditee_stage TEXT;

-- The handover from a unit manager to their staff, and the return.
CREATE TABLE IF NOT EXISTS auditee_delegations (
  delegation_id    TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL,
  work_paper_id    TEXT NOT NULL,
  -- The response round the delegation belongs to, so a finding that goes two
  -- rounds shows two delegations rather than one that appears to have been
  -- reopened.
  round_number     INTEGER,
  delegated_by     TEXT NOT NULL,
  delegated_by_name TEXT,
  delegated_to     TEXT NOT NULL,
  delegated_to_name TEXT,
  -- What the manager asked for. This is the whole of the delegate's brief, so
  -- it is text and not a code.
  instructions     TEXT,
  -- ISSUED while the delegate holds it, RETURNED once they hand it back,
  -- CLOSED when the manager releases the finding to audit.
  status           TEXT NOT NULL DEFAULT 'ISSUED',
  delegated_at     TEXT NOT NULL,
  returned_at      TEXT,
  return_note      TEXT,
  closed_at        TEXT
);

-- The two reads this table gets: a finding's delegation trail, and "is this
-- person holding a live delegation on this finding", which is the access check
-- run on every delegate action and every evidence upload they make.
CREATE INDEX IF NOT EXISTS idx_auditee_delegations_wp
  ON auditee_delegations (work_paper_id, delegated_at);
CREATE INDEX IF NOT EXISTS idx_auditee_delegations_to
  ON auditee_delegations (delegated_to, status);

-- Existing findings already with the auditee are put in the state they are
-- actually in, rather than left with no stage at all: a finding that has been
-- sent and not yet answered is WITH_AUDITEE, and one whose response is in is
-- WITH_AUDIT. Everything else keeps a null stage, which the code reads as
-- "the auditee loop has not started", so nothing is invented for a finding that
-- never went out.
UPDATE work_papers
   SET auditee_stage = 'WITH_AUDITEE'
 WHERE auditee_stage IS NULL
   AND deleted_at IS NULL
   AND TRIM(LOWER(status)) = 'sent to auditee';

UPDATE work_papers
   SET auditee_stage = 'WITH_AUDIT'
 WHERE auditee_stage IS NULL
   AND deleted_at IS NULL
   AND TRIM(LOWER(status)) = 'response received';

-- Verification, to run afterwards.
--
--   -- The column exists and carries what it should.
--   SELECT COALESCE(auditee_stage, '(none)') AS stage, COUNT(*) AS findings
--     FROM work_papers WHERE deleted_at IS NULL GROUP BY 1;
--
--   -- No finding is in a stage the code does not know.
--   SELECT work_paper_id, auditee_stage FROM work_papers
--    WHERE auditee_stage IS NOT NULL
--      AND auditee_stage NOT IN ('WITH_AUDITEE', 'DELEGATED', 'WITH_UNIT_MANAGER',
--                                'WITH_AUDIT', 'CLOSED');
--   -- (no rows is the correct answer)
--
--   -- Live delegations, and who is holding them.
--   SELECT d.work_paper_id, d.delegated_to_name, d.status, d.delegated_at
--     FROM auditee_delegations d WHERE d.status = 'ISSUED' ORDER BY d.delegated_at;
