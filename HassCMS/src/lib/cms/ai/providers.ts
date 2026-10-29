/**
 * The configured models, and the record that a key was never written down.
 *
 * WHAT AN ADMINISTRATOR CONFIGURES: a name, a type, a model, the parameters,
 * what it is for, and the NAME of the Worker secret holding the key. There is
 * no field for the key and no column for it, and the second half is what makes
 * the first half true rather than a habit somebody breaks later.
 *
 * WHAT THE SCREEN SHOWS INSTEAD. Whether the named secret is present in this
 * Worker, which is a boolean derived from `env` at render time, and whether a
 * test call succeeded, which is `last_verify_status` and `last_verified_at`
 * written by ./model.ts. Between them an administrator can see the connection
 * is live without the value ever having existed outside the secret store.
 */
import type { Client } from '@libsql/client/web';
import { newId } from '../repos/authRecords.ts';
import { toDbTimestamp } from '../auth/session.ts';
import type { WriteContext } from '../admin/guard.ts';
import type { VerifyStatus } from './model.ts';

const text = (v: unknown): string => String(v ?? '');
const maybeText = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const maybeNum = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export const PROVIDER_TYPES = ['ANTHROPIC', 'OPENAI', 'AZURE_OPENAI', 'GOOGLE', 'OTHER'] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

export const PURPOSES = ['ASSISTANT', 'CLASSIFICATION', 'BOTH'] as const;
export type Purpose = (typeof PURPOSES)[number];

export interface AiProvider {
  readonly aiProviderId: string;
  readonly providerName: string;
  readonly providerType: ProviderType;
  readonly baseUrl: string | null;
  readonly model: string;
  /** The NAME of a Worker secret. Never a key. */
  readonly secretName: string;
  readonly maxOutputTokens: number | null;
  readonly temperature: number | null;
  readonly purpose: Purpose;
  readonly active: boolean;
  readonly lastVerifiedAt: string | null;
  readonly lastVerifyStatus: VerifyStatus | null;
}

const SELECT = `SELECT ai_provider_id, provider_name, provider_type, base_url, model,
                       secret_name, max_output_tokens, temperature, purpose, active,
                       last_verified_at, last_verify_status
                  FROM ai_providers`;

function rowToProvider(raw: unknown): AiProvider {
  const row = raw as Record<string, unknown>;
  return {
    aiProviderId: text(row.ai_provider_id),
    providerName: text(row.provider_name),
    providerType: text(row.provider_type) as ProviderType,
    baseUrl: maybeText(row.base_url),
    model: text(row.model),
    secretName: text(row.secret_name),
    maxOutputTokens: maybeNum(row.max_output_tokens),
    temperature: maybeNum(row.temperature),
    purpose: text(row.purpose) as Purpose,
    active: Number(row.active ?? 0) === 1,
    lastVerifiedAt: maybeText(row.last_verified_at),
    lastVerifyStatus: maybeText(row.last_verify_status) as VerifyStatus | null,
  };
}

/** Every configured provider, newest first. One round trip. */
export async function listProviders(db: Client): Promise<AiProvider[]> {
  const found = await db.execute(`${SELECT} ORDER BY active DESC, provider_name`);
  return found.rows.map(rowToProvider);
}

/**
 * The provider that will answer for a purpose, or null.
 *
 * ACTIVE AND VERIFIED IS NOT THE TEST. A provider whose last verification
 * failed may still be the one an administrator wants used; the verification is
 * a diagnostic, not a gate, and gating on it would mean a provider that was
 * briefly rate-limited stops answering until somebody presses a button. Active
 * is the switch, and it is the only one.
 */
export async function activeProvider(db: Client, purpose: Purpose): Promise<AiProvider | null> {
  const found = await db.execute({
    sql: `${SELECT} WHERE active = 1 AND purpose IN (?, 'BOTH')
          ORDER BY CASE purpose WHEN 'BOTH' THEN 1 ELSE 0 END, provider_name LIMIT 1`,
    args: [purpose],
  });
  const row = found.rows[0];
  return row === undefined ? null : rowToProvider(row);
}

export async function getProvider(db: Client, id: string): Promise<AiProvider | null> {
  const found = await db.execute({ sql: `${SELECT} WHERE ai_provider_id = ?`, args: [id] });
  const row = found.rows[0];
  return row === undefined ? null : rowToProvider(row);
}

