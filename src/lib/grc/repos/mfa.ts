/**
 * Per-user TOTP enrolment state, stored in the organisation-scoped `config`
 * table (the live schema has no MFA table, and inventing one is exactly the
 * phantom-schema defect class this codebase keeps paying for). Each user's
 * record lives under MFA_TOTP::<user_id> in their home organisation as JSON:
 *
 *   { secret, confirmed, backup, backupPlain? }
 *
 * `secret` is the base32 TOTP secret sealed with AES-GCM (auth/secretBox.ts,
 * keyed off GRC_SESSION_SECRET), never plaintext at rest. While enrolment is
 * pending, `backupPlain` holds the sealed backup codes so the setup screen can
 * show them once; confirming replaces it with `backup`, their SHA-256 hashes
 * only. Consuming a backup code removes its hash.
 */
import type { Client } from '@libsql/client/web';
import { getConfigValues, setConfigValue } from '@grc/repos/orgConfig';
import { hashToken } from '@grc/auth/session';

export function mfaConfigKey(userId: string): string {
  return `MFA_TOTP::${userId}`;
}

export interface MfaRecord {
  /** The sealed base32 secret. */
  secret: string;
  confirmed: boolean;
  /** SHA-256 hex hashes of the unused backup codes (confirmed records). */
  backup: string[];
  /** The sealed plaintext backup codes, present only while pending. */
  backupPlain?: string;
}

/** Parse a stored record value (exported so the middleware can share one config read). */
export function parseMfaRecord(raw: string | undefined): MfaRecord | null {
  if (!raw || raw.trim() === '') return null;
  try {
    const v = JSON.parse(raw) as Partial<MfaRecord>;
    if (typeof v.secret !== 'string' || v.secret === '') return null;
    return {
      secret: v.secret,
      confirmed: v.confirmed === true,
      backup: Array.isArray(v.backup) ? v.backup.map(String) : [],
      backupPlain: typeof v.backupPlain === 'string' ? v.backupPlain : undefined,
    };
  } catch {
    return null;
  }
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
 * Start (or restart) enrolment with a sealed secret and sealed backup codes.
 * Refused once a confirmed record exists: replacing an active second factor is
 * an administrative reset, not a self-service overwrite.
 */
export async function startEnrolment(
  db: Client,
  organizationId: string,
  userId: string,
  sealedSecret: string,
  sealedBackupCodes: string,
): Promise<boolean> {
  const existing = await getMfaRecord(db, organizationId, userId);
  if (existing?.confirmed) return false;
  await writeRecord(db, organizationId, userId, {
    secret: sealedSecret,
    confirmed: false,
    backup: [],
    backupPlain: sealedBackupCodes,
  });
  return true;
}

/** Confirm the pending enrolment, keeping only the backup-code hashes. */
export async function confirmEnrolment(
  db: Client,
  organizationId: string,
  userId: string,
  backupHashes: string[],
): Promise<boolean> {
  const existing = await getMfaRecord(db, organizationId, userId);
  if (!existing || existing.confirmed) return false;
  await writeRecord(db, organizationId, userId, {
    secret: existing.secret,
    confirmed: true,
    backup: backupHashes,
  });
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
    secret: record.secret,
    confirmed: true,
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
