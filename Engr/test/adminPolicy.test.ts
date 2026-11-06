import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mayAssignRoleCode,
  mayManageRoleCode,
  mayManageTargetUser,
  requiresContractorTechnicianScope,
  userManagementScope,
} from '../src/lib/engr/auth/adminPolicy.ts';

test('engineering managers can administer only operational users and roles', () => {
  const scope = userManagementScope(['ENGINEERING_MANAGER'], false);
  assert.equal(scope, 'operational');
  for (const code of ['ENGINEER', 'STATION_MANAGER', 'CONTRACTOR', 'TECHNICIAN', 'VIEWER']) {
    assert.equal(mayAssignRoleCode(scope, code), true, code);
    assert.equal(mayManageTargetUser(scope, [code], false), true, code);
  }
  for (const code of ['OWNER', 'ADMIN', 'ENGINEERING_MANAGER', 'FINANCIAL_CONTROLLER']) {
    assert.equal(mayAssignRoleCode(scope, code), false, code);
    assert.equal(mayManageTargetUser(scope, [code], false), false, code);
  }
  assert.equal(mayManageTargetUser(scope, ['ENGINEER'], true), false);
});

test('administrators cannot grant or manage owner authority', () => {
  const scope = userManagementScope(['ADMIN'], false);
  assert.equal(scope, 'admin');
  assert.equal(mayAssignRoleCode(scope, 'OWNER'), false);
  assert.equal(mayAssignRoleCode(scope, 'ENGINEERING_MANAGER'), true);
  assert.equal(mayManageTargetUser(scope, ['OWNER'], false), false);
  assert.equal(mayManageTargetUser(scope, ['ENGINEERING_MANAGER'], false), true);
  assert.equal(mayManageTargetUser(scope, ['ENGINEER'], true), false);
  assert.equal(mayManageRoleCode(scope, 'OWNER'), false);
  assert.equal(mayManageRoleCode(scope, 'ENGINEER'), true);
});

test('owner and platform owner retain the full organisation administration scope', () => {
  for (const scope of [userManagementScope(['OWNER'], false), userManagementScope([], true)]) {
    assert.equal(scope, 'all');
    assert.equal(mayAssignRoleCode(scope, 'OWNER'), true);
    assert.equal(mayManageTargetUser(scope, ['OWNER'], false), true);
    assert.equal(mayManageTargetUser(scope, ['ADMIN'], true), true);
    assert.equal(mayManageRoleCode(scope, 'OWNER'), true);
  }
});

test('unprivileged roles receive no implicit administration scope', () => {
  const scope = userManagementScope(['ENGINEER'], false);
  assert.equal(scope, 'none');
  assert.equal(mayAssignRoleCode(scope, 'ENGINEER'), false);
  assert.equal(mayManageTargetUser(scope, [], false), false);
});

test('contractor technician administration is bound to the linked contractor', () => {
  assert.equal(requiresContractorTechnicianScope(['CONTRACTOR']), true);
  assert.equal(requiresContractorTechnicianScope(['CONTRACTOR', 'ENGINEERING_MANAGER']), false);
  assert.equal(requiresContractorTechnicianScope(['CONTRACTOR', 'ADMIN']), false);
  assert.equal(requiresContractorTechnicianScope(['ENGINEER']), false);
});
