/**
 * Password hashing and verification with PBKDF2 (WebCrypto crypto.subtle),
 * SHA-256 and a per-user random salt. The iteration count is embedded in the
 * stored string, so it can be raised later without breaking existing hashes.
 *
 * Stored format, written to the users.password_hash column as one value:
 *   pbkdf2$<iterations>$<saltBase64>$<hashBase64>
 *
 * crypto.subtle is native in both the Cloudflare Worker and Node 22 (the
 * bootstrap script), so the same code hashes on the server and at bootstrap.
 */

// WebCrypto PBKDF2 is native, so this stays well within the Worker CPU budget.
const ITERATIONS = 60_000;
const KEY_LEN_BITS = 256; // SHA-256 output width
const SALT_BYTES = 16;

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
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(plain),
    { name: 'PBKDF2' },
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    keyMaterial,
    KEY_LEN_BITS,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(plain: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(plain, salt, ITERATIONS);
  return `pbkdf2$${ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`;
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1) return false;
  const salt = fromBase64(parts[2]);
  const expected = fromBase64(parts[3]);
  const actual = await derive(plain, salt, iterations);
  return timingSafeEqual(actual, expected);
}

// Constant-time compare, so verification does not leak the hash byte by byte.
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
