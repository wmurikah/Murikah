/**
 * Authorisation, proved at the resolver and as a SQL predicate.
 *
 * Against the operator's own seed, so "Gabriel Musembi is scoped to Kenya" is a
 * statement about the configuration this product will run against. Nothing here
 * points at hass-cms.
 *
 * The predicate is applied in the WHERE clause of a real query throughout. A
 * test that resolved a scope and then compared identifiers in JavaScript would
 * prove the resolver and not the thing that protects the data.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, query, type TestClient } from './support/db.ts';
import { seedHass, SEED } from './support/hassSeed.ts';
import {
  can,
  resolveScope,
  scopePredicate,
  explainScope,
  DENY_ALL,
  type ScopedColumns,
  forgetResolvedScopes,
} from '../../src/lib/cms/auth/rbac.ts';
import {
  assignUserRole,
  countAdministrators,
  createRole,
  listRoleHolders,
  listUserRoleAssignments,
  permissionMatrix,
  setRolePermissions,
  updateUserRole,
  LOCKOUT_PERMISSION,
  type WriteResult,
} from '../../src/lib/cms/repos/rbacAdmin.ts';

const NOW = new Date('2026-08-27T09:00:00Z');
const CTX = {
  actorUserId: SEED.admin,
  ip: '10.0.0.10',
  userAgent: 'HassCMS Test',
  now: NOW,
} as const;

const db = async (): Promise<TestClient> => {
  const c = createTestDb();
  await seedHass(c);
  // A Uganda account, so the critical negative test has something to be
  // refused. Every seeded account is Kenya, and a test that could not name a
  // Uganda record could not prove a Kenya user is kept out of one.
  await c.execute({
    sql: `INSERT INTO accounts (account_id, account_code, account_name, account_type, country_id, affiliate_id,
            account_manager_user_id, status, created_at, updated_at)
          VALUES ('ACC-UG-001','CUST-UG-001','Kampala Haulage Ltd','CUSTOMER','CTR-UG','AFF-UG','USR-FMUG','ACTIVE','2026-01-01 00:00:00','2026-01-01 00:00:00')`,
    args: [],
  });
  // And one with a null affiliate, which must reach no affiliate-scoped user.
  await c.execute({
    sql: `INSERT INTO accounts (account_id, account_code, account_name, account_type, country_id, affiliate_id,
            account_manager_user_id, status, created_at, updated_at)
          VALUES ('ACC-ORPHAN','CUST-ORPHAN','Unassigned Holdings Ltd','PROSPECT','CTR-KE',NULL,NULL,'ACTIVE','2026-01-01 00:00:00','2026-01-01 00:00:00')`,
    args: [],
  });
  return c;
};
const asClient = (c: TestClient) => c as unknown as Parameters<typeof resolveScope>[0];

/** The columns `accounts` offers. No `team`: the module has no team ownership. */
const ACCOUNT_COLUMNS: ScopedColumns = {
  country: 'a.country_id',
  affiliate: 'a.affiliate_id',
  owner: 'a.account_manager_user_id',
};

const VIEW = 'CRM.ACCOUNTS.VIEW';

/** Run a list query through the predicate, exactly as an endpoint would. */
async function visibleAccounts(
  c: TestClient,
  userId: string,
  permission = VIEW,
): Promise<string[]> {
  const resolution = await resolveScope(asClient(c), userId, permission);
  const predicate = scopePredicate(resolution, ACCOUNT_COLUMNS);
  const result = await c.execute({
    sql: `SELECT a.account_id FROM accounts a WHERE ${predicate.sql} ORDER BY a.account_id`,
    args: predicate.args as never[],
  });
  return result.rows.map((r) => String(r.account_id));
}

