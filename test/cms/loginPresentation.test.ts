import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const login = readFileSync('src/pages/cms/login.astro', 'utf8');
const providers = readFileSync('src/components/cms/CmsAuthProviders.astro', 'utf8');
const authLayout = readFileSync('src/layouts/CmsAuthLayout.astro', 'utf8');
const appLayout = readFileSync('src/layouts/CmsLayout.astro', 'utf8');
const portalLayout = readFileSync('src/layouts/CmsPortalLayout.astro', 'utf8');
const cmsTheme = readFileSync('src/styles/cms.css', 'utf8');

test('login keeps the task first and removes redundant welcome copy', () => {
  assert.doesNotMatch(login, />\s*HASS Petroleum\s*</);
  assert.doesNotMatch(login, /Sign in to customer operations\./);
  assert.ok(
    login.indexOf('<form id="cms-login-form"') <
      login.indexOf('<CmsAuthProviders purpose="SIGN_IN" apple'),
  );
  assert.match(login, /label="Work email"/);
});

test('login does not reserve dead space for an error that is not present', () => {
  assert.match(login, /data-\[empty\]:hidden/);
  assert.doesNotMatch(login, /<div class="min-h-14">/);
  assert.match(login, /errorBox\.toggleAttribute\('data-empty', !message\)/);
});

test('identity providers use familiar branded marks in the requested order', () => {
  assert.ok(providers.indexOf("key: 'google'") < providers.indexOf("key: 'microsoft'"));
  assert.ok(providers.indexOf("key: 'microsoft'") < providers.indexOf("key: 'apple'"));
  assert.match(providers, /#4285F4/);
  assert.match(providers, /#34A853/);
  assert.match(providers, /#F25022/);
  assert.match(providers, /#00A4EF/);
  assert.match(providers, /Sign in with \{provider\.label\}/);
});

test('the whole CMS uses the richer Hass blue and the same 80 percent default density', () => {
  assert.match(cmsTheme, /--color-cms-royal:\s*#002169/);
  assert.match(cmsTheme, /--color-cms-royal-deep:\s*#00184f/);
  assert.match(cmsTheme, /zoom:\s*0\.8/);

  for (const layout of [authLayout, appLayout, portalLayout]) {
    assert.match(layout, /import '@\/styles\/cms\.css';/);
    assert.match(layout, /class="cms-shell h-full"/);
  }

  assert.doesNotMatch(authLayout, /\.auth-shell\s*\{\s*--color-cms-royal/);
  assert.match(authLayout, /linear-gradient\(145deg, var\(--color-cms-royal\)/);
});
