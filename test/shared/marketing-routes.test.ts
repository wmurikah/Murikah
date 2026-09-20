import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

import { NAV, SERVICES } from '../../src/site.config.ts';

const routes = [
  {
    label: 'Assurance OS',
    from: '/audit-os',
    to: '/assurance-os',
    file: 'assurance-os.astro',
  },
  {
    label: 'Internal audit',
    from: '/assurance',
    to: '/internal-audit',
    file: 'internal-audit.astro',
  },
  {
    label: 'Automation',
    from: '/labs',
    to: '/automation',
    file: 'automation.astro',
  },
  {
    label: 'Training',
    from: '/academy',
    to: '/training',
    file: 'training.astro',
  },
  {
    label: 'Research',
    from: '/intelligence',
    to: '/research',
    file: 'research.astro',
  },
] as const;

test('service labels use matching canonical URLs', () => {
  for (const route of routes) {
    assert.equal(SERVICES.find((service) => service.name === route.label)?.href, route.to);
  }

  const navHrefs = NAV.flatMap((item) => [
    item.href,
    ...(item.children?.map((child) => child.href) ?? []),
  ]);

  for (const route of routes) {
    assert.ok(navHrefs.includes(route.to), `navigation is missing ${route.to}`);
    assert.ok(
      !navHrefs.includes(route.from),
      `navigation still links to legacy route ${route.from}`,
    );
  }
});

test('canonical pages preserve label-to-title information scent', async () => {
  for (const route of routes) {
    const page = await readFile(new URL(`../../src/pages/${route.file}`, import.meta.url), 'utf8');
    assert.ok(
      page.includes(`metaTitle="${route.label}`),
      `${route.to} title no longer starts with ${route.label}`,
    );
  }
});

test('canonical service page files exist and legacy page files are removed', async () => {
  for (const route of routes) {
    await access(new URL(`../../src/pages/${route.file}`, import.meta.url));
  }

  for (const legacy of [
    'audit-os.astro',
    'assurance.astro',
    'labs.astro',
    'academy.astro',
    'intelligence.astro',
  ]) {
    await assert.rejects(access(new URL(`../../src/pages/${legacy}`, import.meta.url)));
  }
});

test('legacy service URLs have explicit permanent redirects', async () => {
  const config = await readFile(new URL('../../astro.config.ts', import.meta.url), 'utf8');

  for (const route of routes) {
    assert.ok(
      config.includes(`'${route.from}': { status: 301, destination: '${route.to}' }`),
      `missing 301 redirect from ${route.from} to ${route.to}`,
    );
  }
});
