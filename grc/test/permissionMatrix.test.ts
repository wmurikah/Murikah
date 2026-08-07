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
  MODULES,
  ACTIONS,
  PERMISSION_MODULES,
  PERMISSION_ACTIONS,
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
  assert.deepEqual(PAGE_PERMISSION_MAP['settings/general'], [
    { module: 'CONFIG', action: 'read' },
    { module: 'SETUP', action: 'read' },
  ]);
  // Build Prompt 43 wired the two modules the live permission_modules table held
  // and nothing read. Each opens its section on its own, and the CONFIG grant
  // that opened them before still does, so reconciling took no access away.
  const setupOnly = buildMatrix([{ moduleCode: 'SETUP', actionCode: 'read', isAllowed: true }]);
  assert.equal(pageAccess(setupOnly, 'settings/general'), true);
  assert.equal(pageAccess(setupOnly, 'settings/dropdowns'), true);
  assert.equal(
    pageAccess(setupOnly, 'settings/access-control'),
    false,
    'CONFIG only, deliberately',
  );
  const notifyOnly = buildMatrix([
    { moduleCode: 'NOTIFICATION', actionCode: 'read', isAllowed: true },
  ]);
  assert.equal(pageAccess(notifyOnly, 'send-queue'), true);
  const configOnly = buildMatrix([{ moduleCode: 'CONFIG', actionCode: 'read', isAllowed: true }]);
  for (const slug of [
    'send-queue',
    'settings',
    'settings/general',
    'settings/affiliates',
    'settings/audit-universe',
    'settings/dropdowns',
  ]) {
    assert.equal(pageAccess(configOnly, slug), true, `CONFIG.read must still open ${slug}`);
  }
  // settings/users is unchanged: it gates on USER.read, not on CONFIG.
  assert.equal(pageAccess(configOnly, 'settings/users'), false);
});

test('the module and action lists come from the one catalogue', () => {
  // The drift this guards against: the code enforcing a module the live
  // permission_modules table does not hold makes every role save violate a
  // foreign key (Build Prompt 43). One source, and the seed reads it too.
  assert.deepEqual(
    MODULES,
    PERMISSION_MODULES.map((m) => m.code),
  );
  assert.deepEqual(
    ACTIONS,
    PERMISSION_ACTIONS.map((a) => a.code),
  );
  assert.equal(new Set(MODULES).size, MODULES.length, 'no duplicate module code');
  assert.equal(new Set(ACTIONS).size, ACTIONS.length, 'no duplicate action code');
  // Every row the save creates is complete, not a bare code.
  for (const module of PERMISSION_MODULES) {
    assert.ok(module.code && module.name && module.description, module.code);
  }
  for (const action of PERMISSION_ACTIONS) {
    assert.ok(action.code && action.name, action.code);
  }
  // Every module the page map gates on must be one the matrix can actually
  // grant, or a page would be locked behind a permission no screen can give.
  for (const grants of Object.values(PAGE_PERMISSION_MAP)) {
    for (const grant of grants) {
      assert.ok(MODULES.includes(grant.module), `${grant.module} must be a real module`);
      assert.ok(ACTIONS.includes(grant.action), `${grant.action} must be a real action`);
    }
  }
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
