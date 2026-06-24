/**
 * Seed the Turso database with a little sample data for local development.
 *
 * Run:  pnpm db:seed   (apply the schema first with `pnpm db:apply`)
 * Note: subscribers use INSERT OR IGNORE (idempotent); a sample lead is added
 * each run, which is fine for development.
 */
import { createClient } from '@libsql/client/web';

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;

if (!url) {
  console.error('✗ TURSO_DATABASE_URL is not set. Add it to .dev.vars or your environment.');
  process.exit(1);
}

const client = createClient({ url, authToken });

await client.batch(
  [
    {
      sql: 'INSERT OR IGNORE INTO subscribers (email, source) VALUES (?, ?)',
      args: ['demo@example.com', 'seed'],
    },
    {
      sql: 'INSERT INTO leads (name, organisation, role, email, message, source) VALUES (?, ?, ?, ?, ?, ?)',
      args: [
        'Sample Lead',
        'Example SACCO',
        'Head of Internal Audit',
        'sample@example.com',
        'This is a seeded sample lead for local development. [placeholder]',
        'seed',
      ],
    },
  ],
  'write',
);

console.log('✓ Seeded sample data');
