-- Migration 008: reattach the orphaned evidence (Build Prompt 65)
--
-- `file_attachments` was empty across the whole system while `files` filled up,
-- so every piece of evidence ever uploaded was orphaned: the bytes are in the
-- organisation's storage, the metadata is in `files`, and nothing ties either to
-- the finding it belongs to. The Evidence panel showed nothing, the
-- send-to-auditee gate correctly counted nothing, and the auditee received a
-- finding with no support attached.
--
-- The application fault is fixed in the code (the link row is written with the
-- file row as one atomic write, the write is read back, and a failure is logged
-- under `[grc.evidence.attach]` and reported rather than swallowed). This
-- migration is the other half: the evidence already uploaded has to become
-- visible without anybody re-uploading it.
--
-- WHY THE ORPHANS ARE RECOVERABLE. The object key is built by the application
-- and names the record the file was uploaded against:
--
--   org/<organization_id>/<entity>/<entity_id>/<file_id>/<filename>
--
-- so `files.storage_key` carries the entity type and the entity id of every file
-- uploaded through the product. That is a fact the application wrote, not a
-- guess: the link is reconstructed from the key, never inferred from timing,
-- from who uploaded it or from anything else circumstantial.
--
-- WHAT IT REFUSES TO GUESS. A file whose key does not have that shape (an
-- import, a Drive-era row, anything hand-loaded) is left alone and listed by the
-- last verification query. A file whose parsed entity id matches no live record
-- is left alone too: attaching evidence to a record that does not exist would
-- put a document in front of the wrong finding, which is worse than leaving it
-- where it is. Nothing is deleted and nothing already linked is touched.
--
-- The entity type is stored upper case, as the live table spells it
-- (`WORK_PAPER`), which is what the code now writes and what its reads match
-- case-insensitively.
--
-- HOW TO RUN IT. See grc/docs/deploy.md, "Migration 008":
--
--   turso db shell hassaudit < grc/db/migrations/008-evidence-attachment-backfill.sql
--
-- Take a backup first (`turso db shell hassaudit .dump > backup.sql`). It is
-- safe to run twice: every insert is guarded by "no link row exists for this
-- file", so a second run inserts nothing.

-- Work papers.
INSERT INTO file_attachments (attachment_id, file_id, entity_type, entity_id,
                              file_category, attached_by, attached_at)
SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
       substr(lower(hex(randomblob(2))), 2) || '-a' ||
       substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
       f.file_id,
       'WORK_PAPER',
       wp.work_paper_id,
       'EVIDENCE',
       f.uploaded_by,
       COALESCE(f.created_at, datetime('now'))
  FROM files f
  JOIN work_papers wp
    ON wp.organization_id = f.organization_id
   AND instr(f.storage_key, '/work_paper/' || wp.work_paper_id || '/') > 0
 WHERE f.deleted_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM file_attachments fa WHERE fa.file_id = f.file_id);

-- Action plans.
INSERT INTO file_attachments (attachment_id, file_id, entity_type, entity_id,
                              file_category, attached_by, attached_at)
SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
       substr(lower(hex(randomblob(2))), 2) || '-a' ||
       substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
       f.file_id,
       'ACTION_PLAN',
       ap.action_plan_id,
       'EVIDENCE',
       f.uploaded_by,
       COALESCE(f.created_at, datetime('now'))
  FROM files f
  JOIN action_plans ap
    ON ap.organization_id = f.organization_id
   AND instr(f.storage_key, '/action_plan/' || ap.action_plan_id || '/') > 0
 WHERE f.deleted_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM file_attachments fa WHERE fa.file_id = f.file_id);

-- Requirements (the owner's uploaded answers, Build Prompt 58).
INSERT INTO file_attachments (attachment_id, file_id, entity_type, entity_id,
                              file_category, attached_by, attached_at)
SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
       substr(lower(hex(randomblob(2))), 2) || '-a' ||
       substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
       f.file_id,
       'REQUIREMENT',
       r.requirement_id,
       'EVIDENCE',
       f.uploaded_by,
       COALESCE(f.created_at, datetime('now'))
  FROM files f
  JOIN work_paper_requirements r
    ON r.organization_id = f.organization_id
   AND instr(f.storage_key, '/requirement/' || r.requirement_id || '/') > 0
 WHERE f.deleted_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM file_attachments fa WHERE fa.file_id = f.file_id);

-- Verification, to run afterwards.
--
--   -- The link table is no longer empty, and what it holds.
--   SELECT entity_type, COUNT(*) AS links FROM file_attachments GROUP BY entity_type;
--
--   -- Every reattached file resolves to a real record.
--   SELECT COUNT(*) AS dangling
--     FROM file_attachments fa
--    WHERE TRIM(UPPER(fa.entity_type)) = 'WORK_PAPER'
--      AND NOT EXISTS (SELECT 1 FROM work_papers wp WHERE wp.work_paper_id = fa.entity_id);
--   -- (0 is the correct answer)
--
--   -- What was deliberately NOT guessed: files still with no link, and the key
--   -- that could not be read as one. These need a human decision, not a script.
--   SELECT f.file_id, f.organization_id, f.file_name, f.storage_key, f.created_at
--     FROM files f
--    WHERE f.deleted_at IS NULL
--      AND NOT EXISTS (SELECT 1 FROM file_attachments fa WHERE fa.file_id = f.file_id)
--    ORDER BY f.created_at DESC;
--
--   -- A finding's evidence, as the application now reads it.
--   SELECT f.file_name, f.size_bytes, fa.attached_at
--     FROM file_attachments fa
--     JOIN files f ON f.file_id = fa.file_id
--    WHERE TRIM(UPPER(fa.entity_type)) = 'WORK_PAPER' AND fa.entity_id = '<work_paper_id>'
--      AND f.deleted_at IS NULL;
