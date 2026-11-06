/**
 * Password hashing and verification with PBKDF2-HMAC-SHA256 and a per-user
 * random salt. The iteration count
 * is embedded in the stored string, so it can be raised later without breaking
 * existing hashes.
 *
 * Stored format, written to the users.password_hash column as one value:
 *   pbkdf2$<iterations>$<saltBase64>$<hashBase64>
 *
 * Cloudflare's PBKDF2 APIs reject iteration counts above 100,000 in production.
 * Computing PBKDF2 from HMAC-SHA256 avoids that cap and preserves existing
 * 600,000-iteration hashes without resetting users' passwords.
 */
import { createHmac } from 'node:crypto';

export const PASSWORD_ITERATIONS = 600_000;
const KEY_LEN_BYTES = 32; // SHA-256 output width
const SALT_BYTES = 16;

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

/** Validate a newly chosen or administrator-issued password. Long passphrases
 * are accepted without composition rules; spaces and paste are deliberately
 * supported. */
export function validateNewPassword(plain: string): string | null {
  if (plain.length < PASSWORD_MIN_LENGTH) {
    return `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
  }
  if (plain.length > PASSWORD_MAX_LENGTH) {
    return `Use no more than ${PASSWORD_MAX_LENGTH} characters.`;
  }
  if (!plain.trim()) return 'The password cannot contain only spaces.';
  return null;
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Check a password against Have I Been Pwned without sending the password or
 * complete hash. A provider outage fails closed for new/reset passwords. */
export async function validatePasswordSecurity(
  plain: string,
  fetcher: typeof fetch = fetch,
): Promise<string | null> {
  const local = validateNewPassword(plain);
  if (local) return local;
  const digest = hex(
    await crypto.subtle.digest('SHA-1', new TextEncoder().encode(plain)),
  ).toUpperCase();
  try {
    const response = await fetcher(`https://api.pwnedpasswords.com/range/${digest.slice(0, 5)}`, {
      headers: { 'Add-Padding': 'true', 'User-Agent': 'Murikah-Engineering-Rhythm' },
    });
    if (!response.ok) throw new Error('password range unavailable');
    const suffix = digest.slice(5);
    const compromised = (await response.text())
      .split(/\r?\n/)
      .some((line) => line.split(':', 1)[0]?.trim().toUpperCase() === suffix);
    return compromised ? 'Choose a password that has not appeared in a known data breach.' : null;
  } catch {
    return 'Password safety checking is temporarily unavailable. Try again shortly.';
  }
}

export function passwordNeedsRehash(stored: string): boolean {
  const parts = stored.split('$');
  return parts.length !== 4 || parts[0] !== 'pbkdf2' || Number(parts[1]) < PASSWORD_ITERATIONS;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function derive(
  plain: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<Uint8Array> {
  // PBKDF2 block 1 is enough for a 32-byte SHA-256 output. U1 = HMAC(P,
  // salt || INT_32_BE(1)); subsequent U values hash the preceding U, and the
  // final block is their XOR. Both Node and Workers provide HMAC-SHA256.
  const block = new Uint8Array(salt.length + 4);
  block.set(salt);
  block[block.length - 1] = 1;
  const key = new TextEncoder().encode(plain);
  let u: Uint8Array = createHmac('sha256', key).update(block).digest();
  const output = new Uint8Array(u);
  for (let i = 1; i < iterations; i++) {
    u = createHmac('sha256', key).update(u).digest();
    for (let j = 0; j < KEY_LEN_BYTES; j++) output[j] ^= u[j];
  }
  return output;
}

export async function hashPassword(plain: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(plain, salt, PASSWORD_ITERATIONS);
  return `pbkdf2$${PASSWORD_ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`;
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 1_000_000) return false;
  try {
    const salt = fromBase64(parts[2]);
    const expected = fromBase64(parts[3]);
    if (salt.length !== SALT_BYTES || expected.length !== KEY_LEN_BYTES) return false;
    const actual = await derive(plain, salt, iterations);
    return timingSafeEqual(actual, expected);
  } catch {
    // A corrupt stored hash is an invalid credential, not an infrastructure
    // failure that should strand every visitor on the unavailable screen.
    return false;
  }
}

// Constant-time compare, so verification does not leak the hash byte by byte.
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
