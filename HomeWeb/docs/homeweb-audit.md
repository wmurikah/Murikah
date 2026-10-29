# HomeWeb audit changes

The website uses its existing Ceramic Ink palette, with separate brass text and accent colours. HomeWeb is the only system changed. The branch is prepared for review; deployment remains separate from this PR.

## Implemented

- Five top-level navigation entries; only Services has a dropdown, with four destinations. Sign in links to the live Assurance OS application. Footer marketing and sign-in destinations are separate.
- Responsive 55:45 hero at desktop widths; product capture follows the buttons on mobile. `public/images/assurance-os/hero.webp` is 1600×1000, under 150 KB. It combines two unaltered screenshots from the local, fictional-data sandbox. Six further captures illustrate workflow stages.
- Company-level standards and existing redacted audit results replace all personal profiles, credentials and founder metadata, as requested. No individual accreditation or corporate endorsement is claimed.
- Six keyboard-operable workflow stages with reduced-motion support, hover/focus pauses, one automatic loop and quiet screen-reader announcements until a stage is selected.
- Pricing links lead to the existing published KES ranges. Every audience card has a destination; fintech, NGO and family-business enquiries retain their segment in the lead source and email notification.
- The home and contact pages share a form with two required fields and an optional challenge. Server validation matches the form. Honeypots are offscreen, unfocusable and hidden from assistive technology. The confirmed call response is one business day.
- Research sits under Insights. Topic chips filter articles, including existing hash links. About has local section links.
- Existing fonts remain self-hosted. Non-hero images load lazily. The actual brand text contrast pairs are covered by tests.

## Analytics configuration

Copy `env.example` to `.env`, or set `PUBLIC_GA_MEASUREMENT_ID` in the **HomeWeb build environment**, using the site's real `G-…` measurement ID. Rebuild after changing it. An empty or invalid ID loads no Google tag and shows no analytics prompt. This public identifier is not a secret; do not put service credentials in the example file.

With an ID configured, visitors can allow or decline analytics and revisit their choice in the footer. Do Not Track suppresses collection. The Google tag loads only after opt-in; advertising signals are disabled. Query strings, form contents and sandbox records are excluded from the custom event payloads.

Events: `cta_call_click`, `sandbox_click`, `sandbox_start`, `form_submit`, `whatsapp_click`. Each includes a `location` value such as `header`, `hero`, `home`, `contact` or `sandbox`. `form_submit` fires only after a successful API response. Browser-only hooks are also available via `murikah:analytics` and `window.dataLayer`.

In GA4, register `location` as an event-scoped custom dimension and mark the desired events as key events. Disable Enhanced Measurement's automatic form interactions and outbound-click tracking to avoid double counting; this implementation emits explicit conversion events. Verify delivery in DebugView after configuring the real property. The owner has confirmed that no measurement ID exists yet, so GA4 remains disabled. Create a Web data stream for `murikah.com` in Google Analytics, then copy its `G-…` measurement ID into the build setting when ready.

## Content decisions and external inputs

- The remaining public legal-template tokens and training-date placeholder are removed. Privacy copy now matches the three-field form and configured providers. The unverified ODPC registration claim is removed. The unavailable checklist offer links directly to the existing ISO 42001 readiness guide instead of promising an email attachment.
- WhatsApp is an inactive “coming soon” placeholder. Replace it with a real `https://wa.me/…` link when the public number is available; the shared event handler will then track clicks.
- No fourth outcome metric, testimonial, free-call/no-slide-deck promise, or quote turnaround is published without confirmation. The three existing metrics remain linked to the redacted report page.
- The Plan caption describes the demonstrated scheduling and audit-time allocation. It does not promise risk/standard linking that was not shown by the sandbox screen. Screens are explicitly labelled as fictional sandbox data.
- Live contact delivery requires the existing Turso and email bindings. Local checks use a mocked successful submission plus real API validation and honeypot handling; no email is sent during testing.

## Verification and maintenance

From `HomeWeb`, run `pnpm test`, `pnpm build`, and start the built Worker with `pnpm exec wrangler dev --config dist/server/wrangler.json --port 8791`. Python scripts require Playwright, Chromium and Pillow in the development environment:

- `python scripts/marketing/check-homeweb.py`: page availability, desktop/mobile layout, menu keyboard behaviour, optional challenge and segment attribution, local API validation, conversion hooks and motion controls.
- `python scripts/marketing/check-analytics.py`: checks the compiled GA4 adapter with a test-ID fixture; Google requests are intercepted, with no actual collection.
- `python scripts/marketing/capture-assurance-screens.py`: regenerate the genuine sandbox screenshots using only seeded fictional data. Review and rebuild after regenerating.

The preview URL can be set with `HOMEWEB_PREVIEW_URL`. Browser review screenshots are saved outside the repository under `/tmp/homeweb-review`.

## Five-second test to run with real visitors

Show the home hero for five seconds to five audit heads or CFOs. Hide it and ask:

1. What does this company do?
2. Who is it for?
3. What would you click first?

Record their exact answers without coaching. Revise the hero until at least four of five identify the service, audience and a suitable next action correctly. This requires actual participants; no user-research results have been invented.

## Content closeout

The fourth metric and testimonial are deliberately omitted until a supporting result and written permission exist. There are no empty result or quote slots on the public pages. A new number, customer quote or user-test result cannot be supplied by editing website code.

For a future outcome metric, record its definition, period, source report and permission to publish the aggregate. For a testimonial, keep the exact approved words (25 or fewer), the approved attribution and written publication permission. Keep client-identifying source records out of this public repository.

For the five-second test, use the three questions above and record one anonymous row per participant: role, their exact answers, whether each answer met the criteria, and the resulting copy change. Do not describe this test as completed before five real participants have taken it.
