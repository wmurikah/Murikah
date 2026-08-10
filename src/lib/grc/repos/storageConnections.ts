/**
 * Per-organisation evidence storage connections (Build Prompt 51).
 *
 * One row per organisation per provider, at most one active. Every read and
 * write is scoped by `organization_id`, so one customer's connection is
 * unreachable from another's, and the active provider is always resolved for the
 * acting organisation rather than for the platform.
 *
 * The provider's settings, credentials included, rest as one AES-GCM sealed JSON
 * blob (`auth/secretBox.ts`, keyed off GRC_SESSION_SECRET), the same treatment
 * the Outlook refresh token already gets. Two rules hold the line:
 *
 * - `listConnections` and everything the settings screen sees returns the config
 *   **masked**. The unsealed config is available only through
 *   `loadActiveConnection`, which the provider factory calls; no screen, no
 *   template and no log line ever holds a readable credential.
 * - Nothing here is cached. It is one indexed read on a small table, and a
 *   cached answer would keep uploading to a provider an administrator has just
 *   disconnected, which is the same reasoning that keeps the permission matrix
 *   uncached (Build Prompt 43).
 */
import type { Client } from '@libsql/client/web';
import { C, cols } from '@grc/schema/columns';
import { seal, open } from '@grc/auth/secretBox';
import { maskConfig, type ProviderCode } from '@grc/storage/provider';

const SC = cols(C.storage_connections);

export type ConnectionStatus = 'pending' | 'connected' | 'error';

/** A connection as the settings screen sees it: config masked, never readable. */
export interface StorageConnectionView {
  provider: ProviderCode;
  status: ConnectionStatus;
  statusDetail: string | null;
  isActive: boolean;
  folderId: string | null;
  folderName: string | null;
  connectedAt: string | null;
  /** Secret fields replaced by their mask; safe to render. */
  maskedConfig: Record<string, string>;
  /** True when a credential is stored at all, so the screen can offer rotation. */
  hasCredentials: boolean;
}

/** A connection with its config unsealed. Only the provider factory sees this. */
export interface ResolvedConnection {
  provider: ProviderCode;
  organizationId: string;
  config: Record<string, string>;
  folderId: string | null;
  folderName: string | null;
  status: ConnectionStatus;
}

const s = (v: unknown): string | null => (v == null || String(v) === '' ? null : String(v));

function parseStatus(raw: unknown): ConnectionStatus {
  const value = String(raw ?? 'pending');
  return value === 'connected' || value === 'error' ? value : 'pending';
}

async function unseal(secret: string, sealed: string | null): Promise<Record<string, string>> {
  if (!sealed) return {};
  const plain = await open(secret, sealed);
  if (plain === null) return {};
  try {
    const parsed: unknown = JSON.parse(plain);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
      );
    }
  } catch {
    // A box that will not parse is treated as no config, so a corrupted row
    // leaves the organisation unconfigured rather than half-configured.
  }
  return {};
}

/**
 * Every provider an organisation has configured, for the settings screen, with
 * the config masked. Ordered active first so the current choice reads first.
 */
export async function listConnections(
  db: Client,
  secret: string,
  organizationId: string,
): Promise<StorageConnectionView[]> {
  const res = await db.execute({
    sql: `SELECT ${SC.provider}, ${SC.config_sealed}, ${SC.folder_id}, ${SC.folder_name},
                 ${SC.status}, ${SC.status_detail}, ${SC.is_active}, ${SC.connected_at}
            FROM storage_connections
           WHERE ${SC.organization_id} = ?
        ORDER BY ${SC.is_active} DESC, ${SC.provider}`,
    args: [organizationId],
  });
  const out: StorageConnectionView[] = [];
  for (const r of res.rows) {
    const provider = String(r.provider) as ProviderCode;
    const config = await unseal(secret, s(r.config_sealed));
    out.push({
      provider,
      status: parseStatus(r.status),
      statusDetail: s(r.status_detail),
      isActive: Number(r.is_active ?? 0) === 1,
      folderId: s(r.folder_id),
      folderName: s(r.folder_name),
      connectedAt: s(r.connected_at),
      maskedConfig: maskConfig(provider, config),
      hasCredentials: Object.keys(config).length > 0,
    });
  }
  return out;
}

/**
 * The organisation's active connection with its config unsealed, or null when it
 * has none. This is the only path that yields a readable credential, and its one
 * caller is the provider factory.
 */
export async function loadActiveConnection(
  db: Client,
  secret: string,
  organizationId: string,
): Promise<ResolvedConnection | null> {
  if (organizationId === '') return null;
  const res = await db.execute({
    sql: `SELECT ${SC.provider}, ${SC.config_sealed}, ${SC.folder_id}, ${SC.folder_name}, ${SC.status}
            FROM storage_connections
           WHERE ${SC.organization_id} = ? AND ${SC.is_active} = 1
           LIMIT 1`,
    args: [organizationId],
  });
  const row = res.rows[0];
  if (!row) return null;
  return {
    provider: String(row.provider) as ProviderCode,
    organizationId,
    config: await unseal(secret, s(row.config_sealed)),
    folderId: s(row.folder_id),
    folderName: s(row.folder_name),
    status: parseStatus(row.status),
  };
}

