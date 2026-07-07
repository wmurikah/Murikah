/**
 * Hass CMS libSQL client factory.
 *
 * Uses the Workers-compatible `@libsql/client/web` build, which speaks the Turso
 * HTTP `/v2/pipeline` protocol, so it runs inside the Cloudflare Worker. A fresh
 * client is created per request (Workers are stateless, so there is no safe
 * module-level singleton across isolates).
 *
 * Foreign keys are turned on for the connection, since libSQL leaves them OFF
 * per connection. This points at the live Hass CMS database, whose conventions
 * are its own: natural primary keys (`user_id`, `session_id`, ...), two user
 * types (STAFF and CUSTOMER), country-scoped roles and branding, and, from this
 * port, a tenant layer above them. The schema is operator-managed and the typed
 * column layer (@cms/schema/columns) is generated from it; do not hand-write
 * column names.
 */
import { createClient, type Client } from '@libsql/client/web';
import type { CmsEnv } from './env';

export async function getDb(env: CmsEnv): Promise<Client> {
  const client = createClient({ url: env.dbUrl, authToken: env.dbToken });
  await client.execute('PRAGMA foreign_keys = ON;');
  return client;
}
