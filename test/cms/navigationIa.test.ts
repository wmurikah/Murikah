/**
 * The functionality preservation ledger, as tests.
 *
 * THIS REFACTOR MOVED THINGS AND WAS NOT ALLOWED TO LOSE ANY. Labels changed,
 * destinations were regrouped, nine user tabs became six, seven helpdesk
 * queues became three plus a menu. Every one of those is a chance to delete a
 * capability by accident and never notice, because a missing link looks
 * exactly like a link somebody forgot to look for.
 *
 * So the ledger is executable. Each assertion below names a capability that
 * existed before this work and proves it is still reachable: the same route,
 * behind the same permission, from somewhere a person can click. A test that
 * merely checked the new structure would pass just as happily on a version
 * that had thrown half the product away.
 *
 * WHAT IS DELIBERATELY NOT ASSERTED: class strings and markup shapes. The
 * requirement is that Helpdesk no longer shows seven equal choices, not that
 * it uses one particular flex utility to avoid it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  CMS_DESTINATIONS,
  adminGroups,
  allowedDestinations,
  destinationAllowed,
  ADMIN_GROUP_ORDER,
} from '../../src/lib/cms/destinations.ts';
import { CMS_NAV, visibleNav, activeNavItem } from '../../src/lib/cms/nav.ts';
import { searchPages } from '../../src/lib/cms/search/pageSearch.ts';
import {
  LEGACY_USER_TABS,
  USER_SECTIONS,
  USER_SECTION_MODEL,
  resolveUserTab,
  userSectionHref,
} from '../../src/lib/cms/admin/userSections.ts';

const PAGES_ROOT = 'src/pages/cms';
const read = (path: string) => readFileSync(path, 'utf8');

/** Every permission code in the seeded catalogue, which is what an admin holds. */
const EVERYTHING = [
  'ADMIN.USERS.MANAGE',
  'ADMIN.ORGANISATION.VIEW',
  'ADMIN.ORGANISATION.MANAGE',
  'ADMIN.ROLES.MANAGE',
  'ADMIN.WORKFLOWS.MANAGE',
  'ADMIN.WORKFLOW_ROLES.MANAGE',
  'ADMIN.PRODUCT_CATALOG.MANAGE',
  'AUDIT.EVENTS.VIEW',
  'CUSTOMERS.ACCOUNTS.VIEW',
  'CRM.LEADS.VIEW',
  'CRM.OPPORTUNITIES.VIEW',
  'CRM.LEAD_SOURCES.MANAGE',
  'CRM.PIPELINES.MANAGE',
  'CRM.LOST_REASONS.MANAGE',
  'SERVICE.CASES.VIEW',
  'SERVICE.CATEGORIES.MANAGE',
  'ORDERS.SALES_ORDER.VIEW',
  'ORDERS.PURCHASE_ORDER.VIEW',
  'SLA.DASHBOARD.VIEW',
  'SLA.RULES.MANAGE',
  'DATA.IMPORTS.VIEW',
  'DATA.IMPORTS.UPLOAD',
];

// ---- the routes behind the catalogue exist --------------------------------

/**
 * Every destination resolves to a real page file.
 *
 * The catalogue is hand-written, and a hand-written path is a typo away from
 * a link that 404s — which page search would then offer as an answer. This
 * walks the route tree and proves every href has a file behind it.
 */
