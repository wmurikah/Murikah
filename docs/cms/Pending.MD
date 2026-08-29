# Hass CMS — Pending after Apple-grade redesign

## Executive status

- **Phase 3 start commit:** `5095c8fd6d47f8443454afd9dcf9ad77939e9c52`
- **Phase 3 end commit:** `19dc1aa`
- **Date:** 2026-08-29
- **Overall implementation state:** Source implementation and Phase 3 consistency audit complete; acceptance awaits visual and manual evidence.
- **Visual validation state:** Pending. The required browser tooling is unavailable in this environment.
- **Build state:** PASS.
- **Test state:** PASS — 693/693 CMS tests and 49/49 design/UX tests.
- **Backend integrity state:** PASS — no frozen backend, domain, stack, schema, API, workflow, analytics, or tenant-isolation path changed.

## Pending summary

| ID    | Area                        | What remains                                                                                               | Why it remains                                                                            | Severity | Type                        | Evidence needed                                                                       | Recommended next action                                                                                        | Owner/dependency                        |
| ----- | --------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | -------- | --------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| P3-01 | Canonical visual acceptance | Review the 48-screen viewport matrix below for hierarchy, density, wrapping, and responsive composition.   | No compatible browser or Playwright driver is available.                                  | HIGH     | VISUAL_VALIDATION           | Reviewed screenshots at all required routes and viewports, with regressions recorded. | Run the existing real-worker screenshot harness in a browser-enabled CI or workstation and review every image. | Design QA + browser-enabled environment |
| P3-02 | Visual QA environment       | Supply a compatible Chromium binary and Playwright driver to the existing harness.                         | The execution environment has neither; the prior package request was blocked by HTTP 403. | HIGH     | ENVIRONMENT                 | Successful harness startup and canonical route capture.                               | Provision tooling outside the application dependency graph; do not add it to production dependencies.          | Build/CI platform owner                 |
| P3-03 | Manual accessibility        | Complete keyboard, screen-reader, focus-order, disclosure, overflow, and real-device checks listed below.  | Automated checks cannot establish the complete interaction experience.                    | HIGH     | MANUAL_ACCESSIBILITY_REVIEW | Signed manual checklist with browser, assistive technology, and device details.       | Test the seeded real-worker application after P3-02 is resolved.                                               | Accessibility reviewer                  |
| P3-04 | Deployment acceptance       | Confirm Cloudflare Worker rendering, fonts, assets, and no-layout-shift behavior in the deployed CMS host. | Local build and worker tests do not validate production delivery conditions.              | MEDIUM   | DEPLOYMENT_VALIDATION       | Staging deployment smoke test across internal and portal sessions.                    | Deploy the committed presentation build to staging and complete the canonical smoke test.                      | Deployment owner                        |
| P3-05 | Pull-request delivery       | Publish the committed Phase 3 branch as a reviewable pull request.                                         | This environment has no authenticated GitHub delivery capability.                         | LOW      | ENVIRONMENT                 | Pull-request URL containing commits `7396db4` and later.                              | Push `feat/cms-apple-grade-phase-3` and open the prepared review from an authenticated environment.            | Repository maintainer                   |

## Canonical screenshot matrix — 48 visual checks

Each cell requires a current screenshot and human review. None was captured in this environment.

| Experience               | 1440 × 900 | 1280 × 800 | 834 × 1194 | 390 × 844 |
| ------------------------ | ---------- | ---------- | ---------- | --------- |
| Login                    | Pending    | Pending    | Pending    | Pending   |
| Dashboard                | Pending    | Pending    | Pending    | Pending   |
| Customers                | Pending    | Pending    | Pending    | Pending   |
| Customer 360             | Pending    | Pending    | Pending    | Pending   |
| Leads                    | Pending    | Pending    | Pending    | Pending   |
| Opportunities / pipeline | Pending    | Pending    | Pending    | Pending   |
| Service                  | Pending    | Pending    | Pending    | Pending   |
| Sales Orders             | Pending    | Pending    | Pending    | Pending   |
| Purchase Orders          | Pending    | Pending    | Pending    | Pending   |
| Performance / SLA        | Pending    | Pending    | Pending    | Pending   |
| Administration           | Pending    | Pending    | Pending    | Pending   |
| Customer Portal          | Pending    | Pending    | Pending    | Pending   |

Review each image for primary-task clarity, one dominant action, scan order, alignment, density, long labels, empty/error states, status noise, clipping, horizontal overflow, and genuine mobile composition.

## Manual UX and accessibility checks

- Traverse the shell, local navigation, filter disclosures, results, pagination, and record overflow using only the keyboard.
- Confirm Escape closes filter and record-action disclosures and returns focus to their triggers.
- Spot-check landmarks, headings, table captions, mobile entity-row link names, status text, and unavailable-value names with a screen reader.
- Verify focus order and focus visibility in login errors, drawers, modals, Customer 360 More, portal More, and record action menus.
- Exercise remove-one filter chips, reset-all, browser Back, copied filter URLs, queue persistence, and List/Pipeline mode persistence.
- Check 390px and a real mobile device for touch targets, long customer names, emails, order numbers, chips, tabs, portal navigation, and drawer actions.
- Confirm login validation and server-error states introduce no layout shift.
- Confirm Dashboard scan order begins with Needs attention and that secondary metrics and charts do not compete with it.
- Confirm portal language remains customer-facing and no internal permission, workflow, scope, or implementation terminology appears.