/** One provider's stored config, unsealed. For the connect flows and the tester. */
export async function loadConnection(
  db: Client,
  secret: string,
  organizationId: string,
  provider: ProviderCode,
): Promise<ResolvedConnection | null> {
  const res = await db.execute({
    sql: `SELECT ${SC.provider}, ${SC.config_sealed}, ${SC.folder_id}, ${SC.folder_name}, ${SC.status}
            FROM storage_connections
           WHERE ${SC.organization_id} = ? AND ${SC.provider} = ?
           LIMIT 1`,
    args: [organizationId, provider],
  });
  const row = res.rows[0];
  if (!row) return null;
  return {
    provider,
    organizationId,
    config: await unseal(secret, s(row.config_sealed)),
    folderId: s(row.folder_id),
    folderName: s(row.folder_name),
    status: parseStatus(row.status),
  };
}

export interface SaveConnectionInput {
  provider: ProviderCode;
  /** The complete config to seal. The caller merges any retained secrets first. */
  config: Record<string, string>;
  folderId?: string | null;
  folderName?: string | null;
  status?: ConnectionStatus;
  statusDetail?: string | null;
  connectedBy?: string;
}

/**
 * Upsert one provider's connection for an organisation, sealing the config.
 *
 * Delete-then-insert rather than an UPDATE with an INSERT fallback: it needs no
 * unique index to be correct, it leaves no stale column behind when a provider's
 * settings change shape, and both statements go in one batch so a failure rolls
 * back rather than leaving the organisation with no connection at all.
 */
export async function saveConnection(
  db: Client,
  secret: string,
  organizationId: string,
  input: SaveConnectionInput,
): Promise<void> {
  const now = new Date().toISOString();
  const sealed = await seal(secret, JSON.stringify(input.config));
  const status = input.status ?? 'pending';
  await db.batch(
    [
      {
        sql: `DELETE FROM storage_connections
               WHERE ${SC.organization_id} = ? AND ${SC.provider} = ?`,
        args: [organizationId, input.provider],
      },
      {
        sql: `INSERT INTO storage_connections
                (${SC.connection_id}, ${SC.organization_id}, ${SC.provider}, ${SC.config_sealed},
                 ${SC.folder_id}, ${SC.folder_name}, ${SC.status}, ${SC.status_detail},
                 ${SC.is_active}, ${SC.connected_at}, ${SC.connected_by}, ${SC.created_at},
                 ${SC.updated_at})
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
        args: [
          crypto.randomUUID(),
          organizationId,
          input.provider,
          sealed,
          input.folderId ?? null,
          input.folderName ?? null,
          status,
          input.statusDetail ?? null,
          status === 'connected' ? now : null,
          input.connectedBy ?? null,
          now,
          now,
        ],
      },
    ],
    'write',
  );
}

/** Record the outcome of a connection test without touching the sealed config. */
export async function recordTestResult(
  db: Client,
  organizationId: string,
  provider: ProviderCode,
  ok: boolean,
  detail: string,
): Promise<void> {
  const now = new Date().toISOString();
  await db.execute({
    sql: `UPDATE storage_connections
             SET ${SC.status} = ?, ${SC.status_detail} = ?, ${SC.connected_at} = ?,
                 ${SC.updated_at} = ?
           WHERE ${SC.organization_id} = ? AND ${SC.provider} = ?`,
    args: [
      ok ? 'connected' : 'error',
      detail.slice(0, 500),
      ok ? now : null,
      now,
      organizationId,
      provider,
    ],
  });
}

/** Store the chosen folder for a provider, leaving its credentials alone. */
export async function setFolder(
  db: Client,
  organizationId: string,
  provider: ProviderCode,
  folderId: string,
  folderName: string,
): Promise<void> {
  await db.execute({
    sql: `UPDATE storage_connections
             SET ${SC.folder_id} = ?, ${SC.folder_name} = ?, ${SC.updated_at} = ?
           WHERE ${SC.organization_id} = ? AND ${SC.provider} = ?`,
    args: [folderId, folderName, new Date().toISOString(), organizationId, provider],
  });
}

/**
 * Make one provider the organisation's active one, in a batch that deactivates
 * the others first. The partial unique index in migration 004 refuses two active
 * rows outright, so this cannot silently leave an organisation with an ambiguous
 * answer even if a future caller forgets the deactivation.
 */
export async function activateConnection(
  db: Client,
  organizationId: string,
  provider: ProviderCode,
): Promise<void> {
  const now = new Date().toISOString();
  await db.batch(
    [
      {
        sql: `UPDATE storage_connections SET ${SC.is_active} = 0, ${SC.updated_at} = ?
               WHERE ${SC.organization_id} = ?`,
        args: [now, organizationId],
      },
      {
        sql: `UPDATE storage_connections SET ${SC.is_active} = 1, ${SC.updated_at} = ?
               WHERE ${SC.organization_id} = ? AND ${SC.provider} = ?`,
        args: [now, organizationId, provider],
      },
    ],
    'write',
  );
}

/**
 * Disconnect a provider: the row and its sealed credentials go entirely, rather
 * than being deactivated. A credential an administrator has asked to remove
 * should not survive as ciphertext on the row, and reconnecting is a fresh
 * consent anyway.
 */
export async function disconnect(
  db: Client,
  organizationId: string,
  provider: ProviderCode,
): Promise<void> {
  await db.execute({
    sql: `DELETE FROM storage_connections
           WHERE ${SC.organization_id} = ? AND ${SC.provider} = ?`,
    args: [organizationId, provider],
  });
}