function routeExists(href: string): boolean {
  const path = href.replace(/^\//, '').split('?')[0] ?? '';
  const candidates = [join(PAGES_ROOT, `${path}.astro`), join(PAGES_ROOT, path, 'index.astro')];
  return candidates.some((candidate) => existsSync(candidate));
}

test('every destination in the catalogue is a page that exists', () => {
  for (const destination of CMS_DESTINATIONS) {
    assert.ok(
      routeExists(destination.href),
      `${destination.label} points at ${destination.href}, which has no page`,
    );
  }
});

test('no destination is listed twice, and every label is distinct', () => {
  const labels = CMS_DESTINATIONS.map((d) => d.label);
  assert.equal(new Set(labels).size, labels.length, 'two destinations share a label');
});

// ---- main navigation -------------------------------------------------------

test('the rail is still the same eight destinations, at the same routes', () => {
  assert.deepEqual(
    CMS_NAV.map((item) => item.href),
    [
      '/app',
      '/app/operations/customers',
      '/app/crm',
      '/app/helpdesk',
      '/app/orders',
      '/app/performance',
      '/app/data',
      '/app/administration',
    ],
    'a rail destination moved or disappeared',
  );
});

test('the two renamed labels kept their routes exactly', () => {
  // THE WHOLE POINT OF THE RENAME. "Data" and "Performance" named the
  // implementation rather than the errand, and a label is what a person reads
  // while a path is what a bookmark holds.
  const upload = CMS_NAV.find((item) => item.label === 'Upload Centre');
  assert.equal(upload?.href, '/app/data', 'Upload Centre must still be the Data route');
  const sla = CMS_NAV.find((item) => item.label === 'SLA Monitor');
  assert.equal(sla?.href, '/app/performance', 'SLA Monitor must still be the Performance route');
  // And the old labels are gone from the rail, so there is one term per thing.
  assert.equal(
    CMS_NAV.some((item) => item.label === 'Data'),
    false,
  );
  assert.equal(
    CMS_NAV.some((item) => item.label === 'Performance'),
    false,
  );
});

test('the rail still filters on permissions, and the active marker still resolves', () => {
  assert.deepEqual(
    visibleNav([]).map((item) => item.label),
    ['Home'],
    'a principal with no permissions sees more than the landing page',
  );
  assert.equal(visibleNav(EVERYTHING).length, CMS_NAV.length);
  // Longest match wins, so a child page marks its module rather than Home.
  assert.equal(activeNavItem('/app/crm/opportunities')?.label, 'CRM');
  assert.equal(activeNavItem('/app/data/history')?.label, 'Upload Centre');
  assert.equal(activeNavItem('/app')?.label, 'Home');
});

test('the sidebar groups reference labels that exist', () => {
  /*
    A group listing a label the model no longer carries renders an empty group,
    which is how a rail silently loses an entry — and is exactly what renaming
    two labels could have caused.

    The item lists are read rather than the whole block, because the block is
    mostly the commentary explaining why Customers sits where it does, and
    quoted words inside a comment are not navigation labels.
  */
  const rail = read('src/components/cms/CmsSidebar.astro');
  const block = rail.slice(rail.indexOf('const groups = ['), rail.indexOf('] as const;'));
  const lists = [...block.matchAll(/items: \[([^\]]*)\]/g)];
  assert.ok(lists.length >= 3, 'the rail groups could not be read');
  for (const list of lists) {
    for (const label of (list[1] ?? '').match(/'([^']+)'/g) ?? []) {
      const bare = label.slice(1, -1);
      assert.ok(
        CMS_NAV.some((item) => item.label === bare),
        `the rail groups reference ${bare}, which is not a navigation entry`,
      );
    }
  }
});

// ---- global search ---------------------------------------------------------

test('record search is untouched: all seven record types still searched', async () => {
  const source = read('src/lib/cms/search/globalSearch.ts');
  for (const group of [
    'ACCOUNT',
    'CONTACT',
    'LEAD',
    'OPPORTUNITY',
    'CASE',
    'SALES_ORDER',
    'PURCHASE_ORDER',
  ]) {
    assert.match(source, new RegExp(`'${group}'`), `${group} is no longer searched`);
  }
  // The scope predicate is still inside each query rather than applied after.
  for (const scope of [
    'scopedAccounts',
    'scopedLeads',
    'scopedOpportunities',
    'scopedCases',
    'scopedSalesOrders',
    'scopedPurchaseOrders',
  ]) {
    assert.match(source, new RegExp(scope), `${scope} was dropped from the search`);
  }
});

