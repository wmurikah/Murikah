/**
 * Load engr/db/seed.sql (subscription plans, the permission registry and the
 * nine system roles with baseline grants) into the Engineering Rhythm Turso
 * database. Shared product catalogue, not tenant data.
 *
 * Run:  pnpm db:engr:seed   (apply the schema first with pnpm db:engr:apply)
 * Safe to re-run: the seed uses INSERT OR IGNORE throughout.
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
const seed = readFileSync(join(here, 'seed.sql'), 'utf8');

const client = createClient({ url, authToken });
await client.executeMultiple(seed);

console.log('✓ Engineering Rhythm catalogue seeded to', url);
