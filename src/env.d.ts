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

    // GRC platform product, its own Turso database (hassaudit) and session
    // secret, namespaced so they never clash with engr or the marketing site.
    // Optional here so the marketing preview typechecks without them; the grc
    // env accessor throws at runtime when any is missing.
    TURSO_GRC_DATABASE_URL?: string;
    TURSO_GRC_AUTH_TOKEN?: string;
    GRC_SESSION_SECRET?: string;

    // GRC notification delivery via Microsoft Graph (Outlook). All optional: the
    // dispatcher's production gate keeps sends off unless GRC_ENV is 'production'
    // and these are present, so a preview or local run drains as a dry-run and a
    // queued row is left PENDING. Set as Worker secrets or in .dev.vars; never
    // committed.
    GRC_ENV?: string; // 'production' enables real sends; anything else is dry-run
    OUTLOOK_CLIENT_ID?: string;
    OUTLOOK_CLIENT_SECRET?: string;
    OUTLOOK_REFRESH_TOKEN?: string;
    OUTLOOK_SENDER_EMAIL?: string;
    OUTLOOK_TENANT?: string; // optional AAD tenant; defaults to 'common'

    // GRC AI assistance provider API keys. Held only as Worker secrets, never in
    // the database; the config module shows only a masked tail. Absent keys leave
    // that provider unconfigured and the AI features degrade gracefully.
    AI_API_KEY_OPENAI?: string;
    AI_API_KEY_ANTHROPIC?: string;
    AI_API_KEY_GOOGLE_AI?: string;

    // GRC evidence storage on Cloudflare R2 (Build Prompt 11). The bucket binding
    // and the S3 presign credentials are optional so the preview deploys with no
    // pre-created bucket; when absent, evidence upload and download report that
    // storage is not configured and the rest of the app is unaffected. The binding
    // gives head/get/put/delete; the S3 credentials sign the presigned URLs that
    // carry the large object bytes directly between the client and R2. Secrets are
    // Worker secrets or .dev.vars, never committed.
    EVIDENCE_BUCKET?: R2Bucket;
    R2_ACCOUNT_ID?: string;
    R2_ACCESS_KEY_ID?: string;
    R2_SECRET_ACCESS_KEY?: string;
    R2_BUCKET?: string; // the bucket name used in the S3 presign path

    // Read-only Google Drive credential for reading and migrating existing
    // Drive-backed evidence (never writing). OAuth2 refresh-token flow from the
    // Worker, scope drive.readonly. Optional; absent leaves Drive files unreadable
    // until provisioned. Worker secrets only, never committed.
    GDRIVE_CLIENT_ID?: string;
    GDRIVE_CLIENT_SECRET?: string;
    GDRIVE_REFRESH_TOKEN?: string;

    // Engineering Rhythm notification dispatcher. All optional: absent or a
    // non-production ENGR_ENV keeps the dispatcher in dry-run and never contacts
    // a provider. Secrets are set as Worker secrets or in .dev.vars.
    ENGR_ENV?: string; // 'production' enables real sends; anything else is dry-run
    AT_USERNAME?: string; // Africa's Talking
    AT_API_KEY?: string;
    AT_SENDER_ID?: string;
    EMAIL_API_KEY?: string; // transactional email provider (Resend)
    EMAIL_FROM?: string; // verified sender address
    ENGR_CRON_SECRET?: string; // guards the internal cron endpoints
    ENGR_WEBHOOK_SECRET?: string; // verifies provider delivery-receipt webhooks

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
      /** The acting organisation: the home org, or another organisation a platform owner switched into. Every query scopes by this. */
      orgId: string;
      /** The user's home organisation. Equals orgId unless a platform owner is acting inside another organisation. */
      homeOrgId: string;
      orgSlug: string;
      /** Display fields; absent on a session minted before they were added. */
      orgName?: string;
      userName?: string;
      userEmail?: string;
      /** True for a platform owner; only they may switch the acting organisation. */
      isPlatformOwner: boolean;
      /** The organisations a platform owner may switch between (all customers); empty for every other user. */
      switchable: { id: string; name: string; slug: string }[];
      roles: string[];
      perms: string[];
      can: (key: string) => boolean;
    };

    /**
     * The visitor-facing host and root-relative path on the Engineering Rhythm
     * subdomain, captured by the middleware before it rewrites the request to the
     * internal /engr route. Anything building a canonical link or highlighting
     * the active nav reads these, since Astro.url reflects the rewritten path.
     */
    engrHost?: string;
    engrPath?: string;

    /**
     * GRC platform request context, attached by src/middleware.ts for
     * authenticated /grc requests. Absent on engr and the marketing site. The
     * organisation is resolved and server-verified from the DB-backed session,
     * so every downstream query scopes by organizationId. This database uses the
     * audit system's own conventions: organization_id and a single role_code.
     */
    grc?: {
      userId: string;
      /** The acting organisation (organization_id). A platform owner may switch; every query scopes by this. */
      organizationId: string;
      /** The user's home organisation. Equals organizationId unless a platform owner is acting elsewhere. */
      homeOrganizationId: string;
      organizationName: string;
      /** The user's single role code, e.g. SENIOR_AUDITOR. */
      roleCode: string;
      userName?: string;
      userEmail?: string;
      /** True for a platform owner (users.is_platform_owner); only they may switch the acting organisation. */
      isPlatformOwner: boolean;
      /** The organisations a platform owner may switch between; empty for every other user. */
      switchable: { id: string; name: string }[];
      /** Permission codes resolved from role_code, e.g. WORK_PAPERS.review. */
      perms: string[];
      /** Plan feature flags from the subscription's plan features_json. */
      features: Record<string, boolean>;
      /** True when the session carries the permission code. */
      can: (code: string) => boolean;
      /** True when the plan enables the named feature (a platform owner is always true). */
      hasFeature: (flag: string) => boolean;
    };

    /** The visitor-facing root-relative path on grc.murikah.com, before the /grc rewrite. */
    grcPath?: string;
  }
}
