# Murikah Tutor deployment preflight

Run this gate before merging the Tutor stack and again before the first Railway deployment:

```bash
python tutor/scripts/preflight.py
```

The command must finish with `PASS`.

## What the gate verifies

- the approved DeepTutor source remains pinned to `1.6.6` / `7a96bba1ae03401644c17763a2411c28aff3dcc9`;
- the Murikah Tutor product name, tagline and logo overlay remain present;
- Railway uses the dedicated Tutor Dockerfile and public port `3782`;
- production authentication is enabled on first boot and secure cookies are enforced;
- main-container subprocess execution defaults to disabled;
- the deployment continues to require persistent `/app/data` storage;
- Tutor deployment code introduces no Turso, libSQL, Postgres or PocketBase dependency; and
- when Git history is available, the feature stack changes only paths under `tutor/`.

## Merge order

The Tutor work is intentionally stacked. Merge in this order only:

1. PR #247 — application boundary
2. PR #248 — pinned source and Murikah branding
3. PR #249 — Railway deployment
4. PR #250 — deployment preflight

Do not squash later PRs into an earlier feature branch out of sequence. After each merge, confirm the next PR still targets a branch containing the merged parent; retarget it to `main` when appropriate before merging.

## Railway acceptance gate

Do not configure Cloudflare yet. The Railway-generated domain must first satisfy all of the following:

- build succeeds using `tutor/Dockerfile.railway`;
- a Railway Volume is mounted exactly at `/app/data`;
- public target port is `3782` and no public service exposes `8001`;
- `/health` returns healthy;
- unauthenticated access is redirected/gated by Tutor authentication;
- the bootstrap administrator can sign in;
- `MURIKAH_TUTOR_ALLOW_MAIN_CONTAINER_EXEC` is unset;
- a small persistent test artifact is created in Tutor;
- the service is redeployed/restarted; and
- the administrator account and test artifact still exist after restart.

Once first boot, authenticated login and persistence are proven, remove the plaintext `MURIKAH_TUTOR_ADMIN_PASSWORD` variable from Railway. The persisted bcrypt hash under `/app/data` remains the authentication source.

Only after this acceptance gate passes should `tutor.murikah.com` be connected through Cloudflare.