/** Fetch one record by id through the same predicate, as a detail endpoint would. */
async function fetchAccount(
  c: TestClient,
  userId: string,
  accountId: string,
): Promise<string | null> {
  const resolution = await resolveScope(asClient(c), userId, VIEW);
  const predicate = scopePredicate(resolution, ACCOUNT_COLUMNS);
  const result = await c.execute({
    sql: `SELECT a.account_id FROM accounts a WHERE a.account_id = ? AND ${predicate.sql} LIMIT 1`,
    args: [accountId, ...predicate.args] as never[],
  });
  return result.rows[0] ? String(result.rows[0].account_id) : null;
}

/** Give a role the permission the scope tests read, so scopes have something to scope. */
async function grantAccountsView(c: TestClient, roleId: string): Promise<void> {
  await c.execute({
    sql: `INSERT OR IGNORE INTO permissions (permission_id, module_name, resource_name, action_name, description)
          VALUES ('PERM-ACC-VIEW','CRM','ACCOUNTS','VIEW','View customer accounts')`,
    args: [],
  });
  await c.execute({
    sql: `INSERT OR IGNORE INTO role_permissions (role_permission_id, role_id, permission_id, allowed, created_at)
          VALUES (?, ?, 'PERM-ACC-VIEW', 1, '2026-01-01 00:00:00')`,
    args: [`RP-ACC-${roleId}`, roleId],
  });
}

const refused = <T>(r: WriteResult<T>) => {
  assert.ok(!r.ok, `expected a refusal, got ${JSON.stringify(r)}`);
  return { kind: r.kind, fields: r.kind === 'not_found' ? [] : r.fields };
};
const audits = (c: TestClient) => query(c, `SELECT * FROM audit_events`);

// ---- the one check ---------------------------------------------------------

test('the check reads permission codes and nothing else', () => {
  const principal = { userId: 'USR-X', permissions: ['ADMIN.ROLES.MANAGE'] };
  assert.equal(can(principal, 'ADMIN.ROLES.MANAGE'), true);
  assert.equal(can(principal, 'ADMIN.USERS.MANAGE'), false);
  assert.equal(can(null, 'ADMIN.ROLES.MANAGE'), false);
});

// ---- the matrix is data ----------------------------------------------------

test('the matrix renders from the table, and a new row appears with no code change', async () => {
  const c = await db();
  const before = await permissionMatrix(asClient(c), SEED.roleAdmin);
  const modules = before.map((m) => m.module);
  assert.ok(modules.includes('ADMIN'));
  assert.ok(!modules.includes('LOGISTICS'), 'nothing invents a module');

  // Insert a permission nothing in this repository has ever heard of.
  await c.execute({
    sql: `INSERT INTO permissions (permission_id, module_name, resource_name, action_name, description)
          VALUES ('PERM-NEW-1','LOGISTICS','FLEET','DISPATCH','Dispatch a delivery vehicle')`,
    args: [],
  });

  const after = await permissionMatrix(asClient(c), SEED.roleAdmin);
  const logistics = after.find((m) => m.module === 'LOGISTICS');
  assert.ok(logistics, 'a new module appears with no code change');
  assert.equal(logistics.resources[0]?.resource, 'FLEET');
  assert.equal(logistics.resources[0]?.actions[0]?.code, 'LOGISTICS.FLEET.DISPATCH');
  assert.equal(logistics.resources[0]?.actions[0]?.granted, false);
  c.close();
});

test('the matrix groups by module, then resource, then action', async () => {
  const c = await db();
  const matrix = await permissionMatrix(asClient(c), SEED.roleAdmin);
  const admin = matrix.find((m) => m.module === 'ADMIN');
  assert.ok(admin);
  // Five ADMIN resources are seeded, and every action beneath them is granted
  // to ROLE-ADMIN by the seed's own SELECT over the whole catalogue.
  assert.deepEqual(admin.resources.map((r) => r.resource).sort(), [
    'PRODUCT_CATALOG',
    'ROLES',
    'USERS',
    'WORKFLOWS',
    'WORKFLOW_ROLES',
  ]);
  assert.equal(admin.grantedCount, admin.totalCount);
  c.close();
});

