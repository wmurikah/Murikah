const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export type MfaKeyResolution = { ok: true; key: string } | { ok: false; response: Response };

/** Resolve the optional Worker secret at the point MFA is used. A partial
 * deployment returns the user to a useful screen instead of throwing a raw
 * Worker 500, while no MFA operation is allowed without the key. */
export function resolveMfaEncryptionKey(
  configured: string | undefined,
  errorLocation: string,
): MfaKeyResolution {
  if (configured) return { ok: true, key: configured };
  return {
    ok: false,
    response: new Response(null, {
      status: 303,
      headers: { location: errorLocation, 'cache-control': 'no-store' },
    }),
  };
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(input: string): Uint8Array<ArrayBuffer> {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, '');
  const output: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(output);
}

export function generateTotpSecret(): string {
  return base32Encode(crypto.getRandomValues(new Uint8Array(20)));
}

function encryptionKey(secret: string): Uint8Array<ArrayBuffer> {
  const key = fromBase64(secret);
  if (key.length !== 32) throw new Error('ENGR_MFA_ENCRYPTION_KEY must decode to 32 bytes.');
  return key;
}

export async function encryptMfaSecret(
  secret: string,
  keySecret: string,
): Promise<{ ciphertext: string; iv: string }> {
  const key = await crypto.subtle.importKey('raw', encryptionKey(keySecret), 'AES-GCM', false, [
    'encrypt',
  ]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(secret),
  );
  return { ciphertext: toBase64(new Uint8Array(ciphertext)), iv: toBase64(iv) };
}

export async function decryptMfaSecret(
  ciphertext: string,
  iv: string,
  keySecret: string,
): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encryptionKey(keySecret), 'AES-GCM', false, [
    'decrypt',
  ]);
  const clear = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(iv) },
    key,
    fromBase64(ciphertext),
  );
  return new TextDecoder().decode(clear);
}

async function totpAtStep(secret: string, step: number): Promise<string> {
  const counter = new Uint8Array(8);
  let value = BigInt(step);
  for (let i = 7; i >= 0; i--) {
    counter[i] = Number(value & 255n);
    value >>= 8n;
  }
  const key = await crypto.subtle.importKey(
    'raw',
    base32Decode(secret),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, counter));
  const offset = digest[digest.length - 1] & 15;
  const binary =
    ((digest[offset] & 127) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3];
  return String(binary % 1_000_000).padStart(6, '0');
}

export async function verifyTotp(
  secret: string,
  code: string,
  now = Date.now(),
): Promise<number | null> {
  if (!/^\d{6}$/.test(code)) return null;
  const current = Math.floor(now / 30_000);
  for (const step of [current - 1, current, current + 1]) {
    if ((await totpAtStep(secret, step)) === code) return step;
  }
  return null;
}

export function totpUri(secret: string, email: string): string {
  const label = encodeURIComponent(`Murikah Engineering:${email}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent('Murikah Engineering')}&algorithm=SHA1&digits=6&period=30`;
}

export function generateRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const raw = base32Encode(crypto.getRandomValues(new Uint8Array(7))).slice(0, 10);
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

export function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z2-7]/g, '');
}

export async function hashRecoveryCode(code: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(normalizeRecoveryCode(code)),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
