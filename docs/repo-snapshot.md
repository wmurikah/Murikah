# Murikah repository snapshot

A read-only, point-in-time snapshot of the `wmurikah/Murikah` repository, prepared for deployment review. No secret values appear here: every credential is referred to by variable name only and shown as `[REDACTED]` or a placeholder. Non-secret configuration (the public site URL, bucket names, binding names) is included.

- Snapshot date: 2026-06-25
- Branch described: `main` (default branch), at commit `f5ca69e` (merge of PR #3, `claude/tender-feynman-g6yasn`).
- Scope note: this snapshot describes the **deployable default branch** (`main`). The repository also has open, unmerged feature branches that add the interactive Labs demos, a site-wide AI assistant, a retention/cron Worker, and a reworked database tooling and schema. Those are **not** on `main` and so are not part of what would deploy today; they are summarised under "Built but unmerged feature branches" so nothing built is hidden.

---

## Overview

Murikah is the marketing website for an AI-native assurance and governance company serving organisations (internal audit, IT audit, data protection, and AI governance). On `main` the site is a content-led marketing site with final copy and a full SEO/AI-discoverability layer. The Labs interactive sandbox is present only as a **stubbed** React island, and there is no AI assistant on this branch yet.

| Concern         | Value (from config on `main`)                                                                                        |
| --------------- | -------------------------------------------------------------------------------------------------------------------- |
| Framework       | Astro `^7.0.2` (TypeScript, strict)                                                                                  |
| UI islands      | React 19 via `@astrojs/react` (one stubbed island)                                                                   |
| Styling         | Tailwind CSS v4 via `@tailwindcss/vite`                                                                              |
| Content         | `@astrojs/mdx` collection, `@astrojs/rss`, `@astrojs/sitemap`                                                        |
| Database        | Turso / libSQL (`@libsql/client`)                                                                                    |
| Email           | Resend (optional, behind an env check)                                                                               |
| Package manager | pnpm `10.33.0` (pinned via `packageManager`)                                                                         |
| Node engine     | `>=22.12.0`                                                                                                          |
| Deploy target   | **Cloudflare Worker** (`@astrojs/cloudflare` v14) serving prerendered static assets plus two on-demand API endpoints |

Output model: pages are prerendered to static HTML; only the API endpoints opt out of prerender and run on demand in the Worker. The build reports `output: "static"`, `mode: "server"`, `adapter: @astrojs/cloudflare`.

---

## File tree

Trimmed; build output (`dist/`, `.astro/`, `.wrangler/`), `node_modules/`, and `.git/` are excluded. This is the full set of 82 tracked files on `main`.

```
.
├── .github/workflows/ci.yml
├── .editorconfig
├── .dev.vars.example
├── .gitignore
├── .prettierignore
├── .prettierrc.json
├── LICENSE
├── README.md
├── astro.config.ts
├── eslint.config.js
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
├── wrangler.jsonc
├── db/
│   ├── apply.ts                   # apply schema.sql (Node, --experimental-strip-types)
│   ├── schema.sql                 # 3 tables
│   └── seed.ts                    # minimal sample data
├── public/
│   ├── .assetsignore
│   ├── favicon.svg
│   ├── llms.txt
│   ├── og-default.png
│   ├── og-default.svg
│   └── robots.txt
└── src/
    ├── env.d.ts                   # Cloudflare.Env binding types
    ├── site.config.ts             # single source of truth (nav, services, SEO)
    ├── content.config.ts          # insights collection schema
    ├── components/
    │   ├── islands/SandboxDemo.tsx        # STUBBED React island for /labs
    │   ├── primitives/            # Section, Container, Button, Card, Stat,
    │   │                          # FeatureGrid, CtaSection, Faq, Prose, Breadcrumb
    │   ├── schema/                # Organization, Service, FaqPage (JSON-LD)
    │   ├── AuthorByline.astro
    │   ├── DemoEmbed.astro
    │   ├── Footer.astro
    │   ├── Header.astro
    │   ├── Logo.astro
    │   ├── Seo.astro
    │   └── SubscribeForm.astro
    ├── content/insights/          # 5 MDX guides
    ├── layouts/                   # BaseLayout, ServiceLayout, InsightLayout
    ├── lib/
    │   ├── db.ts                  # Worker libSQL client (@libsql/client/web)
    │   ├── email.ts
    │   ├── format.ts
    │   ├── http.ts
    │   ├── rate-limit.ts
    │   ├── schema.ts
    │   ├── types.ts
    │   └── validation.ts
    ├── pages/
    │   ├── api/
    │   │   ├── contact.ts                 # POST, prerender = false
    │   │   └── subscribe.ts               # POST, prerender = false
    │   ├── index.astro
    │   ├── about.astro
    │   ├── assurance.astro / audit-os.astro / labs.astro
    │   ├── advisory.astro / academy.astro / intelligence.astro
    │   ├── contact.astro
    │   ├── insights/index.astro
    │   ├── insights/[...slug].astro
    │   ├── privacy.astro / terms.astro / 404.astro
    │   └── rss.xml.ts
    └── styles/
        ├── tokens.css             # Tailwind v4 @theme tokens
        └── global.css
```

No `workers/`, no `wrangler.cron.jsonc`, no `src/lib/ai/`, no `src/lib/demo/`, no `src/components/labs/`, and no `/admin` exist on `main`.

---

## package.json

- `name`: `murikah-web`
- `version`: `0.1.0` (private)
- `type`: `module`
- `packageManager`: `pnpm@10.33.0`
- `engines`: `node >=22.12.0`, `pnpm >=9.0.0`
- `pnpm.onlyBuiltDependencies`: `esbuild`, `sharp`, `workerd`

### scripts

```jsonc
{
  "dev": "astro dev",
  "start": "astro dev",
  "sync": "astro sync",
  "build": "astro check && astro build",
  "preview": "astro preview",
  "cf:typegen": "wrangler types",
  "cf:dev": "astro build && wrangler dev --config dist/server/wrangler.json",
  "cf:deploy": "astro build && wrangler deploy --config dist/server/wrangler.json",
  "lint": "eslint .",
  "lint:fix": "eslint . --fix",
  "format": "prettier --write .",
  "format:check": "prettier --check .",
  "db:apply": "node --env-file-if-exists=.dev.vars --experimental-strip-types db/apply.ts",
  "db:seed": "node --env-file-if-exists=.dev.vars --experimental-strip-types db/seed.ts",
  "astro": "astro",
}
```

The two database scripts run with Node's native TypeScript stripping and load `.dev.vars` via `--env-file-if-exists` (no `tsx`/`dotenv` on this branch).

### dependencies (11)

| Package                         | Version   |
| ------------------------------- | --------- |
| `@astrojs/cloudflare`           | `^14.0.0` |
| `@astrojs/mdx`                  | `^7.0.0`  |
| `@astrojs/react`                | `^6.0.0`  |
| `@astrojs/rss`                  | `^4.0.18` |
| `@astrojs/sitemap`              | `^3.7.3`  |
| `@fontsource-variable/fraunces` | `^5.2.9`  |
| `@fontsource-variable/outfit`   | `^5.2.8`  |
| `@libsql/client`                | `^0.17.4` |
| `astro`                         | `^7.0.2`  |
| `react`                         | `^19.2.0` |
| `react-dom`                     | `^19.2.0` |

### devDependencies (17)

| Package                       | Version         |
| ----------------------------- | --------------- |
| `@astrojs/check`              | `^0.9.9`        |
| `@cloudflare/workers-types`   | `^4.20250109.0` |
| `@tailwindcss/vite`           | `^4.3.1`        |
| `@types/react`                | `^19.2.0`       |
| `@types/react-dom`            | `^19.2.0`       |
| `@typescript-eslint/parser`   | `^8.62.0`       |
| `eslint`                      | `^10.5.0`       |
| `eslint-plugin-astro`         | `^2.0.0`        |
| `eslint-plugin-jsx-a11y`      | `^6.10.2`       |
| `globals`                     | `^17.7.0`       |
| `prettier`                    | `^3.8.4`        |
| `prettier-plugin-astro`       | `^0.14.1`       |
| `prettier-plugin-tailwindcss` | `^0.8.0`        |
| `tailwindcss`                 | `^4.3.1`        |
| `typescript`                  | `~6.0.3`        |
| `typescript-eslint`           | `^8.62.0`       |
| `wrangler`                    | `^4.104.0`      |

---

## Astro config

`astro.config.ts` (full):

```ts
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import mdx from '@astrojs/mdx';
import react from '@astrojs/react';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';

// Single source of truth for the canonical site URL (used by sitemap + SEO).
import { SITE_URL } from './src/site.config';

export default defineConfig({
  // Canonical origin, drives sitemap.xml and canonical/OG URLs.
  site: SITE_URL,

  adapter: cloudflare({
    imageService: 'compile',
  }),

  integrations: [
    mdx(),
    react(),
    sitemap({
      serialize(item) {
        // Priorities: home and service pages highest, guides next, legal lowest.
        const path = new URL(item.url).pathname.replace(/\/$/, '') || '/';
        const services = [
          '/assurance',
          '/audit-os',
          '/labs',
          '/advisory',
          '/academy',
          '/intelligence',
        ];
        if (path === '/') item.priority = 1.0;
        else if (services.includes(path)) item.priority = 0.9;
        else if (path === '/insights' || path.startsWith('/insights/')) item.priority = 0.8;
        else if (path === '/about' || path === '/contact') item.priority = 0.7;
        else if (path === '/privacy' || path === '/terms') item.priority = 0.2;
        else item.priority = 0.6;
        return item;
      },
    }),
  ],

  vite: {
    plugins: [tailwindcss()],
  },

  prefetch: {
    prefetchAll: true,
    defaultStrategy: 'hover',
  },
});
```

- Adapter: `@astrojs/cloudflare` (Workers), `imageService: 'compile'` (build-time images, no runtime Images binding).
- Output: static-first. Pages prerender; API routes set `prerender = false`. `site` is the canonical production URL via `SITE_URL` (`https://www.murikah.com`).
- Integrations: MDX, React, Sitemap (custom priority serialiser).

---

## Cloudflare config and bindings

There is a single Worker on `main` (the site Worker). No companion Cron Worker exists on this branch.

### Site Worker, source config `wrangler.jsonc` (full)

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "murikah-web",
  "main": "@astrojs/cloudflare/entrypoints/server",
  "compatibility_date": "2025-05-21",
  "compatibility_flags": ["nodejs_compat"],

  "assets": {
    "directory": "./dist",
    "binding": "ASSETS",
  },

  "observability": {
    "enabled": true,
  },

  "kv_namespaces": [
    {
      "binding": "CACHE",
      "id": "REPLACE_WITH_KV_NAMESPACE_ID",
    },
  ],

  "r2_buckets": [
    {
      "binding": "ASSETS_BUCKET",
      "bucket_name": "murikah-assets",
    },
  ],

  // Cron PLACEHOLDER, reserved for future Labs sandbox/demo-session resets.
  // A `scheduled` handler must be added before this does anything (out of scope now).
  "triggers": {
    "crons": ["0 3 * * *"],
  },

  "vars": {
    "PUBLIC_SITE_URL": "https://www.murikah.com",
  },
}
```

`@astrojs/cloudflare` reads this at build and emits the deployable `dist/server/wrangler.json` (with the real `main` of `entry.mjs` and `assets.directory` of `../client`). Deploy and `wrangler dev` use the generated file, not this source.

Bindings the site Worker declares or implies:

| Binding           | Type          | Name / id                         | Notes                                                                                                                                                                                                                                                                                                                                    |
| ----------------- | ------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ASSETS`          | Static assets | serves `dist/client`              | Generated automatically from the build.                                                                                                                                                                                                                                                                                                  |
| `CACHE`           | KV namespace  | id `REPLACE_WITH_KV_NAMESPACE_ID` | **Placeholder id; must be replaced with a real KV namespace id before deploy.** Used by the rate limiter and the contact/subscribe endpoints.                                                                                                                                                                                            |
| `ASSETS_BUCKET`   | R2 bucket     | `murikah-assets`                  | Bucket must exist. Reserved for asset overflow and a future downloadable report; not yet read by any code on `main`.                                                                                                                                                                                                                     |
| `SESSION`         | KV namespace  | (no id)                           | **Injected by the adapter** (Astro Sessions, on by default) into the generated `dist/server/wrangler.json`; not in the source file. The app does not use Astro's session API, so it is functionally inert, but it appears in the deployable config and should be resolved before deploy (bind a KV namespace or disable Astro Sessions). |
| `PUBLIC_SITE_URL` | Plain var     | `https://www.murikah.com`         | Non-secret.                                                                                                                                                                                                                                                                                                                              |

