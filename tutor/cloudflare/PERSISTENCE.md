# `/app/data` persistence migration

Cloudflare Container disk is disposable. Murikah Tutor therefore cannot move production traffic from Codespaces until the state currently stored in `/app/data` has a durable home outside the Container.

This migration deliberately separates **structured state** from **large/file-oriented state** instead of treating `/app/data` as one opaque volume.

## What DeepTutor currently places in `/app/data`

The pinned DeepTutor runtime uses the tree for runtime settings and credentials, accounts/auth state, sessions/chat history, per-user workspaces, Memory, Books/Reading/Notebooks, Knowledge Bases, parse caches, generated outputs and logs. Some of that state is file/JSON oriented and some is SQLite-backed.

The live Codespaces tree is authoritative for what Murikah currently uses. Run the inventory helper before designing the final copy plan:

```bash
python tutor/cloudflare/inventory_app_data.py tutor/.codespaces-data
```

The helper reports sizes and storage types only; it does not print file contents or secrets.

## Target storage split

### R2 / object storage

Use R2 for objects that naturally behave as files:

- uploaded documents;
- generated files and diagrams;
- user content workspaces;
- Knowledge Base source documents and large derived artifacts;
- Books/Reading assets;
- exports/backups.

Cloudflare Containers can mount R2 through FUSE when an application requires filesystem APIs. This is appropriate for ordinary files and large assets, but **not** for active SQLite database files.

### Structured transactional state

Do not put a live SQLite database on an R2/FUSE mount. SQLite relies on filesystem locking and atomic local-filesystem semantics that object storage does not provide reliably.

The final Murikah adapter will move transactional state out of container-local SQLite before production cutover. The exact adapter will be selected after inventorying the pinned 1.6.6 data stores, but the design must preserve:

- user/account isolation;
- sessions and messages;
- authentication grants/provider identities;
- audit/security state;
- any other SQLite-backed tables discovered in the live tree.

Cloudflare Durable Object SQLite is the preferred Cloudflare-native target when the store can be cleanly adapted. If a pinned DeepTutor subsystem requires a relational interface that cannot be safely adapted without a large fork, use a dedicated external relational service rather than emulating POSIX SQLite on object storage.

### Runtime configuration and secrets

Public configuration can remain in durable settings storage. Provider credentials and OAuth secrets should move to Cloudflare Worker secrets where possible rather than being copied into source control.

The existing `model_catalog.json` and other DeepTutor settings must be migrated carefully because they currently contain runtime configuration that the application expects at boot.

## Migration sequence

1. **Inventory** the live Codespaces data tree and classify every writable store.
2. **Snapshot** the current `/app/data` before any migration work.
3. **Externalise file stores** to R2 and test read/write behavior from the staging Container.
4. **Externalise transactional stores** to durable structured storage and add migration code for existing records.
5. **Import** the Codespaces snapshot into the new stores.
6. **Run staging** through container sleep/wake, redeploy, and forced replacement tests.
7. **Verify** users, sessions, guest handoff, SSO identities, Knowledge Bases, Memory, uploads and generated outputs survive every lifecycle event.
8. **Freeze writes briefly**, take the final production delta snapshot, import it, and verify counts/checksums.
9. **Attach `tutor.murikah.com`** to the production Container Worker.
10. Keep the old Codespaces deployment intact but read-only/standby for the rollback window; retire it only after production acceptance.

## Acceptance conditions

Production cutover is blocked until:

- a Container can be destroyed and recreated without losing a learner's account or conversation;
- a Worker/Container deployment can be rolled back without restoring an old copy of user data;
- file objects remain downloadable after restart;
- authentication provider links remain stable;
- the migrated data passes record-count/checksum reconciliation;
- no active SQLite database is stored on R2/FUSE;
- backup and recovery are documented and tested.
