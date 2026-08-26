/**
 * Validation for the sign-in payload.
 *
 * Runs before any database call, so a malformed or oversized body costs one
 * parse rather than a round trip to Turso. Hand-rolled to match the repository,
 * which validates the same way in src/lib/validation.ts rather than carrying a
 * validation dependency.
 *
 * The limits are upper bounds against abuse, not policy. A minimum password
 * length is deliberately not enforced here: at sign-in the only question is
 * whether the credential matches, and rejecting a short password with its own
 * message would tell an attacker that the stored password is longer than what
 * they tried. Password policy belongs at the point a password is set.
 */

/** Generous enough for any real address, short enough to bound the work. */
export const MAX_EMAIL_LENGTH = 254; // RFC 5321 practical maximum
/** PBKDF2 cost is independent of input length, so this only bounds the body. */
export const MAX_PASSWORD_LENGTH = 1024;
/** A whole sign-in body has no business being larger than this. */
export const MAX_BODY_BYTES = 4096;

export interface LoginInput {
  /** Lower-cased and trimmed. users.email is COLLATE NOCASE, but normalise anyway. */
  email: string;
  password: string;
}

export type LoginInputResult =
  | { readonly ok: true; readonly value: LoginInput }
  | { readonly ok: false; readonly reason: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Normalise an email for lookup and for `login_attempts.email_attempted`.
 * `users.email` is COLLATE NOCASE so the database would match either way; doing
 * it here as well means the recorded attempt and the lookup agree, and a stored
 * value never depends on how the caller happened to type it.
 */
export function normaliseEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function parseLoginInput(raw: unknown): LoginInputResult {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, reason: 'body_not_an_object' };
  }
  const body = raw as Record<string, unknown>;

  if (typeof body.email !== 'string') return { ok: false, reason: 'email_missing' };
  if (typeof body.password !== 'string') return { ok: false, reason: 'password_missing' };
  if (body.email.length > MAX_EMAIL_LENGTH) return { ok: false, reason: 'email_too_long' };
  if (body.password.length > MAX_PASSWORD_LENGTH) return { ok: false, reason: 'password_too_long' };

  const email = normaliseEmail(body.email);
  if (email.length === 0) return { ok: false, reason: 'email_empty' };
  if (!EMAIL_RE.test(email)) return { ok: false, reason: 'email_malformed' };
  if (body.password.length === 0) return { ok: false, reason: 'password_empty' };

  return { ok: true, value: { email, password: body.password } };
}
