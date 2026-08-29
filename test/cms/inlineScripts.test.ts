/**
 * The Content Security Policy, checked against what the build actually emits.
 *
 * THE OUTAGE THIS EXISTS FOR. The CMS serves `script-src 'self'` with no
 * `unsafe-inline`, which is the directive that makes a reflected `<script>`
 * inert. Vite inlines an emitted asset below 4 KB, and two of the sign-in
 * page's script chunks were under that threshold, so the build put them in the
 * markup and the browser refused to run them. The submit handler never ran,
 * the form fell back to a native POST, the page re-rendered with no message,
 * and nothing ever reached /api/auth/login. Thirty-eight of the forty-seven
 * CMS pages were carrying four or five blocked scripts each.
 *
 * Nothing in the suite could see it. The policy is a header, the scripts are
 * build output, and the two were only ever compared by a browser. So this
 * compares them: every CMS route is rendered by the built worker and its
 * markup is read the way a browser's CSP would read it.
 *
 * A JSON data block is not executable and `script-src` does not govern it, so
 * `type="application/json"` is allowed by type rather than by exception. An
 * inline script carrying the request's nonce is allowed, because the policy
 * names that nonce.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CmsWorker } from './support/worker.ts';
import { AUTH_SCHEMA_DDL } from './support/schema.ts';
import { hashPassword, PASSWORD_ALGORITHM_PBKDF2 } from '../../src/lib/cms/auth/password.ts';

const here = dirname(fileURLToPath(import.meta.url));
const PAGES_ROOT = join(here, '..', '..', 'src', 'pages', 'cms');
const BUILT = existsSync(join(here, '..', '..', 'dist', 'server', 'entry.mjs'));

const worker = new CmsWorker();
const SECRET = 'inline-script-test-secret-0123456789';
const PASSWORD = process.env.CMS_TEST_PASSWORD ?? `test-only-${crypto.randomUUID()}`;
const EMAIL = 'inline.scan@hasspetroleum.com';
let booted = false;

/**
 * Every static CMS route, discovered from the file system.
 *
 * NOT A LIST SOMEBODY MAINTAINS. A page added next month is covered without
 * anyone remembering to add it here, which is the only way a guard like this
 * survives contact with a growing application. Dynamic routes are skipped
 * because they need real record ids; their layouts and components are covered
 * by every static page that shares them.
 */
function cmsRoutes(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...cmsRoutes(full));
      continue;
    }
    if (!name.endsWith('.astro')) continue;
    if (full.includes('[')) continue;
    let route =
      '/' +
      relative(PAGES_ROOT, full)
        .replace(/\.astro$/, '')
        .replace(/\/index$/, '');
    if (route === '/index') route = '/';
    out.push(route === '' ? '/' : route);
  }
  return [...new Set(out)].sort();
}

/** Inline blocks a browser would try to execute, and their opening tags. */
function executableInlineScripts(html: string): string[] {
  const found: string[] = [];
  for (const match of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/g)) {
    const tag = match[0].slice(0, match[0].indexOf('>') + 1);
    // A data block is not script. The browser never executes it and the policy
    // never blocks it.
    if (/type\s*=\s*"(application\/json|application\/ld\+json)"/i.test(tag)) continue;
    // An inline script the policy names by nonce is allowed on purpose.
    if (/\bnonce=/.test(tag)) continue;
    found.push(tag);
  }
  return found;
}

before(async () => {
  if (!BUILT) return;
  await worker.start(AUTH_SCHEMA_DDL, SECRET);
  booted = true;
  const run = (sql: string, args: unknown[] = []) =>
    worker.db.prepare(sql).run(...(args as never[]));
  run(
    `INSERT INTO users (user_id, user_type, first_name, last_name, display_name, email, status, email_verified_at)
       VALUES ('USR-SCAN','INTERNAL','Scan','User','Scan User',?,'ACTIVE','2026-01-01 00:00:00')`,
    [EMAIL],
  );
  run(
    `INSERT INTO auth_credentials (credential_id, user_id, password_hash, password_algorithm, must_change_password, password_changed_at, failed_attempts, locked_until, created_at, updated_at)
     VALUES ('CRED-SCAN','USR-SCAN',?,?,0,'2026-01-01 00:00:00',0,NULL,'2026-01-01 00:00:00','2026-01-01 00:00:00')`,
    [await hashPassword(PASSWORD), PASSWORD_ALGORITHM_PBKDF2],
  );
  run(`INSERT INTO access_roles (role_id, role_name, is_system_role, active)
       VALUES ('ROLE-SCAN','Scan Role',0,1)`);
  run(`INSERT INTO user_roles (user_role_id, user_id, role_id, effective_from, effective_to, active)
       VALUES ('UR-SCAN','USR-SCAN','ROLE-SCAN','2026-01-01',NULL,1)`);
  run(`INSERT INTO user_role_scopes (scope_id, user_role_id, scope_type)
       VALUES ('URS-SCAN','UR-SCAN','GROUP')`);
  run(`INSERT OR IGNORE INTO role_permissions (role_permission_id, role_id, permission_id, allowed, created_at)
       SELECT 'RPS-'||permission_id,'ROLE-SCAN',permission_id,1,CURRENT_TIMESTAMP FROM permissions`);
});

after(async () => {
  if (booted) await worker.stop();
});

