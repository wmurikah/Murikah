/**
 * Apply engr/db/schema.sql to the Engineering Rhythm Turso database.
 *
 * Run:  pnpm db:engr:apply
 * (loads .dev.vars if present, else uses process.env for
 *  TURSO_ENGR_DATABASE_URL / TURSO_ENGR_AUTH_TOKEN). Executed with Node's
 *  native TypeScript stripping, the same workflow as the marketing db scripts.
 *
 * The schema uses CREATE ... IF NOT EXISTS throughout, so re-running is safe.
 */
import { createClient } from '@libsql/client/web';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const url = process.env.TURSO_ENGR_DATABASE_URL;
const authToken = process.env.TURSO_ENGR_AUTH_TOKEN;

if (!url) {
  console.error('✗ TURSO_ENGR_DATABASE_URL is not set. Add it to .dev.vars or your environment.');
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const schema = readFileSync(join(here, 'schema.sql'), 'utf8');

const client = createClient({ url, authToken });
await client.executeMultiple(schema);

console.log('✓ Engineering Rhythm schema applied to', url);