test('page search finds destinations and respects permissions', () => {
  const admin = searchPages(EVERYTHING, 'users');
  assert.equal(admin[0]?.label, 'Users', 'an exact page name is not the first result');

  // THE POINT OF THE PERMISSION FILTER. A person without the administration
  // code is not offered an administration destination merely because the name
  // matches what they typed. The page refuses them independently either way.
  assert.equal(
    searchPages(['SERVICE.CASES.VIEW'], 'users').some((hit) => hit.label === 'Users'),
    false,
    'page search offered an administration destination to somebody without the code',
  );
  assert.equal(searchPages([], 'users').length, 0);
});

test('page search ranks an exact name above a keyword above a substring', () => {
  const hits = searchPages(EVERYTHING, 'upload');
  const labels = hits.map((hit) => hit.label);
  assert.ok(labels.includes('Upload a file'), 'the upload page is missing');
  assert.ok(labels.includes('Upload Centre'), 'the Upload Centre is missing');
  // "Upload a file" starts with the query, "Upload Centre" does too; both beat
  // anything that merely mentions upload in a keyword.
  const first = hits[0];
  assert.ok(first !== undefined && first.rank <= 1, 'a prefix match did not come first');

  // A keyword nobody would guess from the label still finds the page: "log"
  // for the audit trail is the case this exists for.
  assert.ok(
    searchPages(EVERYTHING, 'log').some((hit) => hit.label === 'Audit trail'),
    'a keyword search missed its destination',
  );
  // And a query too short to mean anything returns nothing rather than all of it.
  assert.deepEqual(searchPages(EVERYTHING, 'u'), []);
});

