/**
 * Per-user MFA enrolment state, stored in the organisation-scoped `config`
 * table (the live schema has no MFA table, and inventing one is exactly the
 * phantom-schema defect class this codebase keeps paying for). Each user's
 * record lives under MFA_TOTP::<user_id> in their home organisation as JSON;
 * the pure record shape, its parser and its transitions live in
 * auth/mfaRecord.ts, and the email one-time-code challenge rules in
 * auth/emailOtp.ts (Build Prompt 34 added the email method beside the
 * authenticator app).
 *
 * The sealed pieces (`secret`/`pendingSecret`, the TOTP secret, and
 * `backupPlain`, the unconfirmed backup codes) use AES-GCM
 * (auth/secretBox.ts, keyed off GRC_SESSION_SECRET), never plaintext at
 * rest. While an enrolment is pending, `backupPlain` holds the sealed backup
 * codes so the setup screen can show them once; confirming keeps only
 * `backup`, their SHA-256 hashes. Consuming a backup code removes its hash.
 * The email challenge stores only the code's hash.
 */
import type { Client } from '@libsql/client/web';
import { getConfigValues, setConfigValue } from '@grc/repos/orgConfig';
import { hashToken } from '@grc/auth/session';
import {
  parseMfaRecord,
  canStartEnrolment,
  startPendingRecord,
  promoteRecord,
  type MfaMethod,
  type MfaRecord,
} from '@grc/auth/mfaRecord';
import type { EmailOtpChallenge } from '@grc/auth/emailOtp';

export { parseMfaRecord };
export type { MfaMethod, MfaRecord };

export function mfaConfigKey(userId: string): string {
  return `MFA_TOTP::${userId}`;
}

/** The user's MFA record in their home organisation, or null when never enrolled. */
export async function getMfaRecord(
  db: Client,
  organizationId: string,
  userId: string,
): Promise<MfaRecord | null> {
  const key = mfaConfigKey(userId);
  const values = await getConfigValues(db, organizationId, [key]);
  return parseMfaRecord(values.get(key));
}

async function writeRecord(
  db: Client,
  organizationId: string,
  userId: string,
  record: MfaRecord,
): Promise<void> {
  await setConfigValue(db, organizationId, mfaConfigKey(userId), JSON.stringify(record));
}

/**
 * Start (or restart) an enrolment for the chosen method, with a sealed TOTP
 * secret ('' for the email method) and sealed backup codes. Before a factor
 * is confirmed a pending enrolment is simply replaced; once confirmed, only a
 * switch to the other method is allowed (the active factor keeps working
 * until the new one confirms), and replacing the same method's factor stays
 * an administrative reset, not a self-service overwrite.
 */
export async function startEnrolment(
  db: Client,
  organizationId: string,
  userId: string,
  method: MfaMethod,
  sealedSecret: string,
  sealedBackupCodes: string,
): Promise<boolean> {
  const existing = await getMfaRecord(db, organizationId, userId);
  if (!canStartEnrolment(existing, method)) return false;
  await writeRecord(
    db,
    organizationId,
    userId,
    startPendingRecord(existing, method, sealedSecret, sealedBackupCodes),
  );
  return true;
}

/** Confirm the pending enrolment: the pending method becomes the active factor. */
export async function confirmEnrolment(
  db: Client,
  organizationId: string,
  userId: string,
  backupHashes: string[],
): Promise<boolean> {
  const existing = await getMfaRecord(db, organizationId, userId);
  if (!existing) return false;
  const promoted = promoteRecord(existing, backupHashes);
  if (!promoted) return false;
  await writeRecord(db, organizationId, userId, promoted);
  return true;
}

/** Store (or replace) the email one-time-code challenge on the record. */
export async function saveMfaChallenge(
  db: Client,
  organizationId: string,
  userId: string,
  challenge: EmailOtpChallenge,
): Promise<boolean> {
  const existing = await getMfaRecord(db, organizationId, userId);
  if (!existing) return false;
  await writeRecord(db, organizationId, userId, { ...existing, challenge });
  return true;
}

/** Consume one backup code by value: true when it matched an unused hash. */
export async function consumeBackupCode(
  db: Client,
  organizationId: string,
  userId: string,
  code: string,
): Promise<boolean> {
  const record = await getMfaRecord(db, organizationId, userId);
  if (!record || !record.confirmed || record.backup.length === 0) return false;
  const hash = await hashToken(code.trim().toUpperCase());
  if (!record.backup.includes(hash)) return false;
  await writeRecord(db, organizationId, userId, {
    ...record,
    backup: record.backup.filter((h) => h !== hash),
  });
  return true;
}

/** Fresh backup codes: eight ten-character codes over an unambiguous alphabet. */
export function generateBackupCodes(): string[] {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const codes: string[] = [];
  for (let i = 0; i < 8; i++) {
    const bytes = crypto.getRandomValues(new Uint8Array(10));
    codes.push(Array.from(bytes, (b) => alphabet[b % alphabet.length]).join(''));
  }
  return codes;
}

/** The SHA-256 hex hashes of a set of backup codes, as stored after confirming. */
export async function hashBackupCodes(codes: string[]): Promise<string[]> {
  return Promise.all(codes.map((c) => hashToken(c.trim().toUpperCase())));
}
