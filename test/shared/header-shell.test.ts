import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const PUBLIC_PAGES = [
  'src/pages/index.astro',
  'src/pages/about.astro',
  'src/pages/pricing.astro',
  'src/pages/insights/index.astro',
  'src/pages/insights/[...slug].astro',
  'src/pages/contact.astro',
  'src/pages/assurance-os.astro',
  'src/pages/assurance-os/sandbox.astro',
  'src/pages/products.astro',
  'src/pages/research.astro',
  'src/pages/privacy.astro',
  'src/pages/terms.astro',
  'src/pages/404.astro',
  'src/pages/services.astro',
  'src/pages/internal-audit.astro',
  'src/pages/advisory.astro',
  'src/pages/automation.astro',
  'src/pages/training.astro',
  'src/pages/saccos.astro',
  'src/pages/banks.astro',
  'src/pages/sample-report.astro',
  'src/pages/proof/report-extract.astro',
] as const;

const SERVICE_PAGES = new Set([
  'src/pages/assurance-os.astro',
  'src/pages/research.astro',
  'src/pages/internal-audit.astro',
  'src/pages/advisory.astro',
  'src/pages/automation.astro',
  'src/pages/training.astro',
]);

const INSIGHT_DYNAMIC = 'src/pages/insights/[...slug].astro';

async function source(file: string) {
  return readFile(new URL('../../' + file, import.meta.url), 'utf8');
}

function rgb(hex: string): [number, number, number] {
  const value = hex.replace('#', '');
  return [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16)) as [
    number,
    number,
    number,
  ];
}

function mix(foreground: [number, number, number], background: [number, number, number], alpha: number) {
  return foreground.map((value, index) =>
    Math.round(value * alpha + background[index] * (1 - alpha)),
  ) as [number, number, number];
}

