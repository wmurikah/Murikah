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

const palette = {
  navy: '#071d35',
  headerVeil: '#0c2946',
  ink: '#17283b',
  slate: '#56616d',
  paper: '#f7f5f0',
  surface: '#ffffff',
  goldText: '#7b5c1d',
  decorativeBrass: '#b78b32',
  brassOnDark: '#d1aa58',
  blue: '#244660',
  controlBorder: '#737e89',
  white: '#ffffff',
} as const;

test('marketing text pairs meet WCAG AA contrast thresholds', () => {
  const normalTextPairs = [
    ['body text on paper', palette.ink, palette.paper],
    ['secondary text on paper', palette.slate, palette.paper],
    ['navy text on paper', palette.navy, palette.paper],
    ['gold text on paper', palette.goldText, palette.paper],
    ['gold text on white', palette.goldText, palette.surface],
    ['link text on paper', palette.blue, palette.paper],
    ['white text on navy', palette.white, palette.navy],
    ['white text in header menu', palette.white, palette.headerVeil],
    ['gold text on navy', palette.brassOnDark, palette.navy],
  ] as const;

  for (const [name, foreground, background] of normalTextPairs) {
    assert.ok(
      contrast(foreground, background) >= 4.5,
      `${name} must be at least 4.5:1, got ${contrast(foreground, background).toFixed(3)}:1`,
    );
  }
});

test('functional boundaries and non-text accents meet the 3:1 threshold', () => {
  const nonTextPairs = [
    ['control border on paper', palette.controlBorder, palette.paper],
    ['control border on white', palette.controlBorder, palette.surface],
    ['brass active indicator on navy', palette.decorativeBrass, palette.navy],
  ] as const;

  for (const [name, foreground, background] of nonTextPairs) {
    assert.ok(
      contrast(foreground, background) >= 3,
      `${name} must be at least 3:1, got ${contrast(foreground, background).toFixed(3)}:1`,
    );
  }
});

test('bright brass is decorative on light surfaces, not body text', async () => {
  assert.ok(contrast(palette.decorativeBrass, palette.paper) < 4.5);

  const css = await readFile(new URL('../../src/styles/global.css', import.meta.url), 'utf8');
  assert.match(css, /--color-gold: #7b5c1d;/);
  assert.match(css, /--color-brass: #b78b32;/);
  assert.match(css, /--color-brass-on-dark: #d1aa58;/);
  assert.match(css, /\.on-dark \.eyebrow\s*\{\s*color: var\(--color-brass-on-dark\);/);
});

test('functional form borders do not use the decorative hairline token', async () => {
  const contact = await readFile(new URL('../../src/pages/contact.astro', import.meta.url), 'utf8');
  const subscribe = await readFile(
    new URL('../../src/components/SubscribeForm.astro', import.meta.url),
    'utf8',
  );

  assert.match(contact, /border-control-border/);
  assert.match(subscribe, /border-control-border/);
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

  assert.match(cta, /<Section tone="paper"/);
  assert.doesNotMatch(cta, /tone="navy-rich"/);
  assert.match(footer, /bg-paper-shade/);
  assert.doesNotMatch(footer, /bg-header-bg/);
  assert.doesNotMatch(footer, /\bon-dark\b/);
});
