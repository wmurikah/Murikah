# `/app/data` persistence migration

Cloudflare Container disk is disposable. Murikah Tutor therefore needs durable state outside the Container before accounts, conversations and files can be considered production-safe.

The migration deliberately separates **structured state** from **file/object state** rather than treating `/app/data` as one opaque volume. The Container filesystem is now an execution cache only: learner prompts, answers, turn status, guest identity/quota and learning metadata are written to durable Cloudflare stores and must not exist only in the Container.

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

## Implemented persistence path

The application integration is now repository-managed rather than a dashboard-only placeholder:

- `tutor/cloudflare/migrations/0001_tutor_persistence.sql` creates the D1 manifest, replay-protection and guest-quota tables;
- `deploy_staging.py` applies pending D1 migrations before every Worker/container deploy;
- the Worker exposes only an HMAC-authenticated `/__muri/persist/*` bridge backed by `TUTOR_DB` and `TUTOR_FILES`;
- the Linux container restores durable objects before DeepTutor/auth initialization and checkpoints `/app/data` in the background;
- guest sessions and the seven-prompt ledger use D1 on Cloudflare instead of the container-local SQLite ledger;
- active SQLite files are copied with Python's SQLite backup API before their private checkpoint object is written to R2;
- Cloudflare-managed provider configuration and the auth signing secret are excluded from R2 checkpoints because their authoritative copies remain Worker Variables/Secrets.

The existing `MURIKAH_TUTOR_AUTH_SECRET` authenticates this internal bridge with a separate HMAC request protocol, timestamp window and D1 replay nonce. No additional Cloudflare secret or API token is required.

## D1 verified-email challenges

`0005_tutor_email_verification.sql` adds the first-account verification state used by both local signup and new SSO identities. D1 stores the normalized email/domain, purpose/provider, HMAC digest of the six-digit code, attempt/send counters, expiry/cooldown timestamps and one-time consumption state. Plaintext verification codes are never persisted.

The same migration adds non-secret `email` and `email_verified_at` account metadata. Existing accounts are grandfathered and continue to sign in normally; the gate applies to new accounts moving forward. The Resend API key remains a Cloudflare Worker Secret and is not forwarded into the Linux container or stored in D1/R2.

## Durable member naming personalization

`0007_tutor_preferred_name.sql` extends the existing authoritative `tutor_accounts` record with two non-secret account-personalization fields:

- `preferred_name`: the learner's explicit plain-text answer to what Murikah should call them. It is nullable and limited to 64 characters.
- `preferred_name_decided_at`: the server timestamp of the learner's explicit save or clear action. It distinguishes "never answered" from "cleared later".

D1 remains authoritative. The value is not stored only in React state, browser storage or container-local SQLite, so it survives sign-out/sign-in, browser restart, Tutor deployment and container replacement. Account reconciliation/upsert intentionally does not overwrite either personalization field.

The public member API is `GET /api/murikah/access/preferences` and `PUT /api/murikah/access/preferences`. Those routes derive the member identity from the authenticated Tutor session and never accept a client-supplied actor/user/username as authorization. They call the existing HMAC-authenticated persistence bridge, which uses `GET /__muri/persist/account/personalization` and `POST /__muri/persist/account/preferred-name` internally.

The browser receives only the naming fields it needs: `preferred_name`, `derived_name` and `needs_name_prompt`. It does not need the account email. The server-side fallback resolver uses this order:

1. explicit `preferred_name`;
2. first sensible human token from the email local part before `@`;
3. first sensible human token from the username;
4. no name.

Derived fallback values are never silently written into `preferred_name`. Email/username tokens containing digits, machine-like/reserved labels such as `noreply`, `admin`, `user` or `test`, or otherwise unsuitable tokens are rejected so Tutor falls back to a generic greeting. Clearing the explicit name stores `NULL` while retaining `preferred_name_decided_at`, which restores derived-name behavior without treating the learner as never having answered.

## Virtual Internship Phase 2 scenario state

`0008_virtual_internship_phase2.sql` extends the Phase 1 Virtual Internship foundation without changing its ownership, duration or lifecycle semantics.

D1 stores the immutable engine-ready scenario snapshot in `scenario_version_content` and normalized authored definitions in the `scenario_actors`, `scenario_facts`, `scenario_actor_knowledge`, `scenario_task_definitions`, `scenario_task_dependencies`, `scenario_event_definitions`, `scenario_event_triggers` and `scenario_decision_options` tables.

An engine-ready `scenario_versions.manifest_ref` has the form:

`d1:scenario-version-content/<scenario-version-id>`

