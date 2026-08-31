/**
 * Screenshots of the real dashboard, from the real worker.
 *
 * NOT A TEST, AND DELIBERATELY NOT IN THE SUITE. It boots `wrangler dev` on the
 * build output against the same fake Turso the routing tests use, signs a
 * person in, and drives a browser at it. That is a minute of wall clock and a
 * browser binary, neither of which belongs in a run that has to stay fast.
 *
 * It exists because the alternative was describing a redesign in prose. A
 * dashboard is a picture, and the only honest evidence for one is the picture,
 * taken from the running application rather than from a mock.
 *
 * Run it with:  npx tsx test/cms/support/shots.ts <output-directory>
 */
import { CmsWorker } from './worker.ts';
import { AUTH_SCHEMA_DDL } from './schema.ts';
import { seedHass } from './hassSeed.ts';
import type { TestClient } from './db.ts';
import { hashPassword } from '../../../src/lib/cms/auth/password.ts';

/**
 * Playwright is NOT a dependency of this repository and must not become one:
 * it is a browser driver used to take four pictures, and the build has no need
 * of it. The specifier is a variable so the type checker does not try to
 * resolve a package that is deliberately absent, and the path is supplied by
 * the operator:
 *
 *   PLAYWRIGHT_MODULE=/path/to/playwright-core npx tsx test/cms/support/shots.ts out/
 */
const PLAYWRIGHT = process.env.PLAYWRIGHT_MODULE ?? 'playwright-core';
const CHROMIUM = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
/**
 * `playwright-core` is a CommonJS package, so importing it from ESM puts its
 * exports on `default` rather than naming them. Measured rather than assumed:
 * `import(...)` gives `{ default: { chromium } }` while `require(...)` gives
 * `{ chromium }`. Reading both shapes costs one line and stops this failing
 * with "Cannot read properties of undefined" on a different Node.
 */
const playwright = (await import(PLAYWRIGHT)) as {
  chromium?: unknown;
  default?: { chromium?: unknown };
};
const { chromium } = (
  playwright.chromium !== undefined ? playwright : (playwright.default ?? {})
) as {
  chromium: {
    launch(options: unknown): Promise<{
      newContext(options: unknown): Promise<{
        addCookies(jar: unknown): Promise<void>;
        addInitScript(fn: () => void): Promise<void>;
        newPage(): Promise<{
          goto(url: string, options: unknown): Promise<unknown>;
          $(selector: string): Promise<{
            boundingBox(): Promise<{ x: number } | null>;
            hover(): Promise<void>;
          } | null>;
          waitForTimeout(ms: number): Promise<void>;
          screenshot(options: unknown): Promise<unknown>;
        }>;
        close(): Promise<void>;
      }>;
      close(): Promise<void>;
    }>;
  };
};

const OUT = process.argv[2] ?? '.';
const SECRET = 'shot-session-secret';
const PASSWORD = `shot-only-${crypto.randomUUID()}`;
const EMAIL = 'catherine.mwangi@hasspetroleum.com';

/**
 * `seedHass` speaks the TestClient interface and the worker exposes a raw
 * node:sqlite handle, so this is the adapter between them. It is the narrow
 * slice the seed actually uses: statements in, nothing out.
 */
function adapt(raw: CmsWorker['db']): TestClient {
  const run = (sql: string, args: unknown[] = []) => {
    const prepared = raw.prepare(sql);
    const isRead = /^\s*(SELECT|WITH|PRAGMA)/i.test(sql);
    if (isRead) return { rows: prepared.all(...(args as never[])) as never, rowsAffected: 0 };
    const info = prepared.run(...(args as never[]));
    return { rows: [] as never, rowsAffected: Number(info.changes ?? 0) };
  };
  type Stmt = string | { sql: string; args?: unknown[] };
  const one = (stmt: Stmt) => (typeof stmt === 'string' ? run(stmt) : run(stmt.sql, stmt.args));
  return {
    raw,
    close: () => undefined,
    execute: async (stmt: Stmt) => one(stmt),
    batch: async (stmts: Stmt[]) => stmts.map(one),
  } as unknown as TestClient;
}

const worker = new CmsWorker();
await worker.start(AUTH_SCHEMA_DDL, SECRET);
console.log('worker up on', worker.portNumber);

await seedHass(adapt(worker.db));

