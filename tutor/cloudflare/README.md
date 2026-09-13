# Murikah Tutor on Cloudflare Containers

This directory is the migration target for the Murikah Tutor runtime. During the migration phase it deploys a **staging-only** Cloudflare Worker + Container and does not attach `tutor.murikah.com`.

Production remains on the existing Cloudflare wake Worker -> Codespaces -> named Tunnel path until `/app/data` persistence has been externalised, existing data has been migrated, and restart/rollback tests pass.

## Why this shape

The Tutor application image remains built from the reviewed `tutor/Dockerfile.railway` and pinned DeepTutor 1.6.6 source. Cloudflare owns the runtime lifecycle instead of GitHub Codespaces.

The Worker routes requests to one stable Container instance. The Container uses port `3782`, keeps outbound Internet access for model/provider calls, and sleeps after 15 minutes of inactivity. Cloudflare can then restart it on demand without the multi-minute Codespaces wake path.

`standard-1` is intentionally conservative for staging (0.5 vCPU, 4 GiB memory). We can right-size after observing real runtime memory and latency.

## Automatic deployment from GitHub

Use **Cloudflare Workers Builds** rather than adding Cloudflare deployment credentials to the root Murikah application.

One-time setup in Cloudflare:

1. Workers & Pages -> create or open the Worker named `murikah-tutor-container-staging`.
2. Settings -> Builds -> Connect -> GitHub -> select `wmurikah/Murikah`.
3. Production branch: `main`.
4. Root directory: `/` (repository root).
5. Build command:

```bash
python tutor/scripts/preflight.py && npm install --prefix tutor/cloudflare --no-audit --no-fund
```

6. Deploy command:

```bash
npm --prefix tutor/cloudflare run deploy:staging
```

7. Leave non-production branch deployment disabled for this Worker. Container preview builds do not provide a full Container preview; use a separate staging Worker for full-app testing.

After this one-time connection, a merged Tutor PR that changes `tutor/**` can be deployed from `main` without opening Codespaces or running Docker manually.

## Runtime secrets

Configure these in Cloudflare Worker **Settings -> Variables & Secrets**, not in Git or Wrangler:

Required for a fresh staging boot:

- `MURIKAH_TUTOR_ADMIN_PASSWORD`

Optional/when configured:

- `MURIKAH_TUTOR_ADMIN_USERNAME`
- `MURIKAH_TUTOR_TOKEN_EXPIRE_HOURS`
- `MURIKAH_GOOGLE_CLIENT_ID`
- `MURIKAH_GOOGLE_CLIENT_SECRET`
- `MURIKAH_MICROSOFT_CLIENT_ID`
- `MURIKAH_MICROSOFT_CLIENT_SECRET`
- `MURIKAH_MICROSOFT_TENANT`
- `MURIKAH_APPLE_CLIENT_ID`
- `MURIKAH_APPLE_TEAM_ID`
- `MURIKAH_APPLE_KEY_ID`
- `MURIKAH_APPLE_PRIVATE_KEY_B64`

The existing DeepTutor model/provider catalogue currently lives under `/app/data`; it is part of the persistence migration rather than being duplicated into source control.

## Staging checks

After the first deployment, use the Worker-provided `workers.dev` hostname and verify:

```text
/__muri/edge-health
/health
/
```

`/__muri/edge-health` is answered by the edge Worker and deliberately does not wake the Container. `/health` and the application routes are forwarded to the Tutor Container.

The response from Container-backed routes includes:

```text
x-murikah-tutor-runtime: cloudflare-container
```

## Production cutover gate

Do **not** attach `tutor.murikah.com` to this Worker yet.

Production cutover requires all of the following:

- durable persistence for settings, users/auth, sessions/messages, memory and knowledge state;
- object persistence for uploaded/generated files and workspaces;
- migration of the existing Codespaces `/app/data` without losing current data;
- restart/sleep/restart verification;
- rollback verification;
- Google/Microsoft/Apple callback validation against the production hostname;
- guest and authenticated end-to-end tests;
- streaming response verification through the Cloudflare Worker;
- removal of the Codespaces wake dependency only after the new runtime has passed production smoke tests.

See `PERSISTENCE.md` for the storage migration design.
