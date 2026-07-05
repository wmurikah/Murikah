/**
 * The pure heart of the AI module: the non-AI SMART fallback, the JSON extractor,
 * the key masking and disclaimer, and the per-provider request building and
 * response parsing. All modules under test import only types, so node strips them
 * and runs them directly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateSmartBasic,
  extractJson,
  maskKey,
  AI_DISCLAIMER,
} from '../../src/lib/grc/ai/validation.ts';
import { buildRequest, parseResponse } from '../../src/lib/grc/ai/providers.ts';
import { validateActionPlanPrompt, workPaperInsightsPrompt } from '../../src/lib/grc/ai/prompts.ts';

const NOW = new Date('2026-07-05T00:00:00Z');

test('maskKey shows only a short tail', () => {
  assert.equal(maskKey('sk-abcdef1234'), '****1234');
  assert.equal(maskKey(null), 'Not set');
  assert.equal(maskKey(''), 'Not set');
  assert.equal(maskKey('abc'), '****');
});

test('the disclaimer states the output is advisory', () => {
  assert.match(AI_DISCLAIMER, /advisory/i);
  assert.match(AI_DISCLAIMER, /professional judgement/i);
});

test('SMART fallback: a specific, owned, future, actionable plan scores 100', () => {
  const r = validateSmartBasic(
    {
      description: 'Implement a quarterly user access review across all affiliates.',
      ownerCount: 1,
      dueDate: '2026-12-01',
    },
    NOW,
  );
  assert.equal(r.score, 100);
  assert.equal(r.isValid, true);
  assert.equal(r.issues.length, 0);
  assert.equal(r.strengths.length, 4);
});

test('SMART fallback: a brief, ownerless, past, verbless plan scores 0 with four issues', () => {
  const r = validateSmartBasic({ description: 'fix', ownerCount: 0, dueDate: '2020-01-01' }, NOW);
  assert.equal(r.score, 0);
  assert.equal(r.isValid, false);
  assert.equal(r.issues.length, 4);
});

test('extractJson pulls the object out of surrounding prose', () => {
  const parsed = extractJson<{ score: number }>('Here you go: {"score": 80} thanks');
  assert.equal(parsed?.score, 80);
  assert.equal(extractJson('no json here'), null);
});

test('buildRequest shapes each provider correctly', () => {
  const opts = { model: 'm', maxTokens: 500, temperature: 0.3 };
  const openai = buildRequest('openai', 'KEY', 'sys', 'hi', opts);
  assert.match(openai.url, /openai\.com\/v1\/chat\/completions/);
  assert.equal(openai.headers.authorization, 'Bearer KEY');
  assert.match(openai.body, /"messages"/);

  const anthropic = buildRequest('anthropic', 'KEY', 'sys', 'hi', opts);
  assert.match(anthropic.url, /anthropic\.com\/v1\/messages/);
  assert.equal(anthropic.headers['x-api-key'], 'KEY');
  assert.equal(anthropic.headers['anthropic-version'], '2023-06-01');

  const google = buildRequest('google', 'KEY', 'sys', 'hi', opts);
  assert.match(google.url, /generativelanguage\.googleapis\.com.*generateContent\?key=KEY/);
  assert.match(google.body, /"contents"/);
});

test('parseResponse reads content and usage for each provider', () => {
  const o = parseResponse('openai', {
    choices: [{ message: { content: 'A' } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
  assert.equal(o.content, 'A');
  assert.deepEqual(o.usage, { promptTokens: 10, completionTokens: 5, totalTokens: 15 });

  const a = parseResponse('anthropic', {
    content: [{ text: 'B1' }, { text: 'B2' }],
    usage: { input_tokens: 7, output_tokens: 3 },
  });
  assert.equal(a.content, 'B1B2');
  assert.deepEqual(a.usage, { promptTokens: 7, completionTokens: 3, totalTokens: 10 });

  const g = parseResponse('google', {
    candidates: [{ content: { parts: [{ text: 'C' }] } }],
    usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, totalTokenCount: 6 },
  });
  assert.equal(g.content, 'C');
  assert.deepEqual(g.usage, { promptTokens: 4, completionTokens: 2, totalTokens: 6 });
});

test('prompts ask for the right shape', () => {
  const v = validateActionPlanPrompt({
    description: 'Do a thing',
    dueDate: '2026-12-01',
    owners: 'Ann',
    observationTitle: 'Weak control',
  });
  assert.match(v, /SMART/);
  assert.match(v, /JSON/);
  const w = workPaperInsightsPrompt({
    reference: 'WP-1',
    title: 'T',
    description: 'D',
    riskRating: 'HIGH',
    recommendation: 'R',
    affiliate: 'A',
    auditArea: 'Finance',
  });
  assert.match(w, /WP-1/);
  assert.match(w, /Root cause/i);
});