test('page search costs no database query', () => {
  // A navigation aid that added a read to every keystroke would be a worse
  // product than the one that made people hunt for pages.
  const source = read('src/lib/cms/search/pageSearch.ts');
  assert.equal(/db\.|execute\(|Client/.test(source), false, 'page search touches a database');
});

// ---- Administration --------------------------------------------------------

test('Administration still offers every destination it did, in groups', () => {
  // The twelve the flat page listed, by route, so a rename cannot hide a loss.
  const BEFORE = [
    '/app/administration/ai',
    '/app/administration/channels',
    '/app/administration/organisation',
    '/app/administration/users',
    '/app/administration/roles',
    '/app/administration/workflows',
    '/app/administration/catalogue',
    '/app/administration/audit',
    '/app/administration/health',
    '/app/administration/access-review',
    '/app/administration/components',
    '/app/administration/authority',
  ];
  const after = adminGroups(EVERYTHING).flatMap((section) => section.entries.map((e) => e.href));
  for (const href of BEFORE) {
    assert.ok(after.includes(href), `${href} disappeared from Administration`);
  }
  assert.ok(after.length >= BEFORE.length, 'Administration lost a destination');

  // Grouped rather than flat, which is the change.
  const groups = adminGroups(EVERYTHING).map((section) => section.group);
  assert.ok(groups.length >= 3, 'Administration is still one undifferentiated list');
  assert.deepEqual(
    groups,
    ADMIN_GROUP_ORDER.filter((group) => groups.includes(group)),
    'the groups render out of their declared order',
  );
});

test('Design reference is kept, reachable, and sits under Advanced', () => {
  const design = CMS_DESTINATIONS.find((d) => d.label === 'Design reference');
  assert.equal(design?.href, '/app/administration/components');
  assert.equal(design?.group, 'Advanced', 'the design reference competes with Users again');
  assert.equal(
    ADMIN_GROUP_ORDER[ADMIN_GROUP_ORDER.length - 1],
    'Advanced',
    'Advanced is no longer last',
  );
  // Rendered as a disclosure rather than deleted.
  const page = read('src/pages/cms/app/administration.astro');
  assert.match(page, /<details/, 'Advanced is not progressively disclosed');
});

test('an empty Administration group is never rendered as a heading', () => {
  // Somebody holding only the catalogue code gets the one group that has
  // something in it, and no empty headings above or below it.
  const sections = adminGroups(['ADMIN.PRODUCT_CATALOG.MANAGE']);
  assert.ok(sections.every((section) => section.entries.length > 0));
  assert.deepEqual(
    sections.flatMap((s) => s.entries.map((e) => e.label)),
    ['Product catalogue'],
  );
  assert.deepEqual(adminGroups([]), []);
});

// ---- user detail -----------------------------------------------------------

test('the user record is six primary sections, not nine', () => {
  assert.equal(USER_SECTIONS.length, 6);
  assert.deepEqual(
    [...USER_SECTIONS],
    ['overview', 'edit', 'organisation', 'access', 'security', 'history'],
  );
});

test('every legacy user tab still opens its section and reveals its subsection', () => {
  // THE LINKS PEOPLE HAVE. A bookmark, a runbook, an email from last quarter.
  // None of them may 404, and none of them may silently land on Overview,
  // which is the failure that teaches people the product loses their place.
  const expected: Record<string, { section: string; view: string | null }> = {
    assignments: { section: 'organisation', view: 'assignments' },
    teams: { section: 'organisation', view: 'teams' },
    roles: { section: 'access', view: 'roles' },
    authority: { section: 'access', view: 'authority' },
    identities: { section: 'security', view: 'identities' },
    security: { section: 'security', view: 'security' },
    audit: { section: 'history', view: null },
  };
  for (const legacy of LEGACY_USER_TABS) {
    const resolved = resolveUserTab(legacy, null);
    assert.deepEqual(resolved, expected[legacy], `?tab=${legacy} no longer lands correctly`);
    assert.notEqual(resolved.section, 'overview', `?tab=${legacy} fell through to Overview`);
  }
});

test('the new section names resolve, and a nonsense tab lands on Overview', () => {
  for (const section of USER_SECTIONS) {
    assert.equal(resolveUserTab(section, null).section, section);
  }
  // A section with subsections opens its first when none is named.
  assert.equal(resolveUserTab('access', null).view, 'roles');
  assert.equal(resolveUserTab('organisation', null).view, 'assignments');
  // A view that means nothing does not cost the section that does.
  assert.equal(resolveUserTab('access', 'nonsense').section, 'access');
  assert.equal(resolveUserTab('access', 'nonsense').view, 'roles');
  assert.equal(resolveUserTab('nonsense', null).section, 'overview');
  assert.equal(resolveUserTab(null, null).section, 'overview');
});

test('every capability the nine tabs carried is still on a section', () => {
  const views = USER_SECTION_MODEL.flatMap((entry) => entry.views.map((view) => view.key));
  for (const key of ['assignments', 'teams', 'roles', 'authority', 'identities', 'security']) {
    assert.ok(views.includes(key), `${key} is no longer a subsection anywhere`);
  }
  // History has no chooser because it holds one thing.
  assert.deepEqual(USER_SECTION_MODEL.find((e) => e.section === 'history')?.views, []);

  // And the page renders each one.
  const page = read('src/pages/cms/app/administration/users/[id].astro');
  for (const [section, view] of [
    ['organisation', 'assignments'],
    ['organisation', 'teams'],
    ['access', 'roles'],
    ['access', 'authority'],
    ['security', 'identities'],
    ['security', 'security'],
  ]) {
    assert.match(
      page,
      new RegExp(`tab === '${section}' && view === '${view}'`),
      `the ${section}/${view} block is not rendered`,
    );
  }
  assert.match(page, /tab === 'history'/, 'the audit block is not rendered');
});

test('the section link builder produces the canonical shape', () => {
  const base = '/app/administration/users/USR-1';
  assert.equal(userSectionHref(base, 'access'), `${base}?tab=access`);
  assert.equal(userSectionHref(base, 'access', 'authority'), `${base}?tab=access&view=authority`);
});

test('grouping Access on screen did not merge the two permissions behind it', () => {
  // Roles and workflow authority sit under one heading. They remain two
  // capabilities: a person who may grant one must not thereby grant the other.
  const page = read('src/pages/cms/app/administration/users/[id].astro');
  assert.match(page, /const mayManageRoles = canManageRoles\(permissions\)/);
  assert.match(page, /const mayManageAuthority = canManageWorkflowRoles\(permissions\)/);
  assert.equal(
    /mayManageRoles \|\| mayManageAuthority/.test(page.slice(0, page.indexOf('---', 3))),
    false,
    'the two capabilities were collapsed into one check',
  );
});

// ---- CRM -------------------------------------------------------------------

test('CRM keeps three operational tabs and gains one settings entry', () => {
  const nav = read('src/components/cms/CmsCrmNav.astro');
  assert.match(nav, /const OPERATIONAL = \['Leads', 'Opportunities', 'Activities'\]/);
  assert.match(nav, /CRM settings/);
  // Every CRM configuration page is in the menu, which is more than it had:
  // three of them had no link anywhere in the product before this.
  const settings = CMS_DESTINATIONS.filter(
    (d) => d.area === 'CRM' && !['Leads', 'Opportunities', 'Activities'].includes(d.label),
  ).map((d) => d.href);
  for (const href of [
    '/app/crm/lead-sources',
    '/app/crm/pipelines',
    '/app/crm/lost-reasons',
    '/app/crm/analytics',
  ]) {
    assert.ok(settings.includes(href), `${href} is not reachable from CRM`);
  }
});

test('the CRM settings menu is permission-aware and never renders empty', () => {
  const nav = read('src/components/cms/CmsCrmNav.astro');
  assert.match(nav, /destinationAllowed\(d, permissions\)/, 'the menu is not filtered');
  assert.match(nav, /settings\.length > 0 &&/, 'an empty menu can still render');
  // A lead-only reader is offered no settings at all.
  const forReader = CMS_DESTINATIONS.filter(
    (d) =>
      d.area === 'CRM' &&
      !['Leads', 'Opportunities', 'Activities'].includes(d.label) &&
      destinationAllowed(d, ['CRM.LEADS.VIEW']),
  );
  assert.deepEqual(forReader, []);
});

test('all three CRM workspaces render the same local navigation', () => {
  for (const page of ['crm.astro', 'crm/opportunities.astro', 'crm/activities.astro']) {
    assert.match(
      read(`src/pages/cms/app/${page}`),
      /<CmsCrmNav/,
      `${page} does not use the shared CRM navigation`,
    );
  }
});

// ---- Helpdesk --------------------------------------------------------------

test('every helpdesk queue key survives, and only three are primary', () => {
  const page = read('src/pages/cms/app/helpdesk.astro');
  // THE KEYS ARE THE CONTRACT. `?queue=waiting-internal` in somebody's
  // bookmark must still select that queue, whether or not the strip shows it.
  for (const key of [
    'mine',
    'unassigned',
    'new',
    'waiting-customer',
    'waiting-internal',
    'resolved',
  ]) {
    assert.match(page, new RegExp(`'${key}'`), `the ${key} queue was removed`);
  }
  const primary = page.slice(
    page.indexOf('const PRIMARY_QUEUES'),
    page.indexOf('const MORE_QUEUES'),
  );
  assert.equal((primary.match(/key:/g) ?? []).length, 3, 'the primary strip is not three choices');
  assert.match(primary, /'mine'/);
  assert.match(primary, /'unassigned'/);
  assert.match(primary, /key: null/);
  // The rest are behind one disclosure with a label a person can predict.
  assert.match(page, /More views/);

  // The repository still accepts every key, which is where the contract lives.
  const repo = read('src/lib/cms/repos/serviceAdmin.ts');
  for (const key of [
    'mine',
    'unassigned',
    'new',
    'waiting-customer',
    'waiting-internal',
    'resolved',
  ]) {
    assert.match(repo, new RegExp(`case '${key}'`), `${key} is no longer a queue predicate`);
  }
});

test('a KPI links to a queue only where the two count the same thing', () => {
  const page = read('src/pages/cms/app/helpdesk.astro');
  // New matches queue `new` exactly, so it opens it.
  assert.match(
    page,
    /label="New" value=\{String\(indicators\.newCases\)\} href=\{queueHref\('new'\)\}/,
  );
  // Assigned to me excludes closed cases; queue `mine` does not. Resolved
  // today is today; queue `resolved` is every resolved case. Neither may link,
  // because a figure that opens a list showing a different number is worse
  // than a figure that opens nothing.
  for (const label of ['Assigned to me', 'In progress', 'Waiting', 'Resolved today']) {
    const card = page.slice(page.indexOf(`label="${label}"`));
    const line = card.slice(0, card.indexOf('/>'));
    assert.equal(/href=/.test(line), false, `${label} links to a queue it does not match`);
  }
});

// ---- Home ------------------------------------------------------------------

test('Home discloses the deeper analysis and deletes none of it', () => {
  const page = read('src/pages/cms/app/index.astro');
  assert.match(page, /<CmsMoreDetail id="purchases">/);
  assert.match(page, /<CmsMoreDetail id="sales">/);
  // Both trends and both leaderboards are still rendered, inside it.
  assert.match(page, /title="Purchase order turnaround trend"/);
  assert.match(page, /title="Sales order turnaround trend"/);
  assert.equal((page.match(/<CmsApprovalLeaderboard/g) ?? []).length, 2);
  // And still COMPUTED: a disclosure is not an excuse to stop measuring.
  assert.match(page, /const purchaseTrendChart = trendOf\(/);
  assert.match(page, /const salesTrendChart = trendOf\(/);
  // The headline figures stay in the first view, outside the disclosure.
  const firstDetail = page.indexOf('<CmsMoreDetail');
  assert.ok(page.slice(0, firstDetail).includes('Purchase order approval'), 'the bars were hidden');
});

test('the Home disclosure remembers per browser and adds no schema', () => {
  const source = read('src/components/cms/CmsMoreDetail.astro');
  assert.match(source, /localStorage/, 'the preference is not remembered');
  assert.match(source, /catch/, 'an unguarded localStorage read can take the page down');
  assert.match(source, /More detail/, 'the disclosure label is unpredictable');
  // Native disclosure, no animation, no framework.
  assert.match(source, /<details/);
  assert.equal(/transition-\[|animate-/.test(source), false, 'the disclosure animates');
});

// ---- Orders ----------------------------------------------------------------

test('all four order workspaces keep their routes and share one local navigation', () => {
  const specs: [string, string, string][] = [
    ['orders/sales.astro', 'sales', 'operations'],
    ['orders/purchases.astro', 'purchases', 'operations'],
    ['orders/sales/performance.astro', 'sales', 'performance'],
    ['orders/purchases/performance.astro', 'purchases', 'performance'],
  ];
  for (const [file, process, mode] of specs) {
    const page = read(`src/pages/cms/app/${file}`);
    assert.match(
      page,
      new RegExp(`<CmsOrdersNav process="${process}" mode="${mode}"`),
      `${file} does not carry the shared order navigation`,
    );
  }
  // The hub is kept, not replaced.
  assert.ok(existsSync('src/pages/cms/app/orders.astro'), 'the Orders landing page was deleted');
  // Two dimensions rather than four equal tabs.
  const nav = read('src/components/cms/CmsOrdersNav.astro');
  assert.match(nav, /aria-label="Order process"/);
  assert.match(nav, /aria-label="Order view"/);
  // Switching one keeps the other.
  assert.match(nav, /href\(entry\.key, mode\)/);
  assert.match(nav, /href\(process, entry\.key\)/);
});

// ---- top bar and orientation ----------------------------------------------

test('the top bar stays global-only', () => {
  const bar = read('src/components/cms/CmsTopBar.astro');
  // No module shortcuts were added under cover of a navigation task.
  for (const path of [
    '/app/crm',
    '/app/orders',
    '/app/data',
    '/app/administration',
    '/app/helpdesk',
  ]) {
    assert.equal(bar.includes(`href="${path}"`), false, `the top bar links to ${path}`);
  }
  // The one intended change: the placeholder now says what the box does.
  assert.match(bar, /placeholder="Search records or pages"/);
});

test('orientation cues survive the decluttering', () => {
  const layout = read('src/layouts/CmsLayout.astro');
  assert.match(layout, /skip/i, 'the skip link is gone');
  const rail = read('src/components/cms/CmsSidebar.astro');
  assert.match(rail, /aria-current=\{active \? 'page' : undefined\}/, 'the rail lost its marker');
  const tabs = read('src/components/cms/CmsTabs.astro');
  assert.match(tabs, /aria-current/, 'the tab strip lost its marker');
  // The new local navigations mark their current item too, and not by colour
  // alone: each pairs the marker with a border and a weight change.
  for (const file of ['CmsOrdersNav.astro', 'CmsCrmNav.astro']) {
    assert.match(read(`src/components/cms/${file}`), /aria-current|CmsTabs/);
  }
});

test('the rail cue is shown once and stored the way the rail already stores', () => {
  const script = read('src/components/cms/CmsRailScript.astro');
  assert.match(script, /const HINT_KEY = 'cms\.rail\.hint'/);
  // Only for somebody with no preference at all, and never again afterwards.
  assert.match(script, /localStorage\.getItem\(PIN_KEY\) === null/);
  assert.match(script, /localStorage\.setItem\(HINT_KEY, '1'\)/);
  assert.match(script, /\{ once: true \}/, 'the cue can be re-shown in one session');
  const layout = read('src/layouts/CmsLayout.astro');
  assert.match(layout, /data-cms-rail-hint-dot/, 'the cue is invisible on a collapsed rail');
});

// ---- breadcrumbs -----------------------------------------------------------

test('no breadcrumb claims an ancestor that is not a real destination', () => {
  /*
    THE CASE THIS EXISTS FOR. Six CRM pages showed a clickable ancestor
    labelled "CRM" pointing at /app/crm — a page whose heading reads Leads. So
    pressing CRM landed somewhere that announced itself as something else,
    which is an information-scent failure and the exact thing a breadcrumb is
    supposed to prevent.
  */
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.astro')) files.push(full);
    }
  };
  walk('src/pages/cms/app');

  for (const file of files) {
    const source = read(file);
    assert.equal(
      source.includes("{ label: 'CRM', href: '/app/crm' }"),
      false,
      `${file} labels the Leads page as CRM`,
    );
    // And the renamed labels reach the breadcrumbs too, so one page does not
    // call the Upload Centre by its old name.
    assert.equal(
      source.includes("{ label: 'Data', href: '/app/data' }"),
      false,
      `${file} still says Data in a breadcrumb`,
    );
  }
});

test('the leads page names itself once in its own breadcrumb', () => {
  // It read Home / CRM / Leads: two ancestors for one page, one of them false
  // and neither clickable to anywhere different.
  const page = read('src/pages/cms/app/crm.astro');
  assert.match(page, /crumbs=\{\[\{ label: 'Home', href: '\/app' \}, \{ label: 'Leads' \}\]\}/);
});

// ---- one source of truth ---------------------------------------------------

test('the rail, Administration and page search all read one catalogue', () => {
  // A hand-maintained second list is the thing that diverges; the rail is
  // derived from the catalogue rather than written beside it.
  const nav = read('src/lib/cms/nav.ts');
  assert.match(nav, /from '\.\/destinations\.ts'/);
  assert.match(nav, /CMS_DESTINATIONS\.filter/);
  const admin = read('src/pages/cms/app/administration.astro');
  assert.match(admin, /adminGroups\(permissions\)/);
  const page = read('src/lib/cms/search/pageSearch.ts');
  assert.match(page, /allowedDestinations\(permissions\)/);

  // And the filter is the same function in all three.
  assert.equal(
    allowedDestinations(EVERYTHING).length,
    CMS_DESTINATIONS.filter((d) => destinationAllowed(d, EVERYTHING)).length,
  );
});
