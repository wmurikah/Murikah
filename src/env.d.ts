/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />
/// <reference types="@cloudflare/workers-types" />

// Cloudflare Worker bindings, declared under the `Cloudflare.Env` namespace, // the same shape `wrangler types` generates, and the type behind
// `import { env } from 'cloudflare:workers'`. Kept in sync with wrangler.jsonc.
declare namespace Cloudflare {
  interface Env {
    /** Static assets binding, serves prerendered marketing pages from dist/. */
    ASSETS: Fetcher;
    /** KV: response cache, feature flags, and API rate-limit counters. */
    CACHE: KVNamespace;
    /** R2: static asset overflow + the future downloadable Intelligence report. */
    ASSETS_BUCKET: R2Bucket;

    // Secrets (set via `wrangler secret put` in prod; `.dev.vars` locally).
    TURSO_DATABASE_URL: string;
    TURSO_AUTH_TOKEN: string;
    RESEND_API_KEY?: string;
    CONTACT_NOTIFY_EMAIL?: string;
    RESEND_FROM_EMAIL?: string;

    // Plain vars.
    PUBLIC_SITE_URL?: string;

    // --- AI assistant (Prompt 3) ---
    /** 'anthropic' (default) or 'workers-ai'. */
    AI_PROVIDER?: string;
    /** Anthropic API key. Read server-side only; never sent to the client. */
    ANTHROPIC_API_KEY?: string;
    /** Override the chat model id (defaults set in src/lib/ai/config). */
    AI_MODEL?: string;
    /** Cloudflare Workers AI binding, used when AI_PROVIDER is 'workers-ai'. */
    AI?: { run: (model: string, input: unknown) => Promise<unknown> };

    // --- Demo sandbox (Prompt 3) ---
    /** Salt for hashing visitor IPs stored in demo_sessions. */
    DEMO_HASH_SALT?: string;
    /** Shared secret required to call /api/cron/sweep. */
    CRON_SECRET?: string;
  }
}

// Global Env used by the adapter's Worker handler mirrors Cloudflare.Env.
interface Env extends Cloudflare.Env {}

// Astro.locals, the v14 adapter exposes the execution context as `cfContext`.
type Runtime = import('@astrojs/cloudflare').Runtime;
declare namespace App {
  interface Locals extends Runtime {}
}
