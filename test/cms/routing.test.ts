/**
 * Route protection, against the built worker.
 *
 * These are the cases that only exist as HTTP: a 302 and its Location header, a
 * Cache-Control header, a cookie being refused after sign-out. Asserting them
 * against the flow functions would prove the functions and not the guards, so
 * this boots the real worker and speaks to it over a socket.
 *
 * No browser framework. Everything section 14 lists is a status code, a header
 * or a body, and node's own test runner with a raw http client covers all of
 * it. The two cases that genuinely need a browser, mobile rendering and
 * keyboard behaviour, are manual checks in the pull request.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CmsWorker } from './support/worker.ts';
import { AUTH_SCHEMA_DDL } from './support/schema.ts';
import { hashPassword, PASSWORD_ALGORITHM_PBKDF2 } from '../../src/lib/cms/auth/password.ts';

const SECRET = 'route-test-session-secret';
/**
 * Never a real password, and never a literal in the source: read it from the
 * environment where one is supplied, otherwise generate one per run.
 */
const PASSWORD = process.env.CMS_TEST_PASSWORD ?? `test-only-${crypto.randomUUID()}`;

const INTERNAL_EMAIL = 'internal.user@hasspetroleum.com';
const EXTERNAL_EMAIL = 'external.user@example.co.ke';

const worker = new CmsWorker();
let booted = false;

/**
 * The worker needs dist/, which only exists after a build. Skipping rather than
 * failing keeps `pnpm test` usable before a build, and the skip is loud.
 */
const built = existsSync(join(import.meta.dirname, '..', '..', 'dist', 'server', 'wrangler.json'));

before(async () => {
  if (!built) return;
  await worker.start(AUTH_SCHEMA_DDL, SECRET);
  booted = true;

  // Two users, one of each type, so the routing rules have something to route.
  const hash = await hashPassword(PASSWORD);
  const run = (sql: string, args: unknown[] = []) =>
    worker.db.prepare(sql).run(...(args as never[]));

  run(`INSERT INTO countries (country_id, iso2, country_name, timezone, currency_code, active)
       VALUES ('CTR-KE','KE','Kenya','Africa/Nairobi','KES',1)`);
  run(`INSERT INTO affiliates (affiliate_id, affiliate_code, affiliate_name, country_id, active)
       VALUES ('AFF-KE','HKE','Hass Petroleum Kenya','CTR-KE',1)`);
  run(
    `INSERT INTO departments (department_id, department_name, active) VALUES ('DEP-CS','Customer Service',1)`,
  );
  run(
    `INSERT INTO job_titles (job_title_id, title_name, department_id, active) VALUES ('JT-CSM','Customer Service Manager','DEP-CS',1)`,
  );
  run(
    `INSERT INTO access_roles (role_id, role_name, is_system_role, active) VALUES ('ROLE-CSM','Customer Service Manager',0,1)`,
  );
  run(
    `INSERT INTO access_roles (role_id, role_name, is_system_role, active) VALUES ('ROLE-PORTAL','Customer Portal User',1,1)`,
  );
  run(
    `INSERT INTO permissions (permission_id, module_name, resource_name, action_name) VALUES ('P1','SERVICE','CASES','VIEW')`,
  );
  run(
    `INSERT INTO role_permissions (role_permission_id, role_id, permission_id, allowed) VALUES ('RP1','ROLE-CSM','P1',1)`,
  );

  const user = (id: string, email: string, type: string) =>
    run(
      `INSERT INTO users (user_id, user_type, first_name, last_name, display_name, email, status,
                          email_verified_at, timezone, locale, created_at, updated_at)
       VALUES (?,?,?,?,?,?,'ACTIVE','2026-01-05 08:00:00','Africa/Nairobi','en-KE','2026-01-05 08:00:00','2026-01-05 08:00:00')`,
      [id, type, 'Test', 'User', type === 'EXTERNAL' ? 'Portal User' : 'Internal User', email],
    );
  user('USR-INT', INTERNAL_EMAIL, 'INTERNAL');
  user('USR-EXT', EXTERNAL_EMAIL, 'EXTERNAL');

  const credential = (id: string, userId: string) =>
    run(
      `INSERT INTO auth_credentials (credential_id, user_id, password_hash, password_algorithm,
                                     must_change_password, password_changed_at, failed_attempts,
                                     locked_until, created_at, updated_at)
       VALUES (?,?,?,?,0,'2026-01-05 08:00:00',0,NULL,'2026-01-05 08:00:00','2026-01-05 08:00:00')`,
      [id, userId, hash, PASSWORD_ALGORITHM_PBKDF2],
    );
  credential('CRED-INT', 'USR-INT');
  credential('CRED-EXT', 'USR-EXT');

  run(`INSERT INTO user_assignments (assignment_id, user_id, job_title_id, department_id,
        assignment_level, country_id, affiliate_id, business_unit_id, effective_from, effective_to,
        is_primary, active)
       VALUES ('UA-1','USR-INT','JT-CSM','DEP-CS','AFFILIATE','CTR-KE','AFF-KE',NULL,'2026-01-01',NULL,1,1)`);
  run(`INSERT INTO user_roles (user_role_id, user_id, role_id, effective_from, effective_to, active)
       VALUES ('UR-1','USR-INT','ROLE-CSM','2026-01-01',NULL,1)`);
  run(`INSERT INTO user_roles (user_role_id, user_id, role_id, effective_from, effective_to, active)
       VALUES ('UR-2','USR-EXT','ROLE-PORTAL','2026-01-01',NULL,1)`);
});

