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

    /**
     * KV for the GRC cache-aside layer (Build Prompt 42), and the default
     * backend for it. Optional and unbound on the preview deploy, exactly like
     * CACHE above: src/lib/grc/cache falls back to an in-isolate cache with
     * lifetimes clamped to a few seconds when nothing is bound, so the app is
     * correct either way and simply does less caching. Create and bind it with
     *   wrangler kv namespace create GRC_CACHE
     * then add the binding to wrangler.jsonc. GRC_CACHE is preferred; the
     * existing CACHE namespace is used when only that one is bound (the key
     * prefixes never collide with the rate limiter's).
     */
    GRC_CACHE?: KVNamespace;

    /**
     * The documented swap: an external Upstash Redis, reached over HTTP. Set
     * both and src/lib/grc/cache uses Redis instead of KV, with no call site
     * change. Runtime secrets, never committed:
     *   wrangler secret put GRC_CACHE_REDIS_URL
     *   wrangler secret put GRC_CACHE_REDIS_TOKEN
     */
    GRC_CACHE_REDIS_URL?: string;
    GRC_CACHE_REDIS_TOKEN?: string;

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

    // CMS product, its own Turso database and session secret, namespaced so they
    // never clash with engr, grc or the marketing site. Runtime secrets, never
    // committed. No code reads them at present: the product was torn down to
    // bare ground (Build Prompt 00) and these names are deliberately held in
    // reserve, along with the worker secrets and the database behind them, so
    // the redesign reconnects with the same names and the same values rather
    // than inventing new ones. See docs/cms/CMS_V1_ARCHIVE_NOTES.md.
    TURSO_CMS_DATABASE_URL?: string;
    TURSO_CMS_AUTH_TOKEN?: string;
    CMS_SESSION_SECRET?: string;
    /**
     * Set to the exact string 'development' to let the CMS show an invitation
     * link to the administrator who created a user. Off everywhere else,
     * including where it is unset. See invitationLinksVisible() in
     * src/lib/cms/env.ts for why the comparison is exact rather than truthy.
     */
    CMS_INVITE_LINKS?: string;

    // GRC notification delivery via Microsoft Graph (Outlook), sent as the
    // delegated mailbox an admin connects once on Settings -> Email. All
    // optional: the dispatcher's production gate keeps automated queue sends
    // off unless GRC_ENV is 'production' and the Graph app credentials are
    // present, so a preview or local run drains as a dry-run and a queued row
    // is left PENDING. The refresh token normally lives sealed in the database
    // (minted by the connect flow); GRAPH_REFRESH_TOKEN is an optional
    // operator-provided seed. Set as Worker secrets or in .dev.vars per
    // grc/docs/outlook-email-setup.md; never committed.
    GRC_ENV?: string; // 'production' enables real queue sends; anything else is dry-run
    GRAPH_CLIENT_ID?: string;
    GRAPH_CLIENT_SECRET?: string;
    GRAPH_REFRESH_TOKEN?: string;
    GRC_MAIL_SENDER?: string; // the connected mailbox, hassaudit@outlook.com

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

    // Per-organisation evidence storage connectors (Build Prompt 51). These are
    // the platform's OAuth application registrations, identifying Murikah to each
    // provider; they are the same for every customer, so they are Worker secrets.
    // The per-organisation refresh token is sealed in storage_connections, never
    // here. Absent credentials leave that provider unconnectable and the settings
    // screen says so. The Microsoft app falls back to the Outlook GRAPH_* pair,
    // since one Entra registration can carry both scope sets. See
    // grc/docs/storage-setup.md.
    SHAREPOINT_CLIENT_ID?: string;
    SHAREPOINT_CLIENT_SECRET?: string;
    DROPBOX_CLIENT_ID?: string;
    DROPBOX_CLIENT_SECRET?: string;

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
      /**
       * The acting organisation (organization_id); every query scopes by this.
       * An instance admin is pinned to their home organisation. A platform owner
       * is pinned to none: this is the instance they have entered, and the empty
       * string (matching no row) until they choose one. Guard with
       * `instanceSelected` rather than testing for the empty string; the
       * middleware keeps every instance-requiring path out of that state.
       */
      organizationId: string;
      /** The user's home organisation. Equals organizationId unless a platform owner is acting elsewhere. */
      homeOrganizationId: string;
      /** The acting organisation's name, or 'All organisations' while a platform owner has selected no instance. */
      organizationName: string;
      /** False only for a platform owner who has selected no instance; always true for everyone else. */
      instanceSelected: boolean;
      /** The user's single role code, e.g. SENIOR_AUDITOR. */
      roleCode: string;
      userName?: string;
      userEmail?: string;
      /** True for a platform owner (users.is_platform_owner); only they may switch the acting organisation. */
      isPlatformOwner: boolean;
      /** True while users.must_change_password is set; the middleware forces the change-password flow. */
      mustChangePassword: boolean;
      /** The organisations a platform owner may switch between; empty for every other user. */
      switchable: { id: string; name: string }[];
      /**
       * The RBAC permission matrix from role_permissions, module to action to
       * boolean. A SUPER_ADMIN and a platform owner hold the full matrix. This
       * is the authority for every gate.
       */
      matrix: Record<string, Record<string, boolean>>;
      /** Legacy permission codes derived from the matrix, e.g. WORK_PAPERS.view. */
      perms: string[];
      /**
       * The affiliate confinement in force for this viewer (Build Prompt 45).
       * `confined` is the role's `scope_to_affiliate` flag; `affiliateCode` is
       * the viewer's own `users.affiliate_code`. Together they bound which rows
       * the viewer may see, on top of the matrix. A platform owner and a
       * SUPER_ADMIN are never confined. A confined viewer with a null
       * `affiliateCode` sees nothing until an affiliate is assigned, and the
       * screens say so rather than showing an ordinary empty state.
       */
      affiliateScope: {
        confined: boolean;
        affiliateCode: string | null;
        /**
         * True when the role is confined but the viewer's affiliate is marked
         * `affiliates.is_group`, so the confinement does not narrow them
         * (Build Prompt 48). `confined` is already false in that case; this only
         * lets the screens say why they see every affiliate.
         */
        groupExempt: boolean;
      };
      /** Plan feature flags from the subscription's plan features_json. */
      features: Record<string, boolean>;
      /** True when the matrix grants the action on the module (aliases applied). */
      can: (action: string, module: string) => boolean;
      /** True when the plan enables the named feature (a platform owner is always true). */
      hasFeature: (flag: string) => boolean;
    };

    /** The visitor-facing root-relative path on grc.murikah.com, before the /grc rewrite. */
    grcPath?: string;

    /**
     * The visitor-facing root-relative path on cms.murikah.com, before the /cms
     * rewrite. Attached by the middleware host branch on every CMS request,
     * signed in or not.
     */
    cmsPath?: string;
    /**
     * The request's CSP nonce, for the one inline script the rail needs.
     * Set in the CMS branch of the middleware, read by CmsLayout.
     */
    cmsNonce?: string;

    /**
     * The signed-in CMS principal, attached by the middleware guard from a
     * verified session. Absent on an anonymous request, which is every request
     * to the sign-in page and the sign-in endpoint.
     *
     * `can` is a convenience over the resolved permission codes. It answers
     * whether a permission was granted, not whether an action is allowed in
     * context: fine-grained authorisation, including the data scopes on the
     * roles, arrives in a later phase.
     */
    cms?: {
      sessionId: string;
      user: import('@/lib/cms/repos/identity').CmsIdentity;
      can: (permissionCode: string) => boolean;
    };
  }
}
