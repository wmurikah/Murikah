import type { Client, InStatement } from '@libsql/client/web';
import { newId } from '../repos/authRecords.ts';

export const CHANNEL_PURPOSES = ['NOTIFICATION_EMAIL', 'INQUIRY_EMAIL', 'WHATSAPP'] as const;
export type ChannelPurpose = (typeof CHANNEL_PURPOSES)[number];

export interface ChannelCredential {
  channelConnectionId: string;
  purpose: ChannelPurpose;
  authProvider: 'MICROSOFT' | 'META';
  sealedRefreshToken: string | null;
  sealedAccessToken: string | null;
  providerAccountId: string | null;
  providerAuxId: string | null;
  grantedScopes: string | null;
  syncCursor: string | null;
  connectedAt: string | null;
  updatedAt: string;
  accountIdentifier: string;
  displayName: string;
  connectionStatus: string;
  lastPolledAt: string | null;
  lastError: string | null;
}

const asText = (value: unknown): string => String(value ?? '');
const maybe = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);

function rowToCredential(row: unknown): ChannelCredential {
  const r = row as Record<string, unknown>;
  return {
    channelConnectionId: asText(r.channel_connection_id),
    purpose: asText(r.purpose) as ChannelPurpose,
    authProvider: asText(r.auth_provider) as 'MICROSOFT' | 'META',
    sealedRefreshToken: maybe(r.sealed_refresh_token),
    sealedAccessToken: maybe(r.sealed_access_token),
    providerAccountId: maybe(r.provider_account_id),
    providerAuxId: maybe(r.provider_aux_id),
    grantedScopes: maybe(r.granted_scopes),
    syncCursor: maybe(r.sync_cursor),
    connectedAt: maybe(r.connected_at),
    updatedAt: asText(r.credential_updated_at),
    accountIdentifier: asText(r.account_identifier),
    displayName: asText(r.display_name),
    connectionStatus: asText(r.status),
    lastPolledAt: maybe(r.last_polled_at),
    lastError: maybe(r.last_error),
  };
}

const SELECT = `SELECT cc.channel_connection_id, cc.account_identifier, cc.display_name,
                       cc.status, cc.last_polled_at, cc.last_error,
                       cr.purpose, cr.auth_provider, cr.sealed_refresh_token,
                       cr.sealed_access_token, cr.provider_account_id, cr.provider_aux_id,
                       cr.granted_scopes, cr.sync_cursor, cr.connected_at,
                       cr.updated_at AS credential_updated_at
                  FROM channel_credentials cr
                  JOIN channel_connections cc
                    ON cc.channel_connection_id = cr.channel_connection_id`;

export async function channelCredentialsReady(db: Client): Promise<boolean> {
  try {
    await db.execute('SELECT channel_connection_id FROM channel_credentials LIMIT 1');
    return true;
  } catch (error) {
    if (String(error).toLowerCase().includes('no such table')) return false;
    throw error;
  }
}

export async function listChannelCredentials(db: Client): Promise<ChannelCredential[]> {
  const found = await db.execute(`${SELECT} ORDER BY cr.purpose, cc.display_name`);
  return found.rows.map(rowToCredential);
}

export async function getChannelCredential(
  db: Client,
  purpose: ChannelPurpose,
): Promise<ChannelCredential | null> {
  const found = await db.execute({
    sql: `${SELECT} WHERE cr.purpose = ? AND cc.status = 'CONNECTED'
           ORDER BY cr.updated_at DESC LIMIT 1`,
    args: [purpose],
  });
  return found.rows[0] === undefined ? null : rowToCredential(found.rows[0]);
}

function auditStatement(
  actorUserId: string,
  eventType: string,
  entityId: string,
  after: Record<string, unknown>,
): InStatement {
  return {
    sql: `INSERT INTO audit_events
            (audit_event_id, actor_user_id, event_type, entity_type, entity_id, action,
             before_json, after_json, ip_address, user_agent, event_at)
          VALUES (?, ?, ?, 'CHANNEL_CONNECTION', ?, 'UPDATE', NULL, ?, NULL, NULL, CURRENT_TIMESTAMP)`,
    args: [newId('AEV'), actorUserId, eventType, entityId, JSON.stringify(after)],
  };
}

