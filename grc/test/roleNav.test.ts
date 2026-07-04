/**
 * Role-based navigation and the default landing page. The module under test has
 * no imports, so node strips types and runs it directly. These pin the source's
 * rules: the auditee section and landing, the team-performance roles, the
 * permission-driven workbench and the admin-only setup.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildNav,
  defaultLandingPath,
  isAuditeeRole,
  canSeeTeamPerformance,
  type NavContext,
} from '../../src/lib/grc/dashboard/roleNav.ts';

const ctx = (over: Partial<NavContext>): NavContext => ({
  roleCode: 'AUDITOR',
  perms: [],
  isPlatformOwner: false,
  ...over,
});

function hrefs(groups: ReturnType<typeof buildNav>): string[] {
  return groups.flatMap((g) => g.items.map((i) => i.href));
}

test('auditee and team-performance role sets', () => {
  assert.equal(isAuditeeRole('UNIT_MANAGER'), true);
  assert.equal(isAuditeeRole('SENIOR_AUDITOR'), false);
  assert.equal(canSeeTeamPerformance('HEAD_OF_AUDIT'), true);
  assert.equal(canSeeTeamPerformance('SENIOR_AUDITOR'), true);
  assert.equal(canSeeTeamPerformance('JUNIOR_STAFF'), false);
});

test('a platform owner sees the setup group and the whole workbench', () => {
  const nav = buildNav(ctx({ isPlatformOwner: true }));
  const paths = hrefs(nav);
  assert.ok(paths.includes('/work-papers'));
  assert.ok(paths.includes('/reports'));
  assert.ok(paths.includes('/users'));
  assert.ok(paths.includes('/settings'));
});

test('an ordinary auditor sees the workbench they have permission for, not setup', () => {
  const nav = buildNav(
    ctx({ roleCode: 'AUDITOR', perms: ['WORK_PAPERS.view', 'ACTION_PLANS.view'] }),
  );
  const paths = hrefs(nav);
  assert.ok(paths.includes('/work-papers'));
  assert.ok(paths.includes('/action-plans'));
  assert.ok(!paths.includes('/users'));
  assert.ok(!paths.includes('/settings'));
  // Auditee section only shows with the review permission or an auditee role.
  assert.ok(!paths.includes('/auditee-responses'));
});

test('an auditee sees the auditee section and the dashboard, not setup or reports', () => {
  const nav = buildNav(ctx({ roleCode: 'UNIT_MANAGER', perms: ['ACTION_PLANS.view'] }));
  const paths = hrefs(nav);
  assert.ok(paths.includes('/')); // dashboard for all
  assert.ok(paths.includes('/auditee-responses'));
  assert.ok(paths.includes('/action-plans'));
  assert.ok(!paths.includes('/users'));
  assert.ok(!paths.includes('/reports'));
});

test('board reports show for a board member', () => {
  const nav = buildNav(ctx({ roleCode: 'BOARD_MEMBER', perms: [] }));
  assert.ok(hrefs(nav).includes('/reports'));
});

test('default landing: auditee to overdue then findings; everyone else to dashboard', () => {
  assert.equal(defaultLandingPath('UNIT_MANAGER', false, true), '/action-plans?overdue=1');
  assert.equal(defaultLandingPath('UNIT_MANAGER', false, false), '/work-papers');
  assert.equal(defaultLandingPath('SENIOR_AUDITOR', false, true), '/');
  assert.equal(defaultLandingPath('UNIT_MANAGER', true, true), '/'); // platform owner
});

test('empty nav groups are dropped', () => {
  // A role with no workbench permissions and not an auditee: only the Overview group remains.
  const nav = buildNav(ctx({ roleCode: 'NOBODY', perms: [] }));
  assert.deepEqual(
    nav.map((g) => g.label),
    ['Overview'],
  );
});
