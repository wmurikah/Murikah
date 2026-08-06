/**
 * The email one-time-code challenge: the pure rules for the second MFA method
 * (Build Prompt 34). A 6-digit code is generated at sign-in (or at email
 * enrolment), only its SHA-256 hash is stored, and the challenge expires in
 * ten minutes, locks after five wrong guesses and works exactly once. Resends
 * sit behind a cooldown. Import-free, so node strips types and unit-tests
 * this directly; the hashing and storage live with the callers.
 */

export const OTP_LENGTH = 6;
export const OTP_TTL_MS = 10 * 60_000;
export const OTP_RESEND_COOLDOWN_MS = 60_000;
export const OTP_MAX_ATTEMPTS = 5;

export interface EmailOtpChallenge {
  /** SHA-256 hex of the code; the code itself is never stored. */
  hash: string;
  /** When the code stops working (ten minutes after issue). */
  expiresAt: string;
  /** When the code was issued, for the resend cooldown. */
  sentAt: string;
  /** Wrong guesses so far; the challenge locks at OTP_MAX_ATTEMPTS. */
  attempts: number;
  /** Single-use: set once the code has passed. */
  used?: boolean;
}

/** A fresh numeric code, uniformly random, zero-padded to six digits. */
export function generateOtpCode(): string {
  // Rejection sampling over 32-bit values keeps the distribution uniform.
  const limit = 4_294_000_000; // the largest multiple of 1e6 below 2^32
  for (;;) {
    const v = crypto.getRandomValues(new Uint32Array(1))[0];
    if (v < limit) return String(v % 1_000_000).padStart(OTP_LENGTH, '0');
  }
}

/** The challenge stored for a just-issued code. */
export function newChallenge(hash: string, nowMs: number): EmailOtpChallenge {
  return {
    hash,
    expiresAt: new Date(nowMs + OTP_TTL_MS).toISOString(),
    sentAt: new Date(nowMs).toISOString(),
    attempts: 0,
  };
}

/** Parse a stored challenge value, or undefined when absent or malformed. */
export function parseChallenge(v: unknown): EmailOtpChallenge | undefined {
  if (v == null || typeof v !== 'object') return undefined;
  const c = v as Partial<EmailOtpChallenge>;
  if (typeof c.hash !== 'string' || c.hash === '') return undefined;
  if (typeof c.expiresAt !== 'string' || typeof c.sentAt !== 'string') return undefined;
  return {
    hash: c.hash,
    expiresAt: c.expiresAt,
    sentAt: c.sentAt,
    attempts: typeof c.attempts === 'number' && c.attempts >= 0 ? c.attempts : 0,
    used: c.used === true,
  };
}

/** Milliseconds until another code may be sent; 0 when a send is allowed now. */
export function resendCooldownMs(challenge: EmailOtpChallenge | undefined, nowMs: number): number {
  if (!challenge) return 0;
  const sent = Date.parse(challenge.sentAt);
  if (!Number.isFinite(sent)) return 0;
  return Math.max(0, sent + OTP_RESEND_COOLDOWN_MS - nowMs);
}

export type OtpCheck = 'ok' | 'no_challenge' | 'used' | 'locked' | 'expired' | 'wrong';

/**
 * Judge one guess against the challenge. The order matters: a used or locked
 * challenge never says 'wrong' (guessing tells the caller nothing more), and
 * expiry is checked before the hash so an old code cannot pass.
 */
export function checkOtpAttempt(
  challenge: EmailOtpChallenge | undefined,
  codeHash: string,
  nowMs: number,
): OtpCheck {
  if (!challenge) return 'no_challenge';
  if (challenge.used) return 'used';
  if (challenge.attempts >= OTP_MAX_ATTEMPTS) return 'locked';
  const expires = Date.parse(challenge.expiresAt);
  if (!Number.isFinite(expires) || nowMs > expires) return 'expired';
  return codeHash === challenge.hash ? 'ok' : 'wrong';
}
