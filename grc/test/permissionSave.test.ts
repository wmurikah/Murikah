/**
 * The role-save statement builder and the permission catalogue (Build Prompt 43).
 *
 * The audit found three separate defects in one save path: it was not atomic and
 * half-applied (AC-03), it wrote modules the lookup table did not hold (AC-05),
 * and nothing could catch either before deploy (AC-06). These pin the shape of
 * the fix without needing a database: the statements the save issues, in order,
 * and the single catalogue the code list and the seeded reference rows both come
 * from.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTION_CODES,
  MODULE_CODES,
  PERMISSION_ACTIONS,
  PERMISSION_MODULES,
} from '../../src/lib/grc/auth/permissionCatalogue.ts';
import { MODULES, ACTIONS } from '../../src/lib/grc/auth/matrix.ts';
import {
  buildRoleMatrixStatements,
  type GrantInput,
} from '../../src/lib/grc/repos/permissionGrants.ts';

/** The whole matrix as the screen submits it, with a handful of cells ticked. */
function wholeMatrix(allowed: Set<string>): GrantInput[] {
  const grants: GrantInput[] = [];
  for (const moduleCode of MODULE_CODES) {
    for (const actionCode of ACTION_CODES) {
      grants.push({
        moduleCode,
        actionCode,
        isAllowed: allowed.has(`${moduleCode}.${actionCode}`),
      });
    }
  }
  return grants;
}

const sqlOf = (s: { sql: string }): string => s.sql.replace(/\s+/g, ' ').trim();

// ---- The catalogue is the single source ------------------------------------

test('the code module list is the catalogue, not a second copy of it', () => {
  assert.deepEqual([...MODULES], [...MODULE_CODES]);
  assert.deepEqual([...ACTIONS], [...ACTION_CODES]);
  assert.equal(MODULE_CODES.length, PERMISSION_MODULES.length);
  assert.equal(ACTION_CODES.length, PERMISSION_ACTIONS.length);
});

test('the catalogue carries the modules the gates actually read', () => {
  // CONFIG unlocks every Setup screen and AUDIT_LOG the activity trail
  // (PAGE_PERMISSION_MAP). Losing either silently changes who can reach them,
  // which is the reconciliation AC-05 asked for, in the direction that keeps the
  // product's behaviour.
  for (const required of ['CONFIG', 'AUDIT_LOG', 'WORK_PAPER', 'USER']) {
    assert.ok(MODULE_CODES.includes(required), `${required} must be grantable`);
  }
  // SETUP was CONFIG under a second name and NOTIFICATION gated nothing, so
  // neither is offered: a grant that does nothing is worse than no grant.
  for (const dropped of ['SETUP', 'NOTIFICATION']) {
    assert.ok(!MODULE_CODES.includes(dropped), `${dropped} was deliberately dropped`);
  }
});

test('every catalogue entry is complete, so a lookup row can always be written', () => {
  const codes = new Set<string>();
  for (const module of PERMISSION_MODULES) {
    assert.ok(module.code.length > 0 && module.name.length > 0, 'a module needs a code and a name');
    assert.ok(module.description.length > 0, `${module.code} needs a description`);
    assert.ok(!codes.has(module.code), `${module.code} is declared twice`);
    codes.add(module.code);
  }
  const actions = new Set<string>();
  for (const action of PERMISSION_ACTIONS) {
    assert.ok(action.code.length > 0 && action.name.length > 0);
    assert.ok(!actions.has(action.code), `${action.code} is declared twice`);
    actions.add(action.code);
  }
});

// ---- The save is one atomic, ordered batch ---------------------------------

test('the save ensures every lookup row before it writes a grant', () => {
  const statements = buildRoleMatrixStatements('AUDITOR', wholeMatrix(new Set()));

  const firstGrantWrite = statements.findIndex((s) => sqlOf(s).includes('role_permissions'));
  const ensures = statements
    .slice(0, firstGrantWrite)
    .map(sqlOf)
    .filter((s) => s.startsWith('INSERT INTO permission_'));
  assert.equal(
    ensures.length,
    PERMISSION_MODULES.length + PERMISSION_ACTIONS.length,
    'every module and action must be ensured before any grant is written',
  );
  // Ensured, not blindly inserted: running the save twice must not duplicate.
  for (const sql of ensures) {
    assert.ok(sql.includes('WHERE NOT EXISTS'), `a lookup insert must be conditional: ${sql}`);
  }
});

test('the save replaces the role rather than patching it, in one batch', () => {
  const grants = wholeMatrix(new Set(['WORK_PAPER.read', 'REPORT.export']));
  const statements = buildRoleMatrixStatements('AUDITOR', grants);

  const deleteAt = statements.findIndex((s) => sqlOf(s).startsWith('DELETE FROM role_permissions'));
  assert.ok(deleteAt >= 0, 'the role must be cleared before its grants are written');
  assert.deepEqual(statements[deleteAt].args, ['AUDITOR']);

  const inserts = statements.slice(deleteAt + 1);
  assert.equal(inserts.length, grants.length, 'every submitted cell must be written');
  for (const statement of inserts) {
    assert.ok(sqlOf(statement).startsWith('INSERT INTO role_permissions'));
  }
  // No UPDATE anywhere: the half-applying UPDATE-then-INSERT loop is gone.
  assert.ok(
    !statements.some((s) => sqlOf(s).includes('UPDATE ')),
    'the save never updates in place',
  );
});

test('the whole matrix is written, ticked and unticked alike', () => {
  const allowed = new Set(['WORK_PAPER.read', 'CONFIG.read', 'AUDIT_LOG.read']);
  const statements = buildRoleMatrixStatements('AUDITOR', wholeMatrix(allowed));
  const grantRows = statements
    .filter((s) => sqlOf(s).startsWith('INSERT INTO role_permissions'))
    .map((s) => s.args as (string | number)[]);

  assert.equal(
    grantRows.length,
    MODULE_CODES.length * ACTION_CODES.length,
    'a denied cell is stored as 0, never left out, so the matrix is never partial',
  );
  for (const [role, moduleCode, actionCode, isAllowed] of grantRows) {
    assert.equal(role, 'AUDITOR');
    assert.equal(isAllowed, allowed.has(`${moduleCode}.${actionCode}`) ? 1 : 0);
  }
  // Every module written must be one the batch has already ensured a row for.
  const written = new Set(grantRows.map((r) => String(r[1])));
  for (const moduleCode of written) {
    assert.ok(MODULE_CODES.includes(moduleCode), `${moduleCode} is not in the catalogue`);
  }
});

test('an empty submission clears the role rather than failing', () => {
  // Every box unticked is a legitimate save: it revokes everything.
  const statements = buildRoleMatrixStatements('JUNIOR_STAFF', []);
  const deletes = statements.filter((s) => sqlOf(s).startsWith('DELETE FROM role_permissions'));
  assert.equal(deletes.length, 1);
  assert.equal(
    statements.filter((s) => sqlOf(s).startsWith('INSERT INTO role_permissions')).length,
    0,
  );
});
