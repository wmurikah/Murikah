/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />
/// <reference types="@cloudflare/workers-types" />

// Cloudflare Worker bindings, declared under the `Cloudflare.Env` namespace, // the same shape `wrangler types` generates, and the type behind
// `import { env } from 'cloudflare:workers'`. Kept in sync with wrangler.jsonc.
declare namespace Cloudflare {
  interface Env {
    /** Static assets binding, serves prerendered marketing pages from dist/. */
    ASSETS: Fetcher;
    /**
     * KV for API rate-limit counters. Optional and unbound on the preview
     * deploy: src/lib/rate-limit.ts skips limiting when it is absent, so the
     * endpoints keep working. Re-add the binding in wrangler.jsonc to enforce
     * limits. (The ASSETS_BUCKET R2 binding was likewise removed for the preview,
     * no code on main referenced it, and returns with the feature that needs it.)
     */
    CACHE?: KVNamespace;

    // Secrets (set via `wrangler secret put` in prod; `.dev.vars` locally).
    TURSO_DATABASE_URL: string;
    TURSO_AUTH_TOKEN: string;
    RESEND_API_KEY?: string;
    CONTACT_NOTIFY_EMAIL?: string;
    RESEND_FROM_EMAIL?: string;

    // Engineering Rhythm (Murikah Labs) product, its own Turso database and
    // session secret, namespaced so they never clash with the marketing site.
    // Optional here so the marketing preview typechecks without them; the engr
    // env accessor throws at runtime when any is missing.
    TURSO_ENGR_DATABASE_URL?: string;
    TURSO_ENGR_AUTH_TOKEN?: string;
    ENGR_SESSION_SECRET?: string;

    // Plain vars.
    PUBLIC_SITE_URL?: string;
  }
}

// Global Env used by the adapter's Worker handler mirrors Cloudflare.Env.
interface Env extends Cloudflare.Env {}

// Astro.locals, the v14 adapter exposes the execution context as `cfContext`.
type Runtime = import('@astrojs/cloudflare').Runtime;
declare namespace App {
  interface Locals extends Runtime {
    /**
     * Engineering Rhythm request context, attached by src/middleware.ts for
     * authenticated /engr requests. Absent on the marketing site. The org is
     * resolved from the session, so every downstream query scopes by orgId.
     */
    engr?: {
      userId: string;
      orgId: string;
      orgSlug: string;
      roles: string[];
      perms: string[];
      can: (key: string) => boolean;
    };
  }
}
