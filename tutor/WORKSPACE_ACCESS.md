# Guest workspace and public signup

Guests enter the normal DeepTutor workspace through `POST /api/murikah/access/session`.
Each guest receives a signed, HttpOnly session for an ordinary user with a separate
workspace ID. The normal learner routes, tools, uploads and capabilities are used;
no admin role, private admin resources or owner-bound model credentials are granted.
Deployment-managed, non-owner-bound LLM models are assigned to new public accounts.

One SQLite ledger in `data/system/auth/murikah_guests.sqlite3` enforces seven prompts
per guest session across chat/regeneration, auxiliary HTTP AI actions and the book,
question and partner WebSocket actions. Budget reservation is atomic across concurrent
requests on the runtime. Navigation, uploads and ordinary saves are free. Rejected
chat submissions and HTTP errors release their reservation. Accepted background turns
consume a prompt even if the provider fails later. Signing out or expiration of the
shorter workspace JWT does not reset the remembered guest session's allowance.
Clearing all browser cookies creates a new guest identity; this is a trial quota,
not a per-person abuse-prevention mechanism.

`POST /api/murikah/access/signup` supports password signup without SSO configuration.
It always creates an ordinary account, rejects reserved or existing usernames, and
uses upstream password hashing. Signing up from a guest workspace renames that
identity without changing its ID, retaining its files and conversations. Old guest
JWTs cease to authenticate after promotion. Signing into an existing account opens
that account's workspace; this change does not merge two existing workspaces.

The new overlay is applied last, after the existing build preparations. The original
stateless guest-chat endpoint is retired with HTTP 410 so it cannot offer a second
allowance. The shared fast lane rejects serialized provider errors before the first
token and throughout the winning stream, including split error prefixes. Provider
exhaustion produces a learner-facing retry message.

## Verification

- `python tutor/scripts/preflight.py`
- `python tutor/cloudflare/preflight.py`
- `python -m unittest discover -s tutor/tests -v`
- Apply the complete overlay chain to the pinned DeepTutor commit, then run the
  upstream frontend typecheck.
- The Dockerfile runs the regression suite against its materialized runtime modules.
  The dedicated **Build Murikah Tutor image** workflow builds the production image.

## Deployment boundary

Revision `2026-09-16-v14` forces the new image through the existing rollout checks.
Cloudflare Variables, Secrets and provider/model configuration are preserved.
This PR does not deploy or merge itself.

The existing `/app/data` persistence limitation remains: accounts, guest budgets,
conversations and files are on the container disk and can be lost on replacement.
This is not a durable account-storage implementation. Externalizing that data is a
separate infrastructure milestone documented in `cloudflare/PERSISTENCE.md`.

Sent text prompts show an always-visible Edit button in the shared chat for guests and members, including on touchscreens. The existing editor supports Cancel and Send, retaining conversation branches. Opening/cancelling an edit uses no allowance; sending an edited prompt uses the same seven-prompt guest budget as a new prompt. Editing is unavailable while a response is streaming.

Diagram Design streams status updates immediately, races allowed models with bounded startup/idle/overall timeouts, and commits only complete SVG output. The page shows animated progress, supports cancellation and retains the last diagram/brief on failure. Failed or cancelled diagram requests refund the shared guest allowance; a completed diagram uses one prompt. No model credentials or access grants are changed.

The guest allowance is enforced silently. No guest banner or remaining-prompt counter is shown before the limit. At the limit, the shared workspace prompts the visitor to create an account to keep the guest workspace or sign in to an existing account. Signing in to an existing account does not merge the guest workspace.

Diagram fallbacks remain alive until one provider returns a complete, validated SVG, rather than choosing the first provider to emit text. Common label entities are normalized for XML; incomplete or malformed diagrams trigger another available candidate. Responses distinguish provider availability, timeout and invalid output without exposing provider details.

Account links in the limit prompt preserve the current diagram and brief in this tab for the return from signup/sign-in. This one-time continuation expires after one hour and is consumed on return; it is not a replacement for durable server storage.

ER/data-model and database-schema requests use a compact JSON planning contract and deterministic SVG rendering. Auto mode recognizes ER/ERD and entity-relationship requests. The server validates entity/field references, primary keys, cardinality values and size bounds before rendering. The SVG includes relationship details and assumptions, and uses the selected light/dark style. No static finance schema is used as a production fallback; the model must provide the requested content. Other diagram types continue through the existing SVG path.
