# `/app/data` persistence migration

Cloudflare Container disk is disposable. Murikah Tutor therefore needs durable state outside the Container before accounts, conversations and files can be considered production-safe.

The migration deliberately separates **structured state** from **file/object state** rather than treating `/app/data` as one opaque volume.

## Provisioned production resources

The Cloudflare account hosting `tutor.murikah.com` now has the following dedicated resources:

- D1 database: `murikah-tutor-prod`
  - database id: `e8916f9a-fc2e-4bc6-925f-76c6c401c95b`
  - Worker binding: `TUTOR_DB`
- private R2 bucket: `murikah-tutor-files-prod`
  - storage class: Standard
  - public access: disabled
  - Worker binding: `TUTOR_FILES`

The bindings are repository-managed in `tutor/cloudflare/wrangler.toml`. No R2 access key or D1 credential is stored in the repository or passed into the Linux container.

## What DeepTutor currently places in `/app/data`

The pinned DeepTutor runtime uses the tree for runtime settings and credentials, accounts/auth state, sessions/chat history, per-user workspaces, Memory, Books/Reading/Notebooks, Knowledge Bases, parse caches, generated outputs and logs. Some of that state is file/JSON oriented and some is SQLite-backed.

Use the inventory helper against any source snapshot before migration:

```bash
python tutor/cloudflare/inventory_app_data.py <path-to-app-data>
```

The helper reports sizes and storage types only; it does not print file contents or secrets.

## Target storage split

### R2 / object storage

`TUTOR_FILES` is the durable home for objects that naturally behave as files:

- uploaded documents;
- generated files and diagrams;
- user content workspaces;
- Knowledge Base source documents and large derived artifacts;
- Books/Reading assets;
- exports/backups.

R2 remains private. No `r2.dev` public URL or custom domain is required.

Do not put a live SQLite database on an R2/FUSE mount. SQLite requires local-filesystem locking and atomicity semantics that object storage does not provide.

### D1 / structured state

`TUTOR_DB` is the selected Cloudflare-native durable store for structured persistence metadata and application state that can be cleanly adapted from the pinned DeepTutor 1.6.6 runtime.

Durable Object SQLite was considered as an earlier Cloudflare-native option for transactional state. For this production implementation, the dedicated D1 binding `TUTOR_DB` is the selected structured store, while the existing `TutorContainer` Durable Object continues to manage the container lifecycle.

The persistence adapter must preserve:

- user/account isolation;
- sessions and messages;
- authentication/grant state that is not already sourced from Worker secrets;
- guest prompt-budget state;
- audit/security state;
- durable object/file manifests and migration checkpoints.

Where a pinned DeepTutor subsystem still requires local SQLite semantics, the migration layer must use a safe export/import or adapter pattern rather than running that SQLite file on R2.

### Worker/container boundary

D1 and R2 bindings exist in the Cloudflare Worker runtime, not as native Python objects inside the Linux container. The application persistence implementation therefore uses a controlled Worker-side persistence interface rather than exposing Cloudflare API credentials to the container.

The interface must authenticate container-to-Worker persistence calls, validate object paths, avoid logging secrets, and keep `TUTOR_DB` / `TUTOR_FILES` inaccessible through ordinary public Tutor routes.

### Runtime configuration and secrets

Provider credentials, OAuth secrets and the Tutor signing secret remain Cloudflare Worker Secrets. They are not copied into D1 or R2 merely to achieve persistence.

Cloudflare dashboard Variables remain authoritative for model/service configuration under `keep_vars = true`.

## Migration sequence

1. **Bind** `TUTOR_DB` and `TUTOR_FILES` to `murikah-tutor-container-staging` through `wrangler.toml`.
2. **Inventory/snapshot** any existing `/app/data` that must be preserved before a destructive container replacement.
3. **Create the persistence schema and Worker bridge** for structured state and private objects.
4. **Externalise file stores** to R2 and verify read/write behavior without public bucket access.
5. **Externalise or safely checkpoint transactional stores** into D1-backed durable state.
6. **Import** the existing snapshot and reconcile record counts/checksums.
7. **Run staging** through sleep/wake, redeploy and forced container replacement tests.
8. **Verify** users, sessions, guest handoff, conversations, Knowledge Bases, Memory, uploads and generated outputs survive every lifecycle event.
9. **Cut over** only after the durability tests pass; keep a rollback snapshot until acceptance is complete.

## Acceptance conditions

Persistence is not complete merely because the bindings exist. Production cutover is blocked until:

- a Container can be destroyed and recreated without losing a learner account or conversation;
- a deployment rollback does not roll user data back with the image;
- private file objects remain retrievable after restart;
- guest quotas and authentication state remain consistent;
- the migrated data passes record-count/checksum reconciliation;
- no active SQLite database is stored on R2/FUSE;
- backup and recovery are documented and tested.
