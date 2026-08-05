/**
 * A small AES-GCM sealed box for values that must rest encrypted (the TOTP
 * secret and the unconfirmed backup codes). The key is derived from
 * GRC_SESSION_SECRET (SHA-256 of its raw bytes), so no key material lives in
 * the repository or the database; losing the worker secret invalidates the
 * boxes, which for second-factor material is the safe failure. Only the
 * WebCrypto global is used, so this runs in the Worker and under node tests.
 */

function secretBytes(secret: string): Uint8Array<ArrayBuffer> {
  const binary = atob(secret);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toB64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromB64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function aesKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest('SHA-256', secretBytes(secret));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** Encrypt a value; the result is `ivB64.cipherB64`. */
export async function seal(secret: string, plaintext: string): Promise<string> {
  const key = await aesKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  return `${toB64(iv)}.${toB64(new Uint8Array(cipher))}`;
}

/** Decrypt a sealed value, or null when the box is malformed or tampered with. */
export async function open(secret: string, sealed: string): Promise<string | null> {
  try {
    const dot = sealed.indexOf('.');
    if (dot <= 0) return null;
    const key = await aesKey(secret);
    const iv = fromB64(sealed.slice(0, dot));
    const cipher = fromB64(sealed.slice(dot + 1));
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}
