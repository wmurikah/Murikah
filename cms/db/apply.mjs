// Apply the committed schema snapshot and migrations to a libSQL target, for a
// non-production seeded database (a local libSQL file for dev and CI data-layer
// checks, or a staging Turso HTTP URL for the running app, smoke test and demo
// video). It never touches production: the target is CMS_DB_URL (and optional
// CMS_DB_AUTH_TOKEN), defaulting to a local file under cms/.data (gitignored).
//
//   CMS_DB_URL=file:cms/.data/staging.db pnpm cms:db:apply
//   CMS_DB_URL=libsql://staging-... CMS_DB_AUTH_TOKEN=... pnpm cms:db:apply
//
// Idempotent where the DDL is (CREATE TABLE IF NOT EXISTS in the migrations); the
// base schema snapshot is applied to a fresh database. A build-time dev tool; it
// ships nothing to the Worker.
import { createClient } from '@libsql/client';
import { readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const url = process.env.CMS_DB_URL ?? 'file:cms/.data/staging.db';
const authToken = process.env.CMS_DB_AUTH_TOKEN;

if (url.startsWith('file:')) {
  // Ensure the directory for the local file target exists (path is relative to cwd).
  const filePath = url.slice('file:'.length);
  mkdirSync(dirname(filePath), { recursive: true });
}

const db = createClient(authToken ? { url, authToken } : { url });

async function runScript(label, sql) {
  await db.executeMultiple(sql);
  console.log(`applied ${label}`);
}

// The base schema snapshot (the live ground truth), then ordered migrations.
await runScript('schema.sql', readFileSync(join(here, 'schema.sql'), 'utf8'));
const migDir = join(here, 'migrations');
const migrations = readdirSync(migDir)
  .filter((f) => f.endsWith('.sql'))
  .sort();
for (const m of migrations) {
  await runScript(`migrations/${m}`, readFileSync(join(migDir, m), 'utf8'));
}

console.log(`Schema applied to ${url.startsWith('file:') ? url : 'the configured libSQL target'}.`);
