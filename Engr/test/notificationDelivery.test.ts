import assert from 'node:assert/strict';
import test from 'node:test';
import { emailChannel } from '../src/lib/engr/notify/channels/email-resend.ts';
import { smsChannel } from '../src/lib/engr/notify/channels/sms-africastalking.ts';
import type { DeliveryEnv } from '../src/lib/engr/notify/env.ts';
import type {
  DeliveryRecipient,
  OutboundNotification,
} from '../src/lib/engr/notify/channels/types.ts';

const notification: OutboundNotification = {
  id: 'n1',
  orgId: 'org1',
  channel: 'EMAIL',
  subject: 'Work assigned',
  body: 'A work order is ready.',
  templateKey: 'work.assigned',
  entityType: 'work_order',
  entityId: 'wo1',
};
const recipient: DeliveryRecipient = {
  name: 'Engineer',
  email: 'engineer@example.com',
  phone: '+254700000000',
};
const disabled: DeliveryEnv = {
  mode: 'other',
  at: null,
  email: null,
  cronSecret: null,
  webhookSecret: null,
};

test('unconfigured email is deferred without contacting a provider', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error('provider must not be contacted');
  };
  try {
    assert.deepEqual(await emailChannel.send(notification, recipient, disabled), {
      outcome: 'deferred',
      message: 'email delivery is not configured',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('unconfigured SMS is deferred without contacting a provider', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error('provider must not be contacted');
  };
  try {
    assert.deepEqual(await smsChannel.send(notification, recipient, disabled), {
      outcome: 'deferred',
      message: 'SMS delivery is not configured',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Resend HTTP acceptance is sent even if its optional response JSON is empty', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('', { status: 202 });
  try {
    assert.deepEqual(
      await emailChannel.send(notification, recipient, {
        ...disabled,
        mode: 'production',
        email: { apiKey: 'test-key', from: 'Engineering <test@example.com>' },
      }),
      { outcome: 'sent', providerId: undefined },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
