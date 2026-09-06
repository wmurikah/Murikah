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
  assert.doesNotMatch(source, /Meta pairing is not enabled yet/);
});

test('WhatsApp pairing is an active guided Meta Embedded Signup flow', () => {
  const page = read('src/pages/cms/app/administration/channels.astro');
  const settings = read('src/pages/cms/api/admin/channels/meta/settings.ts');
  const complete = read('src/pages/cms/api/admin/channels/meta/complete.ts');
  const meta = read('src/lib/cms/channels/meta.ts');

  assert.match(page, /id="cms-meta-settings"/);
  assert.match(page, /Meta App ID/);
  assert.match(page, /Embedded Signup configuration ID/);
  assert.match(page, /data-whatsapp-pair/);
  assert.match(page, /whatsapp_business_app_onboarding/);
  assert.match(page, /connect\.facebook\.net\/en_US\/sdk\.js/);
  assert.doesNotMatch(page, /<CmsButton variant="primary" disabled>\s*Pair with QR/);

  assert.match(settings, /provider = 'META'/);
  assert.match(settings, /sealChannelSecret/);
  assert.match(complete, /exchangeMetaCode/);
  assert.match(complete, /saveMetaChannel/);
  assert.match(meta, /subscribed_apps/);
  assert.match(meta, /v26\.0/);
});

test('channel administration accepts dedicated RBAC and existing super-admin access', () => {
  const source = read('src/lib/cms/channels/access.ts');

  assert.match(source, /ADMIN\.CHANNELS\.MANAGE/);
  assert.match(source, /ADMIN\.USERS\.MANAGE/);
  assert.match(source, /permissions\.includes\(CHANNELS_MANAGE\)/);
  assert.match(source, /permissions\.includes\(LEGACY_ADMIN_MANAGE\)/);
});

test('connections can be disconnected without restoring the legacy form', () => {
  const source = read('src/pages/cms/api/admin/channels/disconnect.ts');

  assert.match(source, /requireChannelsManage/);
  assert.match(source, /disconnectChannelPurpose/);
  assert.match(source, /channelCredentialsReady/);
});
