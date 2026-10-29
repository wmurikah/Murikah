import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

import { AUDIENCE, PRICING, STANDARDS } from '../../src/site.config.ts';

test('public proof uses standards, not personal credentials', async () => {
  assert.equal(STANDARDS.length, 3);
  for (const file of ['src/pages/index.astro', 'src/pages/about.astro', 'src/pages/proof/report-extract.astro', 'src/lib/schema.ts', 'public/llms.txt']) {
    const text = await readFile(new URL('../../' + file, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /FOUNDER|Wilberforce|founder:|founder-led|Murikah's founder/);
  }
});

test('homepage proof links to a quantified redacted report extract', async () => {
  const home = await readFile(new URL('../../src/pages/index.astro', import.meta.url), 'utf8');
  const report = await readFile(
    new URL('../../src/pages/proof/report-extract.astro', import.meta.url),
    'utf8',
  );

  assert.match(home, /Results from earlier audit work/);
  assert.match(home, /\/proof\/report-extract/);
  assert.match(report, />93</);
  assert.match(report, />11</);
  assert.match(report, />5</);
  assert.match(report, /No unsupported claim about hours or days saved/);
  assert.match(report, /Client identity redacted/);
});

test('priority audiences have dedicated home-page paths', async () => {
  const saccos = AUDIENCE.find((segment) => segment.name === 'SACCOs');
  const banks = AUDIENCE.find((segment) => segment.name === 'Banks and microfinance');

  assert.equal(saccos?.href, '/saccos');
  assert.equal(banks?.href, '/banks');

  await access(new URL('../../src/pages/saccos.astro', import.meta.url));
  await access(new URL('../../src/pages/banks.astro', import.meta.url));

  const home = await readFile(new URL('../../src/pages/index.astro', import.meta.url), 'utf8');
  assert.match(home, /<AudienceCard/);
});

test('software and services FAQ answers the question in the first sentence', async () => {
  const services = await readFile(
    new URL('../../src/pages/services.astro', import.meta.url),
    'utf8',
  );

  assert.match(services, /question: 'Can we use the software and services separately\?'/);
  assert.match(services, /answer:\s*\n\s*'Yes\./);
});

test('pricing publishes usable ranges and the variables that change price', async () => {
  assert.equal(PRICING[0]?.price, 'KES 15,000 to 35,000');
  assert.equal(PRICING[1]?.price, 'KES 45,000 to 120,000');
  assert.equal(PRICING[2]?.price, 'From KES 150,000');

  const pricing = await readFile(
    new URL('../../src/pages/pricing.astro', import.meta.url),
    'utf8',
  );
  const assurance = await readFile(
    new URL('../../src/pages/assurance-os.astro', import.meta.url),
    'utf8',
  );

  assert.match(pricing, /Assurance OS starts at KES 15,000 per month/);
  assert.match(pricing, /users, entities, onboarding or migration, support needs/);
  assert.match(pricing, /What changes the price\?/);
  assert.doesNotMatch(pricing, /validated on enquiry/i);
  assert.doesNotMatch(assurance, /validated on enquiry/i);
});

test('organization structured data excludes personal profiles', async () => {
  const schema = await readFile(new URL('../../src/lib/schema.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(schema, /founder:|FOUNDER|scholarUrl/);
});
