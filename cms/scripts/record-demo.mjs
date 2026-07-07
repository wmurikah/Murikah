// Record the 60-second Hass CMS overview video from the real running app. It
// follows the storyboard in routes.mjs: sign in as staff, walk the dashboard and
// every module, then sign in as the portal customer and show their self-service
// views. Playwright records the session to a .webm; a paired .mp4 is transcoded
// only if ffmpeg is present (Playwright itself emits webm).
//
//   BASE_URL=https://<staging-cms-host> pnpm cms:demo:record
//
// Like the crawl, it needs the `playwright` package and a reachable BASE_URL
// whose app points at the seeded staging database; absent either it prints why
// and exits 0. The output lands in cms/docs/demo/.
import { mkdir, rename, readdir } from 'node:fs/promises';
import { STORYBOARD, AUTH_ENDPOINTS, DEMO } from './routes.mjs';

const BASE_URL = (process.env.BASE_URL ?? '').replace(/\/$/, '');
const OUT_DIR = 'cms/docs/demo';
const OUT_NAME = 'hass-cms-overview.webm';
const SIZE = { width: 1280, height: 720 };

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

async function signIn(context, userType) {
  const creds = userType === 'CUSTOMER' ? DEMO.portal : DEMO.staff;
  const res = await context.request.post(AUTH_ENDPOINTS.staffLogin, {
    form: { user_type: userType, email: creds.email, password: creds.password },
    maxRedirects: 0,
    failOnStatusCode: false,
  });
  if (res.status() !== 303) throw new Error(`${userType} sign-in returned ${res.status()}`);
}

async function main() {
  if (!BASE_URL) {
    console.log('cms:demo:record — skipped: set BASE_URL to a running CMS app (staging).');
    return 0;
  }
  const pw = await loadPlaywright();
  if (!pw) {
    console.log('cms:demo:record — skipped: playwright is not installed (pnpm add -D playwright).');
    return 0;
  }
  if (!(await reachable(BASE_URL))) {
    console.log(`cms:demo:record — skipped: ${BASE_URL} is not reachable.`);
    return 0;
  }

  await mkdir(OUT_DIR, { recursive: true });
  const browser = await pw.chromium.launch();
  const context = await browser.newContext({
    baseURL: BASE_URL,
    viewport: SIZE,
    recordVideo: { dir: OUT_DIR, size: SIZE },
  });
  const page = await context.newPage();

  let currentAuth = null;
  try {
    for (const scene of STORYBOARD) {
      if (scene.auth !== currentAuth) {
        await signIn(context, scene.auth === 'portal' ? 'CUSTOMER' : 'STAFF');
        currentAuth = scene.auth;
      }
      await page.goto(scene.path, { waitUntil: 'networkidle' });
      console.log(`· ${scene.caption} (${scene.seconds}s)`);
      await page.waitForTimeout(scene.seconds * 1000);
    }
  } finally {
    // The video is finalised on context close; capture its temp path first.
    const video = page.video();
    await context.close();
    await browser.close();
    if (video) {
      const tmp = await video.path();
      await rename(tmp, `${OUT_DIR}/${OUT_NAME}`).catch(async () => {
        // rename across devices can fail; fall back to reporting the temp path.
        const files = await readdir(OUT_DIR);
        console.log('video files in', OUT_DIR, files);
      });
    }
  }
  console.log(`\nRecorded ${OUT_DIR}/${OUT_NAME}.`);
  console.log('For an .mp4, transcode if ffmpeg is available:');
  console.log(`  ffmpeg -i ${OUT_DIR}/${OUT_NAME} ${OUT_DIR}/hass-cms-overview.mp4`);
  return 0;
}

process.exit(await main());
