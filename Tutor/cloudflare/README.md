# Murikah Tutor on Cloudflare Containers

This directory now owns the Cloudflare Container runtime for Murikah Tutor and the public hostname `https://tutor.murikah.com`.

The previous wake Worker -> Codespaces -> named Tunnel path is retained only as rollback infrastructure while persistence and data migration are completed. The public hostname is attached to the Cloudflare Container Worker as a Custom Domain.

## Runtime shape

The Tutor image is built from `Tutor/Dockerfile.railway` and the pinned DeepTutor 1.6.6 source. Cloudflare owns the runtime lifecycle. The application listens on port `3782`, outbound Internet access is enabled for LLM/provider calls, the runtime uses `standard-2`, and it sleeps after 30 minutes of inactivity. Startup goes through the Container SDK so its lifecycle monitoring and idle alarms are armed. In-flight HTTP requests and WebSockets retain the SDK activity tracking; idle expiry uses SIGTERM so the existing persistence loop can perform its final checkpoint.

`MURIKAH_PUBLIC_BASE_URL` is fixed to:

```text
https://tutor.murikah.com
```

This is the canonical base URL for OAuth callbacks and other externally generated links.

## Release from GitHub

The manual **Build Murikah Tutor image** workflow (`.github/workflows/tutor-image.yml`) is the sole release owner. Merging a PR does not deploy Tutor. After merging, run that workflow on `main` to build the immutable image, deploy, and run release verification. Cloudflare Workers Builds' `npm --prefix Tutor/cloudflare run deploy:staging` command is intentionally inert.

Release verification explicitly posts to `/__muri/wake` before checking the runtime image and readiness. Ordinary GET health checks never start compute. The workflow also runs the local Worker regression suite before building the image:

```bash
python Tutor/scripts/preflight.py
python Tutor/cloudflare/preflight.py
npm ci --prefix Tutor/cloudflare
npm --prefix Tutor/cloudflare test
npm --prefix Tutor/cloudflare run check
```

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

## Dormancy and health checks

A passive visit serves an edge landing page with **Open Tutor**. It does not start the container or poll readiness. Selecting Open Tutor sends a same-origin POST to `/__muri/wake`; the response sets a signed, secure, HttpOnly admission cookie. This cookie only controls entry into the compute proxy: it grants no account access and does not replace Tutor authentication. An admitted browser can use the running app normally. After the container sleeps, another explicit Open Tutor action is required to resume it. Deep links remain in the address bar during the JavaScript wake flow.

Browsers without an admission cookie (including ordinary crawlers) do not reach the app proxy, even while the container is warm. Bots that deliberately imitate a browser POST are not prevented by this mechanism; use Cloudflare request controls if access logs show that pattern.

Use `GET /__muri/edge-health` for uptime monitoring. It reports Worker configuration independently of container uptime. `/__muri/runtime-status`, `/__muri/runtime-revision`, and `/health` are read-only container probes: they do not start compute or renew its activity timer. `/health` returns 503 while dormant or starting; that must not trigger an automatic wake/restart monitor.

`/__muri/container-diagnostics` starts a temporary diagnostic container and now requires a deliberate same-origin POST. Its GET route returns 405. The release tooling supplies the method and Origin header automatically. Diagnostic containers use the SDK idle lifecycle and are destroyed in cleanup.

After deployment, verify the production lifecycle once:

1. Open Tutor, complete a chat, and confirm existing account/data access.
2. Close Tutor tabs and avoid app requests for at least 30 minutes. Look for `Murikah Tutor idle timeout reached; stopping container` followed by the container stop event in Cloudflare logs. Confirm the persistence checkpoint completes.
3. Poll only edge/runtime health and visit the landing page: the runtime should remain stopped, with no new container starts.
4. Select Open Tutor again; confirm saved work is restored. Repeat with an active stream/WebSocket to confirm the SDK does not stop in-flight work.
5. Compare **container memory GiB-seconds** and **disk GB-seconds** in subsequent Cloudflare billing data. Historical charges remain, and this repository change cannot establish actual savings until deployed and measured.

Container size and instance ceiling are unchanged. Measure peak memory during document processing before considering a smaller instance. No new scheduled monitor is introduced.

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
python Tutor/cloudflare/verify_persistence_lifecycle.py --snapshot /tmp/tutor-before.json
# perform the lifecycle event
python Tutor/cloudflare/verify_persistence_lifecycle.py --verify /tmp/tutor-before.json
```

See `PERSISTENCE.md` for the ownership model, migration safeguards and acceptance criteria.
