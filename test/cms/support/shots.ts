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
import { withApprovalWork } from './approvalWork.ts';
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
// playwright-core exposes `chromium` on the module in some builds and only on
// the default export in others, so both are accepted rather than the operator
// being told their install is wrong.
const loaded = (await import(PLAYWRIGHT)) as Record<string, unknown>;
const { chromium } = ((loaded.chromium === undefined ? loaded.default : loaded) ?? {}) as {
  chromium: {
    launch(options: unknown): Promise<{
      newContext(options: unknown): Promise<{
        addCookies(jar: unknown): Promise<void>;
        addInitScript(fn: () => void): Promise<void>;
        newPage(): Promise<{
          goto(url: string, options: unknown): Promise<unknown>;
          $(selector: string): Promise<{ boundingBox(): Promise<{ x: number } | null> } | null>;
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

const seedClient = adapt(worker.db);
await seedHass(seedClient);
// The completed approval work the SLA section reports, the same fixture the
// tests assert against, so the picture and the assertions agree.
await withApprovalWork(seedClient);

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

const shoot = async (
  name: string,
  width: number,
  height: number,
  pin: boolean,
  fullPage = false,
) => {
  const context = await browser.newContext({ viewport: { width, height } });
  await context.addCookies(jar);
  if (pin) {
    await context.addInitScript(() => {
      try {
        localStorage.setItem('cms.rail.pinned', '1');
      } catch {
        /* nothing to do */
      }
    });
  }
  const page = await context.newPage();
  await page.goto(`${base}/app`, { waitUntil: 'networkidle' });
  // Where the content starts, so the overlay claim can be measured rather than
  // described: the rail must not move it.
  const main = await page.$('#cms-main');
  const box = main ? await main.boundingBox() : null;
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage });
  console.log(`${name}: main starts at x=${box?.x ?? 'unknown'}`);
  await context.close();
  return box?.x ?? null;
};

// The whole page, because the SLA section runs well below the fold and a
// screenshot of the top of it proves nothing about the charts underneath.
await shoot('after-desktop-full', 1440, 900, false, true);
const collapsed = await shoot('after-desktop-collapsed', 1440, 900, false);
const pinned = await shoot('after-desktop-expanded', 1440, 900, true);
await shoot('after-laptop-collapsed', 1280, 720, false);
await shoot('after-laptop-expanded', 1280, 720, true);
console.log(
  JSON.stringify({
    contentXCollapsed: collapsed,
    contentXPinned: pinned,
    shift: (pinned ?? 0) - (collapsed ?? 0),
  }),
);

await browser.close();
await worker.stop();