export async function saveMicrosoftChannel(
  db: Client,
  input: {
    purpose: 'NOTIFICATION_EMAIL' | 'INQUIRY_EMAIL';
    mailbox: string;
    sealedRefreshToken: string;
    scopes: string;
    actorUserId: string;
  },
): Promise<string> {
  const mailbox = input.mailbox.trim().toLowerCase();
  const existing = await db.execute({
    sql: `SELECT channel_connection_id FROM channel_connections
           WHERE channel = 'EMAIL' AND lower(account_identifier) = ? LIMIT 1`,
    args: [mailbox],
  });
  const connectionId = existing.rows[0]
    ? String((existing.rows[0] as Record<string, unknown>).channel_connection_id)
    : newId('CHC');
  const now = new Date().toISOString().replace('T', ' ').replace('Z', '');
  const statements: InStatement[] = [];
  if (existing.rows[0]) {
    statements.push({
      sql: `UPDATE channel_connections
               SET provider = 'MICROSOFT', status = 'CONNECTED', last_error = NULL,
                   secret_name = 'OAUTH_MANAGED', updated_at = ?
             WHERE channel_connection_id = ?`,
      args: [now, connectionId],
    });
  } else {
    statements.push({
      sql: `INSERT INTO channel_connections
              (channel_connection_id, channel, display_name, provider, account_identifier,
               affiliate_id, secret_name, webhook_secret_name, status, auto_create_case,
               default_case_category_id, created_by_user_id, created_at, updated_at)
            VALUES (?, 'EMAIL', ?, 'MICROSOFT', ?, NULL, 'OAUTH_MANAGED', NULL,
                    'CONNECTED', 0, NULL, ?, ?, ?)`,
      args: [
        connectionId,
        input.purpose === 'NOTIFICATION_EMAIL' ? 'Notification email' : 'Inquiry email',
        mailbox,
        input.actorUserId,
        now,
        now,
      ],
    });
  }
  statements.push(
    {
      sql: `INSERT INTO channel_credentials
              (channel_connection_id, purpose, auth_provider, sealed_refresh_token,
               sealed_access_token, provider_account_id, provider_aux_id, granted_scopes,
               sync_cursor, connected_at, connected_by_user_id, updated_at)
            VALUES (?, ?, 'MICROSOFT', ?, NULL, ?, NULL, ?, NULL, ?, ?, ?)
            ON CONFLICT(channel_connection_id, purpose) DO UPDATE SET
              auth_provider = excluded.auth_provider,
              sealed_refresh_token = excluded.sealed_refresh_token,
              sealed_access_token = NULL,
              provider_account_id = excluded.provider_account_id,
              granted_scopes = excluded.granted_scopes,
              sync_cursor = NULL,
              connected_at = excluded.connected_at,
              connected_by_user_id = excluded.connected_by_user_id,
              updated_at = excluded.updated_at`,
      args: [
        connectionId,
        input.purpose,
        input.sealedRefreshToken,
        mailbox,
        input.scopes,
        now,
        input.actorUserId,
        now,
      ],
    },
    auditStatement(input.actorUserId, 'CHANNEL_CONNECTED', connectionId, {
      purpose: input.purpose,
      provider: 'MICROSOFT',
      mailbox,
    }),
  );
  await db.batch(statements, 'write');
  return connectionId;
}

export async function rotateCredential(
  db: Client,
  credential: ChannelCredential,
  sealedRefreshToken: string | null,
  syncCursor: string | null | undefined,
): Promise<void> {
  const sets = ['updated_at = CURRENT_TIMESTAMP'];
  const args: (string | null)[] = [];
  if (sealedRefreshToken !== null) {
    sets.push('sealed_refresh_token = ?');
    args.push(sealedRefreshToken);
  }
  if (syncCursor !== undefined) {
    sets.push('sync_cursor = ?');
    args.push(syncCursor);
  }
  args.push(credential.channelConnectionId, credential.purpose);
  await db.execute({
    sql: `UPDATE channel_credentials SET ${sets.join(', ')}
           WHERE channel_connection_id = ? AND purpose = ?`,
    args,
  });
}

export async function markChannelRead(
  db: Client,
  connectionId: string,
  error: string | null = null,
): Promise<void> {
  await db.execute({
    sql: `UPDATE channel_connections
             SET last_polled_at = CURRENT_TIMESTAMP,
                 last_error = ?,
                 status = CASE WHEN ? IS NULL THEN 'CONNECTED' ELSE 'ERROR' END,
                 updated_at = CURRENT_TIMESTAMP
           WHERE channel_connection_id = ?`,
    args: [error, error, connectionId],
  });
}

export async function disconnectChannelPurpose(
  db: Client,
  purpose: ChannelPurpose,
  actorUserId: string,
): Promise<boolean> {
  const current = await getChannelCredential(db, purpose);
  if (!current) return false;
  const remaining = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM channel_credentials
           WHERE channel_connection_id = ? AND purpose <> ?`,
    args: [current.channelConnectionId, purpose],
  });
  const count = Number((remaining.rows[0] as Record<string, unknown> | undefined)?.n ?? 0);
  const statements: InStatement[] = [
    {
      sql: `DELETE FROM channel_credentials
             WHERE channel_connection_id = ? AND purpose = ?`,
      args: [current.channelConnectionId, purpose],
    },
  ];
  if (count === 0) {
    statements.push({
      sql: `UPDATE channel_connections SET status = 'DISABLED', updated_at = CURRENT_TIMESTAMP
             WHERE channel_connection_id = ?`,
      args: [current.channelConnectionId],
    });
  }
  statements.push(
    auditStatement(actorUserId, 'CHANNEL_DISCONNECTED', current.channelConnectionId, { purpose }),
  );
  await db.batch(statements, 'write');
  return true;
}
