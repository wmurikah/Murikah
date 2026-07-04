# GRC platform: deploy and runtime configuration

The GRC platform is a second product in this repo, served at `grc.murikah.com`
by the same Cloudflare Worker that serves Engineering Rhythm and the marketing
site. It shares the tooling and the Murikah design system; its data, routes and
session are separate.

## How the worker routes by host

`src/worker.ts` decides the branch by host, before the Astro adapter resolves a
route:

- `grc.murikah.com` (and `*.grc.murikah.com`, and `grc.localhost` in dev): the
  GRC app, rewritten internally to the `/grc/*` routes under `src/pages/grc/**`.
- `engr.murikah.com`: Engineering Rhythm, unchanged.
- `murikah.com`: the marketing site; a stray `/grc` path is redirected to the
  subdomain, exactly as `/engr` is.
- `www.murikah.com`: redirected to the apex.
- any other host: a neutral 404.

The session guard for `/grc/*` runs in `src/middleware.ts`, separate from engr's.

## Runtime secrets (never committed)

Set these for local dev in `.dev.vars` (gitignored; see `.dev.vars.example`) and
in production as Cloudflare Worker secrets. They point at the `hassaudit`
database and sign the GRC session; they are distinct from engr's.

| Secret                   | Purpose                                                    |
| ------------------------ | ---------------------------------------------------------- |
| `TURSO_GRC_DATABASE_URL` | libSQL URL of the `hassaudit` database                     |
| `TURSO_GRC_AUTH_TOKEN`   | auth token for that database                               |
| `GRC_SESSION_SECRET`     | 32+ random bytes, base64 encoded; signs the session cookie |

Set them in production with:

```
wrangler secret put TURSO_GRC_DATABASE_URL
wrangler secret put TURSO_GRC_AUTH_TOKEN
wrangler secret put GRC_SESSION_SECRET
```

Generate a session secret with:

```
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

The GRC env accessor (`src/lib/grc/env.ts`) throws a clear error at runtime if any
is missing, so the app fails loudly rather than running unconfigured. The
marketing preview typechecks without them (they are optional in the env types).

## Custom domain

The operator points the custom domain at the worker:

1. In the Cloudflare dashboard, add `grc.murikah.com` as a Custom Domain (or a
   route) for the worker that serves this project.
2. No code change is needed: the worker already recognises the host and serves
   the GRC app. Confirm on the deployed preview that `grc.murikah.com` shows the
   sign-in and that `engr.murikah.com` and `murikah.com` are unaffected. Every
   response carries `x-mrk-host` and `x-mrk-branch` (the grc branch is
   `grc-app`) so the routing is observable with a plain `curl`.

## Schema

The `hassaudit` schema is operator-managed and must not be changed from here.
The column names this foundation depends on are listed in
`grc/docs/schema-assumptions.md`, which is the single place to reconcile if any
differ from the live database.
