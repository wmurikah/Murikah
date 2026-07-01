# Murikah

> **Assurance. Systems. Intelligence.**
> Pronounced _moo-REE-kah_ (rhymes with Eureka).

Marketing website for **Murikah**, an AI-native assurance and governance company
helping organisations run, prove, and continuously improve their internal
audit and their AI and system governance.

This repository is the **framework** (Build Prompt 1): project setup, design
system, layout/navigation, all routes, the component library, the SEO and
AI-discoverability foundation, and the data/deploy plumbing. **Final marketing
copy and the interactive Labs demos are out of scope** and arrive in later
prompts, placeholder copy is clearly marked with `[placeholder]`.

---

## Tech stack

| Concern       | Choice                                                                  |
| ------------- | ----------------------------------------------------------------------- |
| Framework     | [Astro](https://astro.build) v7 (TypeScript, strict)                    |
| Platform      | Cloudflare **Workers** + static assets (`@astrojs/cloudflare` v14)      |
| Styling       | Tailwind CSS v4 via `@tailwindcss/vite` + design tokens in `@theme`     |
| Content       | `@astrojs/mdx` content collection · `@astrojs/rss` · `@astrojs/sitemap` |
| Interactivity | `@astrojs/react` islands (Labs sandbox, stubbed for now)                |
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

| Variable               | Required | Purpose                                             |
| ---------------------- | -------- | --------------------------------------------------- |
| `TURSO_DATABASE_URL`   | yes\*    | libSQL connection URL (`libsql://…`)                |
| `TURSO_AUTH_TOKEN`     | yes\*    | Turso auth token                                    |
| `RESEND_API_KEY`       | no       | Resend key. If unset, email is **skipped** (no-op). |
| `CONTACT_NOTIFY_EMAIL` | no       | Recipient for contact notifications                 |
| `RESEND_FROM_EMAIL`    | no       | Verified sender address                             |
| `PUBLIC_SITE_URL`      | no       | Canonical/OG origin for non-production environments |

\* Required for the contact/subscribe endpoints to persist data. The site
**builds and runs without them**; the endpoints degrade gracefully and return a
clear error.

## Database (Turso)

1. Create a database and capture its URL + token:

   ```bash
   turso db create murikah
   turso db show murikah --url
   turso db tokens create murikah
   ```

2. Put the URL/token in `.dev.vars` (or your environment).

3. Apply the schema and (optionally) seed sample data:

   ```bash
   pnpm db:apply   # runs db/schema.sql against TURSO_DATABASE_URL
   pnpm db:seed    # inserts a couple of sample rows (dev only)
   ```

   Both scripts auto-load `.dev.vars` if present. Alternatively, apply the schema
   with the Turso CLI: `turso db shell murikah < db/schema.sql`.

Tables: `leads` (contact submissions), `subscribers` (newsletter), and a
forward-looking `demo_sessions` placeholder for future Labs sandboxes.

## Deploy (Cloudflare Workers)

The site deploys as a single Cloudflare Worker that serves the prerendered pages
as static assets, plus the two API endpoints. On `main` the configuration is
intentionally minimal: it needs no pre-created KV namespace, no R2 bucket, and no
cron trigger, so it can go straight to a free `workers.dev` preview. The KV
cache, the R2 bucket, and the scheduled retention all return with the feature
branches that use them.

The deploy must use the config the adapter generates at
`dist/server/wrangler.json` (it carries the correct entrypoint and the
`../client` assets directory), not the root `wrangler.jsonc`:

```bash
pnpm build
npx wrangler deploy --config dist/server/wrangler.json
```

(`pnpm cf:deploy` runs both of those in one step.)

If you want the contact and subscribe forms to actually save submissions, set the
database secrets against the generated config. They are optional: without them the
forms still work and fail gracefully.

```bash
npx wrangler secret put TURSO_DATABASE_URL  --config dist/server/wrangler.json
npx wrangler secret put TURSO_AUTH_TOKEN    --config dist/server/wrangler.json
# Optional, only if contact notifications should be emailed:
npx wrangler secret put RESEND_API_KEY      --config dist/server/wrangler.json
npx wrangler secret put CONTACT_NOTIFY_EMAIL --config dist/server/wrangler.json
npx wrangler secret put RESEND_FROM_EMAIL   --config dist/server/wrangler.json
```

### Deploy a free preview

A plain, no-cost first deploy to a `workers.dev` address, with no custom domain:

1. In the Cloudflare dashboard, open **Workers and Pages**, choose **Create**,
   and **import your repository from GitHub** (connect GitHub first and pick
   `wmurikah/Murikah` if it is not already connected).
2. Set the **build command** to `pnpm build`.
3. Set the **deploy command** to
   `npx wrangler deploy --config dist/server/wrangler.json`. This matters: the
   deploy has to use the config the adapter generates, not the root
   `wrangler.jsonc`.
4. Add one **variable** so the pages show the correct canonical and social-share
   URLs: `PUBLIC_SITE_URL`. You can leave the committed default for the first
   deploy and update it to your preview address afterwards (see step 6).
5. The contact and subscribe forms only need a database **if you want them to
   save**. They load and submit fine without one. To turn on saving, add these as
   **secrets** (not plain variables): `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`.
   To also email the contact notification, add the optional `RESEND_API_KEY`,
   `CONTACT_NOTIFY_EMAIL`, and `RESEND_FROM_EMAIL`.
6. On the first deploy, Cloudflare asks you to pick a free `workers.dev`
   **subdomain**. After that the site is live at
   `murikah-web.<your-subdomain>.workers.dev`, with no custom domain required. If
   you set `PUBLIC_SITE_URL` to that address and redeploy, the canonical and
   social-share tags will match the live preview.

Nothing else needs to exist in your Cloudflare account for the preview: there is
no KV namespace, R2 bucket, or cron trigger to create.

If your final domain differs from `https://murikah.com`, update the canonical
URL in `SITE_URL` (`src/site.config.ts`) and `site` (`astro.config.ts`), which
are kept in sync, plus the `Sitemap:` line in `public/robots.txt`.

## Scripts

| Script            | Description                                         |
| ----------------- | --------------------------------------------------- |
| `pnpm dev`        | Astro dev server                                    |
| `pnpm build`      | `astro check` (type-check) + `astro build`          |
| `pnpm preview`    | Preview the static build                            |
| `pnpm cf:dev`     | Build + `wrangler dev` on the Workers runtime       |
| `pnpm cf:deploy`  | Build + deploy to Cloudflare                        |
| `pnpm cf:typegen` | Generate Worker binding types from `wrangler.jsonc` |
| `pnpm lint`       | ESLint                                              |
| `pnpm format`     | Prettier (write)                                    |
| `pnpm db:apply`   | Apply `db/schema.sql` to Turso                      |
| `pnpm db:seed`    | Seed sample rows                                    |

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
- JSON-LD: `Organization` / `ProfessionalService` on every page, `Service` per
  line, `FAQPage` on FAQ pages and guides, `BreadcrumbList`, and `BlogPosting`
  (authored by the Organization, Murikah) on guides.
- `public/robots.txt` (allows Googlebot, Bingbot, GPTBot, OAI-SearchBot,
  PerplexityBot, Google-Extended), `sitemap-index.xml` (generated, with
  priorities), `rss.xml`, and `public/llms.txt`.
- Guide convention: answer-first opening, semantic H2/H3 mirroring real
  questions, and an FAQ block, encoded in `InsightLayout` and the guides.

### Submit the sitemap after launch

Once the site is live, submit `https://murikah.com/sitemap-index.xml` to
both [Google Search Console](https://search.google.com/search-console) and
[Bing Webmaster Tools](https://www.bing.com/webmasters). Bing matters beyond
Bing itself, because ChatGPT search draws on the Bing index, so submitting there
helps the site surface in AI answers as well as classic search.

## License

MIT © Murikah, see [LICENSE](./LICENSE).