There is a **cron trigger** `["0 3 * * *"]` in `wrangler.jsonc`, described in its own comment as a placeholder. The Astro Cloudflare adapter produces a Worker that exports only a `fetch` handler (no `scheduled` handler), and this trigger carries through to the generated `dist/server/wrangler.json`. Deploying as-is means Cloudflare would fire a daily scheduled event the Worker cannot handle. See Deployment readiness.

No `routes` and no `custom_domain` are configured, so a deploy would publish to the `*.workers.dev` subdomain until a route or custom domain is added for `www.murikah.com`. No D1, Durable Objects, Queues, Hyperdrive, or Workers AI bindings are used on `main`.

---

## Environment variables

Gathered from the code (`import { env } from 'cloudflare:workers'` in the Worker, `process.env` in the Node scripts). Secrets are named only; no values are reproduced.

### Site Worker (read at request time)

| Variable               | Required        | Type in prod | Used for                                          | Read in                 |
| ---------------------- | --------------- | ------------ | ------------------------------------------------- | ----------------------- |
| `TURSO_DATABASE_URL`   | For persistence | Secret/var   | libSQL connection URL (`libsql://...`)            | `src/lib/db.ts`         |
| `TURSO_AUTH_TOKEN`     | For persistence | Secret       | Turso auth token `[REDACTED]`                     | `src/lib/db.ts`         |
| `RESEND_API_KEY`       | Optional        | Secret       | Resend email. If unset, email is skipped (no-op). | `src/lib/email.ts`      |
| `CONTACT_NOTIFY_EMAIL` | Optional        | Secret/var   | Recipient for contact notifications               | `src/lib/email.ts`      |
| `RESEND_FROM_EMAIL`    | Optional        | Secret/var   | Verified sender address                           | `src/lib/email.ts`      |
| `PUBLIC_SITE_URL`      | Optional        | Plain var    | Canonical/OG origin for non-prod                  | set in `wrangler.jsonc` |

