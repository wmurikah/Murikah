/**
 * Password hashing and verification for the CMS.
 *
 * PBKDF2-HMAC-SHA-256 through `crypto.subtle`, which is native in both the
 * Cloudflare Worker and Node 22, so one implementation serves the API and the
 * bootstrap script and the two cannot drift.
 *
 * Argon2id is the better algorithm and is not available here. There is no
 * Argon2 in the Workers runtime, every Argon2 package is a native or WASM
 * dependency, and a WASM build would have to behave identically in the Node
 * bootstrap script as well. The schema anticipated this:
 * `auth_credentials.password_algorithm` permits 'PBKDF2', so storing PBKDF2
 * needs no schema change.
 *
 * WHY THIS IS NOT `@engr/auth/password`
 * Engineering Rhythm already has a PBKDF2 hasher, and the GRC platform reuses
 * it rather than writing a second one. This product deliberately does not, for
 * two reasons that are about behaviour rather than taste:
 *
 *   1. Iteration count. engr hashes at 60,000 iterations. This phase requires
 *      at least 210,000. Raising engr's value would silently change the cost of
 *      every Engineering Rhythm and GRC login, which is not this phase's call
 *      to make.
 *   2. Algorithm dispatch. engr's verifier assumes its own format, because engr
 *      has one algorithm and no column recording which was used. This database
 *      has `password_algorithm` with three permitted values and seed rows
 *      written under ARGON2ID, so verification here has to dispatch on the
 *      stored algorithm before it can parse anything.
 *
 * The stored format is self-describing, so the parameters can be raised later
 * without a migration and without breaking existing credentials:
 *
 *   pbkdf2-sha256$<iterations>$<saltBase64>$<derivedKeyBase64>
 *
 * The hash function is named as well as the family, so a future SHA-512 variant
 * is expressible in the same field. Verification reads the iteration count from
 * the string rather than from this module's constant, so a credential written
 * at 210,000 still verifies after the constant is raised to 400,000, and is
 * simply rehashed on next login by the caller if it wants to.
 */

/**
 * The work factor for newly written credentials. Raising this is a
 * configuration change, not a code change: existing credentials carry their own
 * iteration count inside the stored string and keep verifying unchanged.
 */
export const PBKDF2_ITERATIONS = 210_000;

const KEY_LEN_BITS = 256; // 32-byte derived key
const SALT_BYTES = 16;
const SCHEME = 'pbkdf2-sha256';

/** The value written to auth_credentials.password_algorithm for new rows. */
export const PASSWORD_ALGORITHM_PBKDF2 = 'PBKDF2';

/** The three values the schema's CHECK constraint permits. */
export type PasswordAlgorithm = 'ARGON2ID' | 'BCRYPT' | 'PBKDF2';

/**
 * Why a verification did not succeed. The caller records this against
 * `login_attempts`; it is never shown to the browser, which sees one generic
 * failure for every case.
 */
export type VerifyOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'mismatch' }
  /** The stored value is not parseable under its declared algorithm. */
  | { readonly ok: false; readonly reason: 'malformed_hash' }
  /**
   * The credential was written under an algorithm this runtime cannot compute.
   * The seeded placeholders (`$argon2id$DEMO_DISABLED$...`) land here, which is
   * the intent: no seeded user can sign in until the bootstrap command has
   * rewritten their credential.
   */
  | { readonly ok: false; readonly reason: 'unsupported_algorithm' };

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

/**
 * Constant-time compare. `===` on the derived keys would return early at the
 * first differing byte and leak the correct prefix through timing, which is the
 * whole reason this function exists.
 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/** Hash a new password. Returns the self-describing stored string. */
export async function hashPassword(plain: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const key = await derive(plain, salt, PBKDF2_ITERATIONS);
  return `${SCHEME}$${PBKDF2_ITERATIONS}$${toBase64(salt)}$${toBase64(key)}`;
}

/** Whether a stored string is one this module wrote and can parse. */
export function isPbkdf2Hash(stored: string): boolean {
  const parts = stored.split('$');
  return parts.length === 4 && parts[0] === SCHEME && Number.isInteger(Number(parts[1]));
}

/**
 * Verify a password against a stored credential.
 *
 * Dispatches on the algorithm recorded in the database column first, and on the
 * parameters inside the stored string second, which is the credential-migration
 * path `password_algorithm` exists for: Argon2id can be added later for new
 * credentials while every PBKDF2 credential written today still verifies.
 */
export async function verifyPassword(
  plain: string,
  stored: string,
  algorithm: string,
): Promise<VerifyOutcome> {
  const declared = algorithm.trim().toUpperCase();

  if (declared !== PASSWORD_ALGORITHM_PBKDF2) {
    // ARGON2ID and BCRYPT are permitted by the schema and cannot be computed in
    // this runtime. Burn comparable time anyway, so an old-algorithm credential
    // is not distinguishable from a wrong password by response time.
    await dummyVerify();
    return { ok: false, reason: 'unsupported_algorithm' };
  }

  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== SCHEME) {
    await dummyVerify();
    return { ok: false, reason: 'malformed_hash' };
  }
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1) {
    await dummyVerify();
    return { ok: false, reason: 'malformed_hash' };
  }

  let salt: Uint8Array<ArrayBuffer>;
  let expected: Uint8Array<ArrayBuffer>;
  try {
    salt = fromBase64(parts[2] ?? '');
    expected = fromBase64(parts[3] ?? '');
  } catch {
    await dummyVerify();
    return { ok: false, reason: 'malformed_hash' };
  }
  if (salt.length === 0 || expected.length === 0) {
    await dummyVerify();
    return { ok: false, reason: 'malformed_hash' };
  }

  const actual = await derive(plain, salt, iterations);
  return timingSafeEqual(actual, expected) ? { ok: true } : { ok: false, reason: 'mismatch' };
}

/**
 * Whether a credential should be rehashed because it was written under weaker
 * parameters than the current ones. The caller decides whether to act on it;
 * this module only reports.
 */
export function needsRehash(stored: string, algorithm: string): boolean {
  if (algorithm.trim().toUpperCase() !== PASSWORD_ALGORITHM_PBKDF2) return true;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== SCHEME) return true;
  const iterations = Number(parts[1]);
  return !Number.isInteger(iterations) || iterations < PBKDF2_ITERATIONS;
}

/**
 * A derivation of the same cost as a real verification, against a fixed
 * throwaway salt.
 *
 * The login endpoint calls this when the email is unknown, so an account that
 * does not exist costs the same as one that does with the wrong password.
 * Without it, response time answers "is this address registered?" for anyone
 * willing to time it, which is an account-enumeration oracle that no amount of
 * identical response bodies can close.
 */
const DUMMY_SALT = new Uint8Array(SALT_BYTES); // all zeroes; the value is irrelevant
export async function dummyVerify(): Promise<void> {
  await derive('dummy-verification-input', DUMMY_SALT, PBKDF2_ITERATIONS);
}
