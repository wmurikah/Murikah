-- Migration 004: per-organisation evidence storage connections (Build Prompt 51)
--
-- Evidence used to live wherever the Worker's secrets pointed: one R2 bucket for
-- every customer. That is a single-tenant shape on a multi-tenant platform. An
-- organisation now chooses its own provider (Cloudflare R2, Google Drive,
-- SharePoint/OneDrive or Dropbox), configures it, tests it and picks a folder,
-- and its evidence goes there.
--
-- One row per organisation per provider, and at most one of them active. The
-- unique index on (organization_id, provider) is what makes the settings screen
-- an upsert rather than a source of duplicates; the partial unique index on the
-- active row is what makes "the organisation's active provider" a single answer
-- the code can rely on rather than a convention it has to police.
--
-- CREDENTIALS. config_sealed holds the provider's settings as JSON, sealed with
-- AES-GCM keyed off GRC_SESSION_SECRET (src/lib/grc/auth/secretBox.ts), the same
-- treatment the Outlook refresh token already gets. Nothing readable rests in
-- this column: not an access key, not a refresh token. Losing the worker secret
-- invalidates every box, which for credentials is the safe failure. The column
-- is deliberately one sealed blob rather than a column per field, so a new
-- provider with different settings needs no migration, and so no future query
-- can accidentally select a secret into a log or a screen.
--
-- The row is scoped by organization_id and references organizations, so one
-- customer's connection is unreachable from another's namespace, and deleting an
-- organisation cannot strand its credentials.
--
-- This is a CREATE TABLE: nothing is altered and no data moves. Until an
-- organisation configures a provider it has no row, and the evidence section
-- keeps its honest "not configured" message.
--
-- HOW TO RUN IT. See grc/docs/deploy.md, "Migration 004":
--
--   turso db shell hassaudit < grc/db/migrations/004-storage-connections.sql
--
-- Take a backup first (`turso db shell hassaudit .dump > backup.sql`). It is
-- independent of migrations 001 to 003 and can be applied in any order relative
-- to them. Running it twice fails harmlessly with "table already exists".

CREATE TABLE IF NOT EXISTS storage_connections (
  connection_id   TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(organization_id),
  -- 'r2' | 'google_drive' | 'sharepoint' | 'dropbox'
  provider        TEXT NOT NULL,
  -- The provider's settings as sealed JSON. Never readable, never selected into
  -- anything user-facing; the screen is served a masked projection.
  config_sealed   TEXT,
  -- The chosen folder in the provider's own namespace: an R2 key prefix, a Drive
  -- folder id, a Graph drive/item id pair, a Dropbox path.
  folder_id       TEXT,
  folder_name     TEXT,
  -- 'connected' once a test has passed, 'pending' while half-configured,
  -- 'error' when the last test failed. Only 'connected' is ever used to store.
  status          TEXT NOT NULL DEFAULT 'pending',
  status_detail   TEXT,
  is_active       INTEGER NOT NULL DEFAULT 0,
  connected_at    TEXT,
  connected_by    TEXT,
  created_at      TEXT,
  updated_at      TEXT
);

-- One row per organisation per provider: the settings screen upserts on this.
CREATE UNIQUE INDEX IF NOT EXISTS idx_storage_connections_org_provider
  ON storage_connections (organization_id, provider);

-- At most one active provider per organisation, enforced rather than assumed.
-- A partial index so the inactive rows (a provider configured earlier and since
-- switched away from) may coexist and be switched back to without reconfiguring.
CREATE UNIQUE INDEX IF NOT EXISTS idx_storage_connections_one_active
  ON storage_connections (organization_id) WHERE is_active = 1;

-- Verification, to run afterwards.
--
--   -- The shape, including both indexes.
--   SELECT sql FROM sqlite_master WHERE tbl_name = 'storage_connections';
--
--   -- Who has configured what. config_sealed is deliberately not selected: it
--   -- is ciphertext, and there is never a reason to read it by hand.
--   SELECT organization_id, provider, status, is_active, folder_name, connected_at
--     FROM storage_connections ORDER BY organization_id, provider;
--
--   -- Exactly one active provider per organisation, or none.
--   SELECT organization_id, COUNT(*) FROM storage_connections
--    WHERE is_active = 1 GROUP BY organization_id HAVING COUNT(*) > 1;
