import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import test from 'node:test';

test('homepage hero is centred on the plan-to-board-pack promise', async () => {
  const page = await readFile(new URL('../../src/pages/index.astro', import.meta.url), 'utf8');

  assert.match(page, /Audit you can trace\./);
  assert.match(page, /From plan to board pack\./);
  assert.match(
    page,
    /Murikah pairs senior internal audit with Assurance OS, so evidence, findings and actions\s+stay linked\./,
  );
  assert.doesNotMatch(page, /Internal audit · Assurance OS/);
  assert.doesNotMatch(page, />Engagements<|>Open findings<|>Due actions<|>Sample data</);
  assert.match(page, /Try with sample data →/);
  assert.match(page, /Guided by IIA Standards · ISO\/IEC 27001 · ISO\/IEC 42001/);
});

test('hero product proof is a high-priority lightweight image', async () => {
  const page = await readFile(new URL('../../src/pages/index.astro', import.meta.url), 'utf8');
  const asset = new URL('../../public/images/assurance-os-trace.webp', import.meta.url);
  const bytes = await readFile(asset);
  const metadata = await stat(asset);

  assert.match(page, /src="\/images\/assurance-os-trace\.webp"/);
  assert.match(page, /width="960"/);
  assert.match(page, /height="651"/);
  assert.match(page, /fetchpriority="high"/);
  assert.match(page, /loading="eager"/);
  assert.match(page, /decoding="async"/);
  assert.match(page, /hero-product-shot/);
  assert.match(page, /Product-derived Assurance OS preview using fictional Murikah Demo records/);

  assert.equal(bytes.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(bytes.subarray(8, 12).toString('ascii'), 'WEBP');
  assert.ok(metadata.size < 300_000, `hero image must stay below 300 KB; got ${metadata.size}`);
});

test('public header is a 68px light bar with the same primary CTA treatment', async () => {
  const header = await readFile(
    new URL('../../src/components/Header.astro', import.meta.url),
    'utf8',
  );
  const css = await readFile(new URL('../../src/styles/global.css', import.meta.url), 'utf8');

  assert.match(header, /bg-paper\/95/);
  assert.match(header, /backdrop-blur-md/);
  assert.match(header, /murikah-logo-dark\.png/);
  assert.doesNotMatch(header, /\bon-dark\b/);
  assert.doesNotMatch(header, /bg-header-bg/);
  assert.match(header, /height: 4\.25rem/);
  assert.match(
    header,
    /<Button[\s\S]*?href=\{PRIMARY_CTA\.href\}[\s\S]*?variant="primary"[\s\S]*?size="lg"[\s\S]*?rounded-\[12px\]/,
  );

  assert.match(css, /--header-height: 4\.25rem/);
  assert.match(css, /> header \.btn-primary[\s\S]*?background: #071d35;/);
  assert.doesNotMatch(css, /> header \.btn-primary[\s\S]*?background: #d1aa58;/);
});

test('hero motion is short and respects reduced motion', async () => {
  const css = await readFile(new URL('../../src/styles/global.css', import.meta.url), 'utf8');

  assert.match(
    css,
    /animation: hero-product-in 600ms cubic-bezier\(0\.22, 1, 0\.36, 1\) forwards;/,
  );
  assert.match(css, /transform: translateY\(16px\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.hero-product-shot/);
});

test('mobile accessibility control uses the reduced 40px footprint', async () => {
  const css = await readFile(
    new URL('../../src/components/a11y/AccessibilityAssistant.css', import.meta.url),
    'utf8',
  );

  assert.match(css, /@media \(max-width: 639px\)[\s\S]*?\.a11y__toggle\s*\{[\s\S]*?width: 2\.5rem;[\s\S]*?height: 2\.5rem;/);
});
