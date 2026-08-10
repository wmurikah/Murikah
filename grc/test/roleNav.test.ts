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
  hasAi: false,
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
  assert.ok(paths.includes('/settings/users'));
  assert.ok(paths.includes('/settings'));
});

test('an ordinary auditor sees the workbench they have permission for, not setup', () => {
  const nav = buildNav(
    ctx({ roleCode: 'AUDITOR', perms: ['WORK_PAPERS.view', 'ACTION_PLANS.view'] }),
  );
  const paths = hrefs(nav);
  assert.ok(paths.includes('/work-papers'));
  assert.ok(paths.includes('/action-plans'));
  assert.ok(!paths.includes('/settings/users'));
  assert.ok(!paths.includes('/settings'));
  // Auditee section only shows with the review permission or an auditee role.
  assert.ok(!paths.includes('/auditee-responses'));
});

test('a delegated role with the CONFIG grant sees the setup group', () => {
  const nav = buildNav(ctx({ roleCode: 'HEAD_OF_AUDIT', perms: ['CONFIG.view'] }));
  const paths = hrefs(nav);
  assert.ok(paths.includes('/settings'));
  assert.ok(paths.includes('/send-queue'));
});

test('an auditee sees the auditee section and the dashboard, not setup or reports', () => {
  const nav = buildNav(ctx({ roleCode: 'UNIT_MANAGER', perms: ['ACTION_PLANS.view'] }));
  const paths = hrefs(nav);
  assert.ok(paths.includes('/')); // dashboard for all
  assert.ok(paths.includes('/auditee-responses'));
  assert.ok(paths.includes('/action-plans'));
  assert.ok(!paths.includes('/settings/users'));
  assert.ok(!paths.includes('/reports'));
});

test('board reports show for a board member', () => {
  const nav = buildNav(ctx({ roleCode: 'BOARD_MEMBER', perms: [] }));
  assert.ok(hrefs(nav).includes('/reports'));
});

test('analytics and AI settings are gated behind the AI feature', () => {
  // Without the AI feature, neither link shows even for an admin.
  const off = buildNav(ctx({ isPlatformOwner: true, hasAi: false }));
  assert.ok(!hrefs(off).includes('/analytics'));
  assert.ok(!hrefs(off).includes('/settings/ai'));

  // With the AI feature, an admin sees analytics and AI settings.
  const on = buildNav(ctx({ isPlatformOwner: true, hasAi: true }));
  assert.ok(hrefs(on).includes('/analytics'));
  assert.ok(hrefs(on).includes('/settings/ai'));

  // An auditor with AI sees analytics but not AI settings (admin only).
  const auditor = buildNav(ctx({ roleCode: 'AUDITOR', perms: ['WORK_PAPERS.view'], hasAi: true }));
  assert.ok(hrefs(auditor).includes('/analytics'));
  assert.ok(!hrefs(auditor).includes('/settings/ai'));
});

test('default landing: auditee to overdue then findings; everyone else to dashboard', () => {
  assert.equal(defaultLandingPath('UNIT_MANAGER', false, true), '/action-plans?overdue=1');
  assert.equal(defaultLandingPath('UNIT_MANAGER', false, false), '/work-papers');
  assert.equal(defaultLandingPath('SENIOR_AUDITOR', false, true), '/');
});

test('a platform owner lands on the all-instances view, never pinned to an organisation', () => {
  // Whatever role or overdue state, the owner is not a member of any instance,
  // so the landing is the platform view rather than a customer's dashboard.
  assert.equal(defaultLandingPath('SUPER_ADMIN', true, false), '/platform');
  assert.equal(defaultLandingPath('UNIT_MANAGER', true, true), '/platform');
});

test('a platform owner inside no instance sees only the platform navigation', () => {
  const nav = buildNav(ctx({ isPlatformOwner: true, hasAi: true, instanceSelected: false }));
  const paths = hrefs(nav);
  assert.deepEqual(
    nav.map((g) => g.label),
    ['Platform'],
  );
  assert.ok(paths.includes('/platform'));
  assert.ok(paths.includes('/settings/provision'));
  // Every module needs an acting organisation, so none of them is offered.
  for (const module of ['/', '/work-papers', '/action-plans', '/reports', '/settings']) {
    assert.ok(!paths.includes(module), `${module} needs an instance and must not be offered`);
  }
});

