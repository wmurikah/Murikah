-- ---------------------------------------------------------------------------
-- CMS Build Prompt 26 prerequisite: make audit_events append-only.
--
-- Run by the operator in the Turso console. The application never runs this.
--
-- WHY THIS IS A TRIGGER AND NOT A RULE IN THE CODE.
-- Every audit control up to now has been a promise the application makes:
-- no endpoint updates an audit row, no screen offers a delete. That promise
-- is only as good as the next person to write an endpoint, and it is worth
-- nothing at all to somebody holding the database credentials. A reviewer
-- looking at this evidence needs to know it cannot be edited by the people
-- it describes, and only the database can tell them that.
--
-- After this has run, an UPDATE or a DELETE against audit_events fails with
-- a constraint error, from the application, from a console, from anywhere.
-- A correction to business data creates a NEW business change and a NEW
-- audit event. The original row stands.
--
-- SAFE TO RUN TWICE. Both statements use IF NOT EXISTS.
-- NO TRANSACTION KEYWORDS.
-- ---------------------------------------------------------------------------

CREATE TRIGGER IF NOT EXISTS trg_audit_events_no_update
BEFORE UPDATE ON audit_events
BEGIN
    SELECT RAISE(ABORT, 'audit_events is append-only: UPDATE is refused');
END;

CREATE TRIGGER IF NOT EXISTS trg_audit_events_no_delete
BEFORE DELETE ON audit_events
BEGIN
    SELECT RAISE(ABORT, 'audit_events is append-only: DELETE is refused');
END;

-- ---------------------------------------------------------------------------
-- Verification. Expect exactly two rows.
-- This is the same query the application runs before it serves the audit
-- workspace, and the interface says plainly when it comes back short.
-- ---------------------------------------------------------------------------

SELECT name FROM sqlite_master
 WHERE type = 'trigger' AND name LIKE 'trg_audit_events%'
 ORDER BY name;

-- ---------------------------------------------------------------------------
-- ONE CONSEQUENCE TO UNDERSTAND BEFORE RUNNING THIS.
--
-- `audit_events.actor_user_id` is ON DELETE SET NULL, which is an UPDATE of
-- the audit row performed by the database when a user row is deleted. This
-- trigger will therefore refuse that cascade, and deleting a user will fail
-- while any audit row references them.
--
-- That is the correct outcome and not a defect: the application deactivates
-- users and never deletes them (`users.status`, not `DROP`), precisely so
-- that history keeps its subject. If an operator ever genuinely needs to
-- remove a user row, the audit rows must be dealt with first as a deliberate,
-- reviewed act, which is exactly the conversation this trigger forces.
-- ---------------------------------------------------------------------------
