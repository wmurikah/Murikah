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
import { seal } from '@grc/auth/secretBox';
import {
  parseMfaRecord,
  canStartEnrolment,
  startPendingRecord,
  promoteRecord,
  withEmailDefault,
  switchToEmailRecord,
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
 * The user's record under universal verification (Build Prompt 37): the
 * stored one, or the automatic email default. A missing or unconfirmed
 * record is persisted in its email-default form, so the account verifies by
 * email the moment it exists, with no enrolment step. Provisioning also mints
 * the first set of backup codes, so a temporarily unavailable inbox never
 * locks anyone out; the sealed plaintext rides along for the one showing on
 * the account security screen. A record already carrying codes, or one whose
 * pending enrolment owns `backupPlain` and confirms its own set, is left
 * alone.
 */
export async function ensureMfaRecord(
  db: Client,
  organizationId: string,
  userId: string,
  sessionSecret: string,
): Promise<MfaRecord> {
  const existing = await getMfaRecord(db, organizationId, userId);
  const effective = withEmailDefault(existing);
  // No unused codes and none waiting to be shown: mint a set. This covers the
  // first sign-in and the user who has spent every code they had.
  const mintCodes = effective.backup.length === 0 && effective.backupPlain === undefined;
  if (mintCodes) {
    const codes = generateBackupCodes();
    effective.backup = await hashBackupCodes(codes);
    effective.backupPlain = await seal(sessionSecret, JSON.stringify(codes));
  }
  if (mintCodes || !existing?.confirmed) await writeRecord(db, organizationId, userId, effective);
  return effective;
}

/** Switch the active factor back to email codes: immediate, backup codes kept. */
export async function switchToEmail(
  db: Client,
  organizationId: string,
  userId: string,
): Promise<void> {
  const existing = await getMfaRecord(db, organizationId, userId);
  await writeRecord(db, organizationId, userId, switchToEmailRecord(existing));
}

/**
 * Replace the backup codes on the active record: the hashes for verification
 * and the sealed plaintext so the security screen can show them once. Refused
 * while an enrolment is pending, because that flow owns backupPlain and
 * confirms its own fresh set.
 */
export async function replaceBackupCodes(
  db: Client,
  organizationId: string,
  userId: string,
  hashes: string[],
  sealedPlain: string,
): Promise<boolean> {
  const existing = withEmailDefault(await getMfaRecord(db, organizationId, userId));
  if (existing.pendingMethod) return false;
  await writeRecord(db, organizationId, userId, {
    ...existing,
    backup: hashes,
    backupPlain: sealedPlain,
  });
  return true;
}

/** Drop the sealed shown-once plaintext after the user has saved the codes. */
export async function hideBackupCodes(
  db: Client,
  organizationId: string,
  userId: string,
): Promise<void> {
  const existing = await getMfaRecord(db, organizationId, userId);
  if (!existing?.backupPlain || existing.pendingMethod) return;
  await writeRecord(db, organizationId, userId, { ...existing, backupPlain: undefined });
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