export interface ProviderInput {
  providerName: string;
  providerType: string;
  baseUrl: string | null;
  model: string;
  secretName: string;
  maxOutputTokens: number | null;
  temperature: number | null;
  purpose: string;
  active: boolean;
}

export interface FieldError {
  field: string;
  message: string;
}

/**
 * What the form may say, checked before anything is written.
 *
 * The secret NAME is validated against the shape a Worker secret can have,
 * which is also what stops somebody pasting a key into the field: a key has
 * lower-case letters and punctuation and fails this pattern, so the mistake is
 * refused at the door rather than stored.
 */
export function validateProvider(input: ProviderInput): FieldError[] {
  const errors: FieldError[] = [];
  if (input.providerName.trim() === '')
    errors.push({ field: 'providerName', message: 'Give the provider a name.' });
  if (!(PROVIDER_TYPES as readonly string[]).includes(input.providerType))
    errors.push({ field: 'providerType', message: 'Choose a provider type.' });
  if (input.model.trim() === '') errors.push({ field: 'model', message: 'Name the model.' });
  if (!(PURPOSES as readonly string[]).includes(input.purpose))
    errors.push({ field: 'purpose', message: 'Choose what this provider is for.' });
  if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(input.secretName)) {
    errors.push({
      field: 'secretName',
      message:
        'Give the name of the Worker secret, in capitals and underscores. This is the name, ' +
        'not the key.',
    });
  }
  if (input.maxOutputTokens !== null && input.maxOutputTokens <= 0)
    errors.push({ field: 'maxOutputTokens', message: 'Leave blank or give a number above zero.' });
  if (input.temperature !== null && (input.temperature < 0 || input.temperature > 2))
    errors.push({ field: 'temperature', message: 'Leave blank or give a number from 0 to 2.' });
  if (input.baseUrl !== null && !/^https:\/\//.test(input.baseUrl))
    errors.push({ field: 'baseUrl', message: 'Leave blank or give an https address.' });
  return errors;
}

async function writeAudit(
  db: Client,
  ctx: WriteContext,
  eventType: string,
  entityId: string,
  action: string,
  after: Record<string, unknown>,
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO audit_events
            (audit_event_id, actor_user_id, event_type, entity_type, entity_id, action,
             before_json, after_json, ip_address, user_agent, event_at)
          VALUES (?, ?, ?, 'AI_PROVIDER', ?, ?, NULL, ?, ?, ?, ?)`,
    args: [
      newId('AEV'),
      ctx.actorUserId,
      eventType,
      entityId,
      action,
      JSON.stringify(after),
      ctx.ip ?? null,
      ctx.userAgent ?? null,
      toDbTimestamp(ctx.now),
    ],
  });
}

export async function createProvider(
  db: Client,
  input: ProviderInput,
  ctx: WriteContext,
): Promise<{ ok: true; id: string } | { ok: false; errors: FieldError[] }> {
  const errors = validateProvider(input);
  if (errors.length > 0) return { ok: false, errors };
  const id = newId('AIP');
  const now = toDbTimestamp(ctx.now);
  try {
    await db.execute({
      sql: `INSERT INTO ai_providers
              (ai_provider_id, provider_name, provider_type, base_url, model, secret_name,
               max_output_tokens, temperature, purpose, active, created_by_user_id,
               created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        input.providerName.trim(),
        input.providerType,
        input.baseUrl,
        input.model.trim(),
        input.secretName,
        input.maxOutputTokens,
        input.temperature,
        input.purpose,
        input.active ? 1 : 0,
        ctx.actorUserId,
        now,
        now,
      ],
    });
  } catch (error) {
    if (String(error).includes('UNIQUE'))
      return { ok: false, errors: [{ field: 'providerName', message: 'That name is taken.' }] };
    throw error;
  }
  // THE AUDIT RECORDS THE NAME OF THE SECRET, WHICH IS NOT A SECRET. What it
  // must never record is a value, and there is none to record.
  await writeAudit(db, ctx, 'AI_PROVIDER_CREATED', id, 'CREATE', {
    providerName: input.providerName.trim(),
    providerType: input.providerType,
    model: input.model.trim(),
    secretName: input.secretName,
    purpose: input.purpose,
  });
  return { ok: true, id };
}

