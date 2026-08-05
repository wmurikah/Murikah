/**
 * The unified AI call, ported from 05_AIService.gs callAI. It routes to the
 * configured active provider (a fetch from the Worker), returns the content and
 * token usage, and logs an ai_invocations row for every call: provider, model,
 * tokens, latency, and the outcome (success or the error), ensuring the
 * ai_providers reference row exists first. The API key comes from Worker
 * secrets; when the active provider is disabled or unconfigured the call
 * returns an error without contacting a provider, and the feature layer falls
 * back. A daily per-organisation call allowance caps runaway usage. Column
 * names come from the typed schema layer.
 */
import type { Client } from '@libsql/client/web';
import { C, cols } from '@grc/schema/columns';
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

const INV = cols(C.ai_invocations);
const PROV = cols(C.ai_providers);

/**
 * The daily per-organisation call allowance. Generous for real assistance use,
 * far below anything a runaway loop or a scripted client would need; when it is
 * exhausted the call refuses with a plain message rather than contacting a
 * provider.
 */
export const AI_DAILY_CALL_LIMIT = 200;

export interface CallContext {
  organizationId: string;
  userId: string;
  purpose: string;
  /** The actor's role, recorded on the invocation for the usage trail. */
  invokerRole?: string | null;
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

// The live ai_providers is a global reference table keyed by provider_code (it
// carries no organisation of its own); ensure the row exists so an invocation
// always points at a real provider entry.
async function ensureProvider(db: Client, provider: Provider): Promise<void> {
  await db.execute({
    sql: `INSERT INTO ai_providers
            (${PROV.provider_code}, ${PROV.display_name}, ${PROV.default_model},
             ${PROV.is_enabled}, ${PROV.updated_at})
          SELECT ?, ?, ?, 1, ?
           WHERE NOT EXISTS (SELECT 1 FROM ai_providers WHERE ${PROV.provider_code} = ?)`,
    args: [
      provider,
      provider.charAt(0).toUpperCase() + provider.slice(1),
      DEFAULT_MODELS[provider],
      new Date().toISOString(),
      provider,
    ],
  });
}

async function logInvocation(
  db: Client,
  ctx: CallContext,
  provider: Provider,
  model: string,
  usage: AiUsage,
  latencyMs: number,
  error: string | null,
): Promise<void> {
  try {
    await ensureProvider(db, provider);
    await db.execute({
      sql: `INSERT INTO ai_invocations
              (${INV.invocation_id}, ${INV.organization_id}, ${INV.user_id}, ${INV.provider_code},
               ${INV.model}, ${INV.purpose}, ${INV.related_entity_type}, ${INV.related_entity_id},
               ${INV.prompt_tokens}, ${INV.completion_tokens}, ${INV.total_tokens},
               ${INV.latency_ms}, ${INV.success}, ${INV.error_message}, ${INV.invoker_role},
               ${INV.occurred_at})
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        Math.max(0, Math.round(latencyMs)),
        error == null ? 1 : 0,
        error,
        ctx.invokerRole ?? null,
        new Date().toISOString(),
      ],
    });
  } catch (err) {
    // The call itself must not fail over its own record, but a broken usage
    // trail is a finding, not a shrug: say why in the log.
    console.error('[grc.ai.service] invocation log failed', err);
  }
}

/** Today's call count for the organisation, for the daily allowance. */
async function callsToday(db: Client, organizationId: string): Promise<number> {
  const res = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM ai_invocations
           WHERE ${INV.organization_id} = ? AND date(${INV.occurred_at}) = date('now')`,
    args: [organizationId],
  });
  return Number(res.rows[0]?.n ?? 0);
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

  const refuse = async (error: string): Promise<CallResult> => {
    await logInvocation(db, ctx, provider, model, ZERO, 0, error);
    return { ok: false, content: '', usage: ZERO, provider, model, error };
  };

  // The daily allowance is the outermost guardrail: past it, nothing runs and
  // nothing floods the log with per-call refusals either.
  if ((await callsToday(db, ctx.organizationId)) >= AI_DAILY_CALL_LIMIT) {
    return {
      ok: false,
      content: '',
      usage: ZERO,
      provider,
      model,
      error: `The organisation's daily AI allowance (${AI_DAILY_CALL_LIMIT} calls) is used up. Try again tomorrow.`,
    };
  }

  if (!apiKey || !config.enabled[provider]) {
    return refuse('The active AI provider is not configured or is disabled.');
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

  const started = Date.now();
  try {
    const res = await fetch(req.url, { method: 'POST', headers: req.headers, body: req.body });
    const latency = Date.now() - started;
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const error = `${provider} ${res.status}: ${text.slice(0, 200)}`;
      await logInvocation(db, ctx, provider, model, ZERO, latency, error);
      return { ok: false, content: '', usage: ZERO, provider, model, error };
    }
    const json = (await res.json()) as unknown;
    const parsed = parseResponse(provider, json);
    await logInvocation(db, ctx, provider, model, parsed.usage, Date.now() - started, null);
    return { ok: true, content: parsed.content, usage: parsed.usage, provider, model };
  } catch {
    const error = 'The AI request failed.';
    await logInvocation(db, ctx, provider, model, ZERO, Date.now() - started, error);
    return { ok: false, content: '', usage: ZERO, provider, model, error };
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
