# Cloudflare startup invariant

Cloudflare staging does not use DeepTutor's supervisord entrypoint. The container image still keeps the original Murikah/DeepTutor entrypoint as its Docker default for Codespaces and other runtimes, while the Cloudflare Worker explicitly overrides startup to `/app/murikah-cloudflare-entrypoint.sh`.

The Cloudflare-specific entrypoint:

- runs Murikah's first-boot bootstrap;
- loads DeepTutor's JSON-backed runtime settings;
- starts FastAPI on loopback port 8001;
- starts Next.js on `0.0.0.0:3782`;
- terminates the sibling process if either service exits.

The Worker treats `getState().status` as authoritative. Only `running` and `healthy` are live states. `stopped` and `stopped_with_code` are restarted even if the low-level `ctx.container.running` flag is stale.

This file exists to document the staging-specific behavior and prevent a future refactor from reintroducing the stopped-container loop.
