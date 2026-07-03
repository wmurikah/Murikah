# Deploy

One worker, `murikah-web`, serves both sites. The host branch is decided in the
worker entry, `src/worker.ts`, using the helpers in `src/lib/engr/routing.ts`
(one source of truth). The `src/middleware.ts` session guard runs afterwards on
the engr routes.

- `murikah.com` serves the marketing site.
- `engr.murikah.com` serves Engineering Rhythm at its root; the request is
  rewritten internally to the files under `src/pages/engr/**`.
- `www.murikah.com` redirects (301) to `murikah.com`.
- Any other host is a neutral 404, so no corporate content leaks onto a stray
  host.

An old `murikah.com/engr/...` link is redirected once (301) to the matching
`engr.murikah.com/...` URL.

## Why run_worker_first

`wrangler.jsonc` sets `assets.run_worker_first: true`. Without it the Cloudflare
Assets layer answers a request before the worker runs: `engr.murikah.com/`
returns the marketing `index.html` and an unmatched path returns the marketing
404, both without the worker ever seeing the host. `run_worker_first` makes the
platform invoke the worker first for every request, so the host branch runs
before any static file is served. The host branch cannot live in Astro
middleware, because the Cloudflare adapter answers static assets and the
prerendered 404 before middleware runs; the worker entry is the earliest point.

## Debug headers

Every response carries two headers so the branch is observable on the edge with a
plain `curl -I`:

- `x-mrk-host`: the host as classified from the `Host` header.
- `x-mrk-branch`: one of `marketing`, `app`, `redirect-www`, `redirect-engr-path`,
  `not-found-host`.

They carry no secrets. They are kept for this change so routing can be confirmed
on the Cloudflare preview and in production; they can be removed in a later
tidy-up.

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

## Verifying the routing

Because the branch is read from the `Host` header, it can be exercised without
the real DNS. Build, run the worker, and set the host on each request:

```
pnpm build
pnpm exec wrangler dev --config dist/server/wrangler.json

curl -sI -H 'Host: engr.murikah.com' http://127.0.0.1:8787/login
#   x-mrk-branch: app        (the Engineering Rhythm sign-in page)
curl -sI -H 'Host: engr.murikah.com' http://127.0.0.1:8787/who-we-are
#   404, x-mrk-branch: app   (the engr not-found page, not the corporate one)
curl -sI -H 'Host: murikah.com' http://127.0.0.1:8787/engr/login
#   301 -> https://engr.murikah.com/login, x-mrk-branch: redirect-engr-path
curl -sI -H 'Host: murikah.com' http://127.0.0.1:8787/
#   x-mrk-branch: marketing
curl -sI -H 'Host: www.murikah.com' http://127.0.0.1:8787/
#   301 -> https://murikah.com/, x-mrk-branch: redirect-www
```

On the Cloudflare preview, the same `curl -I` with the `Host` header set confirms
each branch by its `x-mrk-branch`. The preview's own `workers.dev` host is an
unknown host (a neutral 404 by design), so drive the checks with the `Host`
header.

`astro dev` also honours the `Host` header, so `http://engr.localhost:4321/login`
serves the app during development. The session cookie is set without `Secure`
over http, so a local sign-in sticks.
