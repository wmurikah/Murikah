/**
 * The unified AI call, ported from 05_AIService.gs callAI. It routes to the
 * configured active provider (a fetch from the Worker), returns the content and
 * token usage, and logs an ai_invocations row for every call (ensuring the
 * ai_providers parent row exists first). The API key comes from Worker secrets;
 * when the active provider is disabled or unconfigured the call returns an error
 * without contacting a provider, and the feature layer falls back. Column names
 * follow grc/docs/schema-assumptions.md.
 */
import type { Client } from '@libsql/client/web';
import {
  buildRequest,
  parseResponse,
  DEFAULT_MODELS,
  type AiUsage,
  type CallOptions,
  type Provider,
} from './providers';
import { aiKeyFor } from './env';
import { loadAiConfig } from './config';

export interface CallContext {
  organizationId: string;
  userId: string;
  purpose: string;
  relatedEntityType?: string | null;
  relatedEntityId?: string | null;
}

export interface CallResult {
  ok: boolean;
  content: string;
  usage: AiUsage;
  provider: Provider;
  model: string;
  error?: string;
}

const ZERO: AiUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

async function ensureProvider(
  db: Client,
  organizationId: string,
  provider: Provider,
): Promise<void> {
  try {
    await db.execute({
      sql: `INSERT INTO ai_providers (provider_id, organization_id, provider, created_at)
            SELECT ?, ?, ?, ?
             WHERE NOT EXISTS (SELECT 1 FROM ai_providers
                                WHERE organization_id = ? AND provider = ?)`,
      args: [
        crypto.randomUUID(),
        organizationId,
        provider,
        new Date().toISOString(),
        organizationId,
        provider,
      ],
    });
  } catch {
    // best-effort: the invocation log is not worth failing the call over.
  }
}

async function logInvocation(
  db: Client,
  ctx: CallContext,
  provider: Provider,
  model: string,
  usage: AiUsage,
  success: boolean,
): Promise<void> {
  try {
    await ensureProvider(db, ctx.organizationId, provider);
    await db.execute({
      sql: `INSERT INTO ai_invocations
              (invocation_id, organization_id, user_id, provider, model, purpose,
               related_entity_type, related_entity_id, prompt_tokens, completion_tokens,
               total_tokens, success, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        crypto.randomUUID(),
        ctx.organizationId,
        ctx.userId,
        provider,
        model,
        ctx.purpose,
        ctx.relatedEntityType ?? null,
        ctx.relatedEntityId ?? null,
        usage.promptTokens,
        usage.completionTokens,
        usage.totalTokens,
        success ? 1 : 0,
        new Date().toISOString(),
      ],
    });
  } catch {
    // best-effort logging.
  }
}

export interface CallOverrides {
  systemPrompt?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

/** Route a prompt to the active provider, log the invocation, and return the content and usage. */
export async function callAI(
  db: Client,
  ctx: CallContext,
  prompt: string,
  overrides: CallOverrides = {},
): Promise<CallResult> {
  const config = await loadAiConfig(db);
  const provider = config.activeProvider;
  const model = overrides.model ?? config.model;
  const apiKey = aiKeyFor(provider);

  if (!apiKey || !config.enabled[provider]) {
    await logInvocation(db, ctx, provider, model, ZERO, false);
    return {
      ok: false,
      content: '',
      usage: ZERO,
      provider,
      model,
      error: 'The active AI provider is not configured or is disabled.',
    };
  }

  const opts: CallOptions = {
    model,
    maxTokens: overrides.maxTokens ?? config.maxTokens,
    temperature: overrides.temperature ?? config.temperature,
  };
  const req = buildRequest(
    provider,
    apiKey,
    overrides.systemPrompt ?? config.systemPrompt,
    prompt,
    opts,
  );

  try {
    const res = await fetch(req.url, { method: 'POST', headers: req.headers, body: req.body });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      await logInvocation(db, ctx, provider, model, ZERO, false);
      return {
        ok: false,
        content: '',
        usage: ZERO,
        provider,
        model,
        error: `${provider} ${res.status}: ${text.slice(0, 200)}`,
      };
    }
    const json = (await res.json()) as unknown;
    const parsed = parseResponse(provider, json);
    await logInvocation(db, ctx, provider, model, parsed.usage, true);
    return { ok: true, content: parsed.content, usage: parsed.usage, provider, model };
  } catch {
    await logInvocation(db, ctx, provider, model, ZERO, false);
    return {
      ok: false,
      content: '',
      usage: ZERO,
      provider,
      model,
      error: 'The AI request failed.',
    };
  }
}

/** Test a provider's connection with a tiny request (does not log an invocation). */
export async function testConnection(provider: Provider): Promise<{ ok: boolean; error?: string }> {
  const apiKey = aiKeyFor(provider);
  if (!apiKey) return { ok: false, error: 'No API key is set for this provider.' };
  const req = buildRequest(provider, apiKey, 'You are a connection test.', 'Reply with OK.', {
    model: DEFAULT_MODELS[provider],
    maxTokens: 8,
    temperature: 0,
  });
  try {
    const res = await fetch(req.url, { method: 'POST', headers: req.headers, body: req.body });
    if (res.ok) return { ok: true };
    const text = await res.text().catch(() => '');
    return { ok: false, error: `${provider} ${res.status}: ${text.slice(0, 160)}` };
  } catch {
    return { ok: false, error: 'The request failed.' };
  }
}
