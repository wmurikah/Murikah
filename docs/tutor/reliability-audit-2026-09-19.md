# Tutor reliability audit — 2026-09-19

## Finding

The observed follow-up failures were not caused by two concurrent learners exhausting the application server. The interactive fast lane ended its provider race after 12 seconds even though fallback providers started as late as 6.5 seconds and were each intended to receive an 8-second first-token window. A healthy late fallback could therefore be cancelled after only 5.5 seconds. Follow-up turns are more exposed because their conversation payload is larger.

Every edge request also performed a separate container health RPC before it was proxied. That adds latency to page, API and WebSocket traffic and creates duplicate health traffic during bursts.

The root route rendered an authentication-oriented loading screen while it created a guest session in the browser, causing the brief sign-in/sign-up flash.

## Remediation in this change

- Guarantee every delayed provider its full first-token allowance.
- Raise the default first-token and stream-idle budgets to tolerate normal follow-up variance.
- Allow one transient retry in the provider client.
- Recover through the standard chat pipeline if all fast-lane candidates miss instead of immediately failing the learner's turn.
- Cache positive container readiness for five seconds and coalesce simultaneous health checks.
- Paint a guest chat shell immediately at both the Cloudflare cold-start edge and the application root; create the guest session in parallel and retry one transient 5xx response.
- Keep latency events for provider start, failure, recovery, first token and completion.

## Capacity boundary

This removes the identified false timeouts and avoidable per-request health overhead. It does **not** certify 1,000-user capacity. The Worker currently routes normal traffic to one named Tutor container, and durable application state has not yet been fully externalised from `/app/data`. Safe horizontal sharding requires the existing D1/R2 persistence migration to be completed first.

Before a 1,000-user launch:

1. Complete D1/R2 persistence and verify session/conversation survival across container replacement.
2. Shard authenticated traffic with session affinity across container instances.
3. Run staged tests at 25, 100, 250, 500 and 1,000 concurrent sessions, including multi-turn conversations and WebSockets.
4. Set provider quotas from measured peak requests and output tokens, with headroom for failover.
5. Alert on p50/p95/p99 first-token latency, provider 429/5xx rate, fast-lane recovery rate, active streams and queue depth.

Acceptance target: no failed turn caused solely by the local first-token deadline, less than 1% recovery-path use under normal provider health, and error/latency objectives agreed from measured staging results.
