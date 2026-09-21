import assert from 'node:assert/strict';
import { access, readFile, stat } from 'node:fs/promises';
import test from 'node:test';

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
  const linear = [r, g, b].map((value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(a: [number, number, number], b: [number, number, number]) {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

async function exists(url: URL) {
  try {
    await access(url);
    return true;
  } catch {
    return false;
  }
}

test('homepage hero copy is centralised and stays concise', async () => {
  const page = await readFile(new URL('../../src/pages/index.astro', import.meta.url), 'utf8');
  const content = await readFile(new URL('../../src/data/homeHero.ts', import.meta.url), 'utf8');

  assert.match(content, /Audit you can trace\./);
  assert.match(content, /From plan to board pack\./);
  assert.match(
    content,
    /Senior internal audit and Assurance OS, one connected workspace for evidence, findings and board reporting\./,
  );
  assert.match(content, /Book a 20-minute call/);
  assert.match(content, /Try the sandbox/);

  const body =
    'Senior internal audit and Assurance OS, one connected workspace for evidence, findings and board reporting.';
  assert.ok(body.trim().split(/\s+/).length <= 25);

  assert.match(page, /HOME_HERO\.headline/);
  assert.match(page, /HOME_HERO\.body/);
  assert.match(page, /HOME_HERO\.primary/);
  assert.match(page, /HOME_HERO\.secondary/);
  assert.equal((page.match(/<h1\b/g) ?? []).length, 1);
  assert.doesNotMatch(page, /assurance-os-trace\.webp/);
  assert.doesNotMatch(page, /hero-product-frame|fake dashboard/i);
});

test('trust row comes from trust data and contains no unverified placeholder logos', async () => {
  const page = await readFile(new URL('../../src/pages/index.astro', import.meta.url), 'utf8');
  const trust = await readFile(new URL('../../src/data/trust.ts', import.meta.url), 'utf8');

  assert.match(trust, /GUIDED BY/);
  assert.match(trust, /IIA Standards/);
  assert.match(trust, /ISO\/IEC 27001/);
  assert.match(trust, /ISO\/IEC 42001/);
  assert.match(trust, /logos: \[\] as TrustLogo\[\]/);
  assert.match(page, /logo\.verified && logo\.permitted/);

  for (const forbidden of [
    'Allens',
    'NRMA',
    'Wilson Security',
    'AlfredHealth',
    'IAG',
  ]) {
    assert.doesNotMatch(trust, new RegExp(forbidden, 'i'));
    assert.doesNotMatch(page, new RegExp(forbidden, 'i'));
  }
});

test('hero picture contract uses AVIF and WebP variants with eager high-priority fallback', async () => {
  const page = await readFile(new URL('../../src/pages/index.astro', import.meta.url), 'utf8');

  assert.match(page, /<picture class="home-hero__picture">/);
  assert.match(page, /hero-building-1280\.avif 1280w/);
  assert.match(page, /hero-building-1920\.avif 1920w/);
  assert.match(page, /hero-building-1280\.webp 1280w/);
  assert.match(page, /hero-building-1920\.webp 1920w/);
  assert.match(page, /src="\/images\/hero\/hero-building\.jpg"/);
  assert.match(page, /alt=""/);
  assert.match(page, /width="1920"/);
  assert.match(page, /height="1200"/);
  assert.match(page, /fetchpriority="high"/);
  assert.match(page, /loading="eager"/);
  assert.match(page, /object-position: 70% center/);

  const source = new URL('../../public/images/hero/hero-building.jpg', import.meta.url);
  if (await exists(source)) {
    for (const file of [
      'hero-building-1280.avif',
      'hero-building-1920.avif',
      'hero-building-1280.webp',
      'hero-building-1920.webp',
    ]) {
      const variant = new URL(`../../public/images/hero/${file}`, import.meta.url);
      assert.ok(await exists(variant), `${file} must exist when the source JPG is present`);
    }

    for (const file of ['hero-building-1920.avif', 'hero-building-1920.webp']) {
      const metadata = await stat(new URL(`../../public/images/hero/${file}`, import.meta.url));
      assert.ok(metadata.size <= 200_000, `${file} must stay at or below 200 KB`);
    }
  }
});

test('desktop hero and photo geometry match the reference specification', async () => {
  const page = await readFile(new URL('../../src/pages/index.astro', import.meta.url), 'utf8');

  assert.match(page, /height: min\(100svh, 900px\)/);
  assert.match(page, /min-height: 640px/);
  assert.match(page, /--home-hero-gutter: clamp\(1\.5rem, 8\.33vw, 7\.5rem\)/);
  assert.match(page, /inset: 0 0 0 45%/);
  assert.match(page, /width: 55%/);
  assert.match(page, /max-width: 640px/);
  assert.match(page, /font-family: var\(--font-display\)/);
  assert.match(page, /font-size: clamp\(44px, 6vw, 84px\)/);
  assert.match(page, /font-weight: 450/);
  assert.match(page, /line-height: 1\.05/);
  assert.match(page, /letter-spacing: -0\.02em/);
  assert.match(page, /width: 48px;[\s\S]*?height: 2px;[\s\S]*?margin: 32px 0/);
  assert.match(page, /font-size: clamp\(17px, 1\.4vw, 21px\)/);
  assert.match(page, /max-width: 34em/);
  assert.match(
    page,
    /linear-gradient\([\s\S]*?90deg,[\s\S]*?var\(--color-navy\) 0%,[\s\S]*?var\(--color-navy\) 38%,[\s\S]*?rgba\(7, 29, 53, 0\.65\) 60%,[\s\S]*?rgba\(7, 29, 53, 0\) 100%/,
  );
  assert.match(
    page,
    /linear-gradient\(0deg, var\(--color-navy\) 0%, transparent 25%\)/,
  );
});

test('homepage navigation alone overlays hero and turns solid after 24px', async () => {
  const header = await readFile(
    new URL('../../src/components/Header.astro', import.meta.url),
    'utf8',
  );
  const css = await readFile(new URL('../../src/styles/global.css', import.meta.url), 'utf8');
  const page = await readFile(new URL('../../src/pages/index.astro', import.meta.url), 'utf8');

  assert.ok(header.includes("const isHome = path === '/'"));
  assert.match(header, /site-header--home fixed inset-x-0/);
  assert.match(header, /murikah-logo-transparent\.png/);
  assert.match(header, /NAV\.map/);
  assert.match(css, /> header\.site-header--home \{[\s\S]*?background: transparent/);
  assert.match(
    css,
    /> header\.site-header--home\.is-scrolled \{[\s\S]*?background: var\(--color-navy\)/,
  );
  assert.match(page, /top: 24px/);
  assert.match(page, /new IntersectionObserver/);
  assert.match(page, /classList\.toggle\('is-scrolled'/);
});

test('buttons, trust row and hero text clear WCAG AA contrast on navy', async () => {
  const navy = rgb('#071d35');
  const ivory = rgb('#f5f1e8');
  const gold = rgb('#d1aa58');

  const pairs = [
    ['headline', ivory, navy],
    ['body', mix(ivory, navy, 0.82), navy],
    ['secondary button', ivory, navy],
    ['trust caption', mix(ivory, navy, 0.7), navy],
    ['trust items', mix(ivory, navy, 0.8), navy],
    ['primary button text', navy, gold],
  ] as const;

  for (const [name, foreground, background] of pairs) {
    const ratio = contrast(foreground, background);
    assert.ok(ratio >= 4.5, `${name} must be >= 4.5:1; got ${ratio.toFixed(2)}:1`);
  }
});

test('hero motion, focus and mobile behavior meet the requested controls', async () => {
  const page = await readFile(new URL('../../src/pages/index.astro', import.meta.url), 'utf8');
  const css = await readFile(new URL('../../src/styles/global.css', import.meta.url), 'utf8');

  assert.match(page, /animation: home-hero-reveal 600ms var\(--ease-out-soft\) forwards/);
  assert.match(page, /animation-delay: 120ms/);
  assert.match(page, /animation-delay: 200ms/);
  assert.match(page, /animation-delay: 280ms/);
  assert.match(page, /animation-delay: 360ms/);
  assert.match(page, /animation: home-hero-image-fade 900ms/);
  assert.match(page, /animation: home-hero-image-scale 8s/);
  assert.match(page, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(page, /outline: 2px solid var\(--color-hero-ivory\)/);
  assert.match(page, /outline-offset: 3px/);
  assert.match(page, /@media \(max-width: 1023px\)/);
  assert.match(page, /--hero-image-opacity: 0\.35/);
  assert.match(page, /@media \(max-width: 639px\)[\s\S]*?font-size: 40px/);
  assert.match(page, /padding-top: 120px/);
  assert.match(page, /\.home-hero__primary \{[\s\S]*?width: 100%/);
  assert.match(css, /\.home-hero-page \.a11y \{[\s\S]*?bottom: calc\(6rem/);
});

test('only one new specified colour token is introduced for the hero', async () => {
  const css = await readFile(new URL('../../src/styles/global.css', import.meta.url), 'utf8');

  assert.match(css, /--color-hero-ivory: #f5f1e8;/);
  assert.match(css, /background: var\(--color-brass-on-dark\)/);
  assert.match(css, /background: var\(--color-navy\)/);
});