// ---- the seven personas ----------------------------------------------------

test('the System Administrator resolves Group access', async () => {
  const c = await db();
  await grantAccountsView(c, SEED.roleAdmin);
  const resolution = await resolveScope(asClient(c), SEED.admin, VIEW);
  assert.equal(resolution.granted, true);
  assert.equal(resolution.group, true);
  assert.equal(scopePredicate(resolution, ACCOUNT_COLUMNS).sql, '1 = 1');
  assert.equal(
    (await visibleAccounts(c, SEED.admin)).length,
    7,
    'every account, including the orphan',
  );
  c.close();
});

test('Finance Manager Kenya resolves Kenya only', async () => {
  const c = await db();
  await grantAccountsView(c, 'ROLE-FIN');
  const visible = await visibleAccounts(c, SEED.gabriel);
  assert.ok(visible.includes('ACC-001'));
  assert.ok(!visible.includes('ACC-UG-001'), 'a Uganda account is not his');
  assert.ok(!visible.includes('ACC-ORPHAN'), 'a null affiliate reaches no affiliate-scoped user');
  assert.equal(visible.length, 5);
  c.close();
});

test('Finance Manager Uganda resolves Uganda only', async () => {
  const c = await db();
  await grantAccountsView(c, 'ROLE-FIN');
  const visible = await visibleAccounts(c, SEED.grace);
  assert.deepEqual(visible, ['ACC-UG-001']);
  c.close();
});

test('a Country Manager resolves the entity they are scoped to', async () => {
  const c = await db();
  await grantAccountsView(c, 'ROLE-CM');
  assert.equal((await visibleAccounts(c, SEED.amina)).length, 5, 'Amina is scoped to Kenya');
  assert.deepEqual(await visibleAccounts(c, SEED.daniel), ['ACC-UG-001'], 'Daniel to Uganda');
  c.close();
});

test('Group Finance resolves Group where granted', async () => {
  const c = await db();
  await grantAccountsView(c, 'ROLE-GRP-FIN');
  const resolution = await resolveScope(asClient(c), SEED.hassan, VIEW);
  assert.equal(resolution.group, true);
  assert.equal((await visibleAccounts(c, SEED.hassan)).length, 7);
  c.close();
});

test('a Sales Executive scoped to OWN resolves only their own records', async () => {
  const c = await db();
  await grantAccountsView(c, 'ROLE-SALES');
  // James manages the five seeded Kenya accounts and neither of the two added.
  const visible = await visibleAccounts(c, SEED.james);
  assert.deepEqual(visible, ['ACC-001', 'ACC-002', 'ACC-003', 'ACC-004', 'ACC-005']);
  assert.ok(!visible.includes('ACC-ORPHAN'), 'a null owner is nobody, not everybody');
  c.close();
});

test('a Customer Portal user inherits no internal module access', async () => {
  const c = await db();
  await grantAccountsView(c, 'ROLE-FIN');
  for (const external of SEED.external) {
    const resolution = await resolveScope(asClient(c), external, VIEW);
    assert.equal(resolution.granted, false, `${external} must hold no internal grant`);
    assert.equal(scopePredicate(resolution, ACCOUNT_COLUMNS).sql, DENY_ALL.sql);
    assert.deepEqual(await visibleAccounts(c, external), []);
  }
  c.close();
});

// ---- THE CRITICAL NEGATIVE TEST -------------------------------------------

test('Finance Manager Kenya cannot retrieve a Uganda record by calling directly', async () => {
  const c = await db();
  await grantAccountsView(c, 'ROLE-FIN');

  // Named explicitly, as an API caller would name it. Not reached through a
  // link, not reached through a list: asked for by identifier.
  const direct = await fetchAccount(c, SEED.gabriel, 'ACC-UG-001');
  assert.equal(direct, null, 'the server must not return it, whatever the interface offers');

  // And the same identifier fetched by the person it belongs to, so the test
  // proves a refusal rather than a broken query.
  assert.equal(await fetchAccount(c, SEED.grace, 'ACC-UG-001'), 'ACC-UG-001');

  // The list query, separately: the row is absent from the body, not filtered
  // out of the rendering.
  const list = await visibleAccounts(c, SEED.gabriel);
  assert.ok(!list.includes('ACC-UG-001'));
  assert.ok(!JSON.stringify(list).includes('ACC-UG-001'));
  c.close();
});

