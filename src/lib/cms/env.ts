/**
 * CMS environment access.
 *
 * Reads the product's own Turso credentials and session secret from the
 * Cloudflare Worker env, mirroring Engineering Rhythm and the GRC platform. The
 * v14 adapter exposes bindings through the `cloudflare:workers` module,
 * populated from .dev.vars in local development and from Worker secrets in
 * production.
 *
 * The `CMS` in the middle of these names is load-bearing. `TURSO_DATABASE_URL`
 * and `TURSO_AUTH_TOKEN` without it belong to the marketing site and point at a
 * different database holding `leads`, `subscribers` and `demo_sessions`.
 * Reading those would attach authentication to the wrong database, which is
 * exactly the failure the namespacing convention exists to prevent: engr reads
 * TURSO_ENGR_*, grc reads TURSO_GRC_*, and this product reads TURSO_CMS_*.
 *
 * Throws a clear error when any value is missing, so callers fail loudly rather
 * than running against the wrong database or an unsigned session. There is no
 * default and no silent degradation: a missing session secret would mean
 * unkeyed session hashes, which is worse than an outage.
 */
import { env } from 'cloudflare:workers';

export interface CmsEnv {
  dbUrl: string;
  dbToken: string;
  /** HMAC key for session-token hashing. Never leaves the worker. */
  sessionSecret: string;
}

export function getCmsEnv(): CmsEnv {
  const dbUrl = env.TURSO_CMS_DATABASE_URL;
  const dbToken = env.TURSO_CMS_AUTH_TOKEN;
  const sessionSecret = env.CMS_SESSION_SECRET;
  if (!dbUrl || !dbToken || !sessionSecret) {
    throw new Error(
      'The CMS environment is not configured. Set TURSO_CMS_DATABASE_URL, TURSO_CMS_AUTH_TOKEN and CMS_SESSION_SECRET in .dev.vars (local) or as Cloudflare secrets (production).',
    );
  }
  return { dbUrl, dbToken, sessionSecret };
}

/**
 * Whether this deployment may show an invitation link to the administrator who
 * created a user.
 *
 * There is no mail sender configured for this product. `RESEND_API_KEY` belongs
 * to the marketing site and is not this product's to reuse. Until one exists,
 * an invitation has to reach the new user somehow, and the honest local answer
 * is to hand the link to the administrator who is sitting there.
 *
 * That is a development affordance and nothing else. It is off unless
 * `CMS_INVITE_LINKS` is exactly the string `development`, so the default in
 * every environment, including one where the variable was never set, is off.
 * A truthy check would have made `CMS_INVITE_LINKS=false` turn it on.
 *
 * With it off the invitation still issues and the user still exists as INVITED;
 * what fails is the attempt to deliver, loudly, saying mail is not configured.
 * The alternative, creating a user nobody can ever sign in as and saying
 * nothing, is worse.
 */
export function invitationLinksVisible(): boolean {
  return env.CMS_INVITE_LINKS === 'development';
}
