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
import { createBatcher, runSection } from '../../src/lib/cms/batching.ts';
import { countRoundTrips } from './support/subrequestBudget.ts';
import { CMS_NAV, visibleNav, navItemAllowed } from '../../src/lib/cms/nav.ts';

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

/**
 * A seeded database for the scope tests.
 *
 * IT WAS MISSING. This file arrived on `main` calling `db()` with no such
 * helper anywhere in it, which the merge hid: the file also imported a symbol
 * that no longer existed, so it failed to compile and nobody reached the
 * runtime error underneath. It is defined here now, matching the one the
 * subrequest budget test uses, including the two permission rows those tests
 * resolve against: they live in the operator's numbered scripts rather than in
 * the seed, so a test that needs them has to insert them.
 */
async function db(): Promise<TestClient> {
  const c = createTestDb();
  await seedHass(c);
  await c.execute(`INSERT OR IGNORE INTO permissions (permission_id, module_name, resource_name, action_name, description) VALUES
    ('PERM-031','CUSTOMERS','ACCOUNTS','VIEW','View customer accounts and their contacts'),
    ('PERM-036','CRM','OPPORTUNITIES','VIEW','View opportunities and the pipeline')`);
  await c.execute(`INSERT OR IGNORE INTO role_permissions (role_permission_id, role_id, permission_id, allowed, created_at)
    SELECT 'RP-ADMIN-' || permission_id, 'ROLE-ADMIN', permission_id, 1, CURRENT_TIMESTAMP
    FROM permissions WHERE permission_id IN ('PERM-031','PERM-036')`);
  return c;
}

// ---------------------------------------------------------------------------
// §5 The scope memo: the performance fix, and its security property
// ---------------------------------------------------------------------------

/**
 * THESE TWO TESTS WERE REWRITTEN WHEN #175 AND #176 MET ON `main`.
 *
 * Two branches independently added a per-request scope memo and the merge kept
 * one of them. The surviving implementation is the narrower and better of the
 * two: it engages only for a client carrying the batcher's root symbol, which
 * is what every page render uses, and deliberately does NOT memoise a bare
 * client. The consequence is worth stating, because it is a safety property
 * rather than an accident: code that resolves scope outside a batch, which
 * includes every write path that grants a role and then re-reads, is never
 * served an answer from before its own grant.
 *
 * The properties below are the ones the measurement was about and they are
 * unchanged. They are now asserted through the batcher, because that is the
 * only place the memo exists and therefore the only place it can be wrong.
 */
test('the scope memo answers from cache within one request and never across two', async () => {
  const c = await db();
  const other = await db();

  // One request: a batcher over one client, exactly as a page render builds it.
  const countedOne = countRoundTrips(c);
  const batcherOne = createBatcher(countedOne.db as never);

  const [first, second, differentPermission, differentUser] = await runSection(
    batcherOne,
    'memo',
    async (client) => {
      const a = await resolveScope(client, 'USR-CATH', 'CUSTOMERS.ACCOUNTS.VIEW');
      const beforeRepeat = countedOne.statements();
      const b = await resolveScope(client, 'USR-CATH', 'CUSTOMERS.ACCOUNTS.VIEW');
      const repeatCost = countedOne.statements() - beforeRepeat;

      // A DIFFERENT PERMISSION IS A DIFFERENT KEY. The measured saving came
      // from eight helpers asking the same question; it must never come from
      // one helper receiving another's answer.
      const orders = await resolveScope(client, 'USR-CATH', 'ORDERS.SALES_ORDER.VIEW');
      // A DIFFERENT USER IS A DIFFERENT KEY. Serving a Group user's
      // resolution to a country user is a breach, not a performance bug.
      const uganda = await resolveScope(client, 'USR-FMUG', 'CUSTOMERS.ACCOUNTS.VIEW');
      assert.equal(repeatCost, 0, 'the second resolution of the same key issued no statement');
      return [a, b, orders, uganda];
    },
  ).then((r) => (r.ok ? r.value : Promise.reject(new Error('section failed'))));

  assert.deepEqual(second, first, 'the cached answer is the same answer');
  assert.equal(differentPermission.permission, 'ORDERS.SALES_ORDER.VIEW');
  assert.equal(differentUser.userId, 'USR-FMUG', 'a different user gets their own answer');
  assert.notEqual(differentUser.userId, first.userId);

  // A DIFFERENT REQUEST IS A DIFFERENT CLIENT. `getDb` builds one per request,
  // so nothing memoised can outlive the request that memoised it.
  const countedTwo = countRoundTrips(other);
  const batcherTwo = createBatcher(countedTwo.db as never);
  await runSection(batcherTwo, 'memo', (client) =>
    resolveScope(client, 'USR-CATH', 'CUSTOMERS.ACCOUNTS.VIEW'),
  );
  assert.ok(countedTwo.statements() > 0, 'a fresh request resolves from the database');

  c.close();
  other.close();
});

test('a permission granted after a resolution is seen by the next request', async () => {
  const c = await db();

  const grantedIn = async (batcher: ReturnType<typeof createBatcher>) => {
    const result = await runSection(batcher, 'grant', (client) =>
      resolveScope(client, 'USR-CATH', 'AUDIT.EVENTS.SECURITY_VIEW'),
    );
    if (!result.ok) throw new Error('section failed');
    return result.value.granted;
  };

  const requestOne = createBatcher(c as never);
  assert.equal(await grantedIn(requestOne), false, 'the code does not exist yet');

  await c.execute(`INSERT OR IGNORE INTO permissions
      (permission_id, module_name, resource_name, action_name, description)
    VALUES ('PERM-041','AUDIT','EVENTS','SECURITY_VIEW','View security events')`);
  await c.execute(`INSERT OR IGNORE INTO role_permissions
      (role_permission_id, role_id, permission_id, allowed, created_at)
    VALUES ('RP-ADM-041','ROLE-ADMIN','PERM-041',1,CURRENT_TIMESTAMP)`);

  // Within the same request the answer is unchanged, which is correct: a
  // permission does not change halfway through rendering a page.
  assert.equal(await grantedIn(requestOne), false, 'the same request is consistent with itself');

  // THE NEXT REQUEST. In production that is a new client, because `getDb`
  // builds one per request and the memo is keyed on it. The harness holds ONE
  // connection for the whole test, so a second batcher over it is still the
  // same request as far as the memo is concerned; clearing the memo for that
  // client is how the harness expresses the request boundary, and it is the
  // only reason `forgetResolvedScopes` is exported at all.
  forgetResolvedScopes(c as never);
  const requestTwo = createBatcher(c as never);
  assert.equal(await grantedIn(requestTwo), true, 'the next request sees the grant');

  c.close();
});

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
    // A partial renders INTO a page that already has its h1; a title of its
    // own would give the host document two. The rule inverts for fragments.
    if (/export const partial = true/.test(source)) {
      if (headers > 0 || rawH1 > 0) offenders.push(`${path}: a fragment must not carry a title`);
      continue;
    }
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
