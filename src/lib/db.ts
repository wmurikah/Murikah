/**
 * Turso (libSQL) client factory. Uses the Workers-compatible `@libsql/client/web`
 * client, so it is safe to import inside Cloudflare Worker endpoints. Reads
 * credentials from the passed-in env (never hardcoded).
 */
import { createClient, type Client } from '@libsql/client/web';

export interface DbEnv {
  TURSO_DATABASE_URL?: string;
  TURSO_AUTH_TOKEN?: string;
}

/**
 * Create a libSQL client from the Worker env. Throws if the URL is missing so
 * callers can degrade gracefully (the endpoints catch and return a clear error).
 */
export function createDbClient(env: DbEnv): Client {
  const url = env.TURSO_DATABASE_URL;
  const authToken = env.TURSO_AUTH_TOKEN;
  if (!url) {
    throw new Error('TURSO_DATABASE_URL is not configured');
  }
  return createClient({ url, authToken });
}
