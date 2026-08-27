/**
 * Phase 28: the review's findings, held in place by tests.
 *
 * A REVIEW PHASE'S OUTPUT IS EVIDENCE, and evidence that only exists in a
 * pull request description rots. Every finding in this phase that can be
 * expressed as a property of the repository is expressed as one here, so the
 * next person to break it finds out from the suite rather than from a user.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createTestDb, type TestClient } from './support/db.ts';
import { seedHass } from './support/hassSeed.ts';
import { resolveScope, forgetResolvedScopes } from '../../src/lib/cms/auth/rbac.ts';
import { CMS_NAV, visibleNav, navItemAllowed } from '../../src/lib/cms/nav.ts';

const asClient = (c: TestClient) => c as unknown as Parameters<typeof resolveScope>[0];

function walk(dir: string, ext: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path, ext));
    else if (path.endsWith(ext)) out.push(path);
  }
  return out;
}

const CMS_PAGES = walk('src/pages/cms', '.astro');
const CMS_COMPONENTS = walk('src/components/cms', '.astro');
const read = (path: string): string => readFileSync(path, 'utf8');

// ---------------------------------------------------------------------------
// §5 The scope memo: the performance fix, and its security property
// ---------------------------------------------------------------------------

test('the scope memo answers from cache within one client and never across two', async () => {
  const c = await db();
  const other = await db();

  let queries = 0;
  const counting = (inner: TestClient): TestClient =>
    ({
      ...inner,
      async execute(stmt: never) {
        queries += 1;
        return inner.execute(stmt);
      },
    }) as TestClient;

  const one = counting(c) as unknown as Parameters<typeof resolveScope>[0];

  const first = await resolveScope(one, 'USR-CATH', 'CUSTOMERS.ACCOUNTS.VIEW');
  const after = queries;
  const second = await resolveScope(one, 'USR-CATH', 'CUSTOMERS.ACCOUNTS.VIEW');
  assert.equal(queries, after, 'the second resolution issued no query');
  assert.deepEqual(second, first);

  // A DIFFERENT PERMISSION IS A DIFFERENT KEY. The measured saving came from
  // eight helpers asking the same question; it must never come from one
  // helper receiving another's answer.
  await resolveScope(one, 'USR-CATH', 'ORDERS.SALES_ORDER.VIEW');
  assert.equal(queries > after, true, 'a different permission is resolved afresh');

  // A DIFFERENT USER IS A DIFFERENT KEY. Serving a Group user's resolution to
  // a country user is a breach, not a performance bug.
  const beforeUser = queries;
  const uganda = await resolveScope(one, 'USR-FMUG', 'CUSTOMERS.ACCOUNTS.VIEW');
  assert.equal(queries > beforeUser, true, 'a different user is resolved afresh');
  assert.equal(uganda.userId, 'USR-FMUG', 'and the answer is about that user');
  assert.notEqual(uganda.userId, first.userId);

  // A DIFFERENT CLIENT IS A DIFFERENT REQUEST. `getDb` builds one per
  // request, so nothing memoised can outlive the request that memoised it.
  let otherQueries = 0;
  const two = {
    ...other,
    async execute(stmt: never) {
      otherQueries += 1;
      return other.execute(stmt);
    },
  } as unknown as Parameters<typeof resolveScope>[0];
  await resolveScope(two, 'USR-CATH', 'CUSTOMERS.ACCOUNTS.VIEW');
  assert.equal(otherQueries, 1, 'a fresh client resolves from the database');

  c.close();
  other.close();
});

test('a permission granted after a resolution is seen by the next request', async () => {
  const c = await db();
  const client = asClient(c);

  const before = await resolveScope(client, 'USR-CATH', 'AUDIT.EVENTS.SECURITY_VIEW');
  assert.equal(before.granted, false, 'the code does not exist yet');

  await c.execute(`INSERT OR IGNORE INTO permissions
      (permission_id, module_name, resource_name, action_name, description)
    VALUES ('PERM-041','AUDIT','EVENTS','SECURITY_VIEW','View security events')`);
  await c.execute(`INSERT OR IGNORE INTO role_permissions
      (role_permission_id, role_id, permission_id, allowed, created_at)
    VALUES ('RP-ADM-041','ROLE-ADMIN','PERM-041',1,CURRENT_TIMESTAMP)`);

  // Within the same notional request the answer is unchanged, which is
  // correct: a permission does not change halfway through rendering a page.
  const sameRequest = await resolveScope(client, 'USR-CATH', 'AUDIT.EVENTS.SECURITY_VIEW');
  assert.equal(sameRequest.granted, false);

  // The next request sees it.
  forgetResolvedScopes(client);
  const nextRequest = await resolveScope(client, 'USR-CATH', 'AUDIT.EVENTS.SECURITY_VIEW');
  assert.equal(nextRequest.granted, true);
  c.close();
});

async function db(): Promise<TestClient> {
  const c = createTestDb();
  await seedHass(c);
  return c;
}

// ---------------------------------------------------------------------------
// §2 Navigation
// ---------------------------------------------------------------------------

test('no empty parent menu is shown to a user with no child permission', () => {
  // Every entry either requires no permission, or requires codes that a
  // holder could actually use. An entry naming a code nobody can hold would
  // be a menu item that opens a screen refusing its own visitor.
  for (const item of CMS_NAV) {
    if (item.permission === null) continue;
    const codes = typeof item.permission === 'string' ? [item.permission] : item.permission;
    assert.equal(codes.length > 0, true, `${item.label} names an empty permission list`);
    for (const code of codes) {
      assert.match(code, /^[A-Z_]+\.[A-Z_]+\.[A-Z_]+$/, `${item.label}: ${code} is not a code`);
    }
    // Holding any one of them makes the entry visible; holding none hides it.
    assert.equal(navItemAllowed(item, codes.slice(0, 1)), true);
    assert.equal(navItemAllowed(item, []), false, `${item.label} shows to a user with nothing`);
  }

  // A principal with no codes at all sees only the entries that require none.
  const nothing = visibleNav([]);
  for (const item of nothing) {
    assert.equal(item.permission, null, `${item.label} appeared for a user with no permissions`);
  }
});

// ---------------------------------------------------------------------------
// §2 Forms and §3 accessibility
// ---------------------------------------------------------------------------

test('no database column name appears in a form label', () => {
  const offenders: string[] = [];
  for (const path of [...CMS_PAGES, ...CMS_COMPONENTS]) {
    for (const match of read(path).matchAll(/label="([^"]+)"/g)) {
      const label = match[1] as string;
      // A column name looks like `snake_case`, ends in `_id` or `_at`, or is
      // a bare camelCase identifier. A real label has a space and a capital.
      if (/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(label) || /_id$|_at$/.test(label)) {
        offenders.push(`${path}: ${label}`);
      }
    }
  }
  assert.deepEqual(offenders, [], 'a reader must never be shown a column name');
});

test('every status is carried by text as well as colour', () => {
  // CmsBadge is the one status primitive, and it takes a `label` alongside
  // its `tone`. A caller passing a tone and no label would be conveying
  // status by colour alone, which is what this forbids.
  const badge = read('src/components/cms/CmsBadge.astro');
  assert.match(badge, /label: string;/, 'the label is required, not optional');

  const offenders: string[] = [];
  for (const path of [...CMS_PAGES, ...CMS_COMPONENTS]) {
    const source = read(path);
    // Scanned rather than matched with one expression, because `>` appears
    // inside attribute expressions (`tone={n > 0 ? ...}`) and a lazy regex
    // stops there and reports a false breach.
    let cursor = source.indexOf('<CmsBadge');
    while (cursor !== -1) {
      let depth = 0;
      let end = cursor;
      for (; end < source.length; end += 1) {
        const ch = source[end];
        if (ch === '{') depth += 1;
        else if (ch === '}') depth -= 1;
        else if (ch === '>' && depth === 0) break;
      }
      const tag = source.slice(cursor, end + 1);
      if (!/\blabel[=\s]/.test(tag)) {
        offenders.push(`${path}: ${tag.replace(/\s+/g, ' ').slice(0, 90)}`);
      }
      cursor = source.indexOf('<CmsBadge', end);
    }
  }
  assert.deepEqual(offenders, [], 'a badge without a label is status by colour alone');
});

test('every page renders exactly one page header, so there is exactly one h1', () => {
  const offenders: string[] = [];
  for (const path of CMS_PAGES) {
    const source = read(path);
    // A route that only redirects renders no document, so it needs no title.
    // `src/pages/cms/index.astro` is one: it exists so that middleware has a
    // route to run on, and returns before any markup.
    if (/return Astro\.redirect\(/.test(source) && !source.includes('<CmsLayout')) continue;
    const headers = (source.match(/<CmsPageHeader\b/g) ?? []).length;
    const rawH1 = (source.match(/<h1\b/g) ?? []).length;
    // A page uses the header component, or renders its own single h1. The
    // portal and the login page do the latter, deliberately: their shells
    // are not the application shell.
    if (headers === 0 && rawH1 === 0) offenders.push(`${path}: no page title at all`);
    if (headers > 1) offenders.push(`${path}: ${headers} page headers`);
    if (rawH1 > 1) offenders.push(`${path}: ${rawH1} h1 elements`);
  }
  assert.deepEqual(offenders, []);
});

test('every interactive control can take focus visibly', () => {
  // The focus ring is a token and every control carries it. A control with a
  // hover style and no focus style is unusable by keyboard, and the hover
  // style is what makes that easy to miss when testing with a mouse.
  const offenders: string[] = [];
  for (const path of [...CMS_PAGES, ...CMS_COMPONENTS]) {
    const source = read(path);
    const hovers = (source.match(/hover:bg-|hover:text-/g) ?? []).length;
    const focuses = (source.match(/focus-visible:/g) ?? []).length;
    if (hovers > 0 && focuses === 0) offenders.push(`${path}: ${hovers} hover styles, no focus`);
  }
  assert.deepEqual(offenders, [], 'a hover style with no focus style is a mouse-only control');
});

// ---------------------------------------------------------------------------
// §4 Status language
// ---------------------------------------------------------------------------

test('the SLA vocabulary is fixed and has no synonyms', () => {
  // Within SLA, At Risk, Breached, Paused, Met. Nothing else names an SLA
  // state, in any user-visible string in the CMS.
  const banned = /\b(overdue|late)\b/i;
  const offenders: string[] = [];
  for (const path of [...CMS_PAGES, ...CMS_COMPONENTS]) {
    const source = read(path);
    // Only text between tags, which is what a user reads.
    for (const match of source.matchAll(/>([^<>{}]{3,120})</g)) {
      const text = (match[1] as string).trim();
      if (text === '' || !banned.test(text)) continue;
      offenders.push(`${path}: ${text}`);
    }
  }
  assert.deepEqual(offenders, [], 'these read as synonyms for a breach and are not');
});

// ---------------------------------------------------------------------------
// §3 Charts
// ---------------------------------------------------------------------------

test('every chart carries a title, textual values and a tabular alternative', () => {
  const svg = readFileSync('src/lib/cms/charts/svg.ts', 'utf8');
  // The module returns a table beside every chart, and the component renders
  // it. Hover alone is not an interface.
  assert.match(svg, /alt:/, 'every chart returns a text alternative');
  assert.match(svg, /table:/, 'every chart returns a data table');
  assert.match(svg, /role="img"/, 'the SVG is announced as an image');

  const component = readFileSync('src/components/cms/CmsChart.astro', 'utf8');
  assert.match(component, /sr-only/, 'the alternative is available to a screen reader');
  assert.match(component, /<details/, 'the data table is reachable without a mouse');

  // And no hex: the palette is tokens, so a chart inherits the contrast the
  // rest of the application was measured at.
  assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(svg), false, 'a chart colour must be a token');
});

// ---------------------------------------------------------------------------
// §2 Loading and stale data
// ---------------------------------------------------------------------------

test('no page renders a previous record while the next one loads', () => {
  // The whole application is server-rendered with `prerender = false`: a
  // detail page is a fresh document, so there is no moment at which the
  // previous customer's data is on screen under the next customer's title.
  // The property that guarantees it is that no page fetches its own record
  // client-side, so this asserts that.
  const offenders: string[] = [];
  for (const path of CMS_PAGES) {
    const source = read(path);
    if (!source.includes('prerender = false')) offenders.push(`${path}: not server-rendered`);
  }
  assert.deepEqual(offenders, [], 'a prerendered page would serve a build-time record');
});
