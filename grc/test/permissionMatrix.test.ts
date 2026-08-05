/**
 * The RBAC permission matrix core. The module under test has no imports, so node
 * strips types and runs it directly. These pin the source model: the matrix
 * check, the view/read and WORK_PAPERS/WORK_PAPER aliases, the page map, the
 * SUPER_ADMIN full grant and the legacy-code derivation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMatrix,
  canMatrix,
  pageAccess,
  fullMatrix,
  deriveLegacyPerms,
  PAGE_PERMISSION_MAP,
} from '../../src/lib/grc/auth/matrix.ts';

const auditor = buildMatrix([
  { moduleCode: 'WORK_PAPER', actionCode: 'read', isAllowed: true },
  { moduleCode: 'WORK_PAPER', actionCode: 'create', isAllowed: true },
  { moduleCode: 'WORK_PAPER', actionCode: 'update', isAllowed: false },
  { moduleCode: 'ACTION_PLAN', actionCode: 'read', isAllowed: true },
  { moduleCode: 'REPORT', actionCode: 'read', isAllowed: true },
]);

test('canMatrix applies the view/read and WORK_PAPERS/WORK_PAPER aliases', () => {
  assert.equal(canMatrix(auditor, 'read', 'WORK_PAPER'), true);
  assert.equal(canMatrix(auditor, 'view', 'WORK_PAPERS'), true); // both aliases at once
  assert.equal(canMatrix(auditor, 'view', 'WORK_PAPER'), true); // action alias only
  assert.equal(canMatrix(auditor, 'read', 'WORK_PAPERS'), true); // module alias only
  assert.equal(canMatrix(auditor, 'update', 'WORK_PAPER'), false); // explicitly not allowed
  assert.equal(canMatrix(auditor, 'delete', 'WORK_PAPER'), false); // absent means false
  assert.equal(canMatrix(auditor, 'read', 'USER'), false); // absent module
});

test('pageAccess resolves a page slug through the page map', () => {
  assert.equal(pageAccess(auditor, 'work-papers'), true); // WORK_PAPER.read
  assert.equal(pageAccess(auditor, 'work-paper-form'), true); // WORK_PAPER.create
  assert.equal(pageAccess(auditor, 'user-management'), false); // USER.read, not granted
  assert.equal(pageAccess(auditor, 'unknown-slug'), false);
  assert.equal(PAGE_PERMISSION_MAP['system-settings'].module, 'CONFIG');
});

test('fullMatrix grants every module and action (SUPER_ADMIN)', () => {
  const all = fullMatrix();
  assert.equal(canMatrix(all, 'delete', 'USER'), true);
  assert.equal(canMatrix(all, 'export', 'REPORT'), true);
  assert.equal(canMatrix(all, 'approve', 'ACTION_PLAN'), true);
  assert.equal(pageAccess(all, 'audit-log'), true);
});

test('deriveLegacyPerms maps the matrix to the legacy codes in use', () => {
  const legacy = deriveLegacyPerms(auditor);
  assert.ok(legacy.includes('WORK_PAPERS.view'));
  assert.ok(legacy.includes('WORK_PAPERS.create'));
  assert.ok(legacy.includes('ACTION_PLANS.view'));
  assert.ok(legacy.includes('REPORTS.view'));
  assert.ok(!legacy.includes('WORK_PAPERS.edit')); // update was false
  assert.ok(!legacy.includes('WORK_PAPERS.submit')); // submit follows update
  // Every permission the work-paper workflow catalogue gates on must be
  // derivable, or that transition is impossible for everyone.
  const full = deriveLegacyPerms(fullMatrix());
  for (const code of [
    'WORK_PAPERS.submit',
    'WORK_PAPERS.review',
    'WORK_PAPERS.approve',
    'WORK_PAPERS.send',
  ]) {
    assert.ok(full.includes(code), `${code} must be derivable from a full matrix`);
  }
  assert.ok(!legacy.includes('ACTION_PLANS.create')); // not granted
  // A full matrix yields every legacy code.
  assert.ok(deriveLegacyPerms(fullMatrix()).includes('ACTION_PLANS.verify'));
});
