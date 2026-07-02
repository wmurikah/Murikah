/**
 * Create the first Engineering Rhythm tenant so login works end to end.
 *
 * Run:  pnpm db:engr:bootstrap
 * (loads .dev.vars if present, else uses process.env). Idempotent: re-running
 * reuses the organisation, owner, stations, category and subscription rather
 * than duplicating them.
 *
 * The owner email and initial password come from environment variables, never
 * hardcoded:
 *   ENGR_OWNER_EMAIL, ENGR_OWNER_PASSWORD  (required)
 *   ENGR_OWNER_NAME, ENGR_ORG_NAME, ENGR_ORG_SLUG  (optional)
 *
 * Apply the schema and seed first (pnpm db:engr:apply, pnpm db:engr:seed), so
 * the OWNER system role and the TRIAL plan exist.
 */
import { createClient } from '@libsql/client/web';
import { randomUUID } from 'node:crypto';
// Relative import (Node does not resolve the @engr tsconfig alias) so the same
// PBKDF2 hashing is used here as at login.
import { hashPassword } from '../../src/lib/engr/auth/password.ts';

const url = process.env.TURSO_ENGR_DATABASE_URL;
const authToken = process.env.TURSO_ENGR_AUTH_TOKEN;

if (!url) {
  console.error('✗ TURSO_ENGR_DATABASE_URL is not set. Add it to .dev.vars or your environment.');
  process.exit(1);
}

const ownerEmail = (process.env.ENGR_OWNER_EMAIL ?? '').trim().toLowerCase();
const ownerPassword = process.env.ENGR_OWNER_PASSWORD ?? '';
const ownerName = (process.env.ENGR_OWNER_NAME ?? 'Account Owner').trim();
const orgName = (process.env.ENGR_ORG_NAME ?? 'Demo Engineering Co').trim();
const orgSlug = (process.env.ENGR_ORG_SLUG ?? 'demo').trim().toLowerCase();

if (!ownerEmail || !ownerPassword) {
  console.error(
    '✗ Set ENGR_OWNER_EMAIL and ENGR_OWNER_PASSWORD (optionally ENGR_OWNER_NAME, ENGR_ORG_NAME, ENGR_ORG_SLUG) before running.',
  );
  process.exit(1);
}

const newId = (): string => randomUUID().replace(/-/g, '');
const client = createClient({ url, authToken });
await client.execute('PRAGMA foreign_keys = ON;');

// 1. Organisation, idempotent by unique slug.
await client.execute({
  sql: `INSERT OR IGNORE INTO organisations (id, name, slug, country, base_currency)
        VALUES (?, ?, ?, 'KE', 'KES')`,
  args: [newId(), orgName, orgSlug],
});
const orgRow = (
  await client.execute({
    sql: `SELECT id FROM organisations WHERE slug = ? LIMIT 1`,
    args: [orgSlug],
  })
).rows[0];
if (!orgRow) throw new Error('Could not create or find the organisation.');
const orgId = String(orgRow.id);

// 2. Owner user, idempotent by (org_id, email). The password is only set when
//    the user is first created; a re-run leaves an existing password unchanged.
const existingUser = (
  await client.execute({
    sql: `SELECT id FROM users WHERE org_id = ? AND email = ? LIMIT 1`,
    args: [orgId, ownerEmail],
  })
).rows[0];

let userId: string;
let createdUser = false;
if (existingUser) {
  userId = String(existingUser.id);
} else {
  userId = newId();
  const passwordHash = await hashPassword(ownerPassword);
  await client.execute({
    sql: `INSERT INTO users (id, org_id, full_name, email, password_hash, status)
          VALUES (?, ?, ?, ?, ?, 'ACTIVE')`,
    args: [userId, orgId, ownerName, ownerEmail, passwordHash],
  });
  createdUser = true;
}

// 3. Grant the OWNER system role (seeded with org_id IS NULL).
const roleRow = (
  await client.execute({
    sql: `SELECT id FROM roles WHERE code = 'OWNER' AND org_id IS NULL LIMIT 1`,
  })
).rows[0];
if (!roleRow) throw new Error('OWNER system role not found. Run pnpm db:engr:seed first.');
await client.execute({
  sql: `INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)`,
  args: [userId, String(roleRow.id)],
});

// 4. Two example stations and one asset category, so the intake form has
//    options. Idempotent by (org_id, code).
await client.batch(
  [
    {
      sql: `INSERT OR IGNORE INTO stations (id, org_id, code, name, is_base) VALUES (?, ?, 'HQ', 'Head Office', 1)`,
      args: [newId(), orgId],
    },
    {
      sql: `INSERT OR IGNORE INTO stations (id, org_id, code, name) VALUES (?, ?, 'ST-01', 'Station One')`,
      args: [newId(), orgId],
    },
    {
      sql: `INSERT OR IGNORE INTO asset_categories (id, org_id, code, name) VALUES (?, ?, 'GEN', 'Generators')`,
      args: [newId(), orgId],
    },
  ],
  'write',
);

// 5. A TRIALING subscription on the TRIAL plan, only if the org has none.
const hasSubscription = (
  await client.execute({
    sql: `SELECT 1 AS one FROM subscriptions WHERE org_id = ? LIMIT 1`,
    args: [orgId],
  })
).rows[0];
if (!hasSubscription) {
  const planRow = (
    await client.execute({ sql: `SELECT id FROM plans WHERE code = 'TRIAL' LIMIT 1` })
  ).rows[0];
  if (!planRow) throw new Error('TRIAL plan not found. Run pnpm db:engr:seed first.');
  await client.execute({
    sql: `INSERT INTO subscriptions (id, org_id, plan_id, status) VALUES (?, ?, ?, 'TRIALING')`,
    args: [newId(), orgId, String(planRow.id)],
  });
}

console.log('');
console.log('✓ Engineering Rhythm tenant ready.');
console.log(`  Organisation : ${orgName}  (slug: ${orgSlug})`);
console.log(`  Owner email  : ${ownerEmail}`);
console.log(
  createdUser
    ? '  Owner user   : created with the supplied password.'
    : '  Owner user   : already existed, password left unchanged.',
);
console.log('');
console.log('  Sign in at /engr/login with the organisation slug, owner email and password.');
process.exit(0);