after(async () => {
  if (booted) await worker.stop();
});

const skip = () => !built;
const signIn = (email: string) =>
  worker.call('POST', '/api/auth/login', { body: { email, password: PASSWORD } });

test(
  'an unauthenticated request for a protected path redirects to /login',
  { skip: skip() },
  async () => {
    worker.clearCookies();
    for (const path of ['/app', '/app/helpdesk', '/portal', '/']) {
      const response = await worker.call('GET', path, { cookie: null });
      assert.equal(response.status, 302, `${path} status`);
      assert.equal(response.location, '/login', `${path} location`);
    }
  },
);

test('every auth entry page is reachable without a session', { skip: skip() }, async () => {
  for (const [path, text] of [
    ['/login', 'Welcome back'],
    ['/register', 'Join your company workspace'],
    ['/forgot-password', 'Reset your password'],
    ['/reset-password', 'Choose a new password'],
  ] as const) {
    const response = await worker.call('GET', path, { cookie: null });
    assert.equal(response.status, 200, path);
    assert.match(response.body, new RegExp(text), path);
  }
});

test('a valid internal sign-in sets the session cookie', { skip: skip() }, async () => {
  worker.clearCookies();
  const response = await signIn(INTERNAL_EMAIL);
  assert.equal(response.status, 200);
  // Asserted on this response rather than in a case of its own, because a
  // second sign-in would leave a second live session and the sign-out case
  // below reads the newest row. The body names the user and the header carries
  // the credential, so the guard's no-store rule has to reach this one too,
  // and the guard cannot stamp it: the request arrives without a session.
  assert.equal(response.headers['cache-control'], 'no-store');
  const setCookie = ([] as string[]).concat(response.headers['set-cookie'] ?? []);
  assert.match(setCookie[0] ?? '', /^cms_session=/);
  assert.match(setCookie[0] ?? '', /HttpOnly/);
  assert.ok(worker.sessionCookie(), 'the jar must now hold a session cookie');
});

test('the session survives a second request with the same cookie', { skip: skip() }, async () => {
  // No new sign-in: the same jar, a fresh request. This is exactly what a
  // browser refresh does, and it needs no client-side code to work.
  const first = await worker.call('GET', '/app');
  assert.equal(first.status, 200);
  const second = await worker.call('GET', '/app');
  assert.equal(second.status, 200);
  // The greeting is gone with the rest of the page's prose: Home now opens on
  // the two turnaround charts and nothing above them. What proves the session
  // survived is that the shell rendered at all for this cookie.
  assert.match(second.body, /Purchase order approval/);
});

