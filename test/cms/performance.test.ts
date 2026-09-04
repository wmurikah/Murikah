/**
 * Phase 5 performance regressions: the request-scoped database client, the
 * notification bell off the critical path, section-shaped loading, the
 * deferred Home trend, the sign-in quote curtain and the navigation activity
 * line. Each test pins the property that made a page faster, so the next
 * refactor cannot quietly give it back.
 *
 * Two styles on purpose. Pure logic (the trace, the quote picker) is tested
 * by calling it. Wiring that lives in .astro frontmatter and component
 * scripts is pinned by reading the source, the same way navigationIa.test.ts
 * and designSweep.test.ts pin structure — a wiring regression is a text
 * change in exactly these places.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { requestDb } from '../../src/lib/cms/db.ts';
import type { Client } from '@libsql/client/web';
import {
  startTrace,
  serverTimingValue,
  slowRequestLine,
  SLOW_REQUEST_MS,
} from '../../src/lib/cms/perf.ts';
import { SIGN_IN_QUOTES, pickQuote, LAST_QUOTE_KEY } from '../../src/lib/cms/auth/quotes.ts';

const read = (path: string) => readFileSync(path, 'utf8');

// ---- One database client per request ---------------------------------------

test('requestDb hands back the client the middleware already made', async () => {
  // The whole point of the request-scoped client: when the middleware has
  // attached its client to locals, every later caller gets THAT client — no
  // second createClient, no second PRAGMA round trip.
  const sentinel = { closed: false } as unknown as Client;
  assert.equal(await requestDb({ cmsDb: sentinel }), sentinel);
});

test('requestDb still stands alone when no request client exists', () => {
  // Scripts and tests call repos without a middleware in front of them; the
  // fallback path must remain, and it must remain lazy (a dynamic import) so
  // requestDb itself never drags env resolution into a request that has a
  // client. Source-pinned: calling the fallback would need real credentials.
  const source = read('src/lib/cms/db.ts');
  assert.match(source, /if \(locals\.cmsDb !== undefined\) return locals\.cmsDb;/);
  assert.match(source, /await import\('\.\/env\.ts'\)/, 'the fallback resolves env lazily');
  // And write integrity is untouched: the one place clients are made still
  // turns foreign keys on.
  assert.match(source, /PRAGMA foreign_keys = ON/);
});

test('the middleware attaches its client and reports its phases', () => {
  const source = read('src/middleware.ts');
  // The client the guard used to discard is now the request's client…
  assert.match(source, /context\.locals\.cmsDb = db;/);
  // …and only for an authenticated request: the sign-in page holds no handle.
  const attach = source.indexOf('context.locals.cmsDb = db;');
  const principalCheck = source.lastIndexOf("resolution.kind === 'authenticated'", attach);
  assert.ok(principalCheck !== -1, 'the client is attached only once the session resolved');
  // Server-Timing rides authenticated page responses; names and durations only.
  assert.match(source, /serverTimingValue\(trace\)/);
  assert.match(source, /response\.headers\.set\('server-timing', value\)/);
  // The slow-request line goes through the one sanitised formatter.
  assert.match(source, /if \(trace\.total\(\) >= SLOW_REQUEST_MS\)/);
  assert.match(source, /console\.warn\(slowRequestLine\(appPath, trace\)\)/);
});

test('API mutations reuse the request client through connect(locals)', () => {
  const source = read('src/lib/cms/admin/crudRoute.ts');
  assert.match(source, /locals\?.cmsDb/, 'connect() must prefer the request client');
  // The route factories thread their own context through.
  assert.match(source, /connect\(context\.locals\)/);
});

// ---- The trace and its two sanitised outputs -------------------------------

test('a phase that runs twice reports its sum under one name', () => {
  const trace = startTrace();
  trace.add('db', 100);
  trace.add('db', 30);
  trace.add('auth', 5);
  assert.deepEqual(
    trace.spans().map((s) => ({ name: s.name, dur: Math.round(s.dur) })),
    [
      { name: 'db', dur: 130 },
      { name: 'auth', dur: 5 },
    ],
  );
});

test('the Server-Timing value carries names and durations, nothing else', () => {
  const trace = startTrace();
  trace.add('auth', 12.4);
  trace.add('page', 100.6);
  assert.equal(serverTimingValue(trace), 'auth;dur=12, page;dur=101');
});

test('a malformed span name cannot smuggle a header delimiter', () => {
  const trace = startTrace();
  trace.add('ok-name', 5);
  trace.add('bad name;desc="SELECT * FROM users"', 5);
  assert.equal(serverTimingValue(trace), 'ok-name;dur=5');
});

test('the slow-request line never carries a query string', () => {
  // Identifiers live in query strings; the log line stops at the route.
  const trace = startTrace();
  trace.add('db', 800);
  const line = slowRequestLine('/app/customers?customerId=CUST-42', trace);
  assert.match(line, /^\[cms\.perf\] path=\/app\/customers total=\d+ db=800$/);
  assert.ok(!line.includes('CUST-42'));
  assert.equal(SLOW_REQUEST_MS, 750);
});

// ---- The bell, off the critical path ---------------------------------------

test('the layout renders no notification query', () => {
  const layout = read('src/layouts/CmsLayout.astro');
  for (const gone of ['unreadCount', 'listNotifications', 'getDb', 'requestDb']) {
    assert.ok(!layout.includes(gone), `CmsLayout still touches ${gone} — the bell tax is back`);
  }
});

test('the bell endpoint authenticates and answers count-only by default', () => {
  const source = read('src/pages/cms/api/notifications/bell.ts');
  // Deferring the fetch must not defer the authorisation.
  assert.match(source, /requireSignedIn\(context\)/);
  // The caller is the session's user; a userId in the query is not read.
  assert.match(source, /auth\.principal\.user\.userId/);
  assert.ok(!/searchParams\.get\('userId'\)/.test(source));
  // Count alone unless the menu was actually opened.
  assert.match(source, /searchParams\.get\('preview'\) !== '1'/);
  // And it rides the request-scoped client.
  assert.match(source, /connect\(context\.locals\)/);
});

test('the bell fetch is idle-time, silent on failure, and skipped when known', () => {
  const topBar = read('src/components/cms/CmsTopBar.astro');
  assert.match(topBar, /requestIdleCallback/, 'the count fetch must wait for idle time');
  assert.match(topBar, /data-known/, 'a page that knows its count must not refetch it');
  assert.ok(!/setInterval/.test(topBar), 'no polling: one quiet fetch, no retry loop');
});

// ---- Section-shaped loading on the user detail page ------------------------

test('the user detail page loads only the open section', () => {
  const page = read('src/pages/cms/app/administration/users/[id].astro');
  // The audit list is fetched for the History tab and no other.
  assert.match(page, /} else if \(tab === 'history'\) {\s*audit = await userActivity\(/);
  // Teams travel with Organisation, identities with Security.
  assert.match(page, /if \(tab === 'organisation'\) {\s*teams = await listUserTeams\(/);
  assert.match(page, /} else if \(tab === 'security'\) {/);
  // The tab strip's numbers come from one aggregate statement, not from
  // loading every section to count it.
  assert.match(page, /userSectionCounts\(db, userId\)/);
  const counts = read('src/lib/cms/repos/userAdmin.ts');
  const body = counts.slice(counts.indexOf('function userSectionCounts'));
  assert.equal(
    (body.slice(0, body.indexOf('}')).match(/execute/g) ?? []).length,
    1,
    'userSectionCounts must stay one statement of scalar subselects',
  );
});

// ---- The Home trend, genuinely deferred ------------------------------------

test('Home runs no trend query, and no longer fetches one either', () => {
  const home = read('src/pages/cms/app/index.astro');
  assert.ok(!home.includes('approvalTrend'), 'Home runs the trend it was meant to defer');
  // BUILD PROMPT 47 WENT FURTHER THAN DEFERRAL: the disclosure that fetched
  // the fragment is gone from both panels, so Home neither runs the trend nor
  // asks another route to. The fragment still answers for any caller that
  // wants it; nothing on this page is one.
  assert.ok(!home.includes('home-trend'), 'Home still fetches the trend fragment');
  assert.ok(!home.includes('CmsHomeTrendScript'), 'the fetching script is back on Home');
  // A session that expired mid-visit still gets a failure state from that
  // script rather than the login page parsed as a chart, wherever it is used.
  const script = read('src/components/cms/CmsHomeTrendScript.astro');
  assert.match(script, /response\.redirected/);
});

test('the trend fragment authorises itself and clamps its inputs', () => {
  const fragment = read('src/pages/cms/app/fragments/home-trend.astro');
  // Hidden UI is not access control: the endpoint refuses on its own.
  assert.match(
    fragment,
    /if \(!Astro\.locals\.cms \|\| Astro\.locals\.cms\.user\.userType !== 'INTERNAL'\)/,
  );
  assert.match(fragment, /status: 401/);
  // An unparseable period is answered, not guessed around.
  assert.match(fragment, /status: 422/);
  // No parameter can widen the window beyond what Home draws.
  assert.match(fragment, /Math\.min\(TREND_MONTHS, Math\.max\(2,/);
});

// ---- The sign-in quote curtain ---------------------------------------------

test('the quote catalogue is local, sized to spec, and attributed', () => {
  // 20 to 40 quotes, each 18 words or fewer, each with an author.
  assert.ok(SIGN_IN_QUOTES.length >= 20 && SIGN_IN_QUOTES.length <= 40);
  for (const quote of SIGN_IN_QUOTES) {
    assert.ok(quote.text.split(/\s+/).length <= 18, `over 18 words: "${quote.text}"`);
    assert.ok(quote.author.length > 0);
  }
  // No network anywhere near it.
  const source = read('src/lib/cms/auth/quotes.ts');
  assert.ok(!/fetch\(/.test(source), 'the quote catalogue must never call out');
  assert.equal(LAST_QUOTE_KEY, 'cms.quote.last');
});

test('two sign-ins in a row read differently', () => {
  // Force the random draw onto the previous index: the picker must step off it.
  const previous = 3;
  const rigged = () => (previous + 0.5) / SIGN_IN_QUOTES.length;
  const { index } = pickQuote(previous, rigged);
  assert.notEqual(index, previous);
  // With no history, the draw stands as drawn.
  assert.equal(pickQuote(null, rigged).index, previous);
});

test('login navigates immediately on success and the curtain never delays it', () => {
  const login = read('src/pages/cms/login.astro');
  // The 140ms pause before navigation is gone, and must stay gone.
  assert.ok(
    !/setTimeout\([^)]*location\.assign/.test(login),
    'login delays navigation behind a timer again',
  );
  // Curtain up, then navigation, in the same branch with nothing awaited
  // between them.
  assert.match(login, /showQuoteCurtain\(\);\s*location\.assign\(result\.landing\);/);
  // The curtain shows from exactly one place: the success branch.
  assert.equal((login.match(/showQuoteCurtain\(\)/g) ?? []).length, 1);
  assert.ok(login.indexOf("result.status === 'success'") < login.indexOf('showQuoteCurtain()'));
  // Back/forward cache restores a sane page: curtain down, button usable.
  assert.match(login, /event\.persisted/);
  // The curtain ships hidden; only real success reveals it.
  const curtain = read('src/components/cms/CmsQuoteCurtain.astro');
  assert.match(curtain, /data-cms-quote-curtain\s+hidden/);
  assert.ok(!/setTimeout\(|setInterval\(/.test(curtain), 'the curtain must hold no timer');
});

// ---- The navigation activity line ------------------------------------------

test('the activity line observes clicks and never steals them', () => {
  const source = read('src/components/cms/CmsNavigationProgress.astro');
  // Every "open differently" gesture passes through untouched.
  assert.match(source, /event\.defaultPrevented/);
  assert.match(
    source,
    /event\.metaKey \|\| event\.ctrlKey \|\| event\.shiftKey \|\| event\.altKey/,
  );
  assert.match(source, /event\.button !== 0/);
  assert.match(source, /hasAttribute\('download'\)/);
  assert.match(source, /anchor\.origin !== window\.location\.origin/);
  assert.match(source, /anchor\.hash !== ''/);
  assert.ok(!/preventDefault/.test(source), 'the line must never take over the navigation');
  // Honest and bounded: no percentage is ever written into the DOM (the %
  // signs in the stylesheet are transforms, not claims of progress), and no
  // permanent loader.
  assert.ok(!/textContent/.test(source), 'an indeterminate line displays no number');
  assert.match(source, /pageshow/, 'a cache restore must put the line away');
  // The MPA hand-off marker, guarded like all storage.
  assert.match(source, /cms\.nav\.progress/);
  // Mounted once, in the shell.
  assert.match(read('src/layouts/CmsLayout.astro'), /<CmsNavigationProgress \/>/);
});

// ---- The busy-button helper ------------------------------------------------

test('the shared busy helper disables, announces, and restores', () => {
  const source = read('src/lib/cms/ui/busy.ts');
  assert.match(source, /button\.disabled = true;/);
  assert.match(source, /aria-busy/);
  assert.match(source, /button\.disabled = false;/);
  // Re-entry is refused: a button already in flight returns a no-op.
  assert.match(source, /button\.disabled\) return/);
});