Its `scenario_versions.content_hash` must equal the SHA-256 content hash stored with the immutable D1 snapshot. Published definitions cannot be replaced by the normal install operation. Active internships therefore remain reproducible after a deployment or later repository scenario change.

Per-internship mutable truth is stored separately in `internship_scenario_state`, `internship_scenario_facts`, `internship_tasks`, `internship_event_state`, `internship_decisions`, `internship_event_firings` and append-only `internship_state_changes`. These rows link only to `internship_id`; Phase 2 does not introduce another learner ownership authority.

State-changing operations use the existing HMAC-protected `/__muri/persist/*` bridge. Member-specific reads are owner-bound through `internship_instances.learner_id`. The browser cannot directly write arbitrary facts, fire arbitrary events or patch canonical JSON.

The runtime state revision is monotonic. `(internship_id, revision)` and request-id uniqueness protect retries and concurrent transitions, while `(internship_id, event_id)` makes once-only event firing exactly once in D1.

Ordinary task dependency evaluation, actor/learner knowledge views and event evaluation use indexed D1 rows. They do not require R2 or container-local memory for correctness.


## Virtual Internship Phase 3 AI invocation audit

`0009_virtual_internship_phase3_ai.sql` adds `internship_ai_invocations` for bounded model-invocation metadata. This table is separate from Phase 1 lifecycle audit and Phase 2 canonical scenario-transition history because model calls are observability records, not simulation truth.

The existing HMAC persistence bridge exposes only `POST /__muri/persist/internships/ai/invocation` for this Phase 3 audit record. The Worker verifies the authenticated account and binds ownership through `internship_instances.learner_id` before accepting a row. There is no learner-facing invocation-history browser in Phase 3.

Stored metadata is limited to role/object identifiers, provider/model/profile identifiers, prompt and output-schema versions, context/output hashes, latency, retry/fallback counts, normalized status/error metadata, Mentor assistance level and timestamps. Raw prompts, raw responses, provider credentials, authorization headers, scratchpads and chain-of-thought are deliberately excluded.

Phase 3 model calls continue to use the existing Murikah model catalog, account/deployment grants, model-selection resolver and LLM factory. No internship-specific provider credential configuration is introduced.

## Virtual Internship Phase 5 work artifacts

`0011_virtual_internship_phase5_artifacts.sql` adds the durable work-product lineage used by the existing Virtual Internship Work surface. Phase 5 keeps the established split: D1 is the ownership and workflow control plane, while private `TUTOR_FILES` R2 stores artifact bytes. It does not add a second ownership registry and does not make R2 public.

The Phase 5 lineage is explicit and auditable:

`task -> logical artifact -> immutable artifact version -> submission attempt -> workflow review`

D1 adds `internship_task_acknowledgements`, `internship_artifacts`, `internship_artifact_versions`, `internship_artifact_submissions`, `internship_artifact_reviews` and `internship_artifact_activity`. Artifact versions and submission attempts are append-oriented. A saved version is never overwritten in place, and a later resubmission does not change the version referenced by an earlier submission.

Every file-backed or text-backed version has one corresponding `tutor_objects` row owned by the authenticated Tutor member. The canonical object key is generated server-side:

`users/<learner-id>/virtual-internships/<internship-id>/artifact-version/<artifact-version-id>`

The original filename remains display metadata and is never part of the authorization key. The browser receives artifact/version IDs, not an R2 key as a trust token. Downloads re-check internship ownership, artifact/version lineage and the matching `tutor_objects` owner before reading private R2.

Phase 5 calculates SHA-256, size and normalized content type on the server before finalizing a version. The checksum stored with `tutor_objects` is the integrity value; an R2 ETag is not treated as SHA-256. Ordinary downloads validate expected object size without recomputing a full hash on every request. The internal owner-scoped `/internships/artifacts/integrity` persistence route provides deterministic reconciliation of registered versions, missing objects, size mismatches and unregistered Phase 5 objects under the learner/internship prefix. It reports discrepancies and does not destructively delete uncertain objects.

Upload finalization is deliberately compensating because D1 and R2 are not one transaction: authorization and validation happen first, the private R2 object is written, `tutor_objects` and version metadata are finalized in D1, and the R2 object is removed if D1 finalization fails. An artifact version is not considered usable when ownership registration fails.

Current Phase 5 limits are explicit: one file per artifact version, 10 MiB maximum per file/version request, 100 immutable versions per logical artifact, 120,000 characters for text drafting and 512 KiB maximum for the text representation supplied to automated workflow review. Supported stored formats include PDF, DOCX, XLSX, CSV, PPTX, TXT, Markdown, common raster images, JSON/notebook data and common source-code text. Executable formats are rejected. Source code, HTML, SVG and notebooks are stored as data only; learner-supplied code is never executed, and active HTML/SVG is not rendered into the Tutor origin.

