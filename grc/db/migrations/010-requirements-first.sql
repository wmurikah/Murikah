-- Migration 010: requirements come first, the finding comes later (Build Prompt 69)
--
-- A requirement could only be raised against a work paper, because the module
-- was built on the assumption that audit knows which finding a document belongs
-- to before it has seen the document. That is backwards. An auditor asks for the
-- March reconciliations because they are testing something; whether those
-- reconciliations turn out to be evidence for a finding, and which finding, is
-- knowable only once they arrive. Forcing the link up front produced two bad
-- habits: findings raised early as a peg to hang the request on, and requests
-- kept out of the system entirely, in email, where the module was meant to
-- replace them.
--
-- Three changes, and nothing else moves.
--
-- 1. `linked_work_paper_id` (nullable) is the link, with `linked_at` and
--    `linked_by` recording who made it and when. NULL means not yet linked,
--    which is a legitimate resting state and not an error: a requirement may be
--    answered, reviewed and closed without ever belonging to a finding.
--
--    The existing `work_paper_id` column is left exactly where it is and is
--    backfilled FROM, never dropped. The old panel on a finding's own detail
--    (`repos/requirements.ts`) still reads it, and a column the live database
--    has carried for years is not something to remove in the same change that
--    stops depending on it.
--
-- 2. `requirement_recipients` names who the request goes to, and in what
--    capacity: OWNER, who owes the answer, or CC, who is kept informed. The
--    older `requirement_owners` table stays and stays authoritative for who may
--    upload; this table is about who is written to, which is a larger set.
--
-- 3. Everything already in the system is put in the state it is actually in:
--    every requirement that has a work paper is recorded as linked to it, and
--    every existing owner is recorded as an OWNER recipient.
--
-- HOW TO RUN IT. See grc/docs/deploy.md, "Migration 010":
--
--   turso db shell hassaudit < grc/db/migrations/010-requirements-first.sql
--
-- Take a backup first (`turso db shell hassaudit .dump > backup.sql`). The
-- CREATE and the backfills are guarded and safe to re-run. The three ALTERs are
-- not: SQLite has no "ADD COLUMN IF NOT EXISTS", so a second run reports a
-- duplicate column, which is harmless and means the column is already there.

ALTER TABLE work_paper_requirements ADD COLUMN linked_work_paper_id TEXT;
ALTER TABLE work_paper_requirements ADD COLUMN linked_at TEXT;
ALTER TABLE work_paper_requirements ADD COLUMN linked_by TEXT;

CREATE TABLE IF NOT EXISTS requirement_recipients (
  requirement_id  TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  -- Denormalised so a recipient who leaves the organisation is still recorded
  -- as having been written to, which is what an audit file has to show.
  email           TEXT,
  -- OWNER owes the answer; CC is kept informed and uploads nothing.
  recipient_role  TEXT NOT NULL DEFAULT 'OWNER',
  added_at        TEXT,
  added_by        TEXT,
  PRIMARY KEY (requirement_id, user_id, recipient_role)
);

CREATE INDEX IF NOT EXISTS idx_requirement_recipients_user
  ON requirement_recipients (user_id, recipient_role);

-- Every requirement that already hangs off a finding is recorded as linked to
-- it. The link date is the requirement's own creation, because that is when the
-- association was in fact made under the old flow; inventing a link date of
-- "now" would say audit decided this today, which is not true of any of them.
UPDATE work_paper_requirements
   SET linked_work_paper_id = work_paper_id,
       linked_at = COALESCE(linked_at, created_at)
 WHERE linked_work_paper_id IS NULL
   AND work_paper_id IS NOT NULL
   AND TRIM(work_paper_id) <> '';

-- Every existing owner is an OWNER recipient. `added_by` is left null where the
-- older table did not record one rather than guessed at.
INSERT INTO requirement_recipients (requirement_id, user_id, email, recipient_role, added_at, added_by)
SELECT o.requirement_id,
       o.user_id,
       (SELECT u.email FROM users u WHERE u.user_id = o.user_id),
       'OWNER',
       o.added_at,
       o.added_by
  FROM requirement_owners o
 WHERE NOT EXISTS (
         SELECT 1 FROM requirement_recipients rr
          WHERE rr.requirement_id = o.requirement_id
            AND rr.user_id = o.user_id
            AND rr.recipient_role = 'OWNER');

-- ---------------------------------------------------------------------------
-- IF, AND ONLY IF, `work_paper_id` IS DECLARED NOT NULL
-- ---------------------------------------------------------------------------
--
-- A requirement raised without a finding writes NULL to `work_paper_id` as well
-- as leaving `linked_work_paper_id` null, so the two never disagree about
-- whether a requirement belongs to a finding. If the live column was declared
-- NOT NULL, that insert is refused and raising an unlinked requirement fails at
-- the point of creation.
--
-- Check first. This is the whole question:
--
--   SELECT name, "notnull" FROM pragma_table_info('work_paper_requirements')
--    WHERE name = 'work_paper_id';
--
-- `notnull = 0` means there is nothing to do here and the rest of this comment
-- does not apply. `notnull = 1` means the constraint has to come off, and SQLite
-- cannot relax a column constraint in place: the table has to be rebuilt. Run
-- the block below in one transaction, with a backup taken, and check the row
-- count before and after.
--
--   PRAGMA foreign_keys = OFF;
--   BEGIN;
--   CREATE TABLE work_paper_requirements_new (
--     -- Copy the CREATE TABLE from `.schema work_paper_requirements`, changing
--     -- exactly one thing: drop NOT NULL from work_paper_id. Do not retype it
--     -- from this file, which is not the authority on the live column list.
--   );
--   INSERT INTO work_paper_requirements_new SELECT * FROM work_paper_requirements;
--   DROP TABLE work_paper_requirements;
--   ALTER TABLE work_paper_requirements_new RENAME TO work_paper_requirements;
--   -- Recreate every index the original carried (`.indexes work_paper_requirements`).
--   COMMIT;
--   PRAGMA foreign_keys = ON;
--   PRAGMA integrity_check;
--
-- Verification, to run afterwards.
--
--   -- Requirements, by whether they are linked to a finding yet.
--   SELECT CASE WHEN linked_work_paper_id IS NULL THEN 'unlinked' ELSE 'linked' END AS state,
--          COUNT(*) AS requirements
--     FROM work_paper_requirements WHERE deleted_at IS NULL GROUP BY 1;
--
--   -- No link points at a finding that does not exist.
--   SELECT COUNT(*) AS dangling FROM work_paper_requirements r
--    WHERE r.linked_work_paper_id IS NOT NULL
--      AND NOT EXISTS (SELECT 1 FROM work_papers wp
--                       WHERE wp.work_paper_id = r.linked_work_paper_id);
--   -- (0 is the correct answer)
--
--   -- Every owner is a recipient.
--   SELECT COUNT(*) AS owners_without_a_recipient_row FROM requirement_owners o
--    WHERE NOT EXISTS (SELECT 1 FROM requirement_recipients rr
--                       WHERE rr.requirement_id = o.requirement_id
--                         AND rr.user_id = o.user_id AND rr.recipient_role = 'OWNER');
--   -- (0 is the correct answer)