function luminance([r, g, b]: [number, number, number]) {
  const channels = [r, g, b].map((value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(a: [number, number, number], b: [number, number, number]) {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

test('one Header component is mounted only by the shared BaseLayout', async () => {
  const base = await source('src/layouts/BaseLayout.astro');
  assert.match(base, /import Header from '@\/components\/Header\.astro'/);
  assert.equal((base.match(/<Header\s*\/>/g) ?? []).length, 1);

  const srcRoot = new URL('../../src/', import.meta.url);
  const entries = await readdir(srcRoot, { recursive: true });
  const astroFiles = entries.filter((entry) => String(entry).endsWith('.astro'));

  const imports: string[] = [];
  for (const entry of astroFiles) {
    const file = path.join(srcRoot.pathname, String(entry));
    const text = await readFile(file, 'utf8');
    if (text.includes("@/components/Header.astro")) imports.push(String(entry).replaceAll('\\', '/'));
  }

  assert.deepEqual(imports, ['layouts/BaseLayout.astro']);
});

test('every public HTML page reaches BaseLayout and no page owns header styling', async () => {
  const serviceLayout = await source('src/layouts/ServiceLayout.astro');
  const insightLayout = await source('src/layouts/InsightLayout.astro');
  assert.match(serviceLayout, /import BaseLayout from '@\/layouts\/BaseLayout\.astro'/);
  assert.match(insightLayout, /import BaseLayout from '@\/layouts\/BaseLayout\.astro'/);

  for (const file of PUBLIC_PAGES) {
    const text = await source(file);
    if (SERVICE_PAGES.has(file)) {
      assert.match(text, /import ServiceLayout from '@\/layouts\/ServiceLayout\.astro'/, file);
    } else if (file === INSIGHT_DYNAMIC) {
      assert.match(text, /import InsightLayout from '@\/layouts\/InsightLayout\.astro'/, file);
    } else {
      assert.match(text, /import BaseLayout from '@\/layouts\/BaseLayout\.astro'/, file);
    }

    assert.doesNotMatch(text, /site-header--home|data-home-header|header-bg|murikah-logo-dark\.png/);
  }
});

test('global header tokens are exact and the old route/scroll colour overrides are gone', async () => {
  const css = await source('src/styles/global.css');
  const home = await source('src/pages/index.astro');
  const header = await source('src/components/Header.astro');

  for (const token of [
    '--header-bg: #071d35;',
    '--header-border: rgba(245, 241, 232, 0.1);',
    '--header-fg: #f5f1e8;',
    '--header-fg-muted: rgba(245, 241, 232, 0.78);',
    '--header-fg-hover: #ffffff;',
    '--header-height: 72px;',
    '--header-height-sm: 64px;',
    '--header-z: 1000;',
  ]) {
    assert.ok(css.toLowerCase().includes(token), token + ' must be declared');
  }

  assert.match(header, /position: sticky/);
  assert.match(header, /background: var\(--header-bg\)/);
  assert.match(header, /border-bottom: 1px solid var\(--header-border\)/);
  assert.doesNotMatch(header, /backdrop-filter|background:\s*transparent/);
  assert.doesNotMatch(css, /site-header--home/);
  assert.doesNotMatch(home, /IntersectionObserver|is-scrolled|data-home-header|data-home-nav-sentinel/);
});

test('header uses one preloaded SVG lockup and the existing dark-surface gold token', async () => {
  const base = await source('src/layouts/BaseLayout.astro');
  const header = await source('src/components/Header.astro');
  const sandbox = await source('src/components/assurance-os/PublicSandbox.tsx');
  const tokens = await source('src/styles/tokens.css');

  assert.match(base, /rel="preload" href="\/brand\/murikah-header-lockup\.svg" as="image"/);
  assert.match(header, /src="\/brand\/murikah-header-lockup\.svg"/);
  assert.doesNotMatch(header, /murikah-logo-dark|murikah-logo-transparent/);
  assert.doesNotMatch(sandbox, /murikah-logo-dark\.png/);
  assert.match(tokens, /--color-brass-on-dark:\s*#d1aa58/);
  assert.match(header, /background: var\(--color-brass-on-dark\)/);
});

test('header text and CTA contrast exceed WCAG AA on the fixed navy surface', () => {
  const navy = rgb('#071d35');
  const ivory = rgb('#f5f1e8');
  const muted = mix(ivory, navy, 0.78);
  const gold = rgb('#d1aa58');

  assert.ok(contrast(ivory, navy) >= 4.5);
  assert.ok(contrast(muted, navy) >= 4.5);
  assert.ok(contrast(navy, gold) >= 4.5);
});

test('sandbox full-screen retains a 48px shared header instead of hiding it', async () => {
  const header = await source('src/components/Header.astro');
  const sandboxCss = await source('src/components/assurance-os/sandbox/Sandbox.css');
  const sandbox = await source('src/components/assurance-os/PublicSandbox.tsx');

  assert.match(header, /html\.sandbox-fullscreen \.site-header \{\s*height: 48px/);
  assert.match(header, /data-exit-sandbox-fullscreen/);
  assert.match(header, /site-header__cta--fullscreen/);
  assert.doesNotMatch(sandboxCss, /sandbox-fullscreen \.site-header[^\{]*\{[^}]*display:\s*none/);
  assert.match(sandbox, /murikah:sandbox-exit-fullscreen/);
});

test('theme colour, anchor offset, reduced motion and print rules are shared', async () => {
  const base = await source('src/layouts/BaseLayout.astro');
  const css = await source('src/styles/global.css');
  const header = await source('src/components/Header.astro');

  assert.match(base, /<meta name="theme-color" content="#071D35" \/>/);
  assert.match(css, /scroll-padding-top: var\(--header-height\)/);
  assert.match(css, /scroll-margin-top: var\(--header-height\)/);
  assert.match(css, /\.skip-link[\s\S]*?z-index: calc\(var\(--header-z\) \+ 10\)/);
  assert.match(header, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(header, /@media print[\s\S]*?\.site-header[\s\S]*?display: none !important/);
});