test('an authenticated response carries Cache-Control: no-store', { skip: skip() }, async () => {
  const response = await worker.call('GET', '/app');
  assert.equal(response.headers['cache-control'], 'no-store');
});

test('the shell shows the name and the organisational context', { skip: skip() }, async () => {
  const response = await worker.call('GET', '/app');
  // The organisational context lives in the account menu, where it belongs: it
  // is a fact about the reader, not a figure. The greeting that used to sit on
  // the page header has gone with the rest of the prose, so the shell is now
  // the only place these appear, which is what this test is about.
  assert.match(response.body, /Customer Service Manager/, 'the job title is on the shell');
  assert.match(response.body, /Hass Petroleum Kenya/, 'and so is the affiliate');
});

test('navigation is filtered by permission, not by name or title', { skip: skip() }, async () => {
  const response = await worker.call('GET', '/app');
  // ROLE-CSM holds SERVICE.CASES.VIEW and nothing else here.
  assert.match(response.body, /\/app\/helpdesk/, 'Helpdesk must appear');
  assert.ok(!response.body.includes('/app/administration'), 'Administration must not appear');
  assert.ok(!response.body.includes('/app/data'), 'Data must not appear');
});

test(
  'an authenticated internal user is redirected away from /login and /',
  { skip: skip() },
  async () => {
    for (const path of ['/login', '/register', '/forgot-password', '/reset-password', '/']) {
      const response = await worker.call('GET', path);
      assert.equal(response.status, 302, `${path} status`);
      assert.equal(response.location, '/app', `${path} location`);
    }
  },
);

test('no rendered page carries a hash, token or secret', { skip: skip() }, async () => {
  const response = await worker.call('GET', '/app');
  for (const forbidden of [
    'password_hash',
    'refresh_token_hash',
    'secret_encrypted',
    'token_hash',
  ]) {
    assert.ok(!response.body.includes(forbidden), `the shell must not contain ${forbidden}`);
  }
  assert.ok(!response.body.includes(SECRET));
  assert.ok(!response.body.includes(worker.sessionCookie() ?? 'no-cookie'));
});

test(
  'logout revokes the session, redirects, and the same cookie is then refused',
  { skip: skip() },
  async () => {
    const cookie = worker.cookieHeader();
    const out = await worker.call('POST', '/api/auth/logout', { accept: 'text/html' });
    assert.equal(out.status, 303);
    assert.equal(out.location, '/login');

    const row = worker.db
      .prepare(`SELECT status FROM auth_sessions WHERE user_id = 'USR-INT' ORDER BY issued_at DESC`)
      .get() as { status: string };
    assert.equal(row.status, 'REVOKED');

    // The cookie the browser held before sign-out no longer opens anything.
    const after = await worker.call('GET', '/app', { cookie });
    assert.equal(after.status, 302);
    assert.equal(after.location, '/login?expired=1');
  },
);

test(
  'a revoked session redirects with the expiry flag and the page says so',
  { skip: skip() },
  async () => {
    const page = await worker.call('GET', '/login?expired=1', { cookie: null });
    assert.equal(page.status, 200);
    assert.match(page.body, /Your session has expired\. Please sign in again\./);
  },
);

test('an external user lands on /portal and is kept out of /app', { skip: skip() }, async () => {
  worker.clearCookies();
  const login = await signIn(EXTERNAL_EMAIL);
  assert.equal(login.status, 200);
  assert.match(login.body, /"userType":"EXTERNAL"/);

  const app = await worker.call('GET', '/app');
  assert.equal(app.status, 302);
  assert.equal(app.location, '/portal', 'an EXTERNAL user must never render an /app path');

  const root = await worker.call('GET', '/');
  assert.equal(root.location, '/portal');

  const portal = await worker.call('GET', '/portal');
  assert.equal(portal.status, 200);
  // No user_assignments row exists for an external user, so the page must
  // render a complete screen without organisational context rather than throw.
  assert.match(portal.body, /Welcome back/);
  assert.ok(!portal.body.includes('Customer Service Manager'));
});

