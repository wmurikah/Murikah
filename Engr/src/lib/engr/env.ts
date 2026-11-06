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
  mfaEncryptionKey: string;
}

export function getEngrEnv(): EngrEnv {
  const dbUrl = env.TURSO_ENGR_DATABASE_URL;
  const dbToken = env.TURSO_ENGR_AUTH_TOKEN;
  const sessionSecret = env.ENGR_SESSION_SECRET;
  const mfaEncryptionKey = env.ENGR_MFA_ENCRYPTION_KEY;
  if (!dbUrl || !dbToken || !sessionSecret || !mfaEncryptionKey) {
    throw new Error(
      'Engineering Rhythm environment is not configured. Set TURSO_ENGR_DATABASE_URL, TURSO_ENGR_AUTH_TOKEN, ENGR_SESSION_SECRET and ENGR_MFA_ENCRYPTION_KEY in .dev.vars (local) or as Cloudflare secrets (production).',
    );
  }
  return { dbUrl, dbToken, sessionSecret, mfaEncryptionKey };
}
