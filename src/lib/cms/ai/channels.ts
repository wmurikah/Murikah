/**
 * WhatsApp and email connections, configured the same way a provider is: by
 * naming a secret, never by holding one.
 *
 * `auto_create_case` DEFAULTS TO OFF, AND THE COLUMN ALREADY SAYS SO. A new
 * connection reads into the queue and creates nothing until somebody turns it
 * on, so the first thing a mis-configured connection does is fill a review
 * list rather than open two hundred cases nobody asked for. Turning it on is a
 * deliberate act with its own audit row.
 */
import type { Client } from '@libsql/client/web';
import { newId } from '../repos/authRecords.ts';
import { toDbTimestamp } from '../auth/session.ts';
import type { WriteContext } from '../admin/guard.ts';

const text = (v: unknown): string => String(v ?? '');
const maybeText = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

export const CHANNELS = ['WHATSAPP', 'EMAIL'] as const;
export type Channel = (typeof CHANNELS)[number];

export const CONNECTION_STATUSES = ['DRAFT', 'CONNECTED', 'ERROR', 'DISABLED'] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

export interface ChannelConnection {
  readonly channelConnectionId: string;
  readonly channel: Channel;
  readonly displayName: string;
  readonly provider: string;
  readonly accountIdentifier: string;
  readonly affiliateId: string | null;
  /** The NAME of a Worker secret. Never a key. */
  readonly secretName: string;
  readonly webhookSecretName: string | null;
  readonly status: ConnectionStatus;
  readonly lastPolledAt: string | null;
  readonly lastError: string | null;
  readonly autoCreateCase: boolean;
  readonly defaultCaseCategoryId: string | null;
}

const SELECT = `SELECT channel_connection_id, channel, display_name, provider,
                       account_identifier, affiliate_id, secret_name, webhook_secret_name,
                       status, last_polled_at, last_error, auto_create_case,
                       default_case_category_id
                  FROM channel_connections`;

function rowToConnection(raw: unknown): ChannelConnection {
  const row = raw as Record<string, unknown>;
  return {
    channelConnectionId: text(row.channel_connection_id),
    channel: text(row.channel) as Channel,
    displayName: text(row.display_name),
    provider: text(row.provider),
    accountIdentifier: text(row.account_identifier),
    affiliateId: maybeText(row.affiliate_id),
    secretName: text(row.secret_name),
    webhookSecretName: maybeText(row.webhook_secret_name),
    status: text(row.status) as ConnectionStatus,
    lastPolledAt: maybeText(row.last_polled_at),
    lastError: maybeText(row.last_error),
    autoCreateCase: Number(row.auto_create_case ?? 0) === 1,
    defaultCaseCategoryId: maybeText(row.default_case_category_id),
  };
}

/** Every connection. One round trip. */
export async function listConnections(db: Client): Promise<ChannelConnection[]> {
  const found = await db.execute(`${SELECT} ORDER BY channel, display_name`);
  return found.rows.map(rowToConnection);
}

export async function getConnection(db: Client, id: string): Promise<ChannelConnection | null> {
  const found = await db.execute({
    sql: `${SELECT} WHERE channel_connection_id = ?`,
    args: [id],
  });
  const row = found.rows[0];
  return row === undefined ? null : rowToConnection(row);
}

export interface ConnectionInput {
  channel: string;
  displayName: string;
  provider: string;
  accountIdentifier: string;
  affiliateId: string | null;
  secretName: string;
  webhookSecretName: string | null;
  autoCreateCase: boolean;
  defaultCaseCategoryId: string | null;
  status: string;
}

export interface FieldError {
  field: string;
  message: string;
}

