/**
 * Pure validation and normalisation for the Setup module forms. Import-free (a
 * leaf), so node can strip types and unit-test it, and so the API endpoints and
 * the pages share one set of rules. These decide only shape and safety; the
 * repositories enforce uniqueness and references against the database.
 */

/** Normalise a natural code: upper case, trimmed, spaces and runs to a single underscore. */
export function normaliseCode(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);
}

/** A code is one to thirty-two characters of upper-case letters, digits and underscores. */
export function isValidCode(code: string): boolean {
  return /^[A-Z0-9][A-Z0-9_]{0,31}$/.test(code);
}

/** A pragmatic email check: something@something.tld, no spaces. */
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

/** A trimmed required string within a maximum length, or null when empty or too long. */
export function requireText(raw: string | null | undefined, max: number): string | null {
  if (raw == null) return null;
  const t = raw.trim();
  if (t === '' || t.length > max) return null;
  return t;
}

/** A trimmed optional string within a maximum length; empty becomes null. */
export function optionalText(raw: string | null | undefined, max: number): string | null {
  if (raw == null) return null;
  const t = raw.trim();
  if (t === '') return null;
  return t.slice(0, max);
}

/** A password meets the minimum: at least eight characters. */
export function isValidInitialPassword(pw: string): boolean {
  return pw.length >= 8;
}