Automated simulated-supervisor review reuses the Phase 3 provider/orchestration and invocation-audit path. Phase 5 review has only `accepted` and `changes_requested` workflow decisions with feedback/requested changes. It does not create scores, competency levels, Competency Passport evidence, final ratings or internship completion. Because the current Tutor repository has no safe PDF/DOCX/XLSX extraction pipeline, those binary formats remain securely stored and downloadable but automated review fails closed with the submission remaining under review. Text-oriented versions use bounded extracted text only.

A Phase 2 task is transitioned to `completed` through `ScenarioStateService.transition_task` only after every authored required deliverable for that task has an accepted Phase 5 artifact. The frontend never marks a task complete directly. Any authored Phase 2 events caused by task completion continue through the existing deterministic event engine.

Stopped internships keep artifact/version/submission/review history and owner downloads available in read-only mode. Guests cannot create, upload, submit, review or retrieve member artifacts. Phase 5 does not add artifact deletion; submitted and accepted lineage therefore cannot be erased through a new convenience endpoint.

## D1 learning journal

`0003_tutor_learning_journal.sql` makes D1 the durable learning-data journal for Tutor. It stores:

- an opaque actor id and actor type (guest/member/admin);
- a guest session subject without persisting the internal `guest_...` compatibility username;
- conversations and turn lifecycle state;
- the full user prompt and full final assistant response;
- compact extractive prompt/response summaries generated without an extra model call;
- model/provider and latency fields where available;
- failures, timeouts, retries and regeneration flags;
- explicit learner-profile fields for future self-declared learning demographics;
- explicit training/research consent, defaulting to **off**;
- feedback records for future thumbs-up/down or quality labels.

A record becomes `training_eligible=1` only when the learner has explicitly opted in and the turn completed successfully. Sensitive demographics are not inferred from conversation text. Future profile UI may collect only optional, self-declared fields such as learner level, education level, age band, country code, learner role and preferred language.

Binary uploads, diagrams, books and other large objects remain in private R2; D1 stores their ownership/metadata references. This avoids abusing a relational database as blob storage while ensuring no durable user object depends on the Container filesystem.

## D1/R2 ownership model (v29)

Murikah now treats **D1 as the ownership/control plane**, **R2 as the durable object plane**, and the container filesystem as a disposable compatibility cache.

`0004_tutor_object_ownership.sql` adds:

- `tutor_objects`: one D1 ownership row for every durable R2-backed object, including owner kind/id, object type, runtime path, R2 object key, checksum, size and content type;
- `tutor_accounts`: non-secret account identity, role, status and authentication-provider metadata;
- `tutor_access_audit`: security events for denied deployment-configuration changes.

Every new/changed `/app/data` object is classified server-side by the Worker. Per-user DeepTutor paths such as `users/<uid>/...` are registered to that user in D1 and written to canonical private R2 keys of the form:

`users/<uid>/<object-type>/<stable-object-id>`

Partner, administrator and system objects have explicit non-user ownership classes rather than being left unowned. Existing legacy `runtime/...` R2 objects are **not destructively renamed during rollout**. They are reconciled into `tutor_objects` on startup and continue to restore normally; the next changed write moves that path to its canonical ownership key. This compatibility-first migration prevents the ownership upgrade from risking existing conversations, Memory, Knowledge Bases or files.

The Worker derives ownership from the validated runtime path and verifies any ownership metadata sent by the container. The Linux container cannot claim another owner merely by changing an HTTP header. R2 remains private and is reachable only through the HMAC-authenticated persistence bridge.

On every Cloudflare container start, Tutor:

1. restores the existing R2-backed compatibility tree;
2. restores the stable authentication secret and rebuilds normal runtime/model settings exactly as before;
3. opens the backend and frontend ports so learners are not held behind metadata maintenance;
4. starts the normal durable checkpoint loop in the background;
5. reconciles existing manifest objects and non-secret account metadata into D1 in a separate retrying background task.

Only restore/auth/bootstrap are startup-critical. Ownership reconciliation and checkpoint maintenance are additive durable-state work and are deliberately kept off the port-3782 readiness path. The deployment smoke test still waits for ownership reconciliation to converge before declaring a release complete, so availability is not traded for silent persistence drift.

This order preserves the response-time, follow-up, stream-continuation, guest handoff, diagram, Math Animator and other reliability fixes already in production. The v30 change is startup sequencing and deployment diagnostics; it does not replace the current chat execution paths.