export function validateConnection(input: ConnectionInput): FieldError[] {
  const errors: FieldError[] = [];
  if (!(CHANNELS as readonly string[]).includes(input.channel))
    errors.push({ field: 'channel', message: 'Choose WhatsApp or email.' });
  if (input.displayName.trim() === '')
    errors.push({ field: 'displayName', message: 'Give the connection a name.' });
  if (input.provider.trim() === '')
    errors.push({ field: 'provider', message: 'Name the provider.' });
  if (input.accountIdentifier.trim() === '')
    errors.push({
      field: 'accountIdentifier',
      message: 'Give the number or the mailbox this connection reads.',
    });
  if (!(CONNECTION_STATUSES as readonly string[]).includes(input.status))
    errors.push({ field: 'status', message: 'Choose a status.' });
  // THE SAME SHAPE TEST AS A PROVIDER'S, FOR THE SAME REASON: a key pasted
  // into this field fails it, so the mistake is refused rather than stored.
  if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(input.secretName))
    errors.push({
      field: 'secretName',
      message:
        'Give the name of the Worker secret, in capitals and underscores. This is the name, ' +
        'not the key.',
    });
  if (input.webhookSecretName !== null && !/^[A-Z][A-Z0-9_]{2,63}$/.test(input.webhookSecretName))
    errors.push({
      field: 'webhookSecretName',
      message: 'Leave blank, or give the name of the Worker secret in capitals and underscores.',
    });
  // A CONNECTION THAT OPENS CASES MUST KNOW WHICH CATEGORY. `service_cases`
  // requires one and would refuse the insert; catching it here means the
  // administrator learns it while configuring rather than the first message
  // failing silently at three in the morning.
  if (input.autoCreateCase && input.defaultCaseCategoryId === null)
    errors.push({
      field: 'defaultCaseCategoryId',
      message: 'Choose the category a created case will carry.',
    });
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
          VALUES (?, ?, ?, 'CHANNEL_CONNECTION', ?, ?, NULL, ?, ?, ?, ?)`,
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

export async function createConnection(
  db: Client,
  input: ConnectionInput,
  ctx: WriteContext,
): Promise<{ ok: true; id: string } | { ok: false; errors: FieldError[] }> {
  const errors = validateConnection(input);
  if (errors.length > 0) return { ok: false, errors };
  const id = newId('CHC');
  const now = toDbTimestamp(ctx.now);
  try {
    await db.execute({
      sql: `INSERT INTO channel_connections
              (channel_connection_id, channel, display_name, provider, account_identifier,
               affiliate_id, secret_name, webhook_secret_name, status, auto_create_case,
               default_case_category_id, created_by_user_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        input.channel,
        input.displayName.trim(),
        input.provider.trim(),
        input.accountIdentifier.trim(),
        input.affiliateId,
        input.secretName,
        input.webhookSecretName,
        input.status,
        input.autoCreateCase ? 1 : 0,
        input.defaultCaseCategoryId,
        ctx.actorUserId,
        now,
        now,
      ],
    });
  } catch (error) {
    if (String(error).includes('UNIQUE'))
      return {
        ok: false,
        errors: [
          {
            field: 'accountIdentifier',
            message: 'A connection for that number or mailbox already exists on this channel.',
          },
        ],
      };
    throw error;
  }
  await writeAudit(db, ctx, 'CHANNEL_CONNECTION_CREATED', id, 'CREATE', {
    channel: input.channel,
    displayName: input.displayName.trim(),
    accountIdentifier: input.accountIdentifier.trim(),
    secretName: input.secretName,
    autoCreateCase: input.autoCreateCase,
  });
  return { ok: true, id };
}

export async function updateConnection(
  db: Client,
  id: string,
  input: ConnectionInput,
  ctx: WriteContext,
): Promise<{ ok: true } | { ok: false; errors: FieldError[] }> {
  const errors = validateConnection(input);
  if (errors.length > 0) return { ok: false, errors };
  const before = await getConnection(db, id);
  await db.execute({
    sql: `UPDATE channel_connections
             SET channel = ?, display_name = ?, provider = ?, account_identifier = ?,
                 affiliate_id = ?, secret_name = ?, webhook_secret_name = ?, status = ?,
                 auto_create_case = ?, default_case_category_id = ?, updated_at = ?
           WHERE channel_connection_id = ?`,
    args: [
      input.channel,
      input.displayName.trim(),
      input.provider.trim(),
      input.accountIdentifier.trim(),
      input.affiliateId,
      input.secretName,
      input.webhookSecretName,
      input.status,
      input.autoCreateCase ? 1 : 0,
      input.defaultCaseCategoryId,
      toDbTimestamp(ctx.now),
      id,
    ],
  });
  // TURNING CASE CREATION ON IS ITS OWN EVENT, because it is the change that
  // lets a model's suggestion become a record without a person in between.
  // Finding out when that happened should not mean diffing two JSON blobs.
  if (before !== null && before.autoCreateCase !== input.autoCreateCase) {
    await writeAudit(
      db,
      ctx,
      input.autoCreateCase ? 'CHANNEL_AUTO_CASE_ENABLED' : 'CHANNEL_AUTO_CASE_DISABLED',
      id,
      'UPDATE',
      { autoCreateCase: input.autoCreateCase },
    );
  }
  await writeAudit(db, ctx, 'CHANNEL_CONNECTION_UPDATED', id, 'UPDATE', {
    displayName: input.displayName.trim(),
    status: input.status,
    secretName: input.secretName,
    autoCreateCase: input.autoCreateCase,
  });
  return { ok: true };
}
