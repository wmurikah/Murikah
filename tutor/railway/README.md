# Murikah Tutor on Railway

This directory contains the production deployment layer for **Murikah Tutor — AI-powered personalised learning**.

It is intentionally independent from the existing Murikah Astro/Cloudflare Worker/Turso applications.

## Railway service source

After the stacked Tutor PRs are merged, create one Railway service from:

- GitHub repository: `wmurikah/Murikah`
- branch: `main`
- root directory: `/`
- custom Dockerfile path: `/tutor/Dockerfile.railway`

Keep the repository root as the build context because the Tutor build reuses the existing transparent Murikah logo at `docs/images/murikah_6.png`. The existing Murikah application is not built by this Dockerfile.

Recommended Railway watch paths:

```text
/tutor/**
/docs/images/murikah_6.png
```

This prevents ordinary CRM/GRC/Engineering/marketing changes from triggering Tutor deployments.

## Required runtime variables

Set these in the Tutor Railway service only:

```text
PORT=3782
MURIKAH_TUTOR_ADMIN_USERNAME=admin
MURIKAH_TUTOR_ADMIN_PASSWORD=<strong unique secret, minimum 14 characters>
```

Optional:

```text
MURIKAH_TUTOR_TOKEN_EXPIRE_HOURS=24
```

Do not commit the password. It is used only to create the first bcrypt password hash in the persistent DeepTutor auth settings.

After the first successful authenticated boot **and after `/app/data` persistence has been verified across a restart/redeploy**, remove `MURIKAH_TUTOR_ADMIN_PASSWORD` from the Railway service variables. The bcrypt hash remains persisted under `/app/data`; later password/account administration should be performed through Murikah Tutor itself rather than by rebuilding the image.

`MURIKAH_TUTOR_ALLOW_MAIN_CONTAINER_EXEC` must remain unset. Setting it to `1` deliberately re-enables subprocess execution in the main application container and is not approved for the initial public deployment.

## Persistent storage

Attach one Railway Volume to the Tutor service with mount path:

```text
/app/data
```

This is mandatory. Tutor auth state, accounts, settings, learner workspaces, knowledge bases, memory, generated content and other DeepTutor runtime data live under this tree.

Do not attach this volume to any existing Murikah service.

## Public networking

Generate a Railway domain for the Tutor service and select target port:

```text
3782
```

Only the Next.js frontend port is public. FastAPI remains inside the same container on port `8001` and is reached through DeepTutor's server-side proxy.

Do not publish port `8001` as a second public Railway domain.

## Health check

Configure:

```text
Healthcheck path: /health
Healthcheck timeout: 300 seconds
```

The Murikah Tutor `/health` route is unauthenticated by design but returns only `{"status":"ok"}` or a startup status. It checks the internal FastAPI `/health/ready` endpoint, so Railway does not mark a deployment healthy until both the Next.js frontend and Python backend are ready.

Because the service has a persistent volume, Railway may have a short redeployment interruption; the platform does not run two deployments simultaneously against one attached volume.

## First-boot security behaviour

Before DeepTutor starts, `bootstrap_runtime.py`:

1. requires a strong first-boot admin password when no auth settings exist;
2. writes DeepTutor's own `auth.json` with authentication enabled;
3. enables secure cookies;
4. keeps the bootstrap account as administrator;
5. forces the frontend/backend ports to `3782`/`8001` respectively;
6. fixes the backend worker count at one for the initial no-Redis deployment; and
7. disables main-container subprocess execution.

If an existing persistent volume contains `auth.json` with authentication disabled, the service refuses to start rather than exposing an unauthenticated Tutor publicly.

## Database and coordination

The initial deployment intentionally adds no Turso, Postgres, PocketBase or other new database service.

DeepTutor continues using its own JSON/SQLite persistence under `/app/data`. The existing Murikah Turso databases are not read, written, migrated or shared by Tutor.

The initial deployment also keeps DeepTutor's turn coordination in its default in-memory mode with one backend worker, so Redis is not required. Redis can be evaluated later if Tutor needs multiple backend workers or horizontal scaling.

## Upstream/runtime pin

The build materializes DeepTutor source at commit:

```text
7a96bba1ae03401644c17763a2411c28aff3dcc9
```

which is DeepTutor `1.6.6`.

The final image currently reuses the official `ghcr.io/hkuds/deeptutor:latest` runtime, but the Docker build verifies that the image version is exactly `1.6.6`. If upstream advances `latest`, the build deliberately fails until the Murikah Tutor pin is reviewed and updated. This prevents an unreviewed upstream release from entering production silently.

## Preflight

Before merging the Tutor stack and again before the first Railway deployment, run:

```bash
python tutor/scripts/preflight.py
```

It must finish with `PASS`. See `tutor/PREFLIGHT.md` for the full merge order and Railway acceptance gate.

## Not part of this phase

The following remain intentionally pending:

- Cloudflare `tutor.murikah.com` DNS/custom-domain setup
- isolated code-execution runner
- Redis/multi-worker scaling
- replacement of DeepTutor persistence with Turso or another database
- a Murikah-owned `wmurikah/DeepTutor` fork once created

Cloudflare setup should begin only after the Railway-generated domain is healthy, authentication works, and `/app/data` persistence has been proven across a redeploy.
