/**
 * Engineering Rhythm environment access.
 *
 * Reads the product's own Turso credentials and session secret from the
 * Cloudflare Worker env. The v14 adapter exposes bindings through the
 * `cloudflare:workers` module (the same source the marketing endpoints use),
 * populated from .dev.vars in local dev and from Worker secrets in production.
 * Throws a clear error when any value is missing, so callers fail loudly rather
 * than running against the wrong database or an unsigned session.
 */
import { env } from 'cloudflare:workers';

export interface EngrEnv {
  dbUrl: string;
  dbToken: string;
  sessionSecret: string;
}

export function getEngrEnv(): EngrEnv {
  const dbUrl = env.TURSO_ENGR_DATABASE_URL;
  const dbToken = env.TURSO_ENGR_AUTH_TOKEN;
  const sessionSecret = env.ENGR_SESSION_SECRET;
  if (!dbUrl || !dbToken || !sessionSecret) {
    throw new Error(
      'Engineering Rhythm environment is not configured. Set TURSO_ENGR_DATABASE_URL, TURSO_ENGR_AUTH_TOKEN and ENGR_SESSION_SECRET in .dev.vars (local) or as Cloudflare secrets (production).',
    );
  }
  return { dbUrl, dbToken, sessionSecret };
}
