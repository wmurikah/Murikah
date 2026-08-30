/**
 * Build Prompt 39, fault two: the permission that does not exist.
 *
 * The customers page requires `CUSTOMERS.ACCOUNTS.VIEW`. The seeded
 * `permissions` table holds 28 rows across ADMIN, AUDIT, CREDIT, CRM, DATA,
 * ORDERS, PORTAL, SERVICE and SLA, and has no CUSTOMERS module at all. The code
 * the page requires cannot be held by anybody, so everybody is refused —
 * correctly, and indistinguishably from a working guard, which is why it was
 * reported as a fault in the page rather than a gap in the data.
 *
 * A CODE THAT EXISTS ONLY IN TYPESCRIPT IS A PAGE NOBODY CAN OPEN. That is the
 * failure mode this file exists to close: the assertions below hold
 * `src/lib/cms/permissions.ts` and the operator's data script to each other, so
 * the day somebody adds a code in one and forgets the other, the suite says so
 * rather than an administrator discovering it as a refusal months later.
 *
 * IT ALSO PINS THE COLLISION. Two earlier scripts both chose `PERM-041`, for
 * two different codes. `permission_id` is the primary key and both statements
 * are INSERT OR IGNORE, so whichever ran second was silently discarded while
 * its grant still succeeded against the other script's row. The reconciliation
 * script derives every id from its code, so that cannot recur, and the test at
 * the end proves both codes survive a run in either order.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTestDb } from './support/db.ts';
import { seedHass, SEED } from './support/hassSeed.ts';
import * as catalogue from '../../src/lib/cms/permissions.ts';
import { resolveScope, forgetResolvedScopes } from '../../src/lib/cms/auth/rbac.ts';

const SCRIPT = 'docs/cms/permissions/12_reconcile_permission_catalogue.sql';
const CODE = /^[A-Z][A-Z0-9_]*\.[A-Z][A-Z0-9_]*\.[A-Z][A-Z0-9_]*$/;

/**
 * Every code the application names, from the one module that names them.
 *
 * Read by VALUE rather than from a hand-kept list, so a code added to that
 * module is covered by every assertion here the moment it is exported. The
 * module also exports helper functions, which is what the shape test filters
 * out: a code is three uppercase segments separated by dots and nothing else
 * is.
 */
function requiredCodes(): string[] {
  const values: unknown[] = Object.values(catalogue);
  const codes = values.filter((v): v is string => typeof v === 'string' && CODE.test(v));
  return [...new Set(codes)].sort();
}

