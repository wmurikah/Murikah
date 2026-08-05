/**
 * The non-secret AI settings, held in the `config` table (the source keys
 * AI_ACTIVE_PROVIDER, AI_MODEL, AI_MAX_TOKENS, AI_TEMPERATURE, AI_SYSTEM_PROMPT,
 * AI_EVALUATION_ENABLED, AI_REJECTION_THRESHOLD and the per provider enabled
 * flags). The API keys are never here; they are Worker secrets (ai/env.ts).
 * Config is platform-wide by design, so it is keyed by a fixed `GLOBAL`
 * organization_id sentinel rather than a real organisation. Column names come
 * from the typed schema layer; the live `config` table keys rows by
 * organization_id (there is no `scope` column).
 *
 * The live schema may enforce a foreign key from config.organization_id to
 * organizations (connections run with foreign keys ON), which would refuse the
 * sentinel and 500 the save. saveAiConfig self-heals: when the first write is
 * refused it creates the inactive GLOBAL sentinel organisation row (data, not
 * schema) and retries once, so the save round-trips either way.
 */
import type { Client } from '@libsql/client/web';
import { C, cols } from '@grc/schema/columns';
import { DEFAULT_MODELS, isProvider, type Provider } from './providers';
import { DEFAULT_SYSTEM_PROMPT } from './prompts';

const cfg = cols(C.config);
const GLOBAL = 'GLOBAL';

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
      sql: `SELECT ${cfg.config_key}, ${cfg.config_value} FROM config
             WHERE ${cfg.organization_id} = ? AND ${cfg.config_key} LIKE 'AI_%'`,
      args: [GLOBAL],
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
    sql: `UPDATE config SET ${cfg.config_value} = ?, ${cfg.updated_at} = ?
           WHERE ${cfg.organization_id} = ? AND ${cfg.config_key} = ?`,
    args: [value, now, GLOBAL, key],
  });
  if ((upd.rowsAffected ?? 0) === 0) {
    await db.execute({
      sql: `INSERT INTO config (${cfg.organization_id}, ${cfg.config_key}, ${cfg.config_value}, ${cfg.updated_at})
             VALUES (?, ?, ?, ?)`,
      args: [GLOBAL, key, value, now],
    });
  }
}

/**
 * Create the inactive GLOBAL sentinel organisation the platform-wide config rows
 * hang off, for a schema that enforces the organizations foreign key. Inactive
 * (is_active 0), so it never appears in organisation lists or the switcher.
 */
async function ensureGlobalSentinel(db: Client): Promise<void> {
  const org = cols(C.organizations);
  const existing = await db.execute({
    sql: `SELECT ${org.organization_id} FROM organizations WHERE ${org.organization_id} = ? LIMIT 1`,
    args: [GLOBAL],
  });
  if (existing.rows.length > 0) return;
  await db.execute({
    sql: `INSERT INTO organizations
            (${org.organization_id}, ${org.org_code}, ${org.org_name}, ${org.is_active}, ${org.created_at})
          VALUES (?, ?, ?, 0, ?)`,
    args: [GLOBAL, GLOBAL, 'Platform (global configuration)', new Date().toISOString()],
  });
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
  let healed = false;
  for (const [key, value] of pairs) {
    try {
      await setConfig(db, key, value);
    } catch (err) {
      if (healed) throw err;
      healed = true;
      console.error('[grc.ai.config] first write refused, creating the GLOBAL sentinel', err);
      await ensureGlobalSentinel(db);
      await setConfig(db, key, value);
    }
  }
}
