/**
 * The system-generated temporary password (Build Prompt 39). Admins no longer
 * type passwords: creating a user, and resetting one, mint a strong random value
 * here, which is hashed with the canonical scheme before storage and shown to
 * the creating admin exactly once. The plaintext is never stored in the clear
 * and never logged.
 *
 * Import-free (a leaf), so node strips types and unit-tests it directly.
 *
 * The alphabet drops the characters that are read wrongly when a password is
 * spoken down a phone or copied off a screen (0/O, 1/I/l), and the value is
 * grouped in fours so it can be read aloud. Sixteen characters over a
 * thirty-one character alphabet is a little under eighty bits of entropy, well
 * above anything the forced change at first sign-in has to survive.
 */

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const GROUPS = 4;
const GROUP_SIZE = 4;

/** The number of random characters in a generated password (excluding the separators). */
export const TEMPORARY_PASSWORD_CHARS = GROUPS * GROUP_SIZE;

// Rejection sampling rather than a plain modulo. `% ALPHABET.length` over a
// random byte would make the first few letters marginally likelier than the
// rest; that bias is harmless in a backup code but there is no reason to accept
// it in a credential.
const LIMIT = Math.floor(0x100000000 / ALPHABET.length) * ALPHABET.length;

function randomIndex(): number {
  for (;;) {
    const v = crypto.getRandomValues(new Uint32Array(1))[0];
    if (v < LIMIT) return v % ALPHABET.length;
  }
}

/**
 * A fresh temporary password, e.g. `K7RQ-3MTP-XW29-BHDN`. The separators are
 * part of the password: they are what the user types, and they make it far
 * easier to read back correctly.
 */
export function generateTemporaryPassword(): string {
  const groups: string[] = [];
  for (let g = 0; g < GROUPS; g++) {
    let group = '';
    for (let i = 0; i < GROUP_SIZE; i++) group += ALPHABET[randomIndex()];
    groups.push(group);
  }
  return groups.join('-');
}
