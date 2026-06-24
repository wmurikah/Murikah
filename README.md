# Murikah

> **Assurance. Systems. Intelligence.**
> Pronounced _moo-REE-kah_ (rhymes with Eureka).

Marketing website for **Murikah**, an AI-native assurance and governance company
helping African organisations run, prove, and continuously improve their internal
audit and their AI and system governance.

The site includes the full marketing pages and final copy, the SEO and
AI-discoverability layer, the Insights guides, an interactive **Labs sandbox**,
and a site-wide **AI assistant**. A few values are clearly marked with
`{{PLACEHOLDER}}` tokens pending final confirmation before launch.

---

## Tech stack

| Concern       | Choice                                                                  |
| ------------- | ----------------------------------------------------------------------- |
| Framework     | [Astro](https://astro.build) v7 (TypeScript, strict)                    |
| Platform      | Cloudflare **Workers** + static assets (`@astrojs/cloudflare` v14)      |
| Styling       | Tailwind CSS v4 via `@tailwindcss/vite` + design tokens in `@theme`     |
| Content       | `@astrojs/mdx` content collection · `@astrojs/rss` · `@astrojs/sitemap` |
| Interactivity | `@astrojs/react` islands (Labs sandbox + AI assistant)                  |
| Database      | [Turso](https://turso.tech) (libSQL) via `@libsql/client/web`           |
| Email         | [Resend](https://resend.com) (behind an env check; optional)            |
| Fonts         | Self-hosted via Fontsource (Outfit + Fraunces), preloaded               |
| Tooling       | pnpm · ESLint (flat) · Prettier · GitHub Actions CI                     |

Marketing pages are **prerendered** to static HTML and ship **~1 KB of gzipped
JS** (the accessible nav only). Only the API endpoints run on-demand in the Worker.

## Prerequisites

- **Node 22.12+** (Astro 7 requirement) and **pnpm 9+**
- A [Turso](https://turso.tech) database (for the contact/subscribe endpoints)
- A [Cloudflare](https://cloudflare.com) account (to deploy)
- Optionally a [Resend](https://resend.com) API key (for transactional email)

## Quick start

```bash
pnpm install
cp .dev.vars.example .dev.vars   # fill in your values (gitignored)
pnpm dev                         # http://localhost:4321
```

`pnpm dev` runs Astro's dev server. The Cloudflare adapter (v14) integrates the
Cloudflare Vite plugin, so KV/R2/vars from `wrangler.jsonc` + `.dev.vars` are
available on the Workers runtime during dev.

### Run on the Workers runtime (`wrangler dev`)

```bash
pnpm cf:dev    # astro build && wrangler dev --config dist/server/wrangler.json
```

The adapter generates the deployable Worker config at
`dist/server/wrangler.json` during the build (with the correct `main`, the
`../client` assets directory, and all your bindings), so `wrangler dev`/`deploy`
point at that generated file, not the root `wrangler.jsonc` (which is the
human-edited **source** of bindings).

## Environment variables

Set locally in `.dev.vars` (see `.dev.vars.example`); in production set them as
Cloudflare secrets. **Never commit secrets.**

| Variable               | Required | Purpose                                                               |
| ---------------------- | -------- | --------------------------------------------------------------------- |
| `TURSO_DATABASE_URL`   | yes\*    | libSQL connection URL (`libsql://…`)                                  |
| `TURSO_AUTH_TOKEN`     | yes\*    | Turso auth token                                                      |
| `RESEND_API_KEY`       | no       | Resend key. If unset, email is **skipped** (no-op).                   |
| `CONTACT_NOTIFY_EMAIL` | no       | Recipient for contact notifications                                   |
| `RESEND_FROM_EMAIL`    | no       | Verified sender address                                               |
| `PUBLIC_SITE_URL`      | no       | Canonical/OG origin for non-production environments                   |
| `AI_PROVIDER`          | no       | `anthropic` (default) or `workers-ai`                                 |
| `ANTHROPIC_API_KEY`    | no       | Assistant model key. If unset, the assistant returns a calm fallback. |
| `AI_MODEL`             | no       | Override the chat model id                                            |
| `DEMO_HASH_SALT`       | no       | Salt for hashing demo-session IPs (set in prod)                       |
| `CRON_SECRET`          | no       | Shared secret for `/api/cron/sweep` and the Cron Worker               |

\* Required for the contact/subscribe endpoints and demo logging to persist
data. The site **builds and runs without any of these**; the demos compute
server-side and the assistant degrades to a calm fallback, so nothing breaks
when a key is absent.

## Database (Turso)

The database scripts run through `tsx` and resolve credentials the same way the
app does: **the shell environment is read first, then `.dev.vars` as a fallback**
(an existing env value always wins). No Turso CLI is required, and you never need
to `export` anything by hand.

1. Put your two Turso values in `.dev.vars` (copy it from `.dev.vars.example`):

   ```
   TURSO_DATABASE_URL=libsql://your-database-name.turso.io
   TURSO_AUTH_TOKEN=your-turso-auth-token
   ```

   `.dev.vars` is git-ignored and must never be committed. The same two values
   go on the deployed Cloudflare Worker: `TURSO_DATABASE_URL` as a plain
   variable and `TURSO_AUTH_TOKEN` as a Secret. The token is read-write and
   meant to be rotated; when you rotate it, update `.dev.vars` and the Cloudflare
   secret. No code changes are needed.

2. Create the tables and load sample data:

   ```bash
   pnpm db:apply          # create the tables from db/schema.sql (idempotent)
   pnpm db:seed           # load development sample data
   pnpm db:setup          # do both, in order, for a fresh database
   pnpm db:seed:content   # full content seed (added by Build Prompt 4)
   ```

   `pnpm db:reset` is destructive (drops and recreates every table) and refuses
   to run without an explicit confirmation: `CONFIRM=1 pnpm db:reset`.

   Note: run these through pnpm (they use `tsx`); a bare `node db/seed.ts` is
   not expected to work.

### CI and the shell

Because the scripts read the environment first, the same commands work in CI
with no `.dev.vars` present: in GitHub Actions, set `TURSO_DATABASE_URL` and
`TURSO_AUTH_TOKEN` as repository secrets and the scripts pick them up. Locally,
`.dev.vars` provides them. A missing variable produces a clear, specific error
that names the variable and `.dev.vars`, and exits non-zero.

### Turso CLI alternative

If you prefer the CLI, applying the schema directly still works:
`turso db shell murikah < db/schema.sql`. The pnpm scripts do not depend on it.

> **Caution:** never paste the TypeScript seed (`db/seed.ts`) into the Turso web
> console or Drizzle Studio. Those accept SQL only. Use `pnpm db:seed`.

Tables: `leads` (contact submissions), `subscribers` (newsletter), the demo
sandbox tables (`demo_sessions`, `demo_invoices`, `demo_workflow_runs`,
`demo_crm_*`, and the read-only Audit OS seed `demo_findings`/`demo_workpapers`/
`demo_metrics`/`demo_board_items`), and the assistant audit log
(`assistant_conversations`, `assistant_messages`).

## Deploy (Cloudflare Workers)

1. **Create the bindings** and paste the KV id into `wrangler.jsonc`:

   ```bash
   pnpm exec wrangler kv namespace create CACHE     # paste id → kv_namespaces[].id
   pnpm exec wrangler r2 bucket create murikah-assets
   ```

2. **Set production secrets** (against the generated config):

   ```bash
   pnpm exec wrangler secret put TURSO_DATABASE_URL  --config dist/server/wrangler.json
   pnpm exec wrangler secret put TURSO_AUTH_TOKEN    --config dist/server/wrangler.json
   pnpm exec wrangler secret put RESEND_API_KEY      --config dist/server/wrangler.json
   pnpm exec wrangler secret put CONTACT_NOTIFY_EMAIL --config dist/server/wrangler.json
   pnpm exec wrangler secret put RESEND_FROM_EMAIL   --config dist/server/wrangler.json
   ```

3. **Deploy:**

   ```bash
   pnpm cf:deploy   # astro build && wrangler deploy --config dist/server/wrangler.json
   ```

Update the canonical URL in **two** places if your domain differs from
`https://www.murikah.com`: `SITE_URL` in `src/site.config.ts` and `site` in
`astro.config.ts` (kept intentionally in sync), plus the `Sitemap:` line in
`public/robots.txt`.

## Scripts

| Script                | Description                                              |
| --------------------- | -------------------------------------------------------- |
| `pnpm dev`            | Astro dev server                                         |
| `pnpm build`          | `astro check` (type-check) + `astro build`               |
| `pnpm preview`        | Preview the static build                                 |
| `pnpm cf:dev`         | Build + `wrangler dev` on the Workers runtime            |
| `pnpm cf:deploy`      | Build + deploy the site to Cloudflare                    |
| `pnpm cf:deploy:cron` | Deploy the companion Cron Worker (`wrangler.cron.jsonc`) |
| `pnpm cf:typegen`     | Generate Worker binding types from `wrangler.jsonc`      |
| `pnpm lint`           | ESLint                                                   |
| `pnpm format`         | Prettier (write)                                         |
| `pnpm db:apply`       | Apply `db/schema.sql` to Turso                           |
| `pnpm db:seed`        | Seed sample rows + the Audit OS sandbox sample data      |

## Project structure

```
src/
  components/
    primitives/      Section, Container, Button, Card, FeatureGrid, Stat,
                     CtaSection, Faq, Prose, Breadcrumb
    schema/          Organization, Service, FaqPage (JSON-LD emitters)
    islands/         SandboxDemo.tsx (stubbed React island for /labs)
    Header / Footer / Nav / Logo / Seo / DemoEmbed
  layouts/           BaseLayout, ServiceLayout, InsightLayout
  pages/             home, 6 service lines, about, contact, insights,
                     privacy, terms, 404, rss.xml, api/{contact,subscribe}
  content/insights/  MDX guides (one example)
  lib/               db, validation, rate-limit, email, http, format, types
  styles/            tokens.css (@theme), global.css
  site.config.ts     single source of truth (nav, services, SEO, org schema)
  content.config.ts  insights collection schema
db/                  schema.sql, apply.ts, seed.ts
public/              robots.txt, llms.txt, favicon.svg, og-default.png, .assetsignore
```

## Design system

Tokens live in `src/styles/tokens.css` inside a Tailwind v4 `@theme` block, so
every token is available **both** as a utility (`bg-navy`, `text-gold`,
`font-serif`, `text-display`) and as a raw var (`var(--color-navy)`).

- **Brand:** navy `#0B1733` (authority), gold `#C9A227` (the _single_ accent, used only for the one primary action, per Von Restorff), blue `#1E4FA3`
  (interactive). Warm paper background, ink/slate text.
- **Type:** Outfit (UI + headings) and Fraunces (the hero headline only),
  self-hosted and preloaded; a ~1.2 modular scale with tight tracking on
  display sizes; body measure capped at 68ch.
- **Status colours** (RAG) are reserved for product/status only (here: the one
  sanctioned marketing use is contact-form validation feedback).

The build is grounded in usability research, Jakob, Hick, Fitts, Miller,
Gestalt, Von Restorff, Doherty, Tesler, serial-position and peak-end, with
code comments marking non-obvious applications.

## Accessibility & performance

- WCAG 2.2 AA intent: semantic landmarks, a skip link, visible `:focus-visible`
  styles everywhere, full keyboard operation of the nav and mobile menu (with
  focus trap + Escape), labelled form fields with clear errors, correct heading
  order (one `h1` per page), and `prefers-reduced-motion` support.
- Performance: prerendered HTML, ~1 KB gz JS on marketing pages, preloaded
  fonts (`font-display: swap`), reserved image dimensions, modern formats.
- **Verify before launch:** run Lighthouse (mobile) and `axe` against a deployed
  preview, and replace placeholder copy and the legal pages with reviewed text.

## SEO & AI discoverability

- Per-page title, meta description, canonical, Open Graph + Twitter tags, and a
  default share image (`/og-default.png`).
- JSON-LD: `Organization` / `ProfessionalService` with a linked founder
  `Person` on every page, `Service` per line, `FAQPage` on FAQ pages and guides,
  `BreadcrumbList`, and `BlogPosting` on guides.
- `public/robots.txt` (allows Googlebot, Bingbot, GPTBot, OAI-SearchBot,
  PerplexityBot, Google-Extended), `sitemap-index.xml` (generated, with
  priorities), `rss.xml`, and `public/llms.txt`.
- Guide convention: answer-first opening, semantic H2/H3 mirroring real
  questions, and an FAQ block, encoded in `InsightLayout` and the guides.

### Submit the sitemap after launch

Once the site is live, submit `https://www.murikah.com/sitemap-index.xml` to
both [Google Search Console](https://search.google.com/search-console) and
[Bing Webmaster Tools](https://www.bing.com/webmasters). Bing matters beyond
Bing itself, because ChatGPT search draws on the Bing index, so submitting there
helps the site surface in AI answers as well as classic search.

## Labs sandbox and AI assistant

`/labs` hosts a tabbed, interactive sandbox, and a floating AI assistant is
available site-wide. Both are built to be visibly safe for an assurance and
data-protection brand.

### The demos

- **Audit OS sandbox** (read-only): a dashboard, a filterable findings list with
  a detail drawer and work paper, and a board-pack preview, all from seeded
  sample data.
- **Document extraction**: pick a sample invoice and extract its fields to a CSV.
  Optional upload (PDF/PNG/JPEG, under 2MB) is processed transiently and never
  stored; it uses the model when configured, with the output validated against a
  strict schema before display. Sample invoices work with no key.
- **Workflow engine**: compose a trigger to condition to action flow from a
  whitelist, run it against a fixed sample event, and see an audit log.
- **Mini-CRM**: a seeded pipeline where marking a deal Won fires a simulated
  automation and an activity log.

### Safety and isolation model (for maintainers)

This is enforced by shared helpers in `src/lib/demo/` so every demo and the
assistant get the same guarantees.

- **Sessions** (`session.ts`, `guard.ts`): an anonymous UUID in an httpOnly,
  SameSite=Lax cookie (`mk_demo`, Secure in production, 24h). The
  `demo_sessions` row stores a salted **hash** of the IP and a truncated
  user-agent, never a raw IP. Every write is scoped to the session.
- **Rate limits** (`config.ts` + KV): demos 30 per 10 minutes, the assistant 20
  per hour, uploads 10 per hour. A breach returns a calm 429.
- **Auto-reset and retention**: the hourly Cron Worker calls `/api/cron/sweep`,
  which deletes demo data and sessions older than 24 hours and prunes assistant
  logs older than 30 days. Demos also compute server-side and deterministically,
  so they work even before Turso is configured (persistence is then skipped).
- **No real data**: every surface carries a "Demo environment. Sample data only.
  Resets automatically." badge. Uploads are transient. The assistant is told not
  to solicit or retain sensitive data.
- **No arbitrary code**: the workflow demo only interprets whitelisted blocks
  server-side. Visitor-supplied code is never executed. (If that is ever wanted,
  the only acceptable path is Cloudflare's Sandbox SDK with Dynamic Workers in
  isolated V8 isolates; deferred, not built.)
- **Secrets**: the model key lives only in a Cloudflare secret, is read
  server-side in `api/ai/assistant.ts`, and never reaches the client, responses
  or logs.

### The AI assistant

A provider-agnostic adapter (`src/lib/ai/`) defaults to **Anthropic** (set
`ANTHROPIC_API_KEY`), with a `workers-ai` seam selected by `AI_PROVIDER`. The
model id lives in `src/lib/ai/config.ts`. The assistant is grounded in a curated
brief built from `site.config` (no vector database; Cloudflare Vectorize is a
deferred option). It streams over Server-Sent Events and is guardrailed to stay
on topic, never fabricate, never give definitive legal or audit advice, resist
prompt injection, and offer the demo as the next step. With no key set, it
returns a calm fallback so nothing breaks.

### Endpoints (all `prerender = false`, all behind the guard)

`demo/auditos/{dashboard,findings,finding/[ref],board}`, `demo/labs/{extract,
workflow,crm}`, `ai/assistant` (SSE), and `cron/sweep` (secret-guarded).

### Deploy the retention sweep

The Astro adapter does not expose a `scheduled` export, so the sweep runs from a
small companion Cron Worker:

```bash
pnpm exec wrangler secret put CRON_SECRET                         # site Worker
pnpm exec wrangler secret put CRON_SECRET --config wrangler.cron.jsonc
pnpm cf:deploy:cron   # deploys workers/cron.ts on an hourly trigger
```

Set `SITE_URL` in `wrangler.cron.jsonc` to the deployed origin, and set
`DEMO_HASH_SALT` and (optionally) `ANTHROPIC_API_KEY` as site-Worker secrets.

## License

MIT © Murikah, see [LICENSE](./LICENSE).