// ---- scope behaviour -------------------------------------------------------

test('two scopes union rather than intersect', async () => {
  const c = await db();
  await grantAccountsView(c, 'ROLE-FIN');
  // Gabriel is scoped to Kenya. Add Uganda to the same role assignment.
  await c.execute({
    sql: `INSERT INTO user_role_scopes (scope_id, user_role_id, scope_type, country_id, affiliate_id, business_unit_id, team_id, created_at)
          VALUES ('SCOPE-EXTRA','UR-003','AFFILIATE',NULL,'AFF-UG',NULL,NULL,'2026-01-01 00:00:00')`,
    args: [],
  });
  const visible = await visibleAccounts(c, SEED.gabriel);
  assert.ok(visible.includes('ACC-001'), 'Kenya is still his');
  assert.ok(visible.includes('ACC-UG-001'), 'and Uganda is now his too');
  assert.equal(visible.length, 6, 'the union, not the intersection and not the narrower one');
  c.close();
});

test('a record with a null scope column is returned to nobody but a Group holder', async () => {
  const c = await db();
  await grantAccountsView(c, 'ROLE-FIN');
  await grantAccountsView(c, SEED.roleAdmin);
  // The predicate says so in its own text, which is the part that is easy to
  // get wrong: a bare IN returns nothing on a null, an OR ... IS NULL returns
  // everything, and only one of the three readings is right.
  const resolution = await resolveScope(asClient(c), SEED.gabriel, VIEW);
  const predicate = scopePredicate(resolution, ACCOUNT_COLUMNS);
  assert.match(predicate.sql, /IS NOT NULL AND/);
  assert.ok(!/IS NULL\)/.test(predicate.sql), 'nothing widens on a null');

  assert.ok(!(await visibleAccounts(c, SEED.gabriel)).includes('ACC-ORPHAN'));
  assert.ok((await visibleAccounts(c, SEED.admin)).includes('ACC-ORPHAN'), 'Group covers it');
  c.close();
});

test('a TEAM scope on a module with no team ownership contributes nothing', async () => {
  const c = await db();
  await grantAccountsView(c, 'ROLE-FIN');
  await c.execute({
    sql: `UPDATE user_role_scopes SET scope_type = 'TEAM', affiliate_id = NULL, team_id = 'TEAM-FIN-KE' WHERE scope_id = 'SCOPE-003'`,
    args: [],
  });
  const resolution = await resolveScope(asClient(c), SEED.gabriel, VIEW);
  assert.equal(resolution.scopes[0]?.scopeType, 'TEAM');
  // `accounts` declares no team column, so the branch is not approximated into
  // something wider. Nothing in scope is visible in the result and an
  // administrator asks why, which is what gets the configuration corrected.
  assert.equal(scopePredicate(resolution, ACCOUNT_COLUMNS).sql, DENY_ALL.sql);
  assert.deepEqual(await visibleAccounts(c, SEED.gabriel), []);
  c.close();
});

test('a role that grants nothing resolves to a denial, not to everything', async () => {
  const c = await db();
  const resolution = await resolveScope(asClient(c), SEED.gabriel, 'CRM.ACCOUNTS.VIEW');
  assert.equal(resolution.granted, false);
  assert.equal(scopePredicate(resolution, ACCOUNT_COLUMNS).sql, '1 = 0');
  c.close();
});