// A real credential for a seeded administrator, so the dashboard composes with
// every section rather than with whatever a minimal fixture happened to allow.
const hash = await hashPassword(PASSWORD);
worker.db
  .prepare(
    `INSERT INTO auth_credentials (credential_id, user_id, password_hash, password_algorithm,
       must_change_password, password_changed_at, failed_attempts, created_at, updated_at)
     VALUES ('CRED-SHOT','USR-CATH',?,'PBKDF2',0,CURRENT_TIMESTAMP,0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
  )
  .run(hash);
worker.db
  .prepare(
    `UPDATE users SET status = 'ACTIVE', email_verified_at = CURRENT_TIMESTAMP WHERE user_id = 'USR-CATH'`,
  )
  .run();

const login = await worker.call('POST', '/api/auth/login', {
  body: { email: EMAIL, password: PASSWORD },
});
if (login.status !== 200) {
  console.error('sign-in failed', login.status, login.body.slice(0, 400));
  await worker.stop();
  process.exit(1);
}
const cookie = worker.cookieHeader();
console.log('signed in');

const browser = await chromium.launch({ executablePath: CHROMIUM, args: ['--no-sandbox'] });
const base = `http://cms.localhost:${worker.portNumber}`;
const jar = (cookie ?? '')
  .split('; ')
  .filter(Boolean)
  .map((pair) => {
    const [name, ...rest] = pair.split('=');
    return { name: name!, value: rest.join('='), domain: 'cms.localhost', path: '/' };
  });

/**
 * One picture, and the one measurement that goes with it.
 *
 * `hover` is the interesting state, not `pin`. Pinning deliberately widens the
 * rail's footprint and moves the content, which is what a person asks for when
 * they pin it. HOVERING must not: the expanded panel is absolutely positioned
 * and overlays the page. So the overlay claim is measured by taking
 * `#cms-main`'s x before and after a hover, in the same context, and the two
 * numbers have to be identical.
 */
const shoot = async (
  name: string,
  path: string,
  width: number,
  height: number,
  mode: 'collapsed' | 'hover' | 'pinned',
) => {
  const context = await browser.newContext({ viewport: { width, height } });
  await context.addCookies(jar);
  if (mode === 'pinned') {
    await context.addInitScript(() => {
      try {
        localStorage.setItem('cms.rail.pinned', '1');
      } catch {
        /* nothing to do */
      }
    });
  }
  const page = await context.newPage();
  await page.goto(`${base}${path}`, { waitUntil: 'networkidle' });
  const main = await page.$('#cms-main');
  const before = main ? await main.boundingBox() : null;
  if (mode === 'hover') {
    const rail = await page.$('[data-cms-rail]');
    if (rail) await rail.hover();
    // Longer than the 150ms width transition, so the measurement is of the
    // settled state rather than of the animation.
    await page.waitForTimeout(400);
  }
  const after = main ? await main.boundingBox() : null;
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  console.log(
    `${name}: main x before=${before?.x ?? 'n/a'} after=${after?.x ?? 'n/a'} ` +
      `shift=${(after?.x ?? 0) - (before?.x ?? 0)}`,
  );
  await context.close();
  return { before: before?.x ?? null, after: after?.x ?? null };
};

const LABEL = process.env.SHOT_LABEL ?? 'after';
// BOTH LAPTOP WIDTHS, BECAUSE THE CLAIM IS ABOUT BOTH. The two panels sit side
// by side and must fit with no horizontal scroll at 1,280 as well as at 1,440,
// and 1,280 is the width that actually decides it.
await shoot(`${LABEL}-home-1280`, '/app', 1280, 900, 'collapsed');
const home = await shoot(`${LABEL}-home-collapsed`, '/app', 1440, 900, 'collapsed');
const hovered = await shoot(`${LABEL}-home-hover`, '/app', 1440, 900, 'hover');
await shoot(`${LABEL}-home-pinned`, '/app', 1440, 900, 'pinned');
await shoot(`${LABEL}-list-collapsed`, '/app/orders/sales', 1440, 900, 'collapsed');
await shoot(`${LABEL}-list-hover`, '/app/orders/sales', 1440, 900, 'hover');
await shoot(`${LABEL}-home-narrow`, '/app', 430, 900, 'collapsed');

// The sign-in page, which no session should reach.
{
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${base}/login`, { waitUntil: 'networkidle' });
  await page.screenshot({ path: `${OUT}/${LABEL}-login.png`, fullPage: true });
  console.log(`${LABEL}-login: taken`);
  await context.close();
}

console.log(
  JSON.stringify({
    contentXCollapsed: home.after,
    contentXOnHover: hovered.after,
    shiftOnHover: (hovered.after ?? 0) - (hovered.before ?? 0),
  }),
);

await browser.close();
await worker.stop();
