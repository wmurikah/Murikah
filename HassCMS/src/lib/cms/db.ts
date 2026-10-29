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
import type { CmsEnv } from './env.ts';

export async function getDb(env: CmsEnv): Promise<Client> {
  const client = createClient({ url: env.dbUrl, authToken: env.dbToken });
  await client.execute('PRAGMA foreign_keys = ON;');
  return client;
}

/**
 * The request's client, or a fresh one where no request carried it.
 *
 * ONE CLIENT PER AUTHENTICATED REQUEST IS THE POINT. The middleware already
 * creates a client to resolve the session; before this, that client was
 * discarded and the layout, the page and every data-loading component made
 * their own — three to five creations per page, each paying the
 * `PRAGMA foreign_keys = ON` round trip to Turso before its first real query.
 * The middleware now leaves its client on `locals.cmsDb` and everything
 * downstream asks here first.
 *
 * THE FALLBACK IS NOT DEAD CODE. Tests import pages and endpoints directly
 * with hand-built locals, and a rare code path can run where the CMS
 * middleware has not (the marketing host importing a shared module). Those
 * get exactly the client they always got. The fallback preserves the pragma,
 * so referential safety never depends on which path constructed the client.
 *
 * The parameter is the LOCALS OBJECT and not the client, so no call site can
 * accidentally thread a browser-supplied value into the database layer: the
 * only writer of `locals.cmsDb` is the middleware.
 */
export async function requestDb(locals: { cmsDb?: Client }): Promise<Client> {
  if (locals.cmsDb !== undefined) return locals.cmsDb;
  const { getCmsEnv } = await import('./env.ts');
  return getDb(getCmsEnv());
}