test('a withheld row reads as not granted, which is the documented rule', async () => {
  const c = await db();
  await grantAccountsView(c, 'ROLE-FIN');
  await c.execute({
    sql: `UPDATE role_permissions SET allowed = 0 WHERE role_id = 'ROLE-FIN' AND permission_id = 'PERM-ACC-VIEW'`,
    args: [],
  });
  // The harness holds one client across a whole test and changes permissions
  // inside it, which a request never does. The phase 28 scope memo is scoped
  // to a client precisely because a client is a request, so the harness says
  // explicitly where one notional request ends and the next begins.
  forgetResolvedScopes(asClient(c));
  const withheld = await resolveScope(asClient(c), SEED.gabriel, VIEW);
  assert.equal(withheld.granted, false, 'the withholding role contributes nothing');

  // And it does not veto another role that grants the same code, which is the
  // consequence of the rule and is stated rather than hidden.
  await assignUserRole(
    asClient(c),
    SEED.gabriel,
    {
      roleId: SEED.roleAdmin,
      effectiveFrom: '2026-01-01',
      effectiveTo: null,
      active: true,
      scopes: [
        {
          scopeType: 'GROUP',
          countryId: null,
          affiliateId: null,
          businessUnitId: null,
          teamId: null,
        },
      ],
    },
    CTX,
  );
  await grantAccountsView(c, SEED.roleAdmin);
  forgetResolvedScopes(asClient(c));
  const combined = await resolveScope(asClient(c), SEED.gabriel, VIEW);
  assert.equal(combined.granted, true, 'the other role still grants it');
  assert.equal(combined.group, true);
  c.close();
});

test('the explanation names roles and scopes, and never a query', async () => {
  const c = await db();
  await grantAccountsView(c, 'ROLE-FIN');
  const text = explainScope(await resolveScope(asClient(c), SEED.gabriel, VIEW));
  assert.match(text, /Finance Manager/);
  assert.match(text, /AFF-KE/);
  assert.ok(!text.includes('SELECT'), 'a configuration dump is not an explanation');
  c.close();
});

// ---- roles created at runtime ---------------------------------------------

test('a role created at runtime works with no deployment', async () => {
  const c = await db();
  const created = await createRole(
    asClient(c),
    {
      roleName: 'Regional Customer Service Lead',
      description: 'Runs customer service across two affiliates',
      active: true,
    },
    CTX,
  );
  assert.ok(created.ok, JSON.stringify(created));
  assert.equal(created.value.isSystemRole, false, 'a role created here is never a system role');

  await c.execute({
    sql: `INSERT INTO permissions (permission_id, module_name, resource_name, action_name, description)
          VALUES ('PERM-ACC-VIEW','CRM','ACCOUNTS','VIEW','View customer accounts')`,
    args: [],
  });
  const granted = await setRolePermissions(
    asClient(c),
    created.value.roleId,
    [{ permissionId: 'PERM-ACC-VIEW', granted: true }],
    CTX,
  );
  assert.ok(granted.ok);

  const assigned = await assignUserRole(
    asClient(c),
    SEED.james,
    {
      roleId: created.value.roleId,
      effectiveFrom: '2026-01-01',
      effectiveTo: null,
      active: true,
      scopes: [
        {
          scopeType: 'AFFILIATE',
          countryId: null,
          affiliateId: SEED.affKenya,
          businessUnitId: null,
          teamId: null,
        },
        {
          scopeType: 'AFFILIATE',
          countryId: null,
          affiliateId: SEED.affUganda,
          businessUnitId: null,
          teamId: null,
        },
      ],
    },
    CTX,
  );
  assert.ok(assigned.ok, JSON.stringify(assigned));
  assert.equal(assigned.value.scopes.length, 2);

  // And it resolves, immediately, with nothing recompiled.
  const visible = await visibleAccounts(c, SEED.james);
  assert.ok(visible.includes('ACC-001') && visible.includes('ACC-UG-001'));
  c.close();
});

// ---- the last System Administrator ----------------------------------------

