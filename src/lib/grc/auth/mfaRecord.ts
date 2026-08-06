/**
 * The pure shape of a user's MFA record and its transitions (Build Prompt 34
 * extends Build Prompt 25). A record carries the active factor (its method,
 * the sealed TOTP secret when the method is the authenticator app, and the
 * backup-code hashes), an optional pending enrolment (the initial one, or a
 * method switch that keeps the active factor working until the new one
 * confirms), and the email one-time-code challenge. Older records, written
 * before methods existed, parse as the authenticator method; an older
 * unconfirmed record parses as a pending TOTP enrolment. Imports only the
 * import-free challenge module, so node strips types and unit-tests this
 * directly; the DB reads and writes live in repos/mfa.ts.
 */
// The relative import carries its extension so the module also resolves under
// plain node (the unit tests), like reports/docx/wordml.ts.
import { parseChallenge, type EmailOtpChallenge } from './emailOtp.ts';

export type MfaMethod = 'totp' | 'email';

export interface MfaRecord {
  /** The active factor's method (meaningful once confirmed). */
  method: MfaMethod;
  /** The active factor's sealed TOTP secret; '' when the method is email. */
  secret: string;
  /** True when an active factor exists. The enrolment lock keys off this. */
  confirmed: boolean;
  /** SHA-256 hex hashes of the unused backup codes (confirmed records). */
  backup: string[];
  /** The sealed plaintext backup codes, present only while an enrolment is pending. */
  backupPlain?: string;
  /** A pending enrolment or method switch, confirmed at /api/auth/mfa/confirm. */
  pendingMethod?: MfaMethod;
  /** The pending sealed TOTP secret; '' when the pending method is email. */
  pendingSecret?: string;
  /** The email one-time-code challenge (hash only, never the code). */
  challenge?: EmailOtpChallenge;
}

function asMethod(v: unknown): MfaMethod | undefined {
  return v === 'totp' || v === 'email' ? v : undefined;
}

/** Parse a stored record value (exported so the middleware can share one config read). */
export function parseMfaRecord(raw: string | undefined): MfaRecord | null {
  if (!raw || raw.trim() === '') return null;
  try {
    const v = JSON.parse(raw) as Partial<MfaRecord>;
    const record: MfaRecord = {
      method: asMethod(v.method) ?? 'totp',
      secret: typeof v.secret === 'string' ? v.secret : '',
      confirmed: v.confirmed === true,
      backup: Array.isArray(v.backup) ? v.backup.map(String) : [],
      backupPlain: typeof v.backupPlain === 'string' ? v.backupPlain : undefined,
      pendingMethod: asMethod(v.pendingMethod),
      pendingSecret: typeof v.pendingSecret === 'string' ? v.pendingSecret : undefined,
      challenge: parseChallenge(v.challenge),
    };
    // A record written before methods existed: unconfirmed with a secret means
    // a pending authenticator enrolment.
    if (!record.confirmed && !record.pendingMethod && record.secret !== '') {
      record.pendingMethod = 'totp';
      record.pendingSecret = record.secret;
    }
    // A record that is neither an active factor nor a pending enrolment says
    // nothing; treat it as not enrolled.
    if (!record.confirmed && !record.pendingMethod) return null;
    if (record.confirmed && record.method === 'totp' && record.secret === '') return null;
    return record;
  } catch {
    return null;
  }
}

/**
 * Whether a new enrolment may start. Before a factor is confirmed, always (a
 * pending enrolment is simply replaced). Once confirmed, only a switch to the
 * other method is self-service; replacing the same method's factor is an
 * administrative reset, exactly as before methods existed.
 */
export function canStartEnrolment(record: MfaRecord | null, method: MfaMethod): boolean {
  if (!record?.confirmed) return true;
  return method !== record.method;
}

/**
 * The record with a fresh pending enrolment. A confirmed record keeps its
 * active factor (and so the enrolment lock and sign-in behaviour) untouched
 * until the pending method confirms.
 */
export function startPendingRecord(
  record: MfaRecord | null,
  method: MfaMethod,
  sealedSecret: string,
  sealedBackupCodes: string,
): MfaRecord {
  const base: MfaRecord =
    record && record.confirmed ? record : { method, secret: '', confirmed: false, backup: [] };
  return {
    ...base,
    pendingMethod: method,
    pendingSecret: sealedSecret,
    backupPlain: sealedBackupCodes,
    challenge: undefined,
  };
}

/**
 * The record after the pending enrolment confirms: the pending method becomes
 * the active factor with the given backup-code hashes, and every pending and
 * challenge field is dropped. Null when nothing is pending.
 */
export function promoteRecord(record: MfaRecord, backupHashes: string[]): MfaRecord | null {
  if (!record.pendingMethod) return null;
  return {
    method: record.pendingMethod,
    secret: record.pendingMethod === 'totp' ? (record.pendingSecret ?? '') : '',
    confirmed: true,
    backup: backupHashes,
  };
}
