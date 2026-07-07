/**
 * TOTP (RFC 6238) core for the CMS MFA step, ported from the source's 20_mfa.gs
 * flow. Standard parameters: HMAC-SHA1, a 30-second period, 6 digits, a base32
 * secret. Pure and import-free (only the global WebCrypto), so node strips types
 * and unit-tests it directly, and it runs unchanged in the Worker. The current
 * time is passed in, so the code is deterministic and testable; callers pass
 * `Math.floor(Date.now() / 1000)`.
 */

const DIGITS = 6;
const PERIOD = 30;

/** Decode a base32 (RFC 4648, no padding needed) secret to raw bytes. */
export function base32Decode(input: string): Uint8Array {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = input.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) continue; // skip any stray character
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

function counterBytes(counter: number): Uint8Array {
  const buf = new Uint8Array(8);
  // 64-bit big-endian counter; the high 32 bits are ~0 for any realistic time.
  let n = counter;
  for (let i = 7; i >= 0; i--) {
    buf[i] = n & 0xff;
    n = Math.floor(n / 256);
  }
  return buf;
}

async function hotp(secret: Uint8Array, counter: number, digits: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-1' }, false, [
    'sign',
  ]);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, counterBytes(counter)));
  const offset = mac[mac.length - 1] & 0x0f;
  const bin =
    ((mac[offset] & 0x7f) << 24) |
    ((mac[offset + 1] & 0xff) << 16) |
    ((mac[offset + 2] & 0xff) << 8) |
    (mac[offset + 3] & 0xff);
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export interface TotpOptions {
  period?: number;
  digits?: number;
}

/** The TOTP code for a base32 secret at a given unix time (seconds). */
export async function totpAt(
  secretBase32: string,
  timeSeconds: number,
  opts: TotpOptions = {},
): Promise<string> {
  const period = opts.period ?? PERIOD;
  const digits = opts.digits ?? DIGITS;
  const counter = Math.floor(timeSeconds / period);
  return hotp(base32Decode(secretBase32), counter, digits);
}

/**
 * Verify a submitted TOTP code against the secret, allowing +/- `window` steps
 * for clock skew (default 1, so +/- 30 seconds). A non-numeric or wrong-length
 * code is rejected without a crypto call.
 */
export async function verifyTotp(
  secretBase32: string,
  code: string,
  timeSeconds: number,
  opts: TotpOptions & { window?: number } = {},
): Promise<boolean> {
  const digits = opts.digits ?? DIGITS;
  const period = opts.period ?? PERIOD;
  const window = opts.window ?? 1;
  const trimmed = code.trim();
  if (!new RegExp(`^[0-9]{${digits}}$`).test(trimmed)) return false;
  const secret = base32Decode(secretBase32);
  const base = Math.floor(timeSeconds / period);
  for (let w = -window; w <= window; w++) {
    const candidate = await hotp(secret, base + w, digits);
    // Constant-time-ish compare over equal-length digit strings.
    let diff = 0;
    for (let i = 0; i < digits; i++) diff |= candidate.charCodeAt(i) ^ trimmed.charCodeAt(i);
    if (diff === 0) return true;
  }
  return false;
}

/** A fresh base32 secret (160 bits) for enrolment. */
export function generateSecret(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += alphabet[(value >>> bits) & 31];
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}
