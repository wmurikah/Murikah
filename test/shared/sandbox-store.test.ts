import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { canRole } from '../../src/sandbox/permissions.ts';
import { sandboxReducer } from '../../src/sandbox/reducer.ts';
import type { SandboxState } from '../../src/sandbox/types.ts';

function state(): SandboxState {
  return {
    version: 2,
    initializedAt: '2026-09-21T00:00:00.000Z',
    organization: { organizationId: 'ORG-KILIMA', organizationName: 'Kilima Savings and Credit Cooperative Ltd', sector: 'SACCO', currency: 'KES', entities: [{ affiliateCode: 'HO', affiliateName: 'Head Office', isGroup: true }] },
    users: [
      { userId: 'USR-CAE', fullName: 'Amina Kilele', email: 'amina@kilima.example', roleCode: 'HEAD_OF_AUDIT', roleLabel: 'Chief Audit Executive', affiliateCode: 'HO', avatar: 'AK' },
      { userId: 'USR-AUD', fullName: 'Daniel Kifaru', email: 'daniel@kilima.example', roleCode: 'AUDITOR', roleLabel: 'Auditor', affiliateCode: 'HO', avatar: 'DK' },
    ],
    activeUserId: 'USR-CAE',
    activeRoleCode: 'HEAD_OF_AUDIT',
    activeAffiliateCode: 'HO',
    screen: 'dashboard',
    selectedEngagementId: null,
    selectedFindingId: null,
    selectedWorkPaperId: null,
    engagements: [],
    findings: [],
    actionPlans: [{
      actionPlanId: 'AP-1', findingId: 'AUD-1', workPaperId: 'WP-1', actionPlanRef: 'AP-001',
      actionDescription: 'Complete the review.', ownerIds: ['USR-AUD'], dueOffsetDays: 3,
      dueDate: '2026-09-24T00:00:00.000Z', priority: 'High', status: 'Pending',
      escalationState: 'None', reminderOffsetDays: -2, reminderDate: '2026-09-19T00:00:00.000Z',
      createdOffsetDays: -4, createdAt: '2026-09-17T00:00:00.000Z', evidence: [], activity: [],
    }],
    workPapers: [],
    risks: [],
    auditUniverse: [],
    auditLog: [],
    notifications: [],
    savedFindingViews: [],
    findingDraft: { step: 1, condition: '', criteria: '', cause: '', effect: '', riskRating: '', recommendation: '', engagementId: '', process: 'ICT' },
    tourDismissed: false,
    undo: null,
  };
}

test('sandbox reducer applies optimistic action changes and supports Undo', () => {
  const initial = state();
  const changed = sandboxReducer(initial, { type: 'UPDATE_ACTION_STATUS', actionPlanId: 'AP-1', status: 'In Progress' });

  assert.equal(changed.actionPlans[0].status, 'In Progress');
  assert.equal(changed.auditLog[0].action, 'ACTION_PLAN_STATUS_CHANGED');
  assert.equal(changed.undo?.previousActionStatus, 'Pending');

  const undone = sandboxReducer(changed, { type: 'UNDO_LAST' });
  assert.equal(undone.actionPlans[0].status, 'Pending');
  assert.equal(undone.undo, null);
});

test('sandbox role switch changes the acting role and records an audit event', () => {
  const changed = sandboxReducer(state(), { type: 'SWITCH_ROLE', userId: 'USR-AUD' });

  assert.equal(changed.activeUserId, 'USR-AUD');
  assert.equal(changed.activeRoleCode, 'AUDITOR');
  assert.equal(changed.auditLog[0].action, 'ROLE_SWITCHED');
});

test('sandbox permissions reflect author, reviewer, executive, board and process-owner boundaries', () => {
  assert.equal(canRole('AUDITOR', 'finding.create'), true);
  assert.equal(canRole('AUDITOR', 'workpaper.approve'), false);
  assert.equal(canRole('SENIOR_AUDITOR', 'workpaper.review'), true);
  assert.equal(canRole('HEAD_OF_AUDIT', 'action.close'), true);
  assert.equal(canRole('BOARD_MEMBER', 'report.read'), true);
  assert.equal(canRole('BOARD_MEMBER', 'finding.edit'), false);
  assert.equal(canRole('UNIT_MANAGER', 'action.update'), true);
  assert.equal(canRole('UNIT_MANAGER', 'auditlog.read'), false);
});

test('sandbox store is versioned, persisted locally and resettable', async () => {
  const source = await readFile(new URL('../../src/sandbox/store.tsx', import.meta.url), 'utf8');
  assert.match(source, /murikah\.assurance-os\.sandbox\.v2/);
  assert.match(source, /window\.localStorage\.getItem/);
  assert.match(source, /window\.localStorage\.setItem/);
  assert.match(source, /window\.localStorage\.removeItem/);
  assert.match(source, /dispatch\(\{ type: 'RESET'/);
});
