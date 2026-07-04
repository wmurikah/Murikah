# Evidence storage: a decision to make, not to infer

Work papers and their requirements carry evidence files. This note records that
the storage backend is an open decision, so it is chosen deliberately rather than
inferred by whoever wires the first upload.

## The situation

- The source (the Apps Script audit system) stored evidence in **Google Drive**,
  keyed by `files.drive_file_id`.
- The GRC platform runs on **Cloudflare Workers**, where **Cloudflare R2** is the
  native object store.

Both are viable. The choice affects every module that attaches evidence and, more
importantly, the **migration of the existing Drive files**, so it must not be made
silently in a single endpoint.

## What this prompt does

- Models the evidence UI (the detail lists attached evidence) and records
  attachment metadata through `files` and `file_attachments`
  (`src/lib/grc/repos/evidence.ts`).
- Puts the byte storage behind one interface, `StorageBackend`, in
  `src/lib/grc/storage.ts`. `getStorageBackend()` throws until a backend is
  chosen and implemented, so no backend is wired by accident.
- Commits **no storage credentials**.

## The decision (to be taken with the team)

Weigh, at least:

| Factor              | Keep Google Drive                                  | Move to Cloudflare R2                        |
| ------------------- | -------------------------------------------------- | -------------------------------------------- |
| Existing files      | No migration; `drive_file_id` still resolves       | One-time migration of all current evidence   |
| Runtime fit         | Drive API calls from the Worker, OAuth to maintain | Native binding, no external auth per request |
| Cost and egress     | Google account limits and sharing model            | R2 with no egress fees, S3-compatible        |
| Access control      | Drive sharing, separate from the app's RBAC        | App-controlled, signed URLs from the Worker  |
| Operational surface | Another external dependency                        | One platform, one set of secrets             |

## How to wire the chosen backend

1. Implement `StorageBackend` (put/get/remove and optionally `signedUrl`) in
   `src/lib/grc/storage.ts`, reading credentials from `cloudflare:workers` env at
   runtime (an R2 binding, or Drive OAuth secrets), never committed.
2. Return it from `getStorageBackend()`.
3. Add the upload and download endpoints that call it and then record metadata
   with `recordAttachment()` (already implemented).
4. For a Drive-to-R2 migration, copy each object and update `files.storage_backend`
   and `files.storage_key`; keep `drive_file_id` until the migration is verified.

Until then, the module functions fully except for the actual upload and download.