test('Catherine is the only holder of ADMIN.ROLES.MANAGE, so the guard is not theoretical', async () => {
  const c = await db();
  assert.equal(await countAdministrators(asClient(c)), 1);
  const holders = await listRoleHolders(asClient(c), SEED.roleAdmin);
  assert.deepEqual(
    holders.filter((h) => h.current).map((h) => h.displayName),
    ['Catherine Mwangi'],
  );
  c.close();
});

test('removing the last System Administrator is refused', async () => {
  const c = await db();
  const held = await listUserRoleAssignments(asClient(c), SEED.admin);
  const admin = held.find((r) => r.roleId === SEED.roleAdmin);
  assert.ok(admin);

  const result = refused(
    await updateUserRole(
      asClient(c),
      admin.userRoleId,
      { effectiveTo: null, active: false, scopes: null },
      CTX,
    ),
  );
  assert.match(String(result.fields[0]?.message), /nobody able to administer roles/);
  // And nothing was written.
  assert.equal(
    query(c, `SELECT active FROM user_roles WHERE user_role_id = ?`, admin.userRoleId)[0]?.active,
    1,
  );
  assert.equal(await countAdministrators(asClient(c)), 1);
  c.close();
});

test('revoking the permission from the last role that carries it is refused', async () => {
  const c = await db();
  const matrix = await permissionMatrix(asClient(c), SEED.roleAdmin);
  const rolesManage = matrix
    .flatMap((m) => m.resources.flatMap((r) => r.actions))
    .find((a) => a.code === LOCKOUT_PERMISSION);
  assert.ok(rolesManage);

  const result = refused(
    await setRolePermissions(
      asClient(c),
      SEED.roleAdmin,
      [{ permissionId: rolesManage.permissionId, granted: false }],
      CTX,
    ),
  );
  assert.match(String(result.fields[0]?.message), /nobody able to administer roles/);
  assert.equal(await countAdministrators(asClient(c)), 1);
  c.close();
});

test('the same removal is allowed once a second administrator exists', async () => {
  const c = await db();
  await assignUserRole(
    asClient(c),
    SEED.hassan,
    {
      roleId: SEED.roleAdmin,
      effectiveFrom: '2026-01-01',
      effectiveTo: null,
      active: true,
      scopes: [
        {
          scopeType: 'GROUP',
          countryId: null,
          affiliateId: null,
          businessUnitId: null,
          teamId: null,
        },
      ],
    },
    CTX,
  );
  assert.equal(await countAdministrators(asClient(c)), 2);

  const held = await listUserRoleAssignments(asClient(c), SEED.admin);
  const admin = held.find((r) => r.roleId === SEED.roleAdmin);
  assert.ok(admin);
  const result = await updateUserRole(
    asClient(c),
    admin.userRoleId,
    { effectiveTo: null, active: false, scopes: null },
    CTX,
  );
  assert.ok(result.ok, 'the guard is about the last one, not about the role');
  assert.equal(await countAdministrators(asClient(c)), 1);
  c.close();
});

// ---- crafted payloads ------------------------------------------------------

test('a permission id the catalogue does not contain is ignored, never inserted', async () => {
  const c = await db();
  const created = await createRole(
    asClient(c),
    { roleName: 'Data Uploader', description: null, active: true },
    CTX,
  );
  assert.ok(created.ok);

  await setRolePermissions(
    asClient(c),
    created.value.roleId,
    [{ permissionId: 'PERM-DOES-NOT-EXIST', granted: true }],
    CTX,
  );
  const rows = query(c, `SELECT * FROM role_permissions WHERE role_id = ?`, created.value.roleId);
  assert.equal(rows.length, 0, 'a crafted id cannot introduce a code by naming one');
  c.close();
});

test('a role created through the interface can never claim to be a system role', async () => {
  const c = await db();
  const created = await createRole(
    asClient(c),
    // The extra field is not in RoleInput and is not read. A payload that
    // carried is_system_role would set nothing.
    { roleName: 'Pretender', description: null, active: true, isSystemRole: true } as never,
    CTX,
  );
  assert.ok(created.ok);
  assert.equal(
    query(c, `SELECT is_system_role FROM access_roles WHERE role_id = ?`, created.value.roleId)[0]
      ?.is_system_role,
    0,
  );
  c.close();
});

