/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />
/// <reference types="@cloudflare/workers-types" />

// Cloudflare Worker bindings. Kept in sync with `wrangler.jsonc`.
// `wrangler types` can generate a `worker-configuration.d.ts` with the same
// shape, but declaring `Env` here keeps `astro check`/`astro build` fully
// self-contained (no wrangler invocation required to type-check).
interface Env {
  /** Static assets binding — serves prerendered marketing pages from dist/. */
  ASSETS: Fetcher;
  /** KV: response cache, feature flags, and API rate-limit counters. */
  CACHE: KVNamespace;
  /** R2: static asset overflow + the future downloadable Intelligence report. */
  ASSETS_BUCKET: R2Bucket;

  // Secrets (set via `wrangler secret put` in production; `.dev.vars` locally).
  TURSO_DATABASE_URL: string;
  TURSO_AUTH_TOKEN: string;
  RESEND_API_KEY?: string;
  CONTACT_NOTIFY_EMAIL?: string;
  RESEND_FROM_EMAIL?: string;

  // Plain vars.
  PUBLIC_SITE_URL?: string;
}

// Expose the Cloudflare runtime (env + cf + ctx + caches) on Astro.locals.
type Runtime = import('@astrojs/cloudflare').Runtime<Env>;

declare namespace App {
  interface Locals extends Runtime {}
}
