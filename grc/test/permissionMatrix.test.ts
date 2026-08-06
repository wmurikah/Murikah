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
  pageSlugForPath,
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
  assert.equal(pageAccess(auditor, 'reports'), true); // REPORT.read
  assert.equal(pageAccess(auditor, 'settings/users'), false); // USER.read, not granted
  assert.equal(pageAccess(auditor, 'send-queue'), false); // CONFIG.read, not granted
  // An unmapped slug passes: those sections gate on identity or row scope.
  assert.equal(pageAccess(auditor, 'notifications'), true);
  assert.equal(pageAccess(auditor, ''), true); // the dashboard self-gates
  // Any one alternative unlocks a multi-grant section.
  const auditeeOnly = buildMatrix([
    { moduleCode: 'AUDITEE_RESPONSE', actionCode: 'create', isAllowed: true },
  ]);
  assert.equal(pageAccess(auditeeOnly, 'action-plans'), true);
  assert.equal(pageAccess(auditeeOnly, 'auditee-responses'), true);
  assert.equal(pageAccess(auditeeOnly, 'work-papers'), false);
  assert.deepEqual(PAGE_PERMISSION_MAP['settings/general'], [{ module: 'CONFIG', action: 'read' }]);
});

test('pageSlugForPath maps app paths onto the section slugs', () => {
  assert.equal(pageSlugForPath('/'), '');
  assert.equal(pageSlugForPath('/work-papers'), 'work-papers');
  assert.equal(pageSlugForPath('/work-papers/WP-1/edit'), 'work-papers');
  assert.equal(pageSlugForPath('/settings'), 'settings');
  assert.equal(pageSlugForPath('/settings/users'), 'settings/users');
  assert.equal(pageSlugForPath('/settings/access-control'), 'settings/access-control');
  // Every mapped slug must be reachable from a real path shape.
  for (const slug of Object.keys(PAGE_PERMISSION_MAP)) {
    assert.equal(pageSlugForPath(`/${slug}`), slug, slug);
  }
});

test('fullMatrix grants every module and action (SUPER_ADMIN)', () => {
  const all = fullMatrix();
  assert.equal(canMatrix(all, 'delete', 'USER'), true);
  assert.equal(canMatrix(all, 'export', 'REPORT'), true);
  assert.equal(canMatrix(all, 'approve', 'ACTION_PLAN'), true);
  assert.equal(pageAccess(all, 'settings/access-control'), true);
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
