/* eslint-disable @typescript-eslint/no-require-imports */
const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const { mkdir, writeFile } = require('node:fs/promises');

const REQUIRED = [
  '/',
  '/about',
  '/pricing',
  '/insights',
  '/contact',
  '/assurance-os',
  '/assurance-os/sandbox',
  '/products',
  '/research',
  '/privacy',
  '/terms',
  '/404',
];

const BEFORE_AFTER = ['/', '/about', '/pricing', '/insights', '/assurance-os', '/privacy'];

function localPath(value) {
  const url = new URL(value, 'https://murikah.com');
  return url.pathname.replace(/\/$/, '') || '/';
}

async function discoverRoutes(request) {
  const routes = new Set(REQUIRED);
  const index = await request.get('/sitemap-index.xml');
  expect(index.ok()).toBeTruthy();
  const indexText = await index.text();
  const sitemapUrls = Array.from(indexText.matchAll(/<loc>([^<]+)<\/loc>/g), (match) => match[1]);

  for (const sitemapUrl of sitemapUrls) {
    const response = await request.get(new URL(sitemapUrl).pathname);
    expect(response.ok()).toBeTruthy();
    const xml = await response.text();
    for (const loc of Array.from(xml.matchAll(/<loc>([^<]+)<\/loc>/g), (match) => match[1])) {
      const route = localPath(loc);
      if (!route.startsWith('/cms') && !route.startsWith('/grc') && !route.startsWith('/engr')) {
        routes.add(route);
      }
    }
  }

  return Array.from(routes).sort((a, b) => {
    if (a === '/') return -1;
    if (b === '/') return 1;
    return a.localeCompare(b);
  });
}

async function ready(page, route) {
  await page.goto(route, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator('.site-header')).toBeVisible();
}

async function neutralizeCurrentPageIndicator(page) {
  await page.addStyleTag({
    content: [
      '.site-nav-link[aria-current="page"] { color: var(--header-fg-muted) !important; }',
      '.site-nav-link[aria-current="page"]::after { transform: scaleX(0) !important; }',
    ].join('\n'),
  });
}

async function headerMetrics(page) {
  return page.locator('.site-header').evaluate((element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return {
      background: style.backgroundColor,
      height: style.height,
      position: style.position,
      top: Math.round(rect.top),
    };
  });
}

test('every sitemap and required route renders the identical shared header', async ({ page, request }, testInfo) => {
  const routes = await discoverRoutes(request);
  let baseline;

  await mkdir('test-results/header-top-120/' + testInfo.project.name, { recursive: true });

  for (const route of routes) {
    await ready(page, route);
    await neutralizeCurrentPageIndicator(page);

    const header = page.locator('.site-header');
    const image = await header.screenshot({ animations: 'disabled' });
    if (!baseline) baseline = image;
    else expect(image.equals(baseline), route + ' header differs from the home-page baseline').toBeTruthy();

    const viewport = page.viewportSize();
    const top = await page.screenshot({
      animations: 'disabled',
      clip: { x: 0, y: 0, width: viewport.width, height: 120 },
    });
    const name = route === '/' ? 'home' : route.slice(1).replaceAll('/', '--');
    await writeFile(
      'test-results/header-top-120/' + testInfo.project.name + '/' + name + '.png',
      top,
    );
  }
});

test('background, sticky position and height remain invariant at 0, 200 and 2000px', async ({ page, request }, testInfo) => {
  const routes = await discoverRoutes(request);
  const expectedHeight = testInfo.project.name === 'mobile' ? '64px' : '72px';

  for (const route of routes) {
    await ready(page, route);
    await page.evaluate(() => {
      const spacer = document.createElement('div');
      spacer.setAttribute('data-header-test-spacer', 'true');
      spacer.style.height = '2600px';
      spacer.style.pointerEvents = 'none';
      document.body.append(spacer);
    });

    for (const y of [0, 200, 2000]) {
      await page.evaluate((top) => window.scrollTo(0, top), y);
      await page.waitForTimeout(40);
      const metrics = await headerMetrics(page);
      expect(metrics.background, route + ' background at scroll ' + y).toBe('rgb(7, 29, 53)');
      expect(metrics.height, route + ' height at scroll ' + y).toBe(expectedHeight);
      expect(metrics.position, route + ' positioning').toBe('sticky');
      expect(metrics.top, route + ' sticky top at scroll ' + y).toBe(0);
    }
  }
});

test('desktop keyboard flow opens, traverses and closes dropdowns', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Desktop keyboard contract');

  await ready(page, '/');
  await page.keyboard.press('Tab');
  await expect(page.locator('.skip-link')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('.site-header__logo')).toBeFocused();

  const trigger = page.locator('[data-nav-trigger]').first();
  await trigger.focus();
  await page.keyboard.press('Enter');
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');

  await page.keyboard.press('ArrowDown');
  const panel = page.locator('[data-nav-panel]').first();
  const firstItem = panel.locator('[role="menuitem"]').first();
  await expect(firstItem).toBeFocused();

  await page.keyboard.press('ArrowDown');
  await expect(panel.locator('[role="menuitem"]').nth(1)).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
});

