import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

function rgb(hex: string): [number, number, number] {
  const value = hex.replace('#', '');
  return [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
}

function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(foreground: string, background: string): number {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort(
    (a, b) => b - a,
  );
  return (lighter + 0.05) / (darker + 0.05);
}

function marketingTokens(css: string): Record<string, string> {
  const block = css.match(/\.marketing-shell\.ceramic-ink\s*\{([\s\S]*?)\n\}/)?.[1];
  assert.ok(block, 'Ceramic Ink marketing token block must exist');

  return Object.fromEntries(
    Array.from(block.matchAll(/(--color-[a-z-]+):\s*(#[0-9a-f]{6});/g), (match) => [
      match[1],
      match[2],
    ]),
  );
}

test('marketing text pairs meet WCAG AA contrast thresholds', async () => {
  const css = await readFile(new URL('../../src/styles/global.css', import.meta.url), 'utf8');
  const token = marketingTokens(css);

  const normalTextPairs = [
    ['body text on paper', token['--color-ink'], token['--color-paper']],
    ['secondary text on paper', token['--color-slate'], token['--color-paper']],
    ['secondary text in light footer', token['--color-slate'], token['--color-paper-shade']],
    ['navy text on paper', token['--color-navy'], token['--color-paper']],
    ['gold text on paper', token['--color-gold'], token['--color-paper']],
    ['gold text on white', token['--color-gold'], token['--color-surface']],
    ['link text on paper', token['--color-blue'], token['--color-paper']],
    ['white text on navy', '#ffffff', token['--color-navy']],
    ['white text in header menu', '#ffffff', token['--color-header-veil']],
    ['gold text on navy', token['--color-brass-on-dark'], token['--color-navy']],
    ['navy text on gold header CTA', token['--color-navy'], token['--color-brass-on-dark']],
  ] as const;

  for (const [name, foreground, background] of normalTextPairs) {
    assert.ok(foreground && background, `${name} must resolve both colours`);
    const ratio = contrast(foreground, background);
    assert.ok(ratio >= 4.5, `${name} must be at least 4.5:1, got ${ratio.toFixed(3)}:1`);
  }
});

test('functional boundaries and non-text accents meet the 3:1 threshold', async () => {
  const css = await readFile(new URL('../../src/styles/global.css', import.meta.url), 'utf8');
  const token = marketingTokens(css);

  const nonTextPairs = [
    ['control border on paper', token['--color-control-border'], token['--color-paper']],
    ['control border on white', token['--color-control-border'], token['--color-surface']],
    ['brass active indicator on navy', token['--color-brass'], token['--color-navy']],
  ] as const;

  for (const [name, foreground, background] of nonTextPairs) {
    assert.ok(foreground && background, `${name} must resolve both colours`);
    const ratio = contrast(foreground, background);
    assert.ok(ratio >= 3, `${name} must be at least 3:1, got ${ratio.toFixed(3)}:1`);
  }
});

test('bright brass is decorative on light surfaces, not body text', async () => {
  const css = await readFile(new URL('../../src/styles/global.css', import.meta.url), 'utf8');
  const token = marketingTokens(css);

  assert.ok(contrast(token['--color-brass'], token['--color-paper']) < 4.5);
  assert.equal(token['--color-gold'], '#7b5c1d');
  assert.equal(token['--color-brass'], '#b78b32');
  assert.equal(token['--color-brass-on-dark'], '#d1aa58');
  assert.match(css, /\.on-dark \.eyebrow\s*\{\s*color: var\(--color-brass-on-dark\);/);
});

test('functional form borders do not use the decorative hairline token', async () => {
  const contact = await readFile(new URL('../../src/pages/contact.astro', import.meta.url), 'utf8');
  const subscribe = await readFile(
    new URL('../../src/components/SubscribeForm.astro', import.meta.url),
    'utf8',
  );
  const button = await readFile(
    new URL('../../src/components/primitives/Button.astro', import.meta.url),
    'utf8',
  );

  assert.match(contact, /border-control-border/);
  assert.match(subscribe, /border-control-border/);
  assert.match(button, /ring-control-border/);
  assert.doesNotMatch(contact, /placeholder:text-slate\/60/);
  assert.doesNotMatch(subscribe, /placeholder:text-slate\/60/);
});

test('dark surfaces stay scarce: header dark, closing CTA and footer light', async () => {
  const cta = await readFile(
    new URL('../../src/components/primitives/CtaSection.astro', import.meta.url),
    'utf8',
  );
  const footer = await readFile(
    new URL('../../src/components/Footer.astro', import.meta.url),
    'utf8',
  );
  const header = await readFile(
    new URL('../../src/components/Header.astro', import.meta.url),
    'utf8',
  );

  assert.match(header, /bg-header-bg/);
  assert.match(cta, /<Section tone="paper"/);
  assert.doesNotMatch(cta, /tone="navy-rich"/);
  const css = await readFile(new URL('../../src/styles/global.css', import.meta.url), 'utf8');

  assert.match(footer, /bg-paper-shade/);
  assert.doesNotMatch(footer, /bg-header-bg/);
  assert.doesNotMatch(footer, /\bon-dark\b/);
  assert.doesNotMatch(css, /\.marketing-shell\.ceramic-ink \.newsletter-panel/);
});
