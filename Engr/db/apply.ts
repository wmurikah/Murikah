/** Apply every unapplied numbered migration, then verify the canonical schema
 * contract. Safe for blank databases, the legacy repository schema, and the
 * already-expanded production schema. */
import { createClient } from '@libsql/client';
import { runMigrations } from './migrate.ts';

const url = process.env.TURSO_ENGR_DATABASE_URL;
const authToken = process.env.TURSO_ENGR_AUTH_TOKEN;

if (!url) {
  console.error('✗ TURSO_ENGR_DATABASE_URL is not set. Add it to .dev.vars or your environment.');
  process.exit(1);
}

const client = createClient({ url, authToken });
try {
  const result = await runMigrations(client);
  if (result.applied.length) console.log('✓ Applied migrations:', result.applied.join(', '));
  else console.log('✓ No pending migrations.');
  console.log('✓ Engineering schema contract verified at', url);
} finally {
  client.close();
}
