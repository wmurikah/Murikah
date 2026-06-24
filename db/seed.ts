/**
 * Seed the Turso database with sample data for local development and the demo
 * sandbox. Reads the same JSON the app ships (src/lib/demo/sample-data.json),
 * so the seeded Audit OS data matches what the sandbox renders.
 *
 * Run:  pnpm db:seed   (apply the schema first with `pnpm db:apply`)
 * Idempotent for the read-only Audit OS tables (cleared and reloaded each run).
 * Note: the mini-CRM starter contacts ship as constants and are served by the
 * CRM endpoint, so they are not seeded into the session-scoped CRM table.
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
const sample = JSON.parse(readFileSync(join(here, '../src/lib/demo/sample-data.json'), 'utf8'));

const client = createClient({ url, authToken });

const statements = [
  // Marketing sample rows.
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
      'This is a seeded sample lead for local development.',
      'seed',
    ],
  },
  // Read-only Audit OS seed: clear then reload.
  { sql: 'DELETE FROM demo_findings', args: [] },
  { sql: 'DELETE FROM demo_workpapers', args: [] },
  { sql: 'DELETE FROM demo_metrics', args: [] },
  { sql: 'DELETE FROM demo_board_items', args: [] },
];

for (const f of sample.findings) {
  statements.push({
    sql: 'INSERT INTO demo_findings (ref, title, area, risk, status, owner, due_date, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    args: [f.ref, f.title, f.area, f.risk, f.status, f.owner, f.dueDate, f.summary],
  });
}
for (const w of sample.workpapers) {
  statements.push({
    sql: 'INSERT INTO demo_workpapers (finding_ref, title, body) VALUES (?, ?, ?)',
    args: [w.findingRef, w.title, w.body],
  });
}
for (const m of sample.metrics) {
  statements.push({
    sql: 'INSERT OR REPLACE INTO demo_metrics (key, value) VALUES (?, ?)',
    args: [m.key, m.value],
  });
}
for (const b of sample.boardItems) {
  statements.push({
    sql: 'INSERT INTO demo_board_items (title, status, note) VALUES (?, ?, ?)',
    args: [b.title, b.status, b.note],
  });
}

await client.batch(statements, 'write');

console.log(
  `✓ Seeded sample data (${sample.findings.length} findings, ${sample.metrics.length} metrics, ${sample.boardItems.length} board items)`,
);