test('mobile menu is a focus-trapped full-screen sheet with accordion rows', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'Mobile sheet contract');

  await ready(page, '/');
  const toggle = page.locator('[data-mobile-toggle]');
  await toggle.click();

  const panel = page.locator('[data-mobile-panel]');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(panel).toHaveAttribute('aria-hidden', 'false');

  const box = await panel.boundingBox();
  expect(Math.round(box.y)).toBe(64);
  expect(Math.round(box.height)).toBe(780);

  const accordion = page.locator('[data-mobile-accordion-toggle]').first();
  await accordion.click();
  await expect(accordion).toHaveAttribute('aria-expanded', 'true');

  const trap = await page.evaluate(() => {
    const root = document.querySelector('[data-mobile-panel]');
    const items = Array.from(
      root.querySelectorAll('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'),
    ).filter((element) => element.getClientRects().length > 0);
    items[items.length - 1].focus();
    return { first: items[0].className, last: items[items.length - 1].className };
  });
  expect(trap.first).toBeTruthy();
  expect(trap.last).toBeTruthy();

  await page.keyboard.press('Tab');
  const wrapped = await page.evaluate(() => {
    const root = document.querySelector('[data-mobile-panel]');
    const first = Array.from(
      root.querySelectorAll('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'),
    ).filter((element) => element.getClientRects().length > 0)[0];
    return document.activeElement === first;
  });
  expect(wrapped).toBeTruthy();

  await page.keyboard.press('Escape');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toBeFocused();
});

test('header has zero Axe violations on every route', async ({ page, request }) => {
  const routes = await discoverRoutes(request);
  for (const route of routes) {
    await ready(page, route);
    const result = await new AxeBuilder({ page }).include('.site-header').analyze();
    expect(result.violations, route + ' header Axe violations: ' + JSON.stringify(result.violations)).toEqual([]);
  }
});

test('sandbox full-screen keeps the slim shared header and exits through it', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Full-screen header contract');

  await ready(page, '/assurance-os/sandbox');
  const dismiss = page.getByRole('button', { name: 'Dismiss' });
  if (await dismiss.isVisible().catch(() => false)) await dismiss.click();

  await page.getByRole('button', { name: 'Open full screen' }).click();
  await expect(page.locator('html')).toHaveClass(/sandbox-fullscreen/);
  await expect(page.locator('.site-header')).toHaveCSS('height', '48px');
  await expect(page.getByRole('button', { name: 'Exit full screen' })).toBeVisible();
  await expect(page.locator('.site-header__cta--fullscreen')).toBeVisible();

  await page.getByRole('button', { name: 'Exit full screen' }).click();
  await expect(page.locator('html')).not.toHaveClass(/sandbox-fullscreen/);
});

test('write six desktop before-and-after header comparisons', async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Desktop audit artifact');

  await mkdir('public/images/header-audit', { recursive: true });
  const before = await context.newPage();

  for (const route of BEFORE_AFTER) {
    await before.goto('https://murikah.com' + route, { waitUntil: 'networkidle' });
    await before.evaluate(() => document.fonts.ready);
    const beforePng = await before.screenshot({
      animations: 'disabled',
      clip: { x: 0, y: 0, width: 1440, height: 120 },
    });

    await ready(page, route);
    const afterPng = await page.screenshot({
      animations: 'disabled',
      clip: { x: 0, y: 0, width: 1440, height: 120 },
    });

    const montage = await context.newPage();
    await montage.setViewportSize({ width: 2880, height: 160 });
    await montage.setContent(
      '<style>html,body{margin:0;background:#fff;font-family:Arial,sans-serif}' +
        '.labels{height:40px;display:grid;grid-template-columns:1fr 1fr;align-items:center;' +
        'font:600 16px Arial;color:#071D35}.labels span{padding-left:12px}' +
        '.shots{display:flex}.shots img{display:block;width:1440px;height:120px}</style>' +
        '<div class="labels"><span>Before · current production</span><span>After · unified header</span></div>' +
        '<div class="shots"><img src="data:image/png;base64,' +
        beforePng.toString('base64') +
        '"><img src="data:image/png;base64,' +
        afterPng.toString('base64') +
        '"></div>',
    );

    const name = route === '/' ? 'home' : route.slice(1).replaceAll('/', '--');
    await montage.screenshot({
      path: 'public/images/header-audit/' + name + '-before-after.png',
      fullPage: true,
      animations: 'disabled',
    });
    await montage.close();
  }

  await before.close();
});