test('entering an instance gives a platform owner the full module navigation back', () => {
  const nav = buildNav(ctx({ isPlatformOwner: true, hasAi: true, instanceSelected: true }));
  const paths = hrefs(nav);
  assert.ok(paths.includes('/'));
  assert.ok(paths.includes('/work-papers'));
  assert.ok(paths.includes('/settings/users'));
});

test('an instance admin is never given the platform navigation', () => {
  // instanceSelected is meaningless for a pinned user: they always have one.
  const nav = buildNav(
    ctx({ roleCode: 'SUPER_ADMIN', perms: ['CONFIG.view', 'WORK_PAPERS.view'] }),
  );
  const paths = hrefs(nav);
  assert.ok(!paths.includes('/platform'));
  assert.ok(paths.includes('/work-papers'));
});

test('empty nav groups are dropped', () => {
  // A role with no workbench permissions and not an auditee: only the Overview group remains.
  const nav = buildNav(ctx({ roleCode: 'NOBODY', perms: [] }));
  assert.deepEqual(
    nav.map((g) => g.label),
    ['Overview'],
  );
});

// The settings navigation, grouped and de-duplicated (Build Prompt 52). The
// list had grown to a flat Setup group that repeated four screens the settings
// grid also listed, with the send queue under the same bell as Notifications.
test('administration is grouped, and no screen is listed twice', () => {
  const nav = buildNav(ctx({ isPlatformOwner: true, hasAi: true, instanceSelected: true }));
  assert.deepEqual(
    nav.map((g) => g.label),
    ['Overview', 'Audit', 'Organisation', 'Configuration', 'Platform'],
  );

  // The point of the change: one canonical link per screen, nothing repeated.
  const paths = hrefs(nav);
  const seen = new Set<string>();
  const repeated = paths.filter((p) => (seen.has(p) ? true : (seen.add(p), false)));
  assert.deepEqual(repeated, [], `every screen is listed once, repeated: ${repeated.join(', ')}`);
});

test('grouping drops nothing: every destination the flat nav offered is still there', () => {
  const nav = buildNav(ctx({ isPlatformOwner: true, hasAi: true, instanceSelected: true }));
  const paths = hrefs(nav);
  // The Setup group as it stood before the regrouping, plus the settings screens
  // that were reachable only through the grid.
  for (const href of [
    '/settings/affiliates',
    '/settings/audit-universe',
    '/settings/users',
    '/settings/access-control',
    '/send-queue',
    '/settings',
    '/settings/ai',
    '/settings/general',
    '/settings/dropdowns',
    '/settings/email',
    '/settings/storage',
    '/settings/provision',
  ]) {
    assert.ok(paths.includes(href), `${href} must stay reachable from the navigation`);
  }
});

test('each administration screen sits in the group it belongs to', () => {
  const nav = buildNav(ctx({ isPlatformOwner: true, hasAi: true, instanceSelected: true }));
  const group = (label: string): string[] =>
    nav.find((g) => g.label === label)?.items.map((i) => i.href) ?? [];

  // Who and what the audit covers.
  assert.deepEqual(group('Organisation'), [
    '/settings/affiliates',
    '/settings/audit-universe',
    '/settings/users',
    '/settings/access-control',
  ]);
  // How the application behaves, evidence storage included (Build Prompt 51).
  assert.ok(group('Configuration').includes('/settings/storage'));
  assert.ok(group('Configuration').includes('/settings/email'));
  assert.ok(group('Configuration').includes('/settings/general'));
  assert.ok(group('Configuration').includes('/settings/dropdowns'));
  // What belongs to Murikah Labs, not to the customer.
  assert.deepEqual(group('Platform'), ['/platform', '/settings/provision']);
});

test('the send queue is no longer a second bell beside Notifications', () => {
  const nav = buildNav(ctx({ isPlatformOwner: true, instanceSelected: true }));
  const items = nav.flatMap((g) => g.items);
  const queue = items.find((i) => i.href === '/send-queue');
  const bell = items.find((i) => i.href === '/notifications');
  assert.ok(queue && bell, 'both screens are still offered');
  assert.notEqual(queue.icon, bell.icon, 'two destinations must not read as one');
});

test('an admin who is not the platform owner gets no platform group', () => {
  const nav = buildNav(ctx({ roleCode: 'SUPER_ADMIN', perms: ['CONFIG.view'] }));
  assert.ok(!nav.some((g) => g.label === 'Platform'));
  // The configuration screens are still theirs.
  assert.ok(hrefs(nav).includes('/settings/storage'));
});
