# Murikah Tutor on Cloudflare Containers

This directory now owns the Cloudflare Container runtime for Murikah Tutor and the public hostname `https://tutor.murikah.com`.

The previous wake Worker -> Codespaces -> named Tunnel path is retained only as rollback infrastructure while persistence and data migration are completed. The public hostname is attached to the Cloudflare Container Worker as a Custom Domain.

## Runtime shape

The Tutor image is built from `tutor/Dockerfile.railway` and the pinned DeepTutor 1.6.6 source. Cloudflare owns the runtime lifecycle. The application listens on port `3782`, outbound Internet access is enabled for LLM/provider calls, the runtime uses `standard-2`, and it sleeps after 30 minutes of inactivity.

`MURIKAH_PUBLIC_BASE_URL` is fixed to:

```text
https://tutor.murikah.com
```

This is the canonical base URL for OAuth callbacks and other externally generated links.

## Automatic deployment from GitHub

Use **Cloudflare Workers Builds**.

- Repository: `wmurikah/Murikah`
- Production branch: `main`
- Root directory: `/`
- Build command:

```bash
python tutor/scripts/preflight.py && python tutor/cloudflare/preflight.py && npm install --prefix tutor/cloudflare --no-audit --no-fund
```

- Deploy command:

```bash
npm --prefix tutor/cloudflare run deploy:staging
```

The deployment command publishes the Worker/Container and performs an immediate Container rollout. The optional smoke test is separate and does not determine deployment success.

## Runtime secrets

Configure these in Cloudflare Worker **Settings -> Variables & Secrets**, not in Git or Wrangler.

Required:

- `MURIKAH_TUTOR_ADMIN_PASSWORD`

SSO when enabled:

- `MURIKAH_GOOGLE_CLIENT_ID`
- `MURIKAH_GOOGLE_CLIENT_SECRET`
- `MURIKAH_MICROSOFT_CLIENT_ID`
- `MURIKAH_MICROSOFT_CLIENT_SECRET`
- `MURIKAH_MICROSOFT_TENANT`
- `MURIKAH_APPLE_CLIENT_ID`
- `MURIKAH_APPLE_TEAM_ID`
- `MURIKAH_APPLE_KEY_ID`
- `MURIKAH_APPLE_PRIVATE_KEY_B64`

Other optional runtime values include `MURIKAH_TUTOR_ADMIN_USERNAME` and `MURIKAH_TUTOR_TOKEN_EXPIRE_HOURS`.

The DeepTutor model/provider catalogue currently lives under `/app/data`; persistence migration remains separate from the hostname cutover.

## Health checks

Public production checks:

```text
https://tutor.murikah.com/__muri/edge-health
https://tutor.murikah.com/__muri/worker-config
https://tutor.murikah.com/__muri/runtime-status
https://tutor.murikah.com/health
https://tutor.murikah.com/
```

The Worker-provided `workers.dev` hostname remains enabled temporarily for direct diagnostics.

## Persistence remains pending

The public hostname cutover does not make Container-local `/app/data` durable. Before retiring the Codespaces rollback path, externalise and migrate settings, users/auth, sessions/messages, memory, knowledge state, uploads and generated workspaces, then verify sleep/wake, replacement and rollback behavior.

See `PERSISTENCE.md` for the storage migration design.
