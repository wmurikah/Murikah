import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';

const routes = [
  { key: 'home', route: '/' },
  { key: 'assurance-os', route: '/assurance-os' },
  { key: 'insights', route: '/insights' },
];

const rows = [];
for (const item of routes) {
  const production = JSON.parse(
    await readFile(new URL('./lighthouse/production-' + item.key + '.json', import.meta.url), 'utf8'),
  );
  const candidate = JSON.parse(
    await readFile(new URL('./lighthouse/candidate-' + item.key + '.json', import.meta.url), 'utf8'),
  );

  const before = Math.round((production.categories.performance.score ?? 0) * 100);
  const after = Math.round((candidate.categories.performance.score ?? 0) * 100);
  const delta = after - before;
  rows.push({ route: item.route, production: before, candidate: after, delta });

  assert.ok(after >= 90, item.route + ' candidate Lighthouse Performance must be at least 90; got ' + after);
  assert.ok(
    after >= before - 1,
    item.route + ' Performance regressed beyond the 1-point Lighthouse noise allowance: ' +
      before + ' -> ' + after,
  );
}

const markdown = [
  '# Header Lighthouse comparison',
  '',
  'Mobile Lighthouse Performance. A one-point allowance is used for run-to-run measurement noise.',
  '',
  '| Route | Production | Candidate | Delta |',
  '| --- | ---: | ---: | ---: |',
  ...rows.map((row) =>
    '| ' + row.route + ' | ' + row.production + ' | ' + row.candidate + ' | ' +
    (row.delta >= 0 ? '+' : '') + row.delta + ' |',
  ),
  '',
].join('\n');

await writeFile(new URL('./lighthouse-summary.md', import.meta.url), markdown);
console.log(markdown);
