/**
 * Hass CMS platform environment access.
 *
 * Reads the product's own Turso credentials and session secret from the
 * Cloudflare Worker env, mirroring Engineering Rhythm and GRC. The adapter
 * exposes bindings through the `cloudflare:workers` module, populated from
 * .dev.vars in local development and from Worker secrets in production. These
 * values are runtime secrets and are never committed. Throws a clear error when
 * any is missing, so callers fail loudly rather than running against the wrong
 * database or an unsigned session.
 */
import { env } from 'cloudflare:workers';

export interface CmsEnv {
  dbUrl: string;
  dbToken: string;
  sessionSecret: string;
}

export function getCmsEnv(): CmsEnv {
  const dbUrl = env.TURSO_CMS_DATABASE_URL;
  const dbToken = env.TURSO_CMS_AUTH_TOKEN;
  const sessionSecret = env.CMS_SESSION_SECRET;
  if (!dbUrl || !dbToken || !sessionSecret) {
    throw new Error(
      'Hass CMS environment is not configured. Set TURSO_CMS_DATABASE_URL, TURSO_CMS_AUTH_TOKEN and CMS_SESSION_SECRET in .dev.vars (local) or as Cloudflare secrets (production).',
    );
  }
  return { dbUrl, dbToken, sessionSecret };
}
