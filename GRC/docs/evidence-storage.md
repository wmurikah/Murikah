# Evidence storage: Cloudflare R2, with Google Drive read-through

Work papers and their action plans carry evidence files. This note records the
decision taken and how the storage seam is implemented, so the choice is explicit
rather than inferred by whoever wires the first upload.

> **Superseded in part by Build Prompt 51.** Where evidence goes is now an
> organisation's own choice, not the deployment's: each customer configures
> Cloudflare R2, Google Drive, SharePoint/OneDrive or Dropbox on
> `/settings/storage`, with its credentials sealed against that organisation in
> `storage_connections`. See `grc/docs/storage-setup.md` for the connectors and
> `grc/docs/deploy.md` for migration 004.
>
> What this note still describes accurately is everything below the provider:
> the tenant-scoped keys, the content hashing, the governed deletion path, and
> the legacy backends. The env-configured R2 bucket and the read-only Drive
> credential remain, and are what keep evidence attached before the connectors
> existed readable: a stored object records which backend holds it and is
> resolved by that, never by whichever provider is active now. The Drive-to-R2
> background migration is likewise unchanged, and moves legacy evidence into the
> platform bucket rather than into a customer's own account.

## The decision

New evidence is stored in **Cloudflare R2**, the native object store in the
Worker runtime. Existing **Google Drive** files (from the source Apps Script
system, keyed by `files.drive_file_id`) are read through the same seam with a
read-only Drive credential, and a background job migrates them to R2 over time.
Nothing new is ever written to Drive.

R2 wins on runtime fit (a native binding and presigned URLs, no per-request
external auth), egress cost (no egress fees, S3-compatible), and access control
(the app signs short-lived URLs from the Worker under its own RBAC), while the
Drive read-through means no evidence is stranded and the migration is unhurried.

## The seam

App code depends only on `src/lib/grc/storage.ts`: its types and its operations
(`presignUpload`, `finaliseUpload`, `planDownload`, `openObject`, `putObject`,
`removeObject`). Only the backend implementations know the backend and read
credentials from `cloudflare:workers` env:

- `storage/r2.ts` uses the `EVIDENCE_BUCKET` binding for head/get/put/delete and
  the S3 credentials to presign PUT and GET URLs (`storage/sigv4.ts`, Web Crypto).
- `storage/drive.ts` reads and heads only, via a read-only OAuth2 refresh-token
  flow (scope `drive.readonly`); it refuses put, remove and presign.
- `storage/keys.ts` builds the per-tenant, immutable object key and the sha256
  content hash (pure, unit-tested).

## Keys, integrity and transfer

- **Per-tenant keys**: every object lives under
  `org/{organization_id}/{entity}/{entity_id}/{file_id}/{safe_filename}`, so
  tenants are isolated by key namespace. The key is recorded on
  `files.storage_key` with `files.storage_backend = 'r2'`. Keys are immutable: a
  replacement is a new `file_id` and a new key, never an overwrite. A presigned
  URL is only ever issued for a key inside the acting tenant's prefix
  (`keyBelongsToOrg`), so a signed URL can never reach another tenant's evidence.
- **Integrity**: on completion the worker verifies the object exists and computes
  its sha256, stored on `files.content_hash` with `files.content_hash_algo`.
- **Transfer**: the large bytes never stream through the worker. Upload is a
  presigned PUT straight to R2 after an RBAC check on the target; download is a
  short-lived presigned GET (R2) or a worker read-through (Drive), after an RBAC
  check that respects the auditee-safe boundary (an auditee may only fetch
  evidence on their own findings and plans).

## Deletion, retention and legal holds

Deletion is soft and governed. A request is routed through `deletion_queue`,
blocked outright when a `legal_holds` row covers the entity, and stamped with the
retention floor from `retention_policies` so the deferred purge honours
retention. Nothing is hard-deleted in the request path. Deletions, holds that
block a deletion, uploads and config changes are written to `audit_log`, so the
chain of custody is complete.

## Background migration

The worker's daily `scheduled()` block migrates a batch of Drive-backed files to
R2: it reads the Drive bytes through the seam, computes the hash, writes the
object to the tenant R2 key, and switches `files.storage_backend` to `r2` with
the new key and hash, leaving `drive_file_id` for provenance. Files whose entity
is under an active legal hold are skipped. It is best-effort per file and never
blocks an upload or download; it is a no-op until both R2 and the Drive
credential are configured.

## Secrets

The R2 bucket binding, the S3 presign credentials (`R2_ACCOUNT_ID`,
`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`) and the read-only Drive
credential (`GDRIVE_CLIENT_ID`, `GDRIVE_CLIENT_SECRET`, `GDRIVE_REFRESH_TOKEN`)
are Worker secrets only, never committed. They are optional: when absent, the
seam reports that storage is not configured and the rest of the app is
unaffected. See `wrangler.jsonc` for how to provision the bucket and set them.
