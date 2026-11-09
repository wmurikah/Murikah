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
  /** Optional at the application layer so a missing MFA key cannot take the
   * login endpoint or every authenticated page down. MFA routes fail closed
   * and report the missing key explicitly. */
  mfaEncryptionKey?: string;
  /** Independent AES-GCM key for queued invitation and recovery emails. */
  authMessageKey?: string;
  /** Exact file-host names, separated by commas. Empty means links are disabled. */
  attachmentAllowedHosts?: string;
}

export function getEngrEnv(): EngrEnv {
  const dbUrl = env.TURSO_ENGR_DATABASE_URL;
  const dbToken = env.TURSO_ENGR_AUTH_TOKEN;
  const sessionSecret = env.ENGR_SESSION_SECRET;
  const mfaEncryptionKey = env.ENGR_MFA_ENCRYPTION_KEY;
  const authMessageKey = env.ENGR_AUTH_MESSAGE_KEY;
  const attachmentAllowedHosts = env.ENGR_ATTACHMENT_ALLOWED_HOSTS;
  if (!dbUrl || !dbToken || !sessionSecret) {
    throw new Error(
      'Engineering Rhythm environment is not configured. Set TURSO_ENGR_DATABASE_URL, TURSO_ENGR_AUTH_TOKEN and ENGR_SESSION_SECRET in .dev.vars (local) or as Cloudflare secrets (production).',
    );
  }
  return {
    dbUrl,
    dbToken,
    sessionSecret,
    mfaEncryptionKey,
    authMessageKey,
    attachmentAllowedHosts,
  };
}
