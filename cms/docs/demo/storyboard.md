# Hass CMS — 60-second overview (storyboard & designed walkthrough)

This is the shot list for the 60-second overview video and, until the video is
recorded from the running system, the designed-walkthrough fallback. It is
generated from the same `STORYBOARD` in `cms/scripts/routes.mjs` that the
recorder walks, so the written walkthrough and the video can never drift.

The video is recorded from the **real running app** against the **seeded
non-production database** — no mock-ups. The recorder signs in with the demo
credentials (`admin@hasspetroleum.com` for staff, `achieng@nairobilogistics.co.ke`
for the portal; both `HassDemo1!`, non-production demo credentials).

## Shots (≈60s)

| #   | Time | Who    | Screen           | What it shows                                    |
| --- | ---- | ------ | ---------------- | ------------------------------------------------ |
| 1   | 6s   | Staff  | `/`              | Sign in — the branded staff dashboard            |
| 2   | 6s   | Staff  | `/customers`     | Customers: the account base across affiliates    |
| 3   | 5s   | Staff  | `/customers/:id` | A customer, its credit and its contacts          |
| 4   | 6s   | Staff  | `/orders`        | Orders with status and payment state             |
| 5   | 5s   | Staff  | `/orders/:id`    | An order and its lines                           |
| 6   | 6s   | Staff  | `/invoices`      | Invoices, due dates and ETIMS                    |
| 7   | 5s   | Staff  | `/payments`      | Proof-of-payment uploads to review and match     |
| 8   | 5s   | Staff  | `/tickets`       | Support tickets, priority and SLA                |
| 9   | 6s   | Staff  | `/analytics`     | Analytics: revenue by month and the order funnel |
| 10  | 5s   | Portal | `/portal`        | The customer portal home, scoped to one account  |
| 11  | 5s   | Portal | `/portal/orders` | A customer tracks their own orders               |

Total dwell ≈ 60s, plus sign-in and navigation transitions.

## How the video is produced

Both the crawl and the recorder need a running CMS app pointed at the seeded
staging database (the Worker `@libsql/client/web` build cannot open a local
`file:` database, so a staging Turso HTTP endpoint is required), and the
`playwright` package:

```bash
# 1. Point at the staging Turso endpoint (staging creds, never production).
export CMS_DB_URL='libsql://<staging-host>.turso.io'
export CMS_DB_AUTH_TOKEN='<staging-token>'
pnpm cms:db:apply && pnpm cms:db:seed        # schema + deterministic demo data

# 2. Certify every page renders (fails on any 500 or error boundary).
export BASE_URL='https://<staging-cms-host>'
pnpm add -D playwright                        # browser is pre-provisioned
pnpm cms:crawl

# 3. Record the walkthrough once the crawl is green.
pnpm cms:demo:record                          # writes cms/docs/demo/hass-cms-overview.webm
```

The recorder emits `.webm`; transcode to `.mp4` with ffmpeg if a specific
container is needed (the command is printed at the end of the run).

## Status

- [x] Storyboard designed and wired to the recorder (`STORYBOARD`).
- [x] Crawl and recorder staged (`cms/scripts/crawl.mjs`, `record-demo.mjs`).
- [x] Route coverage guarded by a test so the walkthrough stays complete
      (`cms/test/routes.test.ts`).
- [ ] Crawl run green against staging (awaits the staging Turso endpoint).
- [ ] Video recorded and committed to `cms/docs/demo/hass-cms-overview.webm`.