// ---- audit -----------------------------------------------------------------

test('every RBAC change is audited with its before and after state', async () => {
  const c = await db();
  const created = await createRole(
    asClient(c),
    { roleName: 'Auditable Role', description: 'first', active: true },
    CTX,
  );
  assert.ok(created.ok);
  const roleId = created.value.roleId;

  await c.execute({
    sql: `INSERT INTO permissions (permission_id, module_name, resource_name, action_name) VALUES ('PERM-AUD','CRM','ACCOUNTS','VIEW')`,
    args: [],
  });
  await setRolePermissions(asClient(c), roleId, [{ permissionId: 'PERM-AUD', granted: true }], CTX);
  await setRolePermissions(
    asClient(c),
    roleId,
    [{ permissionId: 'PERM-AUD', granted: false }],
    CTX,
  );
  const assigned = await assignUserRole(
    asClient(c),
    SEED.james,
    {
      roleId,
      effectiveFrom: '2026-01-01',
      effectiveTo: null,
      active: true,
      scopes: [
        {
          scopeType: 'OWN',
          countryId: null,
          affiliateId: null,
          businessUnitId: null,
          teamId: null,
        },
      ],
    },
    CTX,
  );
  assert.ok(assigned.ok);
  await updateUserRole(
    asClient(c),
    assigned.value.userRoleId,
    {
      effectiveTo: null,
      active: true,
      scopes: [
        {
          scopeType: 'AFFILIATE',
          countryId: null,
          affiliateId: SEED.affKenya,
          businessUnitId: null,
          teamId: null,
        },
      ],
    },
    CTX,
  );
  await updateUserRole(
    asClient(c),
    assigned.value.userRoleId,
    { effectiveTo: '2026-12-31', active: false, scopes: null },
    CTX,
  );
  await createRole(
    asClient(c),
    { roleName: 'Auditable Role', description: null, active: true },
    CTX,
  );
  const deactivated = await import('../../src/lib/cms/repos/rbacAdmin.ts').then((m) =>
    m.updateRole(
      asClient(c),
      roleId,
      { roleName: 'Auditable Role', description: 'second', active: false },
      CTX,
    ),
  );
  assert.ok(deactivated.ok);

  const events = new Set(audits(c).map((r) => String(r.event_type)));
  for (const expected of [
    'ROLE_CREATED',
    'ROLE_DEACTIVATED',
    'PERMISSION_GRANTED',
    'PERMISSION_REVOKED',
    'USER_ROLE_ASSIGNED',
    'USER_ROLE_REMOVED',
    'ROLE_SCOPE_ASSIGNED',
    'ROLE_SCOPE_CHANGED',
  ]) {
    assert.ok(events.has(expected), `${expected} must be written`);
  }

  const roleCreated = audits(c).find(
    (r) => r.event_type === 'ROLE_CREATED' && r.entity_id === roleId,
  );
  assert.equal(roleCreated?.actor_user_id, SEED.admin);
  assert.equal(roleCreated?.before_json, null);
  const roleUpdated = audits(c).find((r) => r.event_type === 'ROLE_DEACTIVATED');
  assert.equal(JSON.parse(String(roleUpdated?.before_json)).description, 'first');
  assert.equal(JSON.parse(String(roleUpdated?.after_json)).description, 'second');
  c.close();
});

test('a read writes no audit row', async () => {
  const c = await db();
  await permissionMatrix(asClient(c), SEED.roleAdmin);
  await listRoleHolders(asClient(c), SEED.roleAdmin);
  await listUserRoleAssignments(asClient(c), SEED.gabriel);
  await resolveScope(asClient(c), SEED.gabriel, VIEW);
  assert.equal(audits(c).length, 0);
  c.close();
});
