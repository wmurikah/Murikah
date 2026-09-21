import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

import { NAV } from '../../src/site.config.ts';

test('homepage keeps the six-section conversion architecture', async () => {
  const page = await readFile(new URL('../../src/pages/index.astro', import.meta.url), 'utf8');
  const ids = Array.from(
    page.matchAll(/<(?:section|Section|CtaSection)[^>]*\bid="([^"]+)"/g),
    (match) => match[1],
  );

  assert.deepEqual(ids, ['hero', 'proof', 'platform', 'services', 'audience', 'contact']);
  assert.doesNotMatch(page, /Working products/);
  assert.doesNotMatch(page, /Why it works/);
  assert.doesNotMatch(page, /Explore products/);
  assert.doesNotMatch(page, /HeroFilm/);
  assert.doesNotMatch(page, /ProductLinks/);
  assert.doesNotMatch(page, /\bCMS\b|\bTutor\b|\bENGR\b/);
  assert.match(page, /Assurance OS/);
  assert.match(page, /\/assurance-os\/sandbox/);
});

test('Platform navigation leads with Assurance OS and groups secondary apps elsewhere', () => {
  const platform = NAV.find((item) => item.label === 'Platform');
  assert.equal(platform?.href, '/assurance-os');
  assert.deepEqual(
    platform?.children?.map((item) => [item.label, item.href]),
    [
      ['Assurance OS', '/assurance-os'],
      ['Try the sandbox', '/assurance-os/sandbox'],
      ['More from Murikah Labs', '/products'],
    ],
  );

  const serialized = JSON.stringify(platform);
  assert.doesNotMatch(serialized, /cms\.murikah\.com|tutor\.murikah\.com|engr\.murikah\.com/);
});

test('More from Murikah Labs excludes Assurance OS from the peer product grid', async () => {
  const page = await readFile(new URL('../../src/pages/products.astro', import.meta.url), 'utf8');
  assert.match(page, /More from Murikah Labs/);
  assert.match(page, /product\.label !== 'Assurance OS'/);
  assert.match(page, /CMS, Tutor and ENGR/);
});

test('Services is a comparison page rather than a duplicate service-card list', async () => {
  const page = await readFile(new URL('../../src/pages/services.astro', import.meta.url), 'utf8');
  assert.match(page, />Best for</);
  assert.match(page, />What you get</);
  assert.match(page, />Typical start</);
  assert.match(page, /comparison\[service\.slug\]/);
});

test('Assurance OS has a no-sign-in browser-only sample-data sandbox', async () => {
  await access(new URL('../../src/pages/assurance-os/sandbox.astro', import.meta.url));
  await access(new URL('../../src/components/assurance-os/PublicSandbox.tsx', import.meta.url));

  const page = await readFile(
    new URL('../../src/pages/assurance-os/sandbox.astro', import.meta.url),
    'utf8',
  );
  const component = await readFile(
    new URL('../../src/components/assurance-os/PublicSandbox.tsx', import.meta.url),
    'utf8',
  );

  assert.match(page, /No sign-in/i);
  assert.match(page, /fictional SACCO audit portfolio|fictional sample data/i);
  assert.match(component, /Fictional sample data/);
  assert.match(component, /Changes stay in your browser/);
  assert.match(component, /Nothing you type leaves your browser/);
  assert.doesNotMatch(component, /fetch\(|\/api\//);
});
