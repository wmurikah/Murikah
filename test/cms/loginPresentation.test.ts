import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const login = readFileSync('src/pages/cms/login.astro', 'utf8');
const providers = readFileSync('src/components/cms/CmsAuthProviders.astro', 'utf8');
const layout = readFileSync('src/layouts/CmsAuthLayout.astro', 'utf8');

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

test('authentication shell uses the richer Hass blue without changing the global CMS palette', () => {
  assert.match(layout, /--color-cms-royal:\s*#002169/);
  assert.match(layout, /linear-gradient\(145deg, #002169/);
});