### Administrator versus learner controls

Deployment-wide model/provider configuration is administrator-owned at both UI and API layers. Ordinary learners cannot add, remove or reconfigure LLMs, provider URLs/keys, model discovery/tests or personal provider credentials such as Codex OAuth. Direct non-admin attempts receive HTTP 403 and are recorded in the D1 access audit when available.

Learners retain only user-scoped choices such as their own conversations/files and permitted learning preferences, appearance, language and use of tools/capabilities that the administrator has made available. Provider credentials remain Cloudflare Secrets or protected administrator runtime configuration; they are never copied into learner-owned D1/R2 records.

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

Where a pinned DeepTutor subsystem still requires local SQLite semantics, that SQLite file is a compatibility execution cache. Murikah synchronously journals the learner turn in D1 before generation and journals the final answer before completion; the broader DeepTutor cache is additionally checkpointed to private R2. The migration layer must use a safe export/import or adapter pattern rather than running that SQLite file on R2.

### Worker/container boundary

D1 and R2 bindings exist in the Cloudflare Worker runtime, not as native Python objects inside the Linux container. The application persistence implementation therefore uses a controlled Worker-side persistence interface rather than exposing Cloudflare API credentials to the container.

The interface must authenticate container-to-Worker persistence calls, validate object paths, avoid logging secrets, and keep `TUTOR_DB` / `TUTOR_FILES` inaccessible through ordinary public Tutor routes.

### Runtime configuration and secrets

Provider credentials, OAuth secrets and the Tutor signing secret remain Cloudflare Worker Secrets. They are not copied into D1 or R2 merely to achieve persistence.

Cloudflare dashboard Variables remain authoritative for model/service configuration under `keep_vars = true`.

## Migration sequence

1. **Bind** `TUTOR_DB` and `TUTOR_FILES` to `murikah-tutor-container-staging` through `wrangler.toml`.
2. **Inventory/snapshot** any existing `/app/data` that must be preserved before a destructive container replacement.
3. **Create the persistence schema and Worker bridge** for structured state and private objects. Implemented in code.
4. **Externalise file stores** to private R2 checkpoints with a D1 manifest. Implemented in code.
5. **Externalise the guest quota ledger** into D1 and safely checkpoint SQLite-backed runtime state. Implemented in code.
6. **Journal learner turns directly in D1** before generation/completion, including prompts, final answers, summaries, status, performance metadata and consent gating. Implemented in v21.
7. **Register every durable R2 object in D1 with explicit ownership/type metadata** and reconcile legacy manifest rows without destructive rekeying. Implemented in v29.
8. **Reconcile non-secret account role/status metadata into D1** while keeping credentials in Cloudflare Secrets/protected auth storage. Implemented in v29.
9. **Import** an existing snapshot only when one exists. Existing runtime objects are preserved and ownership-registered in place.
10. **Run staging/production verification** through sleep/wake, redeploy and one deliberate forced container replacement.
11. **Verify** users, sessions, guest handoff, conversations, Knowledge Bases, Memory, uploads and generated outputs survive every lifecycle event with zero unregistered durable objects.
12. **Cut over to multi-container sharding** only after the durability tests pass; keep a rollback checkpoint until acceptance is complete.

## Lifecycle acceptance procedure

Use the read-only lifecycle probe immediately before and after each destructive lifecycle test:

```bash
python tutor/cloudflare/verify_persistence_lifecycle.py --snapshot /tmp/tutor-before.json
# perform one target lifecycle event: sleep/wake, deploy, forced container replacement, or rollback
python tutor/cloudflare/verify_persistence_lifecycle.py --verify /tmp/tutor-before.json
```

The probe never reads learner content and never destroys a container. It fails if the D1 ownership schema is unavailable, any R2 manifest row lacks a D1 ownership record, or durable object/account/learning counts regress across the lifecycle event. For the two-user isolation acceptance test, create independent conversations/files/Memory/Knowledge Base data under two test accounts before taking the baseline, then verify each account through the normal Tutor UI after the lifecycle event; direct R2 access remains private and unavailable to learners.

## Acceptance conditions

Persistence is not complete merely because the bindings exist. Production cutover is blocked until:

- a Container can be destroyed and recreated without losing a learner account or conversation;
- a deployment rollback does not roll user data back with the image;
- private file objects remain retrievable after restart;
- guest quotas and authentication state remain consistent;
- the migrated data passes record-count/checksum reconciliation;
- no active SQLite database is stored on R2/FUSE;
- backup and recovery are documented and tested.
