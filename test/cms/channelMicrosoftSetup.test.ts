import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path: string) => readFileSync(path, 'utf8');

test('Channels opens Microsoft setup instead of returning the old configuration error', () => {
  const page = read('src/pages/cms/app/administration/channels.astro');
  const connect = read('src/pages/cms/api/admin/channels/microsoft/connect.ts');

  assert.match(page, /title="Microsoft 365 setup"/);
  assert.match(page, /Application \(client\) ID/);
  assert.match(page, /Client secret/);
  assert.match(page, /Redirect URI/);
  assert.match(page, /data-cms-modal-open="cms-microsoft-settings"/);
  assert.match(connect, /loadMicrosoftConfig/);
  assert.match(connect, /setup=microsoft/);
  assert.doesNotMatch(connect, /existing Microsoft application credentials are required/);
});

test('Microsoft provider secret is sealed before database storage', () => {
  const route = read('src/pages/cms/api/admin/channels/microsoft/settings.ts');
  const settings = read('src/lib/cms/channels/providerSettings.ts');

  assert.match(route, /sealChannelSecret/);
  assert.match(route, /sealed_client_secret/);
  assert.match(settings, /openChannelSecret/);
  assert.match(settings, /channel_provider_settings/);
});
