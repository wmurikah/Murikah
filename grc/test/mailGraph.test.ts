/**
 * The pure pieces of the Outlook mail integration (Build Prompt 33): the
 * authorize URL the connect flow redirects to, the Graph message builder with
 * its plain-text fallback, the stored connection record and its transitions,
 * and the sealed state parameter the connect flow round-trips. Every module
 * under test is import-free, so node strips types and runs them directly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  authorizeUrl,
  buildGraphMessage,
  OUTLOOK_REDIRECT_URI,
  GRAPH_SCOPE,
} from '../../src/lib/grc/notify/graph.ts';
import {
  parseMailConnection,
  rotatedMailRecord,
  staleMailRecord,
  type MailConnectionRecord,
} from '../../src/lib/grc/notify/mailRecord.ts';
import { seal, open } from '../../src/lib/grc/auth/secretBox.ts';

test('the authorize URL targets the consumers endpoint with the delegated scopes', () => {
  const url = new URL(authorizeUrl('client-123', 'sealed-state'));
  assert.equal(url.origin, 'https://login.microsoftonline.com');
  assert.equal(url.pathname, '/consumers/oauth2/v2.0/authorize');
  assert.equal(url.searchParams.get('client_id'), 'client-123');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('redirect_uri'), OUTLOOK_REDIRECT_URI);
  assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.equal(url.searchParams.get('state'), 'sealed-state');
  const scope = url.searchParams.get('scope') ?? '';
  for (const part of ['offline_access', 'Mail.Send', 'openid', 'email', 'User.Read']) {
    assert.ok(scope.includes(part), `the scope must include ${part}`);
  }
  assert.equal(scope, GRAPH_SCOPE);
  assert.equal(
    OUTLOOK_REDIRECT_URI,
    'https://grc.murikah.com/api/admin/outlook/callback',
    'the redirect must match the Entra app registration exactly',
  );
});

test('the Graph message prefers HTML and falls back to plain text', () => {
  const html = buildGraphMessage({
    to: 'user@example.com',
    subject: 'Hello',
    html: '<p>Hi</p>',
    text: 'Hi',
    cc: ['cc@example.com'],
  });
  assert.equal(html.body.contentType, 'HTML');
  assert.equal(html.body.content, '<p>Hi</p>');
  assert.deepEqual(html.toRecipients, [{ emailAddress: { address: 'user@example.com' } }]);
  assert.deepEqual(html.ccRecipients, [{ emailAddress: { address: 'cc@example.com' } }]);
  assert.equal(html.replyTo[0].emailAddress.address, 'audit@hasspetroleum.com');

  const textOnly = buildGraphMessage({ to: 'user@example.com', subject: 'Hello', text: 'Hi' });
  assert.equal(textOnly.body.contentType, 'Text');
  assert.equal(textOnly.body.content, 'Hi');

  const blankHtml = buildGraphMessage({
    to: 'user@example.com',
    subject: 'Hello',
    html: '   ',
    text: 'Hi',
  });
  assert.equal(blankHtml.body.contentType, 'Text', 'blank HTML must fall back to the text body');
});

test('the connection record parses strictly and round-trips', () => {
  const record: MailConnectionRecord = {
    sealedToken: 'iv.cipher',
    address: 'hassaudit@outlook.com',
    connectedAt: '2026-08-06T10:00:00.000Z',
    status: 'ok',
    updatedAt: '2026-08-06T10:00:00.000Z',
  };
  assert.deepEqual(parseMailConnection(JSON.stringify(record)), {
    ...record,
    staleReason: undefined,
  });
  assert.equal(parseMailConnection(undefined), null);
  assert.equal(parseMailConnection(''), null);
  assert.equal(parseMailConnection('not json'), null);
  assert.equal(parseMailConnection('{}'), null, 'a record with no token is no record');
  const coerced = parseMailConnection(JSON.stringify({ sealedToken: 't', status: 'odd' }));
  assert.equal(coerced?.status, 'ok', 'an unknown status coerces to ok');
});

test('rotation renews the token and clears staleness; an auth failure marks stale', () => {
  const record: MailConnectionRecord = {
    sealedToken: 'old',
    address: 'hassaudit@outlook.com',
    connectedAt: '2026-08-06T10:00:00.000Z',
    status: 'stale',
    staleReason: 'expired',
    updatedAt: '2026-08-06T10:00:00.000Z',
  };
  const rotated = rotatedMailRecord(record, 'new-sealed', '2026-08-07T09:00:00.000Z');
  assert.equal(rotated.sealedToken, 'new-sealed');
  assert.equal(rotated.status, 'ok');
  assert.equal(rotated.staleReason, undefined);
  assert.equal(rotated.updatedAt, '2026-08-07T09:00:00.000Z');
  assert.equal(rotated.address, record.address, 'the address is kept');

  const stale = staleMailRecord(rotated, 'x'.repeat(500), '2026-08-07T10:00:00.000Z');
  assert.equal(stale.status, 'stale');
  assert.equal(stale.sealedToken, 'new-sealed', 'the token is kept for diagnosis');
  assert.equal(stale.staleReason?.length, 300, 'the reason is bounded');
});

test('the sealed state parameter round-trips and refuses tampering', async () => {
  const secret = Buffer.from('a'.repeat(32)).toString('base64');
  const state = await seal(secret, JSON.stringify({ u: 'USR-1', t: 1_754_000_000_000 }));
  assert.ok(!state.includes('USR-1'), 'the state is opaque');
  const opened = await open(secret, state);
  assert.deepEqual(JSON.parse(opened ?? ''), { u: 'USR-1', t: 1_754_000_000_000 });
  assert.equal(await open(secret, `${state}x`), null, 'a tampered box does not open');
  const other = Buffer.from('b'.repeat(32)).toString('base64');
  assert.equal(await open(other, state), null, 'another key does not open it');
});
