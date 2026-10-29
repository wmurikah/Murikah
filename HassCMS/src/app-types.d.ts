declare namespace Cloudflare {
  interface Env {
    ASSETS: Fetcher;
    CACHE?: KVNamespace;
    // CMS-only database, authentication and provider bindings.
    TURSO_CMS_DATABASE_URL?: string;
    TURSO_CMS_AUTH_TOKEN?: string;
    CMS_SESSION_SECRET?: string;
    CMS_AUTH_MAIL_ENDPOINT?: string;
    CMS_AUTH_MAIL_SECRET?: string;
    GOOGLE_CLIENT_ID?: string;
    GOOGLE_CLIENT_SECRET?: string;
    MICROSOFT_CLIENT_ID?: string;
    MICROSOFT_CLIENT_SECRET?: string;
    MICROSOFT_TENANT?: string;
    APPLE_CLIENT_ID?: string;
    APPLE_TEAM_ID?: string;
    APPLE_KEY_ID?: string;
    APPLE_PRIVATE_KEY?: string;
    /**
     * Set to the exact string 'development' to let the CMS show an invitation
     * link to the administrator who created a user. Off everywhere else,
     * including where it is unset. See invitationLinksVisible() in
     * src/lib/cms/env.ts for why the comparison is exact rather than truthy.
     */
    CMS_INVITE_LINKS?: string;

  }
}
declare namespace App {
  interface Locals {
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
      user: import('@hasscms/lib/cms/repos/identity').CmsIdentity;
      can: (permissionCode: string) => boolean;
    };

    /**
     * The request's own CMS database client, attached by the middleware when
     * it resolves the session — the SAME client, handed on rather than thrown
     * away. Before this, one authenticated page created three to five clients:
     * middleware, layout, page, and a client per data-loading drawer, each one
     * paying its own `PRAGMA foreign_keys = ON` round trip to Turso.
     *
     * SERVER-ONLY BY CONSTRUCTION. Locals never serialise into HTML — Astro
     * keeps them on the server — and no template interpolates this value.
     * Nothing browser-writable can put a client here: the middleware assigns
     * it and nothing else does.
     *
     * Read through requestDb() in @hasscms/lib/cms/db rather than directly, so code
     * that runs where the middleware has not (tests importing a page, the
     * marketing host) still gets a working client instead of undefined.
     */
    cmsDb?: import('@libsql/client/web').Client;

    /**
     * This request's performance trace, begun by the middleware. Pages may add
     * their own phases (cms.page work, section loads); the middleware turns
     * the spans into a Server-Timing header and, past the slow threshold, one
     * [cms.perf] log line. Durations and code-chosen names only.
     */
    cmsPerf?: import('@hasscms/lib/cms/perf').CmsTrace;
  }
}