export async function updateProvider(
  db: Client,
  id: string,
  input: ProviderInput,
  ctx: WriteContext,
): Promise<{ ok: true } | { ok: false; errors: FieldError[] }> {
  const errors = validateProvider(input);
  if (errors.length > 0) return { ok: false, errors };
  await db.execute({
    sql: `UPDATE ai_providers
             SET provider_name = ?, provider_type = ?, base_url = ?, model = ?, secret_name = ?,
                 max_output_tokens = ?, temperature = ?, purpose = ?, active = ?, updated_at = ?
           WHERE ai_provider_id = ?`,
    args: [
      input.providerName.trim(),
      input.providerType,
      input.baseUrl,
      input.model.trim(),
      input.secretName,
      input.maxOutputTokens,
      input.temperature,
      input.purpose,
      input.active ? 1 : 0,
      toDbTimestamp(ctx.now),
      id,
    ],
  });
  await writeAudit(db, ctx, 'AI_PROVIDER_UPDATED', id, 'UPDATE', {
    providerName: input.providerName.trim(),
    model: input.model.trim(),
    secretName: input.secretName,
    active: input.active,
  });
  return { ok: true };
}

/** The verification result, written where the screen reads it. */
export async function recordVerification(
  db: Client,
  id: string,
  status: VerifyStatus,
  ctx: WriteContext,
): Promise<void> {
  const now = toDbTimestamp(ctx.now);
  await db.execute({
    sql: `UPDATE ai_providers SET last_verified_at = ?, last_verify_status = ?, updated_at = ?
           WHERE ai_provider_id = ?`,
    args: [now, status, now, id],
  });
  await writeAudit(db, ctx, 'AI_PROVIDER_VERIFIED', id, 'VERIFY', { status });
}

/**
 * Every column of the six tables, and whether any of them could hold a
 * credential.
 *
 * THE AUDIT IS CODE, NOT A PROMISE IN A COMMENT. Criterion 23 asks that no key,
 * password or token value is stored in any table; a sentence saying so goes
 * stale the first time somebody adds a column called `api_key` "temporarily".
 * This asks the database what columns exist and fails on any name that reads
 * like a credential, with `secret_name` and `webhook_secret_name` allowed by
 * name because they hold the NAME of a secret. The test prints the whole
 * inventory so the exemption is visible rather than buried in a regular
 * expression.
 */
/**
 * A column name that would hold a credential.
 *
 * `token` IS MATCHED ONLY IN THE SINGULAR, and that is a real distinction
 * rather than a loophole. `auth_token` and `access_token` hold a credential;
 * `input_tokens`, `output_tokens` and `max_output_tokens` are counts of words
 * a model read and wrote, and a pattern that flagged them would have to be
 * suppressed with an exemption list, which is how a check like this stops
 * being read. The plural is a count; the singular is a key.
 */
export const CREDENTIAL_COLUMN =
  /(^|_)(api_?key|apikey|secret|password|passwd|credential)(_|$)|(^|_)token(_|$)/i;

/** The two columns that name a secret rather than holding one. */
export const SECRET_NAME_COLUMNS = new Set(['secret_name', 'webhook_secret_name']);

export const ASSISTANT_TABLES = [
  'ai_providers',
  'bot_conversations',
  'bot_messages',
  'channel_connections',
  'channel_messages',
  'message_classifications',
] as const;

export interface ColumnAudit {
  readonly table: string;
  readonly column: string;
  readonly looksLikeCredential: boolean;
  readonly allowedBecauseItNamesASecret: boolean;
}

export async function auditColumns(
  db: Client,
  tables: readonly string[] = ASSISTANT_TABLES,
): Promise<ColumnAudit[]> {
  const out: ColumnAudit[] = [];
  for (const table of tables) {
    const found = await db.execute({
      sql: `SELECT name FROM pragma_table_info(?)`,
      args: [table],
    });
    for (const raw of found.rows) {
      const column = text((raw as Record<string, unknown>).name);
      out.push({
        table,
        column,
        looksLikeCredential: CREDENTIAL_COLUMN.test(column),
        allowedBecauseItNamesASecret: SECRET_NAME_COLUMNS.has(column),
      });
    }
  }
  return out;
}
