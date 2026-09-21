import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import test from 'node:test';

async function filesUnder(url: URL): Promise<URL[]> {
  const entries = await readdir(url, { withFileTypes: true });
  const out: URL[] = [];
  for (const entry of entries) {
    const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), url);
    if (entry.isDirectory()) out.push(...(await filesUnder(child)));
    else if (/\.(?:ts|tsx)$/.test(entry.name)) out.push(child);
  }
  return out;
}

test('sandbox seed meets the required fictional portfolio scale', async () => {
  const seed = new URL('../../src/sandbox/seed/', import.meta.url);
  const parse = async (name: string) => JSON.parse(await readFile(new URL(name, seed), 'utf8'));

  const users = await parse('users.json');
  const engagements = await parse('engagements.json');
  const findings = await parse('findings.json');
  const actions = await parse('actionPlans.json');
  const workPapers = await parse('workPapers.json');
  const risks = await parse('risks.json');
  const log = await parse('auditLog.json');

  assert.equal(engagements.length, 12);
  assert.equal(findings.length, 40);
  assert.equal(actions.length, 55);
  assert.equal(workPapers.length, 80);
  assert.equal(risks.length, 25);
  assert.ok(log.length >= 300);
  assert.equal(workPapers.reduce((sum: number, row: { evidence: unknown[] }) => sum + row.evidence.length, 0), 360);
  assert.ok(workPapers.every((row: { evidence: unknown[] }) => row.evidence.length >= 3 && row.evidence.length <= 6));
  assert.ok(users.every((user: { email: string }) => user.email.endsWith('@kilima.example')));
  assert.equal(engagements.some((item: { title: string }) => item.title === 'Identity and access management review'), true);
  assert.equal(actions.filter((item: { status: string }) => item.status === 'Overdue').length >= 6, true);
});

test('sandbox source makes no external network calls and has no live Assurance OS link', async () => {
  const roots = [
    new URL('../../src/sandbox/', import.meta.url),
    new URL('../../src/components/assurance-os/sandbox/', import.meta.url),
  ];
  const files = (await Promise.all(roots.map(filesUnder))).flat();
  files.push(new URL('../../src/components/assurance-os/PublicSandbox.tsx', import.meta.url));

  const joined = (await Promise.all(files.map(async (url) => {
    await stat(url);
    return readFile(url, 'utf8');
  }))).join('\n');

  assert.doesNotMatch(joined, /\bfetch\s*\(/);
  assert.doesNotMatch(joined, /XMLHttpRequest/);
  assert.doesNotMatch(joined, /\bWebSocket\b/);
  assert.doesNotMatch(joined, /grc\.murikah\.com/);
  assert.doesNotMatch(joined, /https?:\/\//);
});

test('sandbox page lazy-loads one island and is indexable without snippetting app data', async () => {
  const page = await readFile(new URL('../../src/pages/assurance-os/sandbox.astro', import.meta.url), 'utf8');
  const app = await readFile(new URL('../../src/components/assurance-os/PublicSandbox.tsx', import.meta.url), 'utf8');

  assert.match(page, /Try Assurance OS with sample data/);
  assert.match(page, /client:visible/);
  assert.doesNotMatch(page, /client:load/);
  assert.match(page, /name="robots" content="index,follow"/);
  assert.match(page, /data-nosnippet/);
  assert.match(app, /data-nosnippet/);
  assert.match(app, /React|lazy\(/);
  assert.match(app, /Nothing you type leaves your browser/);
  assert.match(app, /Open full screen/);
  assert.doesNotMatch(page + app, /grc\.murikah\.com/);
});
