/**
 * The smoke database enforces its constraints (Build Prompt 43).
 *
 * This is the test that would have caught the role-save failure before it
 * shipped. The smoke schema is generated from `grc/db/schema.md`, a column
 * dictionary that records no keys, so every table used to be created with bare
 * untyped columns: no foreign key, NOT NULL or CHECK violation could be raised,
 * and a write the live database refuses passed the smoke run (audit finding
 * AC-06, `grc/docs/access-control-audit.md`).
 *
 * These drive `createTables` directly against an in-memory `node:sqlite`
 * database, so they are fast and need neither the built worker nor the harness.
 * A constraint quietly dropped from the generated schema fails here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createTables, parseSchema } from './smoke/fakeTurso.ts';
import {
  PERMISSION_ACTIONS,
  PERMISSION_MODULES,
  PLATFORM_DEFAULT_ORG,
} from '../../src/lib/grc/auth/permissionModules.ts';

const SCHEMA_MD = join(import.meta.dirname, '..', 'db', 'schema.md');

const ORG = 'ORG-TEST';

/** A smoke-shaped database with the permission reference rows already in it. */
function permissionDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  createTables(db, parseSchema(SCHEMA_MD));
  // Grants reference the organisation they belong to since the matrix became
  // tenant data, so both the sentinel and a real organisation must exist first.
  for (const org of [PLATFORM_DEFAULT_ORG, ORG]) {
    db.prepare(`INSERT INTO organizations (organization_id, org_name) VALUES (?, ?)`).run(org, org);
  }
  db.prepare(`INSERT INTO roles (role_code, role_name) VALUES (?, ?)`).run('AUDITOR', 'Auditor');
  for (const module of PERMISSION_MODULES) {
    db.prepare(`INSERT INTO permission_modules (module_code, module_name) VALUES (?, ?)`).run(
      module.code,
      module.name,
    );
  }
  for (const action of PERMISSION_ACTIONS) {
    db.prepare(`INSERT INTO permission_actions (action_code, action_name) VALUES (?, ?)`).run(
      action.code,
      action.name,
    );
  }
  return db;
}

function grant(
  db: DatabaseSync,
  role: string,
  module: string,
  action: string,
  org: string = ORG,
): void {
  db.prepare(
    `INSERT INTO role_permissions (organization_id, role_code, module_code, action_code, is_allowed)
     VALUES (?, ?, ?, ?, 1)`,
  ).run(org, role, module, action);
}

test('the smoke database enforces the permission foreign keys', () => {
  const db = permissionDb();
  // The write the product actually makes is accepted.
  grant(db, 'AUDITOR', 'WORK_PAPER', 'read');

  // A module the lookup table does not hold is refused, exactly as the live
  // database refuses it. This is the violation that failed every role save.
  assert.throws(
    () => grant(db, 'AUDITOR', 'NOT_A_MODULE', 'read'),
    /FOREIGN KEY/i,
    'a grant on an unknown module must be refused',
  );
  assert.throws(
    () => grant(db, 'AUDITOR', 'WORK_PAPER', 'incinerate'),
    /FOREIGN KEY/i,
    'a grant for an unknown action must be refused',
  );
  assert.throws(
    () => grant(db, 'NOT_A_ROLE', 'WORK_PAPER', 'read'),
    /FOREIGN KEY/i,
    'a grant for an unknown role must be refused',
  );
  // Tenant scoping is a real reference too (Build Prompt 44): a grant cannot be
  // written for an organisation that does not exist.
  assert.throws(
    () => grant(db, 'AUDITOR', 'ACTION_PLAN', 'read', 'ORG-DOES-NOT-EXIST'),
    /FOREIGN KEY/i,
    'a grant for an unknown organisation must be refused',
  );
  db.close();
});

test('the same cell can be granted differently in two organisations', () => {
  // The shape the tenant-scoped key makes possible, and the reason the primary
  // key had to be rebuilt: one role, one module, one action, two organisations,
  // two independent answers.
  const db = permissionDb();
  grant(db, 'AUDITOR', 'WORK_PAPER', 'read', ORG);
  grant(db, 'AUDITOR', 'WORK_PAPER', 'read', PLATFORM_DEFAULT_ORG);
  const rows = db
    .prepare(
      `SELECT organization_id AS o FROM role_permissions
        WHERE role_code = 'AUDITOR' AND module_code = 'WORK_PAPER' AND action_code = 'read'
        ORDER BY organization_id`,
    )
    .all() as { o: string }[];
  assert.deepEqual(
    rows.map((r) => r.o),
    [PLATFORM_DEFAULT_ORG, ORG].sort(),
  );
  db.close();
});

test('every module the code enforces can be granted in the smoke database', () => {
  // The reconciliation, proved end to end: the catalogue the matrix screen
  // renders and the save writes is exactly the reference data the seed creates,
  // so no cell of the matrix can violate a foreign key.
  const db = permissionDb();
  for (const module of PERMISSION_MODULES) {
    for (const action of PERMISSION_ACTIONS) {
      grant(db, 'AUDITOR', module.code, action.code);
    }
  }
  const stored = db
    .prepare(
      `SELECT COUNT(*) AS n FROM role_permissions
        WHERE role_code = 'AUDITOR' AND organization_id = ?`,
    )
    .get(ORG) as { n: number | bigint };
  assert.equal(Number(stored.n), PERMISSION_MODULES.length * PERMISSION_ACTIONS.length);
  db.close();
});

test('the smoke database enforces NOT NULL on a grant', () => {
  const db = permissionDb();
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO role_permissions
             (organization_id, role_code, module_code, action_code, is_allowed)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(ORG, 'AUDITOR', 'WORK_PAPER', 'read', null),
    /NOT NULL/i,
    'a grant with no is_allowed must be refused',
  );
  db.close();
});

test('the smoke database still enforces the config organisation reference', () => {
  // The constraint that was already declared, kept green by the generalisation.
  const db = new DatabaseSync(':memory:');
  createTables(db, parseSchema(SCHEMA_MD));
  assert.throws(
    () =>
      db
        .prepare(`INSERT INTO config (organization_id, config_key, config_value) VALUES (?, ?, ?)`)
        .run('GLOBAL', 'AI_ACTIVE_PROVIDER', 'anthropic'),
    /FOREIGN KEY/i,
    'a config row for an organisation that does not exist must be refused',
  );
  db.prepare(`INSERT INTO organizations (organization_id, org_name) VALUES (?, ?)`).run(
    'GLOBAL',
    'Platform',
  );
  db.prepare(`INSERT INTO config (organization_id, config_key, config_value) VALUES (?, ?, ?)`).run(
    'GLOBAL',
    'AI_ACTIVE_PROVIDER',
    'anthropic',
  );
  db.close();
});
