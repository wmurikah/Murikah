/**
 * CMS libSQL client factory.
 *
 * Uses the Workers-compatible `@libsql/client/web` build, which speaks the
 * Turso HTTP `/v2/pipeline` protocol, so it runs inside the Cloudflare Worker.
 * A fresh client is created per request, because Workers are stateless and
 * there is no safe module-level singleton across isolates.
 *
 * Foreign keys are turned on for the connection, since libSQL leaves them OFF
 * per connection. On the remote HTTP protocol the pragma holds reliably within
 * a single batch or transaction, so multi-statement writes use
 * `batch(..., 'write')` to stay atomic and referentially safe. This matters
 * here: a login writes a session, a credential reset and an audit event, and a
 * half-written login is worse than a failed one.
 *
 * Every statement in this product is parameterised. No query is built by
 * string concatenation anywhere in src/lib/cms.
 */
import { createClient, type Client } from '@libsql/client/web';
import type { CmsEnv } from './env';

export async function getDb(env: CmsEnv): Promise<Client> {
  const client = createClient({ url: env.dbUrl, authToken: env.dbToken });
  await client.execute('PRAGMA foreign_keys = ON;');
  return client;
}