test('no CMS page carries an inline script the policy would block', async (t) => {
  if (!BUILT) {
    t.skip('dist/ is not built; run pnpm build first');
    return;
  }
  const signIn = await worker.call('POST', '/api/auth/login', {
    body: { email: EMAIL, password: PASSWORD },
    cookie: null,
  });
  assert.equal(signIn.status, 200, 'the scan needs a session to reach the app pages');
  const cookie = worker.cookieHeader();

  const offenders: string[] = [];
  let scanned = 0;
  for (const route of cmsRoutes(PAGES_ROOT)) {
    const response = await worker.call('GET', route, { cookie });
    if (response.status >= 400) continue;
    const html = String(response.body ?? '');
    if (html === '') continue;
    scanned += 1;
    for (const tag of executableInlineScripts(html)) offenders.push(`${route}  ${tag}`);
  }
  assert.ok(scanned > 20, `the scan reached the pages, found ${scanned}`);
  assert.deepEqual(
    offenders,
    [],
    `these pages carry an inline script that "script-src 'self'" will block, so none of ` +
      `their behaviour runs in a browser. Let Astro emit the script to a file, or give it ` +
      `the request nonce:\n${offenders.join('\n')}`,
  );
});

test('the sign-in page runs its script from a file, not from the markup', async (t) => {
  if (!BUILT) {
    t.skip('dist/ is not built; run pnpm build first');
    return;
  }
  const response = await worker.call('GET', '/login', { cookie: null });
  assert.equal(response.status, 200);
  const html = String(response.body);
  assert.deepEqual(executableInlineScripts(html), [], 'the sign-in page is the one that broke');
  // And it does load its behaviour from somewhere, so a page with no script at
  // all cannot pass this by having nothing to block.
  assert.match(
    html,
    /<script[^>]*\bsrc="\/_astro\/[^"]+\.js"/,
    'the handler is served as a module',
  );
});

test('the policy still refuses inline script generally', async (t) => {
  if (!BUILT) {
    t.skip('dist/ is not built; run pnpm build first');
    return;
  }
  const response = await worker.call('GET', '/login', { cookie: null });
  const csp = String(response.headers['content-security-policy'] ?? '');
  // Only the script directive. `style-src` legitimately carries
  // 'unsafe-inline', because Astro emits scoped styles inline and a stylesheet
  // cannot exfiltrate a session; asserting against the whole policy string
  // would confuse the two.
  const scriptSrc = csp
    .split(';')
    .map((directive) => directive.trim())
    .find((directive) => directive.startsWith('script-src'));
  assert.ok(scriptSrc !== undefined, `the policy must name script-src, got: ${csp}`);
  assert.match(scriptSrc, /'self'/, "'self' carries every bundled module");
  assert.doesNotMatch(
    scriptSrc,
    /unsafe-inline/,
    'unsafe-inline would give back exactly what this directive exists to take away',
  );
  assert.doesNotMatch(scriptSrc, /unsafe-eval/);
});

/**
 * The sign-in flow, over real HTTP against the built worker.
 *
 * WHY THIS BELONGS BESIDE THE POLICY TEST. The outage was not that sign-in was
 * wrong; sign-in was correct the whole time and every unit test of it passed.
 * What broke was the one link nothing asserted: whether the browser would run
 * the code that calls it. These two assertions are the other end of that link,
 * so a future change that reaches the endpoint but not the page, or the page
 * but not the endpoint, fails here rather than in somebody's console.
 */
test('real credentials are accepted and the session cookie is set', async (t) => {
  if (!BUILT) {
    t.skip('dist/ is not built; run pnpm build first');
    return;
  }
  const response = await worker.call('POST', '/api/auth/login', {
    body: { email: EMAIL, password: PASSWORD },
    cookie: null,
  });
  assert.equal(response.status, 200, 'the credential is correct, so this must succeed');
  const setCookie = ([] as string[]).concat(
    (response.headers['set-cookie'] as string[] | string | undefined) ?? [],
  );
  assert.ok(setCookie.length > 0, 'a sign-in that sets no cookie has not signed anybody in');
  const cookie = setCookie.join('; ');
  assert.match(cookie, /HttpOnly/i, 'the session cookie is not readable by script');
  // Strict, not Lax: a CMS session must not ride a cross-site navigation.
  assert.match(cookie, /SameSite=Strict/i);
  // The body names where this user's session starts, which is what the page
  // navigates to. The redirect is the browser's, not the server's.
  const body = JSON.parse(String(response.body)) as { landing?: string };
  assert.equal(body.landing, '/app', 'an internal user with no executive code lands on /app');
});

test('an empty sign-in is refused, and says so', async (t) => {
  if (!BUILT) {
    t.skip('dist/ is not built; run pnpm build first');
    return;
  }
  const response = await worker.call('POST', '/api/auth/login', { body: {}, cookie: null });
  assert.equal(response.status, 401);
  const body = JSON.parse(String(response.body)) as { error?: { message?: string } };
  assert.equal(
    body.error?.message,
    'That email address and password do not match.',
    'the one message every credential failure gets, so none of them is an oracle',
  );
  assert.equal(
    ([] as string[]).concat((response.headers['set-cookie'] as string[] | string | undefined) ?? [])
      .length,
    0,
    'a refused sign-in sets no cookie',
  );
});
