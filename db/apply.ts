/**
 * Apply db/schema.sql to the configured Turso database.
 *
 * Run:  pnpm db:apply
 * (loads .dev.vars if present, else uses process.env for TURSO_DATABASE_URL /
 *  TURSO_AUTH_TOKEN). Executed with Node's native TypeScript stripping.
 */
import { createClient } from '@libsql/client/web';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;

if (!url) {
  console.error('✗ TURSO_DATABASE_URL is not set. Add it to .dev.vars or your environment.');
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const schema = readFileSync(join(here, 'schema.sql'), 'utf8');

const client = createClient({ url, authToken });
await client.executeMultiple(schema);

console.log('✓ Schema applied to', url);
