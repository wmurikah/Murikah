# Marketing audit implementation

Scope: public marketing site only. Astro, React islands, Tailwind, the Cloudflare adapter, Wrangler configuration, dependencies and deployment workflows are unchanged. Existing CMS/GRC/ENGR/Tutor applications are linked, not modified.

## Audit recommendations

1. Removed public pricing and hosting draft tokens. Unconfirmed contract, tier and residency specifics now direct buyers to a written quote rather than making up terms. Removed unverified ODPC registration wording.
2. Replaced the rotating hero with a static, descriptive proposition and a user-initiated 20-second film. No carousel hydration or multi-image download on the homepage.
3. Added Products to desktop/mobile navigation, a /products hub and links in the homepage/footer to the existing four subdomains. Familiar service labels and consistent separation of five services from software.
4. Product demo CTAs say Request a demo, service CTAs say Discuss your requirements, and enquiry guidance explains response time. Demo links prefill an editable request. Suppressed duplicate closing buttons to the same destination.
5. Added a clearly labelled fictional sample audit finding and links to working products. About now invites review of the proposed lead, experience and responsibilities. Named biographies, verified credentials and permissioned client results still need owner-supplied evidence; none were invented.
6. Removed defensive Big Four comparisons and shortened key introductions. Updated service naming, added primary standards links and retained canonical metadata, article dates and existing structured data.

## Interaction and media

Content is visible before JavaScript. Mobile focus trapping only includes visible controls; the menu scrolls and releases its scroll lock when moving to desktop. The audit walkthrough starts paused. Native video controls, preload=none, a poster and adjacent description keep the video optional. Media is a checked-in 136 KB MP4 plus JPEG, served by the existing deployment.

## Validation

- ESLint: changed marketing components and pages pass.
- Prettier: all changed web source files pass.
- git diff --check: passes.
- ffprobe: H.264 MP4, 20.000 seconds; poster and ending frame visually inspected.
- Astro check: 21 errors, all in unchanged tutor/cloudflare/src/index.ts, including missing @cloudflare/containers. That file matches origin/main byte-for-byte. No marketing errors reported.
- Astro build: Vite compilation succeeds; Cloudflare prerender setup then fails locally with uv_interface_addresses (sandbox network-interface enumeration). Full production build is not verified locally.
- Browser viewport/keyboard testing and production Core Web Vitals remain pending. No performance scores or client outcomes are claimed.
