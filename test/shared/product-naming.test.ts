import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { NAV, PRODUCTS, SERVICES } from '../../src/site.config.ts';

test('Assurance OS is the sole buyer-facing name for the audit platform', () => {
  const product = PRODUCTS.find((item) => item.href === 'https://grc.murikah.com');
  assert.equal(product?.label, 'Assurance OS');

  const service = SERVICES.find((item) => item.slug === 'assurance-os');
  assert.equal(service?.name, 'Assurance OS');
  assert.equal(service?.fullName, 'Assurance OS');
  assert.equal(service?.href, '/assurance-os');

  const platform = NAV.find((item) => item.label === 'Platform');
  assert.ok(
    platform?.children?.some(
      (item) => item.label === 'Assurance OS' && item.href === '/assurance-os',
    ),
  );
  assert.ok(!JSON.stringify(NAV).includes('GRC · Assurance OS'));
});

test('buyer-facing marketing pages do not present GRC as a second product name', async () => {
  const paths = [
    '../../src/pages/products.astro',
    '../../src/pages/pricing.astro',
    '../../src/pages/contact.astro',
    '../../src/pages/about.astro',
    '../../src/pages/assurance-os.astro',
  ];

  for (const path of paths) {
    const content = await readFile(new URL(path, import.meta.url), 'utf8');
    assert.doesNotMatch(content, /\bGRC\b/);
    assert.doesNotMatch(content, /GRC\s*[·/]\s*Assurance OS/);
    assert.doesNotMatch(content, /Assurance OS\s*[·/]\s*GRC/);
  }
});