test('an unknown email and a wrong password are byte-identical', { skip: skip() }, async () => {
  worker.clearCookies();
  const unknown = await worker.call('POST', '/api/auth/login', {
    body: { email: 'nobody.here@hasspetroleum.com', password: 'x'.repeat(20) },
    cookie: null,
  });
  const wrong = await worker.call('POST', '/api/auth/login', {
    body: { email: INTERNAL_EMAIL, password: 'x'.repeat(20) },
    cookie: null,
  });
  assert.equal(unknown.status, wrong.status);
  assert.equal(unknown.body, wrong.body);
  assert.equal(unknown.status, 401);
});

test('a missing email or password is refused the same way', { skip: skip() }, async () => {
  for (const body of [{ password: 'x' }, { email: INTERNAL_EMAIL }, {}]) {
    const response = await worker.call('POST', '/api/auth/login', { body, cookie: null });
    assert.equal(response.status, 401, JSON.stringify(body));
  }
});

test('the shell ships the handler its drawer trigger depends on', { skip: skip() }, async () => {
  // Astro ships a component's <script> only when that component is rendered.
  // The overlay handler used to live in CmsModal, which nothing rendered, so
  // the drawer trigger in the top bar carried data-cms-modal-open and no code
  // was listening: the navigation drawer never opened on a small screen. The
  // markup alone cannot show that, which is why this asserts the handler and
  // not just the attribute.
  //
  // The cases above leave the jar signed out or holding the external user, and
  // only an internal user renders the shell, so this signs in for itself.
  worker.clearCookies();
  await signIn(INTERNAL_EMAIL);
  const page = await worker.call('GET', '/app');

  assert.match(page.body, /data-cms-modal-open="cms-nav-drawer"/, 'the trigger must be rendered');
  assert.match(page.body, /<dialog id="cms-nav-drawer"/, 'the drawer must be rendered');

  // cmsOverlaysBound is the guard the handler sets on first run, so finding it
  // proves the listener itself ships rather than only its markup.
  //
  // IT IS FETCHED, NOT READ OUT OF THE HTML. This used to search the page body,
  // which passed only while the build was inlining the script INTO the body,
  // and that inlining is what `script-src 'self'` refused to execute: the
  // assertion was quietly proving the bug. Scripts are now emitted as modules,
  // so the honest question is whether the module the page references is served
  // and contains the handler.
  const sources = [...page.body.matchAll(/<script[^>]*\bsrc="(\/_astro\/[^"]+)"/g)].map(
    (match) => match[1] as string,
  );
  assert.ok(sources.length > 0, 'the shell must reference at least one module');
  let bound = false;
  for (const src of sources) {
    const asset = await worker.call('GET', src);
    if (asset.status === 200 && /cmsOverlaysBound/.test(asset.body)) bound = true;
  }
  assert.ok(bound, `the overlay handler must reach the page; checked ${sources.join(', ')}`);
});

test('the apex, engr and grc hosts are unaffected', { skip: skip() }, async () => {
  // The whole point of the host branch is that changing one product cannot move
  // another, so this asserts it rather than assuming it.
  const marketing = await worker.call('GET', '/', { cookie: null, host: 'murikah.com' });
  assert.equal(marketing.status, 200);
  assert.equal(marketing.headers['x-mrk-branch'], 'marketing');
  assert.match(marketing.body, /Internal audit and AI governance/);

  const engr = await worker.call('GET', '/login', { cookie: null, host: 'engr.murikah.com' });
  assert.equal(engr.status, 200);
  assert.equal(engr.headers['x-mrk-branch'], 'app');
  assert.match(engr.body, /Engineering Rhythm/);

  const grc = await worker.call('GET', '/login', { cookie: null, host: 'grc.murikah.com' });
  assert.equal(grc.status, 200);
  assert.equal(grc.headers['x-mrk-branch'], 'grc-app');
  assert.match(grc.body, /Assurance OS/);

  // And the CMS host still takes its own branch.
  const cms = await worker.call('GET', '/login', { cookie: null });
  assert.equal(cms.headers['x-mrk-branch'], 'cms-app');
});
