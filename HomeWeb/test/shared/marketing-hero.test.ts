import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import test from 'node:test';
import { HOME_HERO } from '../../src/data/homeHero.ts';
import { TRUST } from '../../src/data/trust.ts';

test('hero gives the audit proposition, a call and a sample-data route', () => {
  assert.equal(HOME_HERO.headline.join(' '), 'Audit you can trace. From plan to board pack.');
  assert.match(HOME_HERO.body, /Boards and regulators now ask for evidence/);
  assert.equal(HOME_HERO.primary.href, '/contact?intent=call');
  assert.equal(HOME_HERO.secondary.href, '/assurance-os/sandbox');
  assert.equal(TRUST.caption, 'Work aligned to:');
  assert.equal(TRUST.logos.length, 0);
});

test('real sandbox captures stay within the image budget', async () => {
  for (const stage of [
    'hero',
    'plan',
    'fieldwork',
    'review',
    'findings',
    'remediation',
    'report',
  ]) {
    const image = new URL(`../../public/images/assurance-os/${stage}.webp`, import.meta.url);
    assert.ok((await stat(image)).size < 150_000, stage + ' exceeds 150 KB');
    const bytes = await readFile(image);
    assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
    assert.equal(bytes.toString('ascii', 8, 12), 'WEBP');
  }
});
