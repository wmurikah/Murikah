/**
 * Engineering Rhythm libSQL client factory.
 *
 * Uses the Workers-compatible `@libsql/client/web` build so it runs inside the
 * Cloudflare Worker. A fresh client is created per request (Workers are
 * stateless, so there is no safe module-level singleton across isolates).
 *
 * Foreign keys are turned on for the connection, since libSQL leaves them OFF
 * per connection. On the remote HTTP protocol the pragma reliably holds within a
 * single batch or transaction, so the multi-statement writes in the repositories
 * use `batch(..., 'write')` to stay atomic and referentially safe.
 *
 * All money in this database is integer minor units (KES cents). Repositories
 * return the raw minor units; formatting to major units happens in the view
 * layer only.
 */
import { createClient, type Client } from '@libsql/client/web';
import type { EngrEnv } from './env';

async function createDb(env: EngrEnv): Promise<Client> {
  const client = createClient({ url: env.dbUrl, authToken: env.dbToken });
  await client.execute('PRAGMA foreign_keys = ON;');
  return client;
}

/** Share one client and its initialization within an Astro request. The cache
 * lives on request locals, never in the Worker isolate or across users. */
export function getDb(env: EngrEnv, locals?: App.Locals): Promise<Client> {
  if (!locals) return createDb(env);
  return (locals.engrDb ??= createDb(env));
}
