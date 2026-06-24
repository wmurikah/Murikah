/**
 * DESTRUCTIVE: drops the application's tables and recreates them from
 * db/schema.sql. This deletes ALL data in the target database.
 *
 * Guarded: it refuses to run unless CONFIRM=1 is set.
 *   CONFIRM=1 pnpm db:reset
 *
 * The confirmation is checked before the environment is even loaded, so an
 * accidental run never touches credentials or the database.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.CONFIRM !== '1') {
  console.error('✗ Refusing to run. db:reset DROPS ALL TABLES and deletes all data.');
  console.error('  If you are certain, re-run with an explicit confirmation:');
  console.error('    CONFIRM=1 pnpm db:reset');
  process.exit(1);
}

// Load the env + client only after the guard passes.
const { createDbClient } = await import('./_env');

const here = dirname(fileURLToPath(import.meta.url));
const schema = readFileSync(join(here, 'schema.sql'), 'utf8');

// Only drop the tables this app declares in schema.sql.
const tables = [...schema.matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)/gi)].map((m) => m[1]);

const client = createDbClient();

console.log(`Dropping ${tables.length} tables, then recreating from db/schema.sql...`);
for (const table of tables) {
  await client.execute(`DROP TABLE IF EXISTS ${table}`);
}
await client.executeMultiple(schema);

console.log(`✓ Reset complete. Dropped and recreated ${tables.length} tables.`);