/** Every code the data script inserts. */
function scriptCodes(): string[] {
  const sql = readFileSync(SCRIPT, 'utf8');
  const insert = sql.slice(
    sql.indexOf('INSERT OR IGNORE INTO permissions'),
    sql.indexOf('-- 2. Grant every one of them'),
  );
  return [...insert.matchAll(/\('PERM-[A-Z0-9_-]+','([A-Z_]+)','([A-Z_]+)','([A-Z_]+)'/g)]
    .map((m) => `${m[1]}.${m[2]}.${m[3]}`)
    .sort();
}

test('every code the application checks is in the data script', () => {
  const required = requiredCodes();
  const inScript = scriptCodes();
  const missing = required.filter((code) => !inScript.includes(code));
  assert.deepEqual(missing, [], `codes the application checks and the script omits: ${missing}`);
  console.log(`[permissions] the application checks ${required.length} codes`);
});

test('the data script adds nothing the application does not check', () => {
  // A granted code nothing reads is a permission that cannot be audited by
  // observing behaviour, so the script is a mirror rather than a wish list.
  const required = requiredCodes();
  const extra = scriptCodes().filter((code) => !required.includes(code));
  assert.deepEqual(extra, [], `codes the script adds and nothing checks: ${extra}`);
});

test('no permission id in the script is claimed twice', () => {
  // THE PERM-041 FAULT, ASSERTED AGAINST. Two earlier scripts both chose that
  // id for different codes, and INSERT OR IGNORE on a primary key discards the
  // second silently.
  const ids = [...readFileSync(SCRIPT, 'utf8').matchAll(/\('(PERM-[A-Z0-9_-]+)',/g)].map(
    (m) => m[1]!,
  );
  assert.deepEqual(
    ids.filter((id, i) => ids.indexOf(id) !== i),
    [],
    'an id is claimed twice, which INSERT OR IGNORE would discard in silence',
  );
  // And every id is derived from its code, which is what makes that structural
  // rather than a thing somebody remembered to check.
  const rows = [
    ...readFileSync(SCRIPT, 'utf8').matchAll(
      /\('(PERM-[A-Z0-9_-]+)','([A-Z_]+)','([A-Z_]+)','([A-Z_]+)'/g,
    ),
  ];
  for (const [, id, module, resource, action] of rows) {
    assert.equal(id, `PERM-${module}-${resource}-${action}`, `${id} is not derived from its code`);
  }
});

test('the script uses INSERT OR IGNORE and no transaction keywords', () => {
  const sql = readFileSync(SCRIPT, 'utf8');
  const statements = sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
  assert.ok(!/\bBEGIN\b|\bCOMMIT\b|\bROLLBACK\b|\bSAVEPOINT\b|\bTRANSACTION\b/i.test(statements));
  // Every write is an idempotent insert. Nothing updates and nothing deletes,
  // so a partial run is safe to repeat rather than something to unpick.
  for (const write of statements.matchAll(/^\s*(INSERT|UPDATE|DELETE|DROP|ALTER)\b[^\n]*/gim)) {
    assert.match(write[0]!, /^\s*INSERT OR IGNORE\b/i, `not idempotent: ${write[0]!.trim()}`);
  }
});

/**
 * The script's statements, comments stripped BEFORE the split on `;`.
 *
 * The order matters and is the point of this helper: splitting first would cut
 * a comment that contains a semicolon in half and leave its second line
 * standing as SQL. That is not a hypothetical — a prose semicolon in this file
 * did exactly that, and some consoles split the same naive way, so the script
 * now carries no semicolon in any comment either.
 */
function statementsOf(sql: string): string[] {
  const code = sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
  return code
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement !== '');
}

test('no comment in the script carries a semicolon', () => {
  // A console that splits on `;` before stripping comments would run the tail
  // of that comment as SQL. Cheap to guarantee, expensive to debug.
  const offenders = readFileSync(SCRIPT, 'utf8')
    .split('\n')
    .filter((line) => line.trimStart().startsWith('--') && line.includes(';'));
  assert.deepEqual(offenders, [], 'a comment carries a semicolon');
});

test('after the script runs, the administrator can open a customer', async () => {
  const db = createTestDb();
  await seedHass(db);

  // BEFORE. The code does not exist, so the resolver refuses — which is exactly
  // what the live database does today and exactly what was reported as a fault
  // in the page.
  const before = await resolveScope(db as never, SEED.admin, catalogue.ACCOUNTS_VIEW);
  assert.equal(before.granted, false, 'the seeded catalogue should not hold the customer code');

  // AFTER. The operator's script, run verbatim from the file rather than from a
  // copy of it, so this test fails if the file changes and stops working.
  for (const statement of statementsOf(readFileSync(SCRIPT, 'utf8'))) {
    await db.execute(statement);
  }
  forgetResolvedScopes(db as never);

  const after = await resolveScope(db as never, SEED.admin, catalogue.ACCOUNTS_VIEW);
  assert.equal(after.granted, true, 'the administrator still cannot open a customer');

  // And every other code the application checks, not only the reported one.
  for (const code of requiredCodes()) {
    forgetResolvedScopes(db as never);
    const resolved = await resolveScope(db as never, SEED.admin, code);
    assert.equal(resolved.granted, true, `the administrator does not hold ${code}`);
  }

  // THE NEW EXPECTED COUNT. It was 28 before any script ran; the earlier
  // acceptance criteria that name 28 should be updated to this rather than read
  // as a regression.
  const resolved = await db.execute(`
    SELECT COUNT(DISTINCT p.module_name || '.' || p.resource_name || '.' || p.action_name) AS n
      FROM user_roles ur
      JOIN role_permissions rp ON rp.role_id = ur.role_id AND rp.allowed = 1
      JOIN permissions p ON p.permission_id = rp.permission_id
     WHERE ur.user_id = '${SEED.admin}' AND ur.active = 1`);
  console.log(
    `[permissions] the administrator resolves ${resolved.rows[0]!.n} codes after the script`,
  );
  assert.ok(
    Number(resolved.rows[0]!.n) >= requiredCodes().length,
    'the administrator holds fewer codes than the application checks',
  );
  db.close();
});

test('the two codes that collided on PERM-041 both survive', async () => {
  const db = createTestDb();
  await seedHass(db);
  for (const statement of statementsOf(readFileSync(SCRIPT, 'utf8'))) {
    await db.execute(statement);
  }
  const found = await db.execute(`
    SELECT module_name || '.' || resource_name || '.' || action_name AS code
      FROM permissions
     WHERE code IN ('AUDIT.EVENTS.SECURITY_VIEW', 'EXECUTIVE.DASHBOARD.VIEW')
     ORDER BY code`);
  assert.deepEqual(
    found.rows.map((row) => String(row.code)),
    ['AUDIT.EVENTS.SECURITY_VIEW', 'EXECUTIVE.DASHBOARD.VIEW'],
    'one of the two codes that shared PERM-041 is still missing',
  );
  db.close();
});
