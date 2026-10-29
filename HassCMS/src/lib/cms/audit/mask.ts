/**
 * The masked-key list, maintained in one place.
 *
 * Section 4 of the phase is explicit about why this exists: the earlier
 * phases were told never to write a secret into an audit row, and this
 * assumes one slipped through anyway, because that is what a control does. A
 * control that only works when everything upstream worked is not a control.
 *
 * MASKING IS UNCONDITIONAL. There is no permission that reveals a masked
 * value, not for a system administrator and not behind Technical Details.
 * The reason is that nobody has a legitimate need for a historical password
 * hash or a session token: knowing the field changed is the audit fact, and
 * the value itself is only useful to somebody attacking the account. So the
 * renderer says the field changed and refuses to say to what.
 *
 * The match is on the key, case-insensitively, by substring, on both the
 * leaf name and the full dotted path. Substring rather than exact because
 * the same secret reaches a JSON payload under half a dozen spellings
 * (`passwordHash`, `password_hash`, `pwdHash`, `hash`), and a list of exact
 * names is a list somebody will forget to extend.
 */

/**
 * Fragments that make a key sensitive. Lower case; the comparison lowercases
 * the key before testing.
 *
 * `hash` on its own is deliberately here even though it also matches an
 * innocent `file_hash`. Masking an import file's checksum costs a reader
 * nothing; revealing a password hash costs an account. When the two collide,
 * the safe reading wins, and `fileHash` is exempted below because it is a
 * real field a reader legitimately needs.
 */
const SENSITIVE_FRAGMENTS: readonly string[] = [
  'password',
  'passwd',
  'pwd',
  'hash',
  'secret',
  'token',
  'credential',
  'otp',
  'mfa',
  'totp',
  'backup_code',
  'backupcode',
  'recovery_code',
  'recoverycode',
  'private_key',
  'privatekey',
  'session',
  'cookie',
  'salt',
  'auth_token',
  'api_key',
  'apikey',
  'bearer',
];

/**
 * Keys that contain a sensitive fragment and are nonetheless safe.
 *
 * Kept short and justified one by one. Everything not on this list that
 * matches a fragment is masked, so the failure mode of forgetting to add
 * something here is an over-masked field, which a reader can ask about.
 */
const EXEMPT_KEYS: readonly string[] = [
  // The uploaded file's content hash. It is the duplicate-detection rule the
  // Upload Centre reports on screen, and it is a checksum of a spreadsheet.
  'filehash',
  'file_hash',
  'contenthash',
  'content_hash',
  // The session's own identifier as an audit subject: an investigator needs
  // to say which session, and the id is not the credential. The credential is
  // `session_token`, which is not exempt.
  'sessionid',
  'session_id',
];

export const MASKED_PLACEHOLDER = 'Hidden';

/** True where a key must never have its value rendered. */
export function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  const leaf = (lower.split('.').pop() ?? lower).trim();
  if (EXEMPT_KEYS.includes(leaf) || EXEMPT_KEYS.includes(lower)) return false;
  return SENSITIVE_FRAGMENTS.some(
    (fragment) => leaf.includes(fragment) || lower.includes(fragment),
  );
}

/**
 * A whole JSON payload with every sensitive value replaced, recursively.
 *
 * Used for the Technical Details disclosure, so that even the raw view a
 * privileged principal sees carries no secret. The alternative, showing raw
 * JSON as it was stored, would make the disclosure the one hole in the
 * control.
 */
export function maskPayload(value: unknown, path = ''): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value))
    return value.map((item, index) => maskPayload(item, `${path}.${index}`));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      const full = path === '' ? key : `${path}.${key}`;
      out[key] = isSensitiveKey(full) ? MASKED_PLACEHOLDER : maskPayload(inner, full);
    }
    return out;
  }
  return value;
}

/** The masked payload as a string, for rendering. Never throws on a cycle. */
export function maskedJson(raw: string | null): string | null {
  if (raw === null) return null;
  try {
    return JSON.stringify(maskPayload(JSON.parse(raw)), null, 2);
  } catch {
    // Not JSON. It could be anything, including a bare token somebody stored
    // as a string, so it is not rendered at all rather than rendered raw.
    return 'Not valid JSON. The stored value is not shown.';
  }
}
