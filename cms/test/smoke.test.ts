/**
 * Data-layer smoke test against the seeded non-production database. It applies to
 * a local libSQL file (or a staging Turso URL via CMS_DB_URL) that has been
 * seeded with `pnpm cms:db:apply && pnpm cms:db:seed`; when no seeded database is
 * present it skips cleanly, so CI without a seed stays honest rather than falsely
 * green. It exercises the core reads every phase relies on and verifies the demo
 * sign-in, so a broken query or a schema drift is caught before a page 500s.
 *
 * This complements the app-level smoke crawl (sign in and GET every page), which
 * runs against a staging Turso HTTP endpoint the Worker build can reach; a local
 * libSQL file is node-only. Both are gated behind the same seeded database.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { webcrypto as crypto } from 'node:crypto';
import { createClient } from '@libsql/client';

const url = process.env.CMS_DB_URL ?? 'file:cms/.data/staging.db';
const fileMissing = url.startsWith('file:') && !existsSync(url.slice('file:'.length));
const skip = fileMissing
  ? 'no seeded database (run: pnpm cms:db:apply && pnpm cms:db:seed)'
  : false;

/** Verify a pbkdf2$iter$salt$hash value the way the app's shared verifier does. */
async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number(parts[1]);
  const salt = Buffer.from(parts[2], 'base64');
  const expected = Buffer.from(parts[3], 'base64');
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(plain),
    { name: 'PBKDF2' },
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    expected.length * 8,
  );
  return Buffer.from(new Uint8Array(bits)).equals(expected);
}

test('cms smoke: seeded customers and contacts read back', { skip }, async () => {
  const db = createClient({ url });
  const customers = await db.execute('SELECT customer_id, company_name FROM customers');
  assert.ok(customers.rows.length > 0, 'expected seeded customers');

  const first = String(customers.rows[0].customer_id);
  const contacts = await db.execute({
    sql: 'SELECT contact_id FROM contacts WHERE customer_id = ?',
    args: [first],
  });
  assert.ok(contacts.rows.length >= 0, 'contacts query runs');
});

test('cms smoke: the staff sign-in resolves with its role and permissions', { skip }, async () => {
  const db = createClient({ url });
  const user = await db.execute({
    sql: "SELECT user_id, password_hash FROM users WHERE email = ? AND status = 'ACTIVE'",
    args: ['admin@hasspetroleum.com'],
  });
  assert.equal(user.rows.length, 1, 'expected the seeded super admin');
  const userId = String(user.rows[0].user_id);

  const role = await db.execute({
    sql: 'SELECT role_code FROM user_roles WHERE user_id = ?',
    args: [userId],
  });
  assert.ok(
    role.rows.some((r) => r.role_code === 'SUPER_ADMIN'),
    'expected the super admin role',
  );

  const perms = await db.execute({
    sql: 'SELECT permission_code FROM role_permissions WHERE role_code = ?',
    args: ['SUPER_ADMIN'],
  });
  assert.ok(
    perms.rows.some((r) => r.permission_code === 'customers.view'),
    'expected the customers.view grant',
  );

  const ok = await verifyPassword('HassDemo1!', String(user.rows[0].password_hash));
  assert.equal(ok, true, 'the demo password verifies against the seeded hash');
});

test('cms smoke: a portal customer can sign in', { skip }, async () => {
  const db = createClient({ url });
  const contact = await db.execute({
    sql: "SELECT password_hash FROM contacts WHERE is_portal_user = 1 AND status = 'ACTIVE' LIMIT 1",
  });
  assert.equal(contact.rows.length, 1, 'expected a seeded portal contact');
  const ok = await verifyPassword('HassDemo1!', String(contact.rows[0].password_hash));
  assert.equal(ok, true, 'the demo portal password verifies');
});
