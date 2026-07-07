// Hass CMS app-level smoke crawl. Against a running CMS app (a staging deploy or
// the staging Turso-backed worker), it signs in as staff and as the portal
// customer, GETs every page in the route manifest, dry-runs the search forms,
// and fails on any 500 or on the error boundary rendering. This is the app-level
// counterpart to the data-layer smoke test (cms/test/smoke.test.ts): the smoke
// test proves the queries; this proves the rendered pages.
//
//   BASE_URL=https://<staging-cms-host> pnpm cms:crawl
//
// It needs two things the sandbox may not have: the `playwright` package and a
// reachable BASE_URL whose app points at the seeded staging database. When
// either is absent it prints why and exits 0 (a staged tool skips honestly
// rather than failing red); when it runs, any 500 or boundary hit exits 1.
import { ROUTES, SEARCH_DRY_RUNS, AUTH_ENDPOINTS, DEMO } from './routes.mjs';

const BASE_URL = (process.env.BASE_URL ?? '').replace(/\/$/, '');
const BOUNDARY = 'cms-errcard'; // the error boundary's class; its presence is a fail

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    return null;
  }
}

async function reachable(url) {
  try {
    const res = await fetch(url, { method: 'HEAD' });
    return res.status < 500;
  } catch {
    return false;
  }
}

/** Sign a fresh context in as the given user type; returns the context. */
async function signIn(browser, userType) {
  const context = await browser.newContext({ baseURL: BASE_URL });
  const creds = userType === 'CUSTOMER' ? DEMO.portal : DEMO.staff;
  const res = await context.request.post(AUTH_ENDPOINTS.staffLogin, {
    form: { user_type: userType, email: creds.email, password: creds.password },
    maxRedirects: 0,
    failOnStatusCode: false,
  });
  // A successful sign-in 303-redirects and sets the session cookie.
  if (res.status() !== 303) {
    throw new Error(`${userType} sign-in returned ${res.status()}, expected 303`);
  }
  return context;
}

async function checkPage(context, path) {
  const page = await context.newPage();
  try {
    const res = await page.goto(path, { waitUntil: 'domcontentloaded' });
    const status = res ? res.status() : 0;
    const html = await page.content();
    const boundary = html.includes(BOUNDARY);
    const ok = status < 500 && !boundary;
    return { path, status, boundary, ok };
  } finally {
    await page.close();
  }
}

async function main() {
  if (!BASE_URL) {
    console.log('cms:crawl — skipped: set BASE_URL to a running CMS app (staging).');
    return 0;
  }
  const pw = await loadPlaywright();
  if (!pw) {
    console.log('cms:crawl — skipped: playwright is not installed (pnpm add -D playwright).');
    return 0;
  }
  if (!(await reachable(BASE_URL))) {
    console.log(`cms:crawl — skipped: ${BASE_URL} is not reachable.`);
    return 0;
  }

  const browser = await pw.chromium.launch();
  const results = [];
  try {
    // Public pages: no auth.
    const anon = await browser.newContext({ baseURL: BASE_URL });
    for (const r of ROUTES.filter((r) => r.auth === 'public' && r.crawl)) {
      results.push(await checkPage(anon, r.path));
    }
    await anon.close();

    // Staff pages + search dry-runs.
    const staff = await signIn(browser, 'STAFF');
    for (const r of ROUTES.filter((r) => r.auth === 'staff' && r.crawl)) {
      results.push(await checkPage(staff, r.path));
    }
    for (const q of SEARCH_DRY_RUNS) {
      results.push(await checkPage(staff, q));
    }
    await staff.close();

    // Portal pages.
    const portal = await signIn(browser, 'CUSTOMER');
    for (const r of ROUTES.filter((r) => r.auth === 'portal' && r.crawl)) {
      results.push(await checkPage(portal, r.path));
    }
    await portal.close();
  } finally {
    await browser.close();
  }

  const failures = results.filter((r) => !r.ok);
  for (const r of results) {
    const mark = r.ok ? 'ok  ' : 'FAIL';
    const why = r.boundary ? ' (error boundary)' : '';
    console.log(`${mark} ${String(r.status).padEnd(3)} ${r.path}${why}`);
  }
  console.log(`\n${results.length - failures.length}/${results.length} pages crawl-green.`);
  if (failures.length) {
    console.error(`\n${failures.length} page(s) failed the crawl (500 or error boundary).`);
    return 1;
  }
  return 0;
}

process.exit(await main());
