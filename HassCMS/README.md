# HassCMS

Hass Petroleum's customer operations system. This directory owns the CMS routes, components, layouts, business logic, database scripts and SQL documentation, tests, assets, styles, runtime bindings, package manifest and lockfile.

CMS does not import source or dependencies from Tutor, GRC, Engineering Rhythm or the marketing application. Small generic helpers and design styles were copied here so the other applications retain their existing versions. The spreadsheet package `xlsx` is declared only by HassCMS.

## Develop independently

Use Node 22.22.2 and pnpm 10.33.0. From this directory:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm cf:dev
```

The build runs Astro's type check and generates a standalone Cloudflare Worker in `dist/server/wrangler.json`. The Worker serves CMS at `cms.murikah.com`, `cms.localhost` and local loopback hosts. It rejects the other product hosts. For local verification:

```sh
curl --fail -H 'Host: cms.murikah.com' http://127.0.0.1:8787/login
```

Copy `.dev.vars.example` to `.dev.vars` and supply CMS-specific credentials securely for real database/authentication workflows. Do not reuse other products' databases or session secrets. Tests use temporary SQLite-backed Turso emulators; no production migration, seed, deployment or credential change is part of this extraction.

## Deployment

This package is now independent. The old root compatibility links have been removed. Database tooling lives in `db/`; SQL documentation remains in `docs/cms/`. Deploy `hass-cms` and configure its existing CMS-specific credentials before assigning the production CMS hostname. Follow the repository README's deployment transition sequence.

## Known baseline

The original CMS suite has existing UI/design assertions and an unregistered schema-script failure. Standalone validation: 1,003 passed, 18 failed, zero skipped. The three additional isolation checks pass. The combined suite retains its separate cross-product and marketing assertions. See `docs/cms/` for the complete SQL, security, migration and product runbooks.
