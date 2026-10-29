import test from 'node:test';
import assert from 'node:assert/strict';
import { canManageAi, AI_MANAGE } from '../../src/lib/cms/ai/access.ts';
import { callModel } from '../../src/lib/cms/ai/model.ts';
import {
  approvedAiProviderPolicy,
  canonicalAiProviderFields,
  providerConfigurationApproved,
} from '../../src/lib/cms/ai/security.ts';
import type { AiProvider } from '../../src/lib/cms/ai/providers.ts';

const request = {
  system: 'Reply OK.',
  messages: [{ role: 'user' as const, content: 'OK' }],
};

const provider = (over: Partial<AiProvider> = {}): AiProvider => ({
  aiProviderId: 'AIP-SECURITY',
  providerName: 'Security test',
  providerType: 'OPENAI',
  baseUrl: null,
  model: 'gpt-test',
  secretName: 'OPENAI_API_KEY',
  maxOutputTokens: 8,
  temperature: null,
  purpose: 'BOTH',
  active: true,
  lastVerifiedAt: null,
  lastVerifyStatus: null,
  ...over,
});

test('CY-01: provider type owns its credential name and destination', () => {
  assert.deepEqual(canonicalAiProviderFields('OPENAI'), {
    secretName: 'OPENAI_API_KEY',
    baseUrl: null,
  });
  assert.equal(approvedAiProviderPolicy('OPENAI')?.endpoint, 'https://api.openai.com/v1/chat/completions');
  assert.equal(approvedAiProviderPolicy('ANTHROPIC')?.secretName, 'ANTHROPIC_API_KEY');
  assert.equal(approvedAiProviderPolicy('OTHER'), null);
  assert.equal(approvedAiProviderPolicy('AZURE_OPENAI'), null);
  assert.equal(approvedAiProviderPolicy('GOOGLE'), null);
});

test('CY-01: user administration does not imply AI administration', () => {
  assert.equal(canManageAi(['ADMIN.USERS.MANAGE']), false);
  assert.equal(canManageAi([AI_MANAGE]), true);
});

test('CY-01: a malicious stored row cannot select another Worker secret or host', async () => {
  const malicious = provider({
    secretName: 'CMS_SESSION_SECRET',
    baseUrl: 'https://attacker.example/collect',
  });
  assert.equal(providerConfigurationApproved(malicious), false);

  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error('network must not be reached');
  }) as typeof fetch;

  try {
    const answer = await callModel(
      malicious,
      {
        CMS_SESSION_SECRET: 'must-never-leave-the-worker',
        TURSO_AUTH_TOKEN: 'must-never-leave-the-worker-either',
      },
      request,
    );
    assert.equal(answer.status, 'ERROR');
    assert.equal(fetchCalls, 0, 'security policy refuses before any outbound request');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('CY-01: an approved provider with no approved key fails before network access', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error('network must not be reached');
  }) as typeof fetch;

  try {
    const answer = await callModel(provider(), { CMS_SESSION_SECRET: 'present' }, request);
    assert.equal(answer.status, 'UNAUTHORISED');
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
