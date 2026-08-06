/**
 * The stored Outlook mail connection: the delegated Microsoft Graph refresh
 * token an admin minted through the one-time connect flow, plus the connected
 * mailbox address and the connection state. The Worker cannot write its own
 * secrets, so the record lives as a platform-wide config row (the GLOBAL
 * sentinel, orgConfig.ts) with the refresh token sealed by AES-GCM
 * (auth/secretBox.ts, keyed off GRC_SESSION_SECRET) so it never rests in
 * plaintext. Microsoft rotates consumer refresh tokens on each use, so the
 * sender writes the rotated token back through rotateMailToken; an auth
 * failure marks the record stale so the Email screen shows "Not connected".
 * The pure record shape and transitions live in notify/mailRecord.ts.
 */
import type { Client } from '@libsql/client/web';
import { getGlobalConfigValue, setGlobalConfigValue } from '@grc/repos/orgConfig';
import {
  MAIL_CONNECTION_KEY,
  parseMailConnection,
  rotatedMailRecord,
  staleMailRecord,
  type MailConnectionRecord,
} from '@grc/notify/mailRecord';

export type { MailConnectionRecord };

/** The stored connection, or null when the admin has never connected. */
export async function getMailConnection(db: Client): Promise<MailConnectionRecord | null> {
  return parseMailConnection(await getGlobalConfigValue(db, MAIL_CONNECTION_KEY));
}

/** Store (or replace) the connection record. */
export async function saveMailConnection(db: Client, record: MailConnectionRecord): Promise<void> {
  await setGlobalConfigValue(db, MAIL_CONNECTION_KEY, JSON.stringify(record));
}

/** Replace the stored refresh token after Microsoft rotates it on redemption. */
export async function rotateMailToken(
  db: Client,
  record: MailConnectionRecord,
  sealedToken: string,
  nowIso: string,
): Promise<void> {
  await saveMailConnection(db, rotatedMailRecord(record, sealedToken, nowIso));
}

/** Mark the connection stale after an auth failure, keeping the sealed token. */
export async function markMailConnectionStale(
  db: Client,
  record: MailConnectionRecord,
  reason: string,
  nowIso: string,
): Promise<void> {
  await saveMailConnection(db, staleMailRecord(record, reason, nowIso));
}
