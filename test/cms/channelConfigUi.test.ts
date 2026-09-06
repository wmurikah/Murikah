import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path: string) => readFileSync(path, 'utf8');

test('channels administration uses the new communication setup workspace', () => {
  const source = read('src/pages/cms/app/administration/channels.astro');

  assert.match(source, /title="Channels & communications"/);
  assert.match(source, /title="Notification email"/);
  assert.match(source, /title="Inquiry email"/);
  assert.match(source, /title="WhatsApp"/);
  assert.match(source, /Connect Microsoft/);
  assert.match(source, /Pair with QR/);
  assert.match(source, /Role-based access/);
  assert.match(source, /\/app\/administration\/roles/);

  assert.doesNotMatch(source, /Add a connection/);
  assert.doesNotMatch(source, /Name of the stored secret/);
  assert.doesNotMatch(source, /cms-channel-form/);
  assert.doesNotMatch(source, /autoCreateCase/);
});

test('channel administration accepts dedicated RBAC and existing super-admin access', () => {
  const source = read('src/lib/cms/channels/access.ts');

  assert.match(source, /ADMIN\.CHANNELS\.MANAGE/);
  assert.match(source, /ADMIN\.USERS\.MANAGE/);
  assert.match(source, /permissions\.includes\(CHANNELS_MANAGE\)/);
  assert.match(source, /permissions\.includes\(LEGACY_ADMIN_MANAGE\)/);
});

test('email connections can be disconnected without restoring the legacy form', () => {
  const source = read('src/pages/cms/api/admin/channels/disconnect.ts');

  assert.match(source, /requireChannelsManage/);
  assert.match(source, /disconnectChannelPurpose/);
  assert.match(source, /channelCredentialsReady/);
});