Bindings (not string vars) referenced from code: `CACHE` (KV) in the rate limiter and the contact/subscribe endpoints. The site builds and serves without any of the above set: pages are prerendered, and the two endpoints degrade gracefully and return a clear error when Turso is not configured.

### Database scripts (Node)

| Variable             | Required | Used for                       |
| -------------------- | -------- | ------------------------------ |
| `TURSO_DATABASE_URL` | Yes      | Target database for apply/seed |
| `TURSO_AUTH_TOKEN`   | Yes      | Auth token `[REDACTED]`        |

`pnpm db:apply` / `pnpm db:seed` read these from the environment and also auto-load `.dev.vars` when present (via `--env-file-if-exists`). A missing URL prints a clear error and exits non-zero. Credentials are not printed.

### `.dev.vars.example` (full, committed; placeholders only)

The committed template. It contains no real values. Local secrets live in `.dev.vars`, which is git-ignored and was not read for this report.

```bash
# Local Worker variables/secrets. Copy to `.dev.vars` (gitignored) for local dev.
# `astro dev` reads these via the adapter's platformProxy; `wrangler dev` reads them natively.
# In production these are set as Cloudflare secrets (see README), NOT committed.

# --- Turso (libSQL), required for contact/subscribe persistence ---
TURSO_DATABASE_URL="libsql://your-database-name.turso.io"
TURSO_AUTH_TOKEN="your-turso-auth-token"

# --- Resend transactional email, OPTIONAL ---
# If RESEND_API_KEY is empty/unset, email sending is skipped (no-op) and the
# endpoints still validate + persist. The build never requires a key.
RESEND_API_KEY=""
# Notification recipient for contact submissions.
CONTACT_NOTIFY_EMAIL="hello@murikah.com"
# Verified sender (must be a verified domain in Resend for production).
RESEND_FROM_EMAIL="Murikah <noreply@murikah.com>"

# --- Public site URL (canonical/OG fallback for non-production environments) ---
PUBLIC_SITE_URL="http://localhost:4321"
```

