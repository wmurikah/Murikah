/**
 * GRC password hashing and verification.
 *
 * The two products reuse one implementation so their PBKDF2 scheme cannot drift:
 * this re-exports Engineering Rhythm's hasher and verifier, whose parameters
 * match the seeded hassaudit hashes exactly (PBKDF2 with HMAC-SHA-256, the
 * iteration count read from the stored string, a 16-byte salt base64-decoded to
 * raw bytes, a 32-byte derived key, standard base64, and a constant-time
 * compare). Engineering Rhythm's module is imported, not modified.
 *
 * The only GRC-side addition is to trim the stored value before parsing, so a
 * stray leading or trailing whitespace or a trailing newline on the
 * users.password_hash column can never make a correct password fail.
 */
import { hashPassword, verifyPassword as sharedVerifyPassword } from '@engr/auth/password';

export { hashPassword };

/** Verify a password against a stored pbkdf2$iterations$salt$hash value. */
export function verifyPassword(plain: string, stored: string): Promise<boolean> {
  return sharedVerifyPassword(plain, stored.trim());
}
