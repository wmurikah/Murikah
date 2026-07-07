/**
 * Hass CMS password hashing and verification.
 *
 * The live schema stores users.password_hash as `pbkdf2$iter$salt$hash`, the
 * same PBKDF2-HMAC-SHA-256 scheme Engineering Rhythm and GRC use (iteration count
 * embedded in the string, a base64 salt, a 32-byte derived key, standard base64,
 * constant-time compare). So the three products reuse one implementation and the
 * scheme cannot drift: this re-exports Engineering Rhythm's hasher and verifier,
 * imported, not modified.
 *
 * The verifier trims the stored value first, so a stray leading or trailing
 * whitespace on the column can never make a correct password fail.
 */
import { hashPassword, verifyPassword as sharedVerifyPassword } from '@engr/auth/password';

export { hashPassword };

/** Verify a password against a stored pbkdf2$iterations$salt$hash value. */
export function verifyPassword(plain: string, stored: string): Promise<boolean> {
  return sharedVerifyPassword(plain, stored.trim());
}
