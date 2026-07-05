/**
 * The non-secret AI settings, held in the `config` table under the GLOBAL scope
 * (the source keys AI_ACTIVE_PROVIDER, AI_MODEL, AI_MAX_TOKENS, AI_TEMPERATURE,
 * AI_SYSTEM_PROMPT, AI_EVALUATION_ENABLED, AI_REJECTION_THRESHOLD and the per
 * provider enabled flags). The API keys are never here; they are Worker secrets
 * (ai/env.ts). Config is platform-wide (GLOBAL), so it is not org-scoped by
 * design. Column names follow grc/docs/schema-assumptions.md.
 */
import type { Client } from '@libsql/client/web';
import { DEFAULT_MODELS, isProvider, type Provider } from './providers';
import { DEFAULT_SYSTEM_PROMPT } from './prompts';

export interface AiConfig {
  activeProvider: Provider;
  model: string;
  maxTokens: number;
  temperature: number;
  systemPrompt: string;
  evaluationEnabled: boolean;
  rejectionThreshold: number;
  enabled: Record<Provider, boolean>;
}

const truthy = (v: string | undefined): boolean => v === 'true' || v === '1';
const numOr = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

export async function loadAiConfig(db: Client): Promise<AiConfig> {
  const map = new Map<string, string>();
  try {
    const res = await db.execute({
      sql: `SELECT config_key, config_value FROM config WHERE scope = 'GLOBAL' AND config_key LIKE 'AI_%'`,
      args: [],
    });
    for (const r of res.rows) {
      map.set(String(r.config_key), r.config_value == null ? '' : String(r.config_value));
    }
  } catch {
    // No config table or rows: fall through to the defaults.
  }

  const activeRaw = map.get('AI_ACTIVE_PROVIDER') ?? 'openai';
  const activeProvider: Provider = isProvider(activeRaw) ? activeRaw : 'openai';
  const model = map.get('AI_MODEL') || DEFAULT_MODELS[activeProvider];
  const maxTokens = Math.max(64, Math.min(numOr(map.get('AI_MAX_TOKENS'), 1500), 8000));
  const temperature = Math.max(0, Math.min(numOr(map.get('AI_TEMPERATURE'), 0.3), 1));
  const rejectionThreshold = Math.max(
    0,
    Math.min(numOr(map.get('AI_REJECTION_THRESHOLD'), 50), 100),
  );

  return {
    activeProvider,
    model,
    maxTokens,
    temperature,
    systemPrompt: map.get('AI_SYSTEM_PROMPT') || DEFAULT_SYSTEM_PROMPT,
    evaluationEnabled: truthy(map.get('AI_EVALUATION_ENABLED')),
    rejectionThreshold,
    enabled: {
      openai: truthy(map.get('AI_ENABLED_OPENAI')),
      anthropic: truthy(map.get('AI_ENABLED_ANTHROPIC')),
      google: truthy(map.get('AI_ENABLED_GOOGLE')),
    },
  };
}

async function setConfig(db: Client, key: string, value: string): Promise<void> {
  const now = new Date().toISOString();
  const upd = await db.execute({
    sql: `UPDATE config SET config_value = ?, updated_at = ? WHERE scope = 'GLOBAL' AND config_key = ?`,
    args: [value, now, key],
  });
  if ((upd.rowsAffected ?? 0) === 0) {
    await db.execute({
      sql: `INSERT INTO config (scope, config_key, config_value, updated_at) VALUES ('GLOBAL', ?, ?, ?)`,
      args: [key, value, now],
    });
  }
}

export interface AiConfigInput {
  activeProvider: string;
  model: string;
  maxTokens: number;
  temperature: number;
  systemPrompt: string;
  evaluationEnabled: boolean;
  rejectionThreshold: number;
  enabled: Record<Provider, boolean>;
}

export async function saveAiConfig(db: Client, input: AiConfigInput): Promise<void> {
  const pairs: [string, string][] = [
    ['AI_ACTIVE_PROVIDER', input.activeProvider],
    ['AI_MODEL', input.model],
    ['AI_MAX_TOKENS', String(input.maxTokens)],
    ['AI_TEMPERATURE', String(input.temperature)],
    ['AI_SYSTEM_PROMPT', input.systemPrompt],
    ['AI_EVALUATION_ENABLED', input.evaluationEnabled ? 'true' : 'false'],
    ['AI_REJECTION_THRESHOLD', String(input.rejectionThreshold)],
    ['AI_ENABLED_OPENAI', input.enabled.openai ? 'true' : 'false'],
    ['AI_ENABLED_ANTHROPIC', input.enabled.anthropic ? 'true' : 'false'],
    ['AI_ENABLED_GOOGLE', input.enabled.google ? 'true' : 'false'],
  ];
  for (const [key, value] of pairs) {
    await setConfig(db, key, value);
  }
}
