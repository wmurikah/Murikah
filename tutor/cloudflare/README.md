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

`keep_vars = true` is deliberate: non-secret production model/service variables are maintained in the Cloudflare dashboard and must survive a repo-backed Wrangler deployment. Worker Secrets are preserved by Cloudflare independently.

## Runtime secrets and model configuration

Configure production credentials in Cloudflare Worker **Settings -> Variables & Secrets**, not in Git or Wrangler.

Required secrets:

- `MURIKAH_TUTOR_ADMIN_PASSWORD`
- `MURIKAH_TUTOR_AUTH_SECRET`
- `MURIKAH_GOOGLE_CLIENT_ID`
- `MURIKAH_GOOGLE_CLIENT_SECRET`
- `MURIKAH_NVIDIA_NIM_API_KEY`
- `MURIKAH_DASHSCOPE_API_KEY`
- `MURIKAH_TAVILY_API_KEY`

New local and social accounts are activated only after a six-digit code sent to their email is verified. The Worker sends those messages through Resend using `RESEND_API_KEY`; the key remains in Worker Secrets and is never forwarded into the Tutor container. `RESEND_API_KEY` is required for **new-account verification**, but it is deliberately not a Wrangler deploy-time requirement. If it is absent, the Tutor Worker and existing/guest access remain available while verification start/resend returns a service-unavailable response, so no unverified new member session can be issued. This prevents a missing mail-provider credential from taking the entire Tutor deployment offline while preserving the signup security gate.

`RESEND_FROM_EMAIL` defaults to the repository-managed `Murikah Tutor <noreply@murikah.com>` sender and that sender/domain must be verified in the Resend account.

`MURIKAH_TUTOR_AUTH_SECRET` is the stable DeepTutor session-signing secret. It must be at least 32 characters and must remain unchanged across normal deployments. The Cloudflare runtime restores it to `data/system/auth/auth_secret` before DeepTutor imports its authentication module, so replacing a Container does not invalidate every existing signed session merely because the local disk was recreated.

Optional additional SSO providers:

- `MURIKAH_MICROSOFT_CLIENT_ID`
- `MURIKAH_MICROSOFT_CLIENT_SECRET`
- `MURIKAH_MICROSOFT_TENANT`
- `MURIKAH_APPLE_CLIENT_ID`
- `MURIKAH_APPLE_TEAM_ID`
- `MURIKAH_APPLE_KEY_ID`
- `MURIKAH_APPLE_PRIVATE_KEY_B64`

Other optional runtime values include `MURIKAH_TUTOR_ADMIN_USERNAME` and `MURIKAH_TUTOR_TOKEN_EXPIRE_HOURS`.

The Cloudflare Worker forwards the dashboard-managed NVIDIA, DashScope, Tavily, model, endpoint, and Video Learning variables into the Linux Container. On every Cloudflare Container start, `bootstrap_runtime.py` rebuilds DeepTutor's `model_catalog.json` and `video_learning.json` from those bindings. This makes provider credentials and production model selections recoverable after a disposable Container replacement and prevents duplicate provider cards from accumulating across restarts.

Cloudflare is authoritative only for service configuration. Chats, users, learner progress, memory, knowledge bases, attachments, generated files, and other user data still require durable storage and are not stored in Worker Variables or Secrets.

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

## Persistence and ownership

Tutor user data is durably externalised from the disposable Container:

- D1 `TUTOR_DB` is the structured learning, guest-quota, account-metadata and object-ownership control plane;
- private R2 `TUTOR_FILES` stores durable user/workspace objects;
- every R2-backed manifest object is reconciled to an explicit D1 owner/type record on startup;
- per-user paths are written to canonical `users/<uid>/<object-type>/<object-id>` R2 keys on their next changed checkpoint;
- provider/API credentials and signing secrets remain Cloudflare Secrets rather than learner data.

The local `/app/data` tree remains a compatibility execution cache for pinned DeepTutor subsystems and is safely restored/checkpointed without placing live SQLite databases on R2.

Use the lifecycle acceptance probe before and after sleep/wake, deploy, forced replacement or rollback:

```bash
python tutor/cloudflare/verify_persistence_lifecycle.py --snapshot /tmp/tutor-before.json
# perform the lifecycle event
python tutor/cloudflare/verify_persistence_lifecycle.py --verify /tmp/tutor-before.json
```

See `PERSISTENCE.md` for the ownership model, migration safeguards and acceptance criteria.
