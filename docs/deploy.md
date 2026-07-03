# Deploy

One worker, `murikah-web`, serves both sites. Routing is by hostname (see
`src/middleware.ts` and `src/lib/engr/routing.ts`):

- `murikah.com` serves the marketing site.
- `engr.murikah.com` serves Engineering Rhythm at its root; the request is
  rewritten internally to the files under `src/pages/engr/**`.

An old `murikah.com/engr/...` link is redirected once (301) to the matching
`engr.murikah.com/...` URL.

## One-time setup

These are done by the operator, once, in the web dashboards. They are not in
code.

### 1. Add the subdomain to the worker

In the Cloudflare dashboard, open the `murikah-web` worker, Settings, Domains
and Routes, Add custom domain, and add `engr.murikah.com`. Because `murikah.com`
is already on Cloudflare, this provisions the DNS record and the TLS certificate
automatically. The hostname routing in the worker takes effect once the domain
resolves to the worker.

Do not also declare the same custom domain in `wrangler.jsonc`; use one place or
the other, not both.

### 2. Add the two GitHub secrets

In GitHub, Settings, Secrets and variables, Actions, add:

- `CLOUDFLARE_API_TOKEN`: a token created from the "Edit Cloudflare Workers"
  template.
- `CLOUDFLARE_ACCOUNT_ID`: the account id shown in the Cloudflare dashboard.

These are used only by the deploy workflow. They are not the worker's runtime
secrets.

### 3. Point provider callbacks at the subdomain

The self-secured machine endpoints now live at the subdomain root. Update any
external caller so it does not rely on the 301 (many providers do not follow a
redirect for a POST):

- Notification delivery webhooks: `https://engr.murikah.com/api/webhooks/...`
- Any external scheduler that calls the cron drains:
  `https://engr.murikah.com/api/cron/...`

The in-worker Cron Triggers (`src/worker.ts`) are unaffected; they call the
dispatcher directly and need no URL.

## Deploying

The `Deploy to Cloudflare` workflow (`.github/workflows/deploy.yml`) is manual.
Run it from the Actions tab (Run workflow). It installs, runs
`pnpm run build`, and deploys the generated `dist/server/wrangler.json` with
wrangler. It builds the whole worker, marketing and engr together.

A deploy does not touch the worker's runtime secrets (`TURSO_ENGR_*`,
`ENGR_SESSION_SECRET`, and the notification provider keys). Those are set once on
the worker with `wrangler secret put` or in the Cloudflare dashboard, and are
never added to GitHub.

The workflow is deliberately manual so it does not double-deploy alongside the
existing Cloudflare git integration. If the git integration is later retired,
this workflow can take over completely.

## Runtime secrets (reference)

Set on the worker, not in GitHub:

- `TURSO_ENGR_DATABASE_URL`, `TURSO_ENGR_AUTH_TOKEN`, `ENGR_SESSION_SECRET`
- `ENGR_ENV` (`production` enables real notification sends)
- notification provider keys (`AT_*`, `EMAIL_*`), `ENGR_CRON_SECRET`,
  `ENGR_WEBHOOK_SECRET`
- marketing: `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `RESEND_API_KEY`,
  `CONTACT_NOTIFY_EMAIL`, `RESEND_FROM_EMAIL`

## Local development

Hostname routing works locally through the `.localhost` names, which resolve to
127.0.0.1 with no hosts-file entry:

- `http://engr.localhost:4321/login` serves the Engineering Rhythm login.
- `http://localhost:4321/` serves the marketing site.

The session cookie is set without `Secure` over http, so a local sign-in sticks.
