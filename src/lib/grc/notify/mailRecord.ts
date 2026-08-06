/**
 * The pure shape of the stored Outlook mail connection: the record format,
 * its parser and the transitions (rotation and going stale). Import-free so
 * the unit tests run it directly under node; the DB reads and writes live in
 * repos/mailConnection.ts.
 */

export const MAIL_CONNECTION_KEY = 'MAIL_OUTLOOK_CONNECTION';

export interface MailConnectionRecord {
  /** The sealed (never plaintext) Graph refresh token. */
  sealedToken: string;
  /** The connected mailbox address, read from Graph /me at connect time. */
  address: string;
  /** When the admin completed the connect flow. */
  connectedAt: string;
  /** 'ok', or 'stale' after an auth failure (reconnect required). */
  status: 'ok' | 'stale';
  /** Why the connection went stale, for the Email screen. */
  staleReason?: string;
  updatedAt: string;
}

/** Parse a stored record value, or null when absent or malformed. */
export function parseMailConnection(raw: string | null | undefined): MailConnectionRecord | null {
  if (!raw || raw.trim() === '') return null;
  try {
    const v = JSON.parse(raw) as Partial<MailConnectionRecord>;
    if (typeof v.sealedToken !== 'string' || v.sealedToken === '') return null;
    return {
      sealedToken: v.sealedToken,
      address: typeof v.address === 'string' ? v.address : '',
      connectedAt: typeof v.connectedAt === 'string' ? v.connectedAt : '',
      status: v.status === 'stale' ? 'stale' : 'ok',
      staleReason: typeof v.staleReason === 'string' ? v.staleReason : undefined,
      updatedAt: typeof v.updatedAt === 'string' ? v.updatedAt : '',
    };
  } catch {
    return null;
  }
}

/** The record after Microsoft rotates the refresh token on redemption. */
export function rotatedMailRecord(
  record: MailConnectionRecord,
  sealedToken: string,
  nowIso: string,
): MailConnectionRecord {
  return { ...record, sealedToken, status: 'ok', staleReason: undefined, updatedAt: nowIso };
}

/** The record after an auth failure: stale, with the reason, token kept. */
export function staleMailRecord(
  record: MailConnectionRecord,
  reason: string,
  nowIso: string,
): MailConnectionRecord {
  return { ...record, status: 'stale', staleReason: reason.slice(0, 300), updatedAt: nowIso };
}