(The example file's header still references the older "platformProxy" wording; functionally the v14 adapter exposes these via its Vite plugin during `astro dev`.)

---

## Routes and features

### Pages (all prerendered, `prerender = true`)

| Route              | Source                     | Kind                                      |
| ------------------ | -------------------------- | ----------------------------------------- |
| `/`                | `src/pages/index.astro`    | Home                                      |
| `/about`           | `about.astro`              | Company                                   |
| `/assurance`       | `assurance.astro`          | Service line                              |
| `/audit-os`        | `audit-os.astro`           | Service line                              |
| `/labs`            | `labs.astro`               | Service line + **stubbed** sandbox island |
| `/advisory`        | `advisory.astro`           | Service line                              |
| `/academy`         | `academy.astro`            | Service line                              |
| `/intelligence`    | `intelligence.astro`       | Service line                              |
| `/contact`         | `contact.astro`            | Contact form                              |
| `/insights`        | `insights/index.astro`     | Guides index                              |
| `/insights/<slug>` | `insights/[...slug].astro` | Guide (5 entries)                         |
| `/privacy`         | `privacy.astro`            | Legal (template, needs review)            |
| `/terms`           | `terms.astro`              | Legal (template, needs review)            |
| `/404`             | `404.astro`                | Not found                                 |
| `/rss.xml`         | `rss.xml.ts`               | RSS feed (prerendered)                    |

`sitemap-index.xml` and `sitemap-0.xml` are generated by `@astrojs/sitemap` at build.

### API endpoints (all `prerender = false`, run in the Worker)

| Endpoint              | Purpose                                                          |
| --------------------- | ---------------------------------------------------------------- |
| `POST /api/contact`   | Contact form submission (validate, persist lead, optional email) |
| `POST /api/subscribe` | Newsletter subscribe                                             |

### Feature presence on `main`

| Feature                      | State on `main`                                                                                                                                                |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Marketing pages + final copy | **Present.** All routes, final copy via `site.config.ts`, five Insights guides.                                                                                |
| SEO / AI discoverability     | **Present.** JSON-LD emitters (Organization/Service/FaqPage), `robots.txt`, `llms.txt`, generated sitemap with priorities, RSS.                                |
| Labs interactive demos       | **Stub only.** `/labs` embeds `src/components/islands/SandboxDemo.tsx`, a placeholder React island. The four real demos are on an unmerged branch (see below). |
| Site-wide AI assistant       | **Not present** on `main`.                                                                                                                                     |
| `/admin` area                | **Not present** on `main`.                                                                                                                                     |

---

## Data layer

### Tables in `db/schema.sql` (3, all `CREATE TABLE IF NOT EXISTS`, idempotent)

```sql
-- Contact form submissions.
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, organisation TEXT,
  role TEXT, email TEXT NOT NULL, message TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'contact', created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Newsletter subscribers (email unique; re-subscribing is idempotent).
CREATE TABLE IF NOT EXISTS subscribers (
  id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL DEFAULT 'website', created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Forward-looking placeholder for future Labs sandboxes; unused by any endpoint.
CREATE TABLE IF NOT EXISTS demo_sessions (
  id TEXT PRIMARY KEY, demo TEXT NOT NULL, state TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at TEXT
);
```

| Table           | Purpose                                                                                   |
| --------------- | ----------------------------------------------------------------------------------------- |
| `leads`         | Contact-form submissions (used by `/api/contact`)                                         |
| `subscribers`   | Newsletter subscribers (used by `/api/subscribe`)                                         |
| `demo_sessions` | Reserved placeholder for future Labs sandboxes; not read or written by any code on `main` |

### Seed and apply scripts

| Script                          | What it does                                                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `db/apply.ts` (`pnpm db:apply`) | Reads `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN`, applies `db/schema.sql` via `executeMultiple`. Uses `@libsql/client/web`. |
| `db/seed.ts` (`pnpm db:seed`)   | Inserts a sample subscriber (`demo@example.com`, `INSERT OR IGNORE`) and a sample lead (marked `[placeholder]`).         |

There is no `db:reset`, no `db:setup`, and no content seed on this branch.

### Content collections

One collection, `insights` (`src/content.config.ts`), loaded from `src/content/insights/**/*.{md,mdx}` with a typed Zod schema (title, description, optional question/summary, dates, author, category, tags, service, related, optional FAQ block, draft). Current MDX guides:

- `co-sourced-vs-outsourced-internal-audit.mdx`
- `internal-audit-software-cost-kenya.mdx`
- `iso-42001-readiness.mdx`
- `kenya-data-protection-act.mdx`
- `sacco-internal-audit-sasra.mdx`

---

## Build-state read

| Capability                        | State on `main`                                                                                                                                                                                                  |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Framework and design system       | **In place.** Astro 7 + Cloudflare adapter, Tailwind v4 `@theme` tokens, component primitives, layouts.                                                                                                          |
| Page content and SEO/GEO          | **In place.** Final copy via `site.config.ts`, five Insights guides, JSON-LD, `robots.txt`, `llms.txt`, generated sitemap, RSS. Some legal/contact specifics remain as `{{PLACEHOLDER}}`/`[placeholder]` tokens. |
| Labs demos and AI assistant       | **Not on `main`.** `/labs` shows a stubbed island; the real demos and the assistant live on an unmerged branch.                                                                                                  |
| Admin and database-driven content | **Not built.**                                                                                                                                                                                                   |
| Database scripts and seeding      | **Basic.** Apply + seed only, via Node `--experimental-strip-types`; the reworked CLI-free tooling is on an unmerged branch.                                                                                     |

### Built but unmerged feature branches

The repository contains open feature branches (not merged into `main`) that add substantial functionality. They are noted here so the advisor knows the work exists, but **none of it is on `main`** and so none of it would deploy from the default branch today:

- **Labs interactive sandbox**: four demos (Assurance OS read-only sandbox, document extraction, workflow engine, mini-CRM) with React components and `/api/demo/*` endpoints, backed by a `src/lib/demo/` isolation layer (anonymous sessions, salted IP hashing, rate limits, retention sweep).
- **Site-wide AI assistant**: a provider-agnostic adapter (`src/lib/ai/`, Anthropic default with a Workers AI seam) and an `/api/ai/assistant` SSE endpoint.
- **Retention/cron Worker**: a companion Worker (`workers/cron.ts`, `wrangler.cron.jsonc`) on an hourly trigger that calls a secured `/api/cron/sweep` endpoint, because the Astro adapter cannot export a `scheduled` handler.
- **Reworked database tooling**: CLI-free `tsx` scripts with a shared env loader (shell-first, then `.dev.vars`), idempotent apply, guarded reset, a content-seed placeholder, and an expanded schema (around 13 tables for the demo and assistant data). This branch also adds `dotenv` and `tsx` as devDependencies and changes the `db:*` scripts to run via `tsx`.

Merging these introduces new required configuration on top of what `main` needs today: additional secrets (`ANTHROPIC_API_KEY`, `DEMO_HASH_SALT`, `CRON_SECRET`), a new `AI_PROVIDER` var, a second Worker to deploy, and a larger schema to apply.

---

## CI and deployment

### Continuous integration, `.github/workflows/ci.yml`

Triggers on push to `main` and on every pull request; concurrency cancels superseded runs. One job on `ubuntu-latest`:

1. Checkout
2. Setup pnpm (v10)
3. Setup Node 22 with pnpm cache
4. `pnpm install --frozen-lockfile`
5. `pnpm run lint`
6. `pnpm run build` (`astro check` + `astro build`)

No environment variables or secrets are configured in CI, which confirms the build does not require any secret (verified below). There is **no deploy job**; deployment is manual.

### Deployment (manual)

- Site: `pnpm cf:deploy` -> `astro build` then `wrangler deploy --config dist/server/wrangler.json`.
- Production secrets are set with `wrangler secret put ... --config dist/server/wrangler.json` (documented in `README.md`).

---

## Build result

Built locally from `main` for this snapshot.

- Node `v22.22.2`, pnpm `10.33.0`.
- `pnpm install --frozen-lockfile`: success (lockfile up to date for `main`).
- `pnpm build` (`astro check` + `astro build`): **success.**
  - Output directory: `dist/` with `dist/client` (static assets, `_headers`, `sitemap-index.xml`) and `dist/server` (`entry.mjs`, chunks, middleware, and the generated `wrangler.json`).
  - 19 static routes prerendered (the 14 pages, the 5 guides expanded from `insights/[...slug]`, and `rss.xml`); the two API endpoints built as server entrypoints.
- Build without secrets: re-run with `.dev.vars` temporarily removed (the file was renamed, never read, and restored). Exit code `0`. The build does **not** require any environment variable or secret; it is safe to build in CI with none configured. (`astro build` logs `Using secrets defined in .dev.vars` only when that file is present, to expose local vars to the dev runtime; it does not print any value and is not required.)

The generated deployable config `dist/server/wrangler.json` confirms: `name: murikah-web`, `main: entry.mjs`, `assets.directory: ../client` (`binding: ASSETS`), `compatibility_date: 2025-05-21`, `compatibility_flags: [nodejs_compat]`, `vars: { PUBLIC_SITE_URL }`, `kv_namespaces: [SESSION, CACHE]`, `r2_buckets: [ASSETS_BUCKET]`, and `triggers.crons: ["0 3 * * *"]` (with no matching `scheduled` handler in the Worker).

---

## Deployment readiness

- **Target:** a Cloudflare **Worker** (not Pages), via `@astrojs/cloudflare` v14. Prerendered pages are served as static assets through the `ASSETS` binding (`dist/client`); the two API endpoints run on demand in the Worker (`dist/server/entry.mjs`).
- **Build command and output:** `pnpm build` (or `pnpm cf:deploy`, which builds then deploys). Output is `dist/`, deployed with `wrangler deploy --config dist/server/wrangler.json`. Node 22+, pnpm 10.
- **Bindings that must exist in Cloudflare** (names exactly as used):
  - `CACHE` (KV namespace): create it and replace the placeholder id `REPLACE_WITH_KV_NAMESPACE_ID` in `wrangler.jsonc`. **Blocking** for deploy.
  - `ASSETS_BUCKET` (R2 bucket): create the bucket `murikah-assets`. The binding is declared, so a deploy expects it to exist.
  - `SESSION` (KV namespace): injected by the adapter's Astro Sessions feature into the generated config without an id. Resolve before deploy by binding a KV namespace or disabling Astro Sessions in the adapter config.
  - `ASSETS` (static assets): generated automatically from `dist/client`; no manual step.
- **Environment variables and secrets to set in Cloudflare:**
  - Secrets (via `wrangler secret put`): `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` (required for the contact/subscribe endpoints to persist). Optional: `RESEND_API_KEY`, `CONTACT_NOTIFY_EMAIL`, `RESEND_FROM_EMAIL` (transactional email).
  - Plain var (already in `wrangler.jsonc`): `PUBLIC_SITE_URL`.
- **Currently blocking or risking a clean production deploy:**
  1. `CACHE` KV id is a placeholder and must be replaced.
  2. R2 bucket `murikah-assets` must be created.
  3. The adapter-injected `SESSION` KV binding needs a namespace or Astro Sessions disabled.
  4. The `wrangler.jsonc` cron trigger `["0 3 * * *"]` has no `scheduled` handler (the adapter exports only `fetch`). Deploying with it means Cloudflare fires a daily scheduled event the Worker cannot service. Remove the trigger before deploy (the unmerged retention work moves scheduling to a separate Cron Worker), or add a handler.
  5. No route or custom domain is configured; add one for `www.murikah.com` (keep `SITE_URL` in `src/site.config.ts`, `site` in `astro.config.ts`, and the `Sitemap:` line in `public/robots.txt` in sync, all currently `https://www.murikah.com`).
  6. Turso secrets must be set for the contact and subscribe endpoints to persist (the site still builds and serves without them).
- **Not blocking the build, but do before launch:** rotate the Turso auth token (it was shared out of band during setup and is intended to be rotated; it is read-write), then update local `.dev.vars` and the Cloudflare secret. Replace the legal and contact placeholders (below). Verify the Resend sender domain if email is enabled.

---

## Open questions and placeholders

Unfinished or to-confirm items found on `main`:

- **README is out of date relative to the merged content.** `README.md` still describes the repository as "the framework (Build Prompt 1)" with "final marketing copy and the interactive Labs demos out of scope" and lists `content/insights/ MDX guides (one example)`. In fact `main` carries final copy in `src/site.config.ts` and five guides. The README should be refreshed to match.
- **Labs is a stub; assistant and admin are absent on `main`.** The real Labs demos, the AI assistant, the cron/retention Worker, and the reworked DB tooling are on unmerged feature branches (see "Built but unmerged feature branches"). Decide whether to merge them before launch or ship the marketing site first.
- **`{{PLACEHOLDER}}` tokens to resolve before launch** (the voice convention marks unverified specifics):
  - `src/site.config.ts`: `legalName` (`{{LEGAL: confirm the registered legal entity name}}`), `email` (`{{CONTACT: confirm the final public address}}`), `twitter` handle and social profile URLs (`{{SOCIAL: ...}}`).
  - `src/pages/privacy.astro` and `src/pages/terms.astro`: marked `{{LEGAL REVIEW REQUIRED}}` with several `{{LEGAL: ...}}` tokens (dates, retention periods, processors, cookie/analytics tooling, ODPC registration number, liability wording). Plain-English templates pending legal review.
  - `src/pages/audit-os.astro`: `{{DATA: confirm hosting region and data-residency commitments before launch}}`.
  - `src/pages/academy.astro`: `{{ACADEMY: confirm upcoming dates}}`.
  - `src/pages/insights/index.astro`: `{{ASSET: final ISO 42001 readiness checklist PDF to add (R2)}}`.
  - `db/seed.ts`: the sample lead message is marked `[placeholder]` (development data only).
- **Infrastructure placeholders:** `CACHE` KV id (`REPLACE_WITH_KV_NAMESPACE_ID`) in `wrangler.jsonc`; the placeholder cron trigger with no handler; the adapter-injected `SESSION` KV binding; the R2 bucket and a custom domain to create.

```

```
