# Murikah

**Assurance. Systems. Intelligence.**

Murikah is an MIT-licensed software monorepo for operational assurance, governance and workflow tools. It brings together four working product areas: customer operations, audit and risk, engineering maintenance, and AI-assisted learning.

The repository contains the applications, shared platform code, database schemas, tests, deployment configuration and product documentation used to build and operate the Murikah platform. It is actively maintained and is intended to be useful both as deployable software and as a reference implementation for teams building practical governance and operational systems.


## What is in this repository

| Product | Purpose | Main areas |
| --- | --- | --- |
| **CMS** | Customer operations | Leads, customer accounts, orders, service requests and connected fulfilment workflows |
| **Assurance OS** | Internal audit and risk | Audit planning, evidence, work papers, findings, action plans, remediation and reporting |
| **ENGR / Engineering Rhythm** | Maintenance operations | Assets, maintenance schedules, work orders, technician assignment and operating follow-up |
| **Tutor** | AI-assisted learning | Learning, research, co-writing and diagram design in an isolated AI workspace |

Live product entry points are maintained at:

- `https://cms.murikah.com`
- `https://grc.murikah.com`
- `https://engr.murikah.com`
- `https://tutor.murikah.com`

The public site and product directory are served from `https://murikah.com`.

## Why Murikah exists

Operational assurance work often lives across spreadsheets, email, document folders and disconnected line-of-business tools. Murikah is an attempt to make those workflows explicit, testable and maintainable in software.

The project focuses on problems such as:

- linking audit observations to owned and dated remediation actions;
- preserving traceable evidence and approval workflows;
- connecting customer activity to fulfilment and service operations;
- managing maintenance work from request through assignment and follow-up;
- making AI-assisted learning useful without coupling it to the rest of the platform;
- running these systems on infrastructure that can be tested, deployed and reviewed as code.

The project is still evolving. Public adoption is not represented here as larger than it is; the repository is published so its architecture, implementation choices and maintenance work can be inspected directly.

## Architecture

Murikah is organised as a monorepo with two deliberately different application boundaries.

### Core Murikah applications

The public site, CMS, GRC and ENGR share the main TypeScript/Astro codebase and Cloudflare deployment model. Host-based routing keeps the applications separated while allowing them to reuse selected platform primitives.

Core technologies include:

- **Astro 7** and **TypeScript**
- **React** islands where client interactivity is needed
- **Tailwind CSS 4**
- **Cloudflare Workers**
- **Turso/libSQL** for application data
- **GitHub Actions** for CI and deployment checks
- **ESLint**, **Prettier** and automated tests

### Murikah Tutor

Tutor is intentionally isolated from the core Astro applications. It is based on the open-source [HKUDS/DeepTutor](https://github.com/HKUDS/DeepTutor) project and currently consumes a pinned upstream commit rather than vendoring the full upstream repository.

Murikah adds its own deployment, access, persistence, provider failover, guest-workspace and presentation layers while retaining compatibility with DeepTutor internals where practical.

The upstream source is materialised locally with:

```bash
cd tutor
./scripts/materialize.sh
```

The generated checkout is written to `tutor/.vendor/DeepTutor` and is ignored by Git. See [`tutor/README.md`](./tutor/README.md) and [`tutor/source/README.md`](./tutor/source/README.md) for the source and compatibility model.

DeepTutor is distributed under the Apache License 2.0. Its upstream licence and notices remain applicable to the materialised upstream project and derivative deployment as required.

## Repository map

```text
.
├── src/                  # Shared Astro application, routes, components and platform code
│   ├── components/       # Shared and product-specific UI components
│   ├── layouts/          # Site and application layouts
│   ├── lib/              # Application logic, auth, routing and integrations
│   └── pages/            # Public site plus CMS, GRC and ENGR routes
├── cms/                  # CMS database and supporting application assets
│   └── db/
├── grc/                  # GRC database, documentation and tests
│   ├── db/
│   ├── docs/
│   └── test/
├── engr/                 # Engineering Rhythm database and tests
│   ├── db/
│   └── test/
├── tutor/                # Isolated Tutor source, deployment, persistence and tests
│   ├── cloudflare/
│   ├── scripts/
│   ├── source/
│   └── tests/
├── test/                 # Cross-application and CMS test suites
├── db/                   # Shared/public-site database tooling
├── docs/                 # Architecture, product and implementation documentation
└── .github/              # CI and repository automation
```

## Getting started

### Prerequisites

- Node.js **22.12+**
- pnpm **9+**
- A Cloudflare account for Worker deployment
- A Turso/libSQL database for workflows that persist data

Clone the repository and install dependencies:

```bash
git clone https://github.com/wmurikah/Murikah.git
cd Murikah
pnpm install
cp .dev.vars.example .dev.vars
pnpm dev
```

The local Astro development server runs at `http://localhost:4321` by default.

Environment variables are documented in `.dev.vars.example`. Keep secrets in local or platform-managed secret stores; do not commit them.

## Development commands

```bash
pnpm dev            # local Astro development server
pnpm build          # Astro type-check and production build
pnpm test           # core application test suites
pnpm lint           # ESLint
pnpm format:check   # Prettier verification
pnpm cf:dev         # build and run on the Cloudflare Worker runtime
pnpm cf:deploy      # build and deploy using the generated Worker config
```

Database scripts include:

```bash
pnpm db:apply
pnpm db:seed
pnpm db:cms:bootstrap-admin
pnpm db:engr:apply
pnpm db:engr:seed
pnpm db:engr:bootstrap
pnpm db:engr:seed-demo
```

Product-specific deployment and migration instructions live with the relevant application rather than being duplicated here.

## Testing and maintenance

Changes are expected to keep application boundaries intact and include appropriate validation. Depending on the area changed, maintenance work includes:

- TypeScript and Astro checks;
- unit and integration tests;
- product-specific persistence and migration checks;
- Cloudflare deployment preflights;
- Tutor runtime and image-build regression tests;
- accessibility and browser behaviour checks for user-facing changes.

The repository uses pull requests for feature, maintenance and deployment changes so implementation decisions and validation remain reviewable in Git history.

## Contributing

Issues and pull requests are welcome.

Before opening a pull request:

1. keep the affected product boundary clear;
2. avoid introducing secrets or environment-specific credentials;
3. add or update tests where behaviour changes;
4. run the relevant lint, format, test and build checks;
5. document deployment or migration implications when applicable.

For Tutor changes, preserve the upstream compatibility boundary documented under `tutor/` unless the change intentionally revises that architecture.

A more detailed contributor guide will be maintained as the external contributor workflow develops.

## Security

Please do not publish credentials, tokens, private customer data or exploitable production details in issues or pull requests. Security-sensitive reports should be handled privately with the project maintainer rather than disclosed publicly before remediation.

## Project status

Murikah is under active development. Interfaces, schemas and deployment patterns may continue to change as the products mature. The repository should therefore be treated as evolving software rather than a frozen framework or finished reference architecture.

The maintainer welcomes review of architecture, tests, security controls, documentation and product workflows, including contributions that make the project easier for other teams to understand, deploy or extend.

## Licence

Unless a subcomponent states otherwise, Murikah-authored code in this repository is licensed under the [MIT License](./LICENSE).

Third-party and upstream components retain their own licences. In particular, Murikah Tutor builds on [HKUDS/DeepTutor](https://github.com/HKUDS/DeepTutor), which is distributed under the Apache License 2.0; applicable upstream notices and licence terms must be preserved.
