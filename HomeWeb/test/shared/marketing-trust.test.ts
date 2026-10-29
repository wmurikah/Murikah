import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

import { AUDIENCE, FOUNDER, PRICING } from '../../src/site.config.ts';

test('founder proof exposes the requested credentials and research evidence', () => {
  assert.equal(FOUNDER.name, 'Wilberforce L. Murikah');
  assert.deepEqual(FOUNDER.credentials, [
    'CISA',
    'ISO/IEC 27001:2022 Lead Auditor',
    'ISO/IEC 42001:2023 Lead Auditor',
  ]);
  assert.match(FOUNDER.research, /peer-reviewed research/i);
  assert.ok(FOUNDER.papers.length >= 2);
  assert.ok(FOUNDER.scholarUrl.startsWith('https://scholar.google.com/'));
});

test('homepage proof links to a quantified redacted report extract', async () => {
  const home = await readFile(new URL('../../src/pages/index.astro', import.meta.url), 'utf8');
  const report = await readFile(
    new URL('../../src/pages/proof/report-extract.astro', import.meta.url),
    'utf8',
  );

  assert.match(home, /Anonymised prior assurance programme/);
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
  assert.match(home, /segment\.href/);
  assert.match(home, /View your path/);
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

test('organization structured data names the founder', async () => {
  const schema = await readFile(new URL('../../src/lib/schema.ts', import.meta.url), 'utf8');
  assert.match(schema, /founder:\s*\{/);
  assert.match(schema, /name: FOUNDER\.name/);
  assert.match(schema, /sameAs: \[FOUNDER\.scholarUrl\]/);
});
