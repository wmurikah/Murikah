import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  clearSessionCookies,
  createSessionCookie,
  GRC_SESSION_COOKIE,
  GRC_SESSION_COOKIE_LEGACY,
} from '../src/lib/grc/auth/session.ts';

const source = (path: string): string =>
  readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

function astroFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? astroFiles(path) : entry.name.endsWith('.astro') ? [path] : [];
  });
}

test('layouts opt into OS text scaling and use a relative base type scale', () => {
  assert.match(source('src/layouts/GrcLayout.astro'), /name="text-scale" content="scale"/);
  assert.match(source('src/layouts/GrcAuthLayout.astro'), /name="text-scale" content="scale"/);
  const css = source('src/styles/grc.css');
  assert.match(css, /--grc-fs-body:\s*1rem/);
  assert.doesNotMatch(css, /--grc-fs-(?:body|small|caption|micro|h1|h2):\s*[\d.]+px/);
});

test('mobile drawer contains focus and makes page content inert', () => {
  const layout = source('src/layouts/GrcLayout.astro');
  assert.match(layout, /main\.inert = open/);
  assert.match(layout, /e\.key === 'Tab'/);
  assert.match(layout, /target\?\.focus/);
  assert.match(layout, /e\.key !== 'Escape'/);
});

test('data-table headers declare scope and scroll regions are keyboard reachable', () => {
  for (const file of astroFiles(new URL('../src', import.meta.url).pathname)) {
    const body = readFileSync(file, 'utf8');
    for (const tag of body.matchAll(/<th\b[^>]*>/g)) {
      assert.match(tag[0], /\bscope=/, `${file} contains an unscoped ${tag[0]}`);
    }
    for (const tag of body.matchAll(/<div\b[^>]*class="[^"]*grc-tablewrap[^"]*"[^>]*>/g)) {
      assert.match(tag[0], /\btabindex="0"/, `${file} contains an unfocusable table region`);
      assert.match(tag[0], /\brole="region"/, `${file} does not expose the table region`);
      assert.match(tag[0], /\baria-label=/, `${file} does not name the table region`);
    }
  }
});

test('worker applies the browser security-header baseline', () => {
  const worker = source('src/worker.ts');
  for (const header of [
    'content-security-policy-report-only',
    'strict-transport-security',
    'x-content-type-options',
    'x-frame-options',
    'referrer-policy',
    'permissions-policy',
  ]) {
    assert.ok(worker.includes(header), `missing ${header}`);
  }
});

test('shell database extras are lazy and login exposes accessible recovery controls', () => {
  const layout = source('src/layouts/GrcLayout.astro');
  assert.doesNotMatch(layout, /await getSidebarCounts/);
  assert.doesNotMatch(layout, /await Promise\.all\(\[\s*listRoleCodes/);
  assert.match(layout, /fetch\('\/api\/sidebar-counts'/);
  assert.match(layout, /fetch\('\/api\/role-preview\/options'/);

  const login = source('src/pages/grc/login.astro');
  assert.match(login, /aria-describedby=\{failed \? 'login-error'/);
  assert.match(login, /spellcheck="false"/);
  assert.match(login, /class="grc-password-toggle"/);
});

test('production sessions use __Host cookies and logout clears the legacy name', async () => {
  const key = btoa('01234567890123456789012345678901');
  const production = await createSessionCookie('session-id', key, true);
  const local = await createSessionCookie('session-id', key, false);
  assert.match(production, new RegExp(`^${GRC_SESSION_COOKIE}=`));
  assert.match(production, /; Secure;/);
  assert.match(local, new RegExp(`^${GRC_SESSION_COOKIE_LEGACY}=`));
  const cleared = clearSessionCookies(true).join('\n');
  assert.ok(cleared.includes(`${GRC_SESSION_COOKIE}=`));
  assert.ok(cleared.includes(`${GRC_SESSION_COOKIE_LEGACY}=`));
  assert.match(source('src/pages/grc/api/auth/logout.ts'), /clear-site-data/);
});
