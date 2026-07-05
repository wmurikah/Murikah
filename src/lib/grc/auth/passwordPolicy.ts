/**
 * The new-password rules for the change-password flow, kept as a pure, import-free
 * leaf so node can strip types and unit-test it directly. The endpoint verifies
 * the current password against the stored hash separately; this validates only
 * the requested new value: a minimum length, that it differs from the current
 * password, and that the confirmation matches. British spelling; no policy on
 * character classes beyond length, so a long passphrase is welcome.
 */

export const MIN_PASSWORD_LENGTH = 12;

export interface PasswordCheck {
  ok: boolean;
  /** A single, user-facing reason when the check fails. */
  error?: string;
}

/**
 * Validate a requested password change. `current` is the plaintext the user
 * entered as their current password (already verified by the caller), so the
 * "must differ" rule compares plaintext to plaintext.
 */
export function checkNewPassword(current: string, next: string, confirm: string): PasswordCheck {
  if (next.length < MIN_PASSWORD_LENGTH) {
    return {
      ok: false,
      error: `The new password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    };
  }
  if (next === current) {
    return { ok: false, error: 'The new password must be different from your current one.' };
  }
  if (next !== confirm) {
    return { ok: false, error: 'The new password and its confirmation do not match.' };
  }
  return { ok: true };
}
