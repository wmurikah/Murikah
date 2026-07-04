/**
 * GRC platform environment access.
 *
 * Reads the product's own Turso credentials and session secret from the
 * Cloudflare Worker env, mirroring Engineering Rhythm. The v14 adapter exposes
 * bindings through the `cloudflare:workers` module, populated from .dev.vars in
 * local dev and from Worker secrets in production. The database is `hassaudit`;
 * these values are runtime secrets and are never committed. Throws a clear error
 * when any is missing, so callers fail loudly rather than running against the
 * wrong database or an unsigned session.
 */
import { env } from 'cloudflare:workers';

export interface GrcEnv {
  dbUrl: string;
  dbToken: string;
  sessionSecret: string;
}

export function getGrcEnv(): GrcEnv {
  const dbUrl = env.TURSO_GRC_DATABASE_URL;
  const dbToken = env.TURSO_GRC_AUTH_TOKEN;
  const sessionSecret = env.GRC_SESSION_SECRET;
  if (!dbUrl || !dbToken || !sessionSecret) {
    throw new Error(
      'GRC platform environment is not configured. Set TURSO_GRC_DATABASE_URL, TURSO_GRC_AUTH_TOKEN and GRC_SESSION_SECRET in .dev.vars (local) or as Cloudflare secrets (production).',
    );
  }
  return { dbUrl, dbToken, sessionSecret };
}
