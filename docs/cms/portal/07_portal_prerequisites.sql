-- ---------------------------------------------------------------------------
-- CMS Build Prompt 25: customer portal prerequisites.
--
-- Run by the operator in the Turso console. The application never runs this.
--
-- THE PORTAL REFUSES TO SERVE UNTIL THIS HAS RUN. `verifyPortalTables` in
-- src/lib/cms/portal/tenant.ts checks all three facts below with queries and
-- reports what is missing by name. That is deliberate: without
-- `customer_visible` there is no way to tell an internal attachment from a
-- customer-facing one, and the honest behaviour is to serve nothing and say
-- why rather than to guess and hope.
--
-- WHAT IT ADDS, AND WHY EACH ONE
--
--   entity_attachments.customer_visible
--     Whether a document may be seen by the customer. DEFAULT 0, which is
--     the right way round: every attachment that existed before the portal
--     is invisible until somebody decides otherwise. A document becomes
--     customer-facing by a decision, never by an oversight.
--
--   entity_attachments.portal_document_title
--     The customer-facing name. Internal filenames carry initials, revision
--     numbers and occasionally a colleague's opinion, and none of that is
--     something to send a customer. NULL falls back to "Document".
--
--   survey_invitations
--     One invitation admits one response, and the database is what enforces
--     it: `survey_response_id` is UNIQUE and the invitation is unique per
--     (survey, case, contact). A second submission fails on the constraint,
--     which the application catches and reports as "already answered". A
--     button that hides itself is a courtesy; the constraint is the control.
--
-- SAFE TO RUN TWICE? THE TWO ALTERs ARE NOT.
-- SQLite has no ADD COLUMN IF NOT EXISTS. Running them a second time fails
-- with "duplicate column name", which is harmless and leaves the schema as
-- it was. The CREATE TABLE and both CREATE INDEX statements are idempotent.
-- If you are re-running this file, run the verification block first: if it
-- already returns the three rows, there is nothing to do.
--
-- NO TRANSACTION KEYWORDS.
-- ---------------------------------------------------------------------------

ALTER TABLE entity_attachments ADD COLUMN customer_visible INTEGER NOT NULL DEFAULT 0 CHECK(customer_visible IN (0,1));
ALTER TABLE entity_attachments ADD COLUMN portal_document_title TEXT;

CREATE TABLE IF NOT EXISTS survey_invitations (
    survey_invitation_id TEXT PRIMARY KEY,
    survey_id TEXT NOT NULL,
    case_id TEXT,
    account_id TEXT NOT NULL,
    contact_id TEXT,
    invited_at TEXT NOT NULL,
    expires_at TEXT,
    survey_response_id TEXT UNIQUE,
    FOREIGN KEY (survey_id) REFERENCES customer_surveys(survey_id) ON DELETE CASCADE,
    FOREIGN KEY (case_id) REFERENCES service_cases(case_id) ON DELETE CASCADE,
    FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE,
    FOREIGN KEY (contact_id) REFERENCES contacts(contact_id) ON DELETE SET NULL,
    FOREIGN KEY (survey_response_id) REFERENCES survey_responses(survey_response_id) ON DELETE SET NULL,
    UNIQUE(survey_id, case_id, contact_id)
);

CREATE INDEX IF NOT EXISTS idx_survey_invitations_account ON survey_invitations(account_id, invited_at);
CREATE INDEX IF NOT EXISTS idx_entity_attachments_visible ON entity_attachments(entity_type, entity_id, customer_visible);

-- ---------------------------------------------------------------------------
-- Verification. Expect exactly three rows: the two columns and the table.
-- This is the same question the application asks on every portal request.
-- ---------------------------------------------------------------------------

SELECT 'entity_attachments.customer_visible' AS fact
  FROM pragma_table_info('entity_attachments') WHERE name = 'customer_visible'
UNION ALL
SELECT 'entity_attachments.portal_document_title'
  FROM pragma_table_info('entity_attachments') WHERE name = 'portal_document_title'
UNION ALL
SELECT 'survey_invitations'
  FROM sqlite_master WHERE type = 'table' AND name = 'survey_invitations';

-- ---------------------------------------------------------------------------
-- NOTHING IS MADE VISIBLE BY THIS SCRIPT.
--
-- No UPDATE sets customer_visible = 1 anywhere in it, and none should be
-- added. Deciding that a particular document may be sent to a particular
-- customer is a judgement about that document, and a bulk UPDATE would make
-- it for every document at once, silently and in the operator's name.
--
-- SO THE DOCUMENTS TAB IS EMPTY UNTIL SOMETHING SETS THE FLAG, and today
-- nothing does: no phase up to and including this one manages attachments,
-- so `entity_attachments` has no internal screen and no upload path. The
-- portal reads the flag correctly and shows an empty state rather than a
-- broken one. Whoever builds attachment management sets the flag there, one
-- document at a time, with the decision recorded against the person who
-- made it. Until then an operator who needs to share a specific document can
-- set its flag by hand, naming the row:
--
--   UPDATE entity_attachments
--      SET customer_visible = 1, portal_document_title = 'Delivery note'
--    WHERE entity_attachment_id = 'EA-...';
-- ---------------------------------------------------------------------------
