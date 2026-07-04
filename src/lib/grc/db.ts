/**
 * GRC platform libSQL client factory.
 *
 * Uses the Workers-compatible `@libsql/client/web` build, which speaks the Turso
 * HTTP `/v2/pipeline` protocol, so it runs inside the Cloudflare Worker. A fresh
 * client is created per request (Workers are stateless, so there is no safe
 * module-level singleton across isolates).
 *
 * Foreign keys are turned on for the connection, since libSQL leaves them OFF
 * per connection. This points at the `hassaudit` database, whose conventions
 * differ from Engineering Rhythm's: tenancy is `organization_id`, primary keys
 * are natural (`user_id`, `work_paper_id`, ...), a user carries one
 * `role_code`, and statuses are data-driven through `enum_values` and
 * `status_transitions`. The schema is operator-managed and must not be changed
 * from here.
 */
import { createClient, type Client } from '@libsql/client/web';
import type { GrcEnv } from './env';

export async function getDb(env: GrcEnv): Promise<Client> {
  const client = createClient({ url: env.dbUrl, authToken: env.dbToken });
  await client.execute('PRAGMA foreign_keys = ON;');
  return client;
}
