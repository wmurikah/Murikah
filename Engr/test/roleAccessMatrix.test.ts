/**
 * Executable contract for the Engineering Rhythm role catalogue.
 *
 * The UI is deliberately not the source of truth for access.  These tests load
 * the real migration set and seed catalogue into SQLite, then assert the
 * permissions that separate makers, approvers, external actors and finance.
 * A future edit to seed.sql that quietly broadens a role therefore fails CI.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createClient, type Client } from '@libsql/client';
import { runMigrations } from '../db/migrate.ts';
import { loadUserAuth } from '../src/lib/engr/auth/rbac.ts';
import {
  mayAssignRoleCode,
  mayManageTargetUser,
  userManagementScope,
} from '../src/lib/engr/auth/adminPolicy.ts';

interface TestDatabase {
  client: Client;
  close(): void;
}

function database(): TestDatabase {
  const directory = mkdtempSync(join(tmpdir(), 'engr-role-test-'));
  const client = createClient({ url: `file:${join(directory, 'test.db')}` });
  return {
    client,
    close() {
      client.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function seededDatabase(): Promise<TestDatabase> {
  const db = database();
  await runMigrations(db.client);
  const seed = readFileSync(new URL('../db/seed.sql', import.meta.url), 'utf8');
  await db.client.executeMultiple(seed);
  return db;
}

async function permissionsFor(client: Client, role: string): Promise<Set<string>> {
  const result = await client.execute({
    sql: `SELECT p.key
            FROM roles r
            JOIN role_permissions rp ON rp.role_id = r.id
            JOIN permissions p ON p.id = rp.permission_id
           WHERE r.org_id IS NULL AND r.code = ?
        ORDER BY p.key`,
    args: [role],
  });
  return new Set(result.rows.map((row) => String(row.key)));
}

function requires(role: string, actual: Set<string>, keys: string[]): void {
  for (const key of keys) {
    assert.equal(actual.has(key), true, `${role} must have ${key}`);
  }
}

function forbids(role: string, actual: Set<string>, keys: string[]): void {
  for (const key of keys) {
    assert.equal(actual.has(key), false, `${role} must not have ${key}`);
  }
}

test('the catalogue defines every supported role and no ungranted permission', async () => {
  const db = await seededDatabase();
  try {
    const roles = await db.client.execute(
      `SELECT code FROM roles WHERE org_id IS NULL ORDER BY code`,
    );
    assert.deepEqual(
      roles.rows.map((row) => String(row.code)),
      [
        'ADMIN',
        'CONTRACTOR',
        'ENGINEER',
        'ENGINEERING_MANAGER',
        'FINANCIAL_CONTROLLER',
        'OWNER',
        'STATION_MANAGER',
        'TECHNICIAN',
        'VIEWER',
      ],
    );

    const orphaned = await db.client.execute(
      `SELECT p.key
         FROM permissions p
        WHERE NOT EXISTS (
          SELECT 1 FROM role_permissions rp WHERE rp.permission_id = p.id
        )
        ORDER BY p.key`,
    );
    assert.deepEqual(orphaned.rows, [], 'every registered permission needs an intentional owner');
  } finally {
    db.close();
  }
});

test('owner and administrator receive the complete permission registry', async () => {
  const db = await seededDatabase();
  try {
    const total = Number(
      (await db.client.execute('SELECT COUNT(*) AS n FROM permissions')).rows[0].n,
    );
    assert.equal((await permissionsFor(db.client, 'OWNER')).size, total);
    assert.equal((await permissionsFor(db.client, 'ADMIN')).size, total);
  } finally {
    db.close();
  }
});

test('engineer is a maker and verifier without approval or administration powers', async () => {
  const db = await seededDatabase();
  try {
    const p = await permissionsFor(db.client, 'ENGINEER');
    requires('ENGINEER', p, [
      'requests.view',
      'requests.create',
      'requests.edit',
      'requests.submit',
      'rfq.view',
      'rfq.create',
      'rfq.edit',
      'rfq.submit',
      'pm.view',
      'pm.create',
      'pm.edit',
      'lpo.view',
      'lpo.create',
      'lpo.edit',
      'lpo.submit',
      'workorder.view',
      'workorder.create',
      'workorder.edit',
      'cost.view',
      'cost.verify',
      'bill.view',
      'bill.verify',
      'engineer_assignments.view',
      'attachments.upload',
      'reports.view',
    ]);
    forbids('ENGINEER', p, [
      'requests.accept',
      'requests.reject',
      'requests.route',
      'rfq.release',
      'rfq.award',
      'quotes.select',
      'pm.activate',
      'pm.allocate',
      'lpo.approve',
      'lpo.issue',
      'workorder.assign',
      'workorder.reassign',
      'workorder.cancel',
      'cost.approve',
      'bill.approve.engineering',
      'bill.approve.finance',
      'payment.record',
      'users.manage',
      'users.assign_roles',
      'roles.manage',
      'org.manage',
    ]);
  } finally {
    db.close();
  }
});

test('engineering manager controls its organisation without security or finance escalation', async () => {
  const db = await seededDatabase();
  try {
    const p = await permissionsFor(db.client, 'ENGINEERING_MANAGER');
    requires('ENGINEERING_MANAGER', p, [
      'requests.accept',
      'requests.reject',
      'requests.route',
      'requests.cancel',
      'rfq.release',
      'rfq.award',
      'quotes.select',
      'pm.activate',
      'pm.allocate',
      'pm.archive',
      'lpo.approve',
      'lpo.issue',
      'lpo.cancel',
      'lpo.close',
      'workorder.assign',
      'workorder.reassign',
      'workorder.cancel',
      'jobcard.confirm',
      'cost.approve',
      'bill.approve.engineering',
      'stations.manage',
      'assets.manage',
      'contractors.manage',
      'technicians.manage',
      'slas.manage',
      'rates.manage',
      'engineer_assignments.manage',
      'users.invite',
      'users.update',
      'users.reset_password',
      'users.suspend',
      'users.assign_roles',
      'notifications.monitor',
      'notifications.retry',
      'notifications.configure',
      'reports.export',
      'audit.view',
      'attachments.manage',
    ]);
    forbids('ENGINEERING_MANAGER', p, [
      'roles.manage',
      'org.manage',
      'bill.approve.finance',
      'payment.record',
      'payment.reverse',
      'quotes.submit',
      'workorder.execute',
      'workorder.assign_technician',
      'jsa.submit',
    ]);
  } finally {
    db.close();
  }
});

test('external, station and finance roles stay within their workflow lanes', async () => {
  const db = await seededDatabase();
  try {
    const station = await permissionsFor(db.client, 'STATION_MANAGER');
    requires('STATION_MANAGER', station, [
      'requests.view',
      'requests.create',
      'requests.edit',
      'requests.submit',
      'workorder.view',
      'arrival.confirm',
      'jobcard.view',
      'jobcard.confirm',
    ]);
    forbids('STATION_MANAGER', station, [
      'requests.accept',
      'workorder.assign',
      'cost.approve',
      'users.manage',
    ]);

    const finance = await permissionsFor(db.client, 'FINANCIAL_CONTROLLER');
    requires('FINANCIAL_CONTROLLER', finance, [
      'bill.view',
      'bill.approve.finance',
      'payment.view',
      'payment.record',
      'payment.reverse',
      'reports.view',
      'audit.view',
    ]);
    forbids('FINANCIAL_CONTROLLER', finance, [
      'bill.approve.engineering',
      'workorder.assign',
      'roles.manage',
      'users.manage',
    ]);

    const contractor = await permissionsFor(db.client, 'CONTRACTOR');
    requires('CONTRACTOR', contractor, [
      'quotes.view',
      'quotes.submit',
      'workorder.view',
      'workorder.accept',
      'technicians.view',
      'technicians.manage',
      'workorder.assign_technician',
      'attachments.upload',
      'cost.view',
      'cost.create',
      'cost.submit',
      'bill.view',
      'bill.create',
      'bill.submit',
    ]);
    forbids('CONTRACTOR', contractor, [
      'rfq.award',
      'workorder.assign',
      'cost.approve',
      'bill.approve.engineering',
      'payment.record',
    ]);

    const technician = await permissionsFor(db.client, 'TECHNICIAN');
    requires('TECHNICIAN', technician, [
      'workorder.view',
      'workorder.accept',
      'workorder.execute',
      'jsa.submit',
      'jobcard.view',
      'jobcard.create',
      'jobcard.submit',
      'attachments.upload',
    ]);
    forbids('TECHNICIAN', technician, [
      'workorder.assign',
      'workorder.close',
      'cost.create',
      'bill.create',
      'users.manage',
    ]);
  } finally {
    db.close();
  }
});

test('viewer is read-only and excludes identity, security, audit and finance data', async () => {
  const db = await seededDatabase();
  try {
    const viewer = await permissionsFor(db.client, 'VIEWER');
    requires('VIEWER', viewer, [
      'org.view',
      'stations.view',
      'assets.view',
      'requests.view',
      'pm.view',
      'workorder.view',
      'reports.view',
    ]);
    forbids('VIEWER', viewer, [
      'users.view',
      'roles.view',
      'settings.view',
      'audit.view',
      'contractors.view',
      'technicians.view',
      'engineer_assignments.view',
      'rates.view',
      'rfq.view',
      'quotes.view',
      'cost.view',
      'bill.view',
      'payment.view',
      'requests.create',
      'workorder.create',
      'reports.export',
    ]);
    for (const key of viewer) {
      assert.match(key, /\.view$/, `VIEWER contains mutating permission ${key}`);
    }
  } finally {
    db.close();
  }
});

test('authentication ignores a role belonging to another organisation', async () => {
  const db = await seededDatabase();
  try {
    await db.client.batch(
      [
        { sql: `INSERT INTO organisations (id, name, slug) VALUES ('oa', 'A', 'a')`, args: [] },
        { sql: `INSERT INTO organisations (id, name, slug) VALUES ('ob', 'B', 'b')`, args: [] },
        {
          sql: `INSERT INTO users (id, org_id, full_name, email)
                VALUES ('ua', 'oa', 'A User', 'a@example.test')`,
          args: [],
        },
        {
          sql: `INSERT INTO roles (id, org_id, code, name)
                VALUES ('foreign-role', 'ob', 'FOREIGN_ADMIN', 'Foreign admin')`,
          args: [],
        },
        {
          sql: `INSERT INTO role_permissions (role_id, permission_id)
                SELECT 'foreign-role', id FROM permissions WHERE key = 'org.manage'`,
          args: [],
        },
        {
          sql: `INSERT INTO user_roles (user_id, role_id)
                SELECT 'ua', id FROM roles WHERE org_id IS NULL AND code = 'ENGINEER'`,
          args: [],
        },
        {
          sql: `INSERT INTO user_roles (user_id, role_id) VALUES ('ua', 'foreign-role')`,
          args: [],
        },
      ],
      'write',
    );

    const auth = await loadUserAuth(db.client, 'oa', 'ua');
    assert.deepEqual(auth.roles, ['ENGINEER']);
    assert.equal(auth.perms.includes('requests.create'), true);
    assert.equal(auth.perms.includes('org.manage'), false);
  } finally {
    db.close();
  }
});

test('delegated user administration cannot grant or modify privileged roles', () => {
  const manager = userManagementScope(['ENGINEERING_MANAGER'], false);
  assert.equal(manager, 'operational');
  for (const code of ['ENGINEER', 'STATION_MANAGER', 'CONTRACTOR', 'TECHNICIAN', 'VIEWER']) {
    assert.equal(mayAssignRoleCode(manager, code), true, `manager should assign ${code}`);
  }
  for (const code of ['OWNER', 'ADMIN', 'ENGINEERING_MANAGER', 'FINANCIAL_CONTROLLER']) {
    assert.equal(mayAssignRoleCode(manager, code), false, `manager must not assign ${code}`);
  }
  assert.equal(mayManageTargetUser(manager, ['ENGINEER'], false), true);
  assert.equal(mayManageTargetUser(manager, ['ENGINEER', 'VIEWER'], false), true);
  assert.equal(mayManageTargetUser(manager, ['ENGINEERING_MANAGER'], false), false);
  assert.equal(mayManageTargetUser(manager, ['ENGINEER'], true), false);

  const admin = userManagementScope(['ADMIN'], false);
  assert.equal(mayAssignRoleCode(admin, 'ENGINEERING_MANAGER'), true);
  assert.equal(mayAssignRoleCode(admin, 'OWNER'), false);
  assert.equal(mayManageTargetUser(admin, ['OWNER'], false), false);

  const owner = userManagementScope(['OWNER'], false);
  assert.equal(mayAssignRoleCode(owner, 'OWNER'), true);
  assert.equal(mayManageTargetUser(owner, ['OWNER'], true), true);
});
