/**
 * Server-side record numbers for leads, opportunities and cases.
 *
 * THE NUMBER IS NEVER ACCEPTED FROM A CLIENT.
 * No validator in this product reads `leadNumber`, `opportunityNumber` or
 * `caseNumber` from a payload. A caller cannot choose one, so a caller cannot
 * collide with one deliberately or reuse one to overwrite somebody else's
 * record.
 *
 * WHY NOT MAX() + 1
 * `SELECT MAX(...) + 1` reads, then writes, with a gap in between. Two requests
 * that read the same maximum both compute the same next value and one of them
 * fails, or worse, both succeed against a column that is not unique. libSQL over
 * HTTP gives no transaction spanning the two, and this product runs on Workers
 * where "two requests at once" is the normal case rather than the unlucky one.
 *
 * THE FORMAT
 *   {PREFIX}-{YYYY}-{10 lowercase hex characters}
 * for example `LD-2026-9f2c4ab103`.
 *
 * The year prefix is the part a human reads: it sorts, it groups by season, and
 * it matches the shape of the seeded `LD-2026-0001`. The suffix is 40 bits of
 * `crypto.getRandomValues`, which is not a sequence and makes no claim to be
 * one. That is the deliberate trade: the seeded numbers are consecutive and
 * these are not, because a consecutive number is exactly the thing that cannot
 * be produced safely without a lock this database does not offer.
 *
 * 40 bits is about 1.1e12 values. At ten thousand records in a year the chance
 * of any collision at all is under one in twenty thousand, and a collision is
 * not a failure anyway: see below.
 *
 * THE UNIQUENESS GUARANTEE IS THE DATABASE, NOT THIS FUNCTION.
 * `leads.lead_number`, `opportunities.opportunity_number` and
 * `service_cases.case_number` are each UNIQUE. `withGeneratedNumber` attempts
 * the write, and if the database refuses it on that column it generates a fresh
 * number and tries again. So correctness does not rest on the odds: it rests on
 * the constraint, and the randomness only makes retries rare.
 */

/** How many times a write is retried on a number collision before giving up. */
export const NUMBER_ATTEMPTS = 5;

const HEX = 5; // bytes, rendered as 10 hex characters

/**
 * A record number for a given prefix and moment.
 *
 * `now` is passed in rather than read here, so a test can fix the year and so
 * the number agrees with the `created_at` written in the same statement.
 */
export function generateNumber(prefix: string, now: Date): string {
  const bytes = crypto.getRandomValues(new Uint8Array(HEX));
  const suffix = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${prefix}-${now.getUTCFullYear()}-${suffix}`;
}

/** Whether a thrown error is the database refusing this specific number column. */
export function isNumberCollision(error: unknown, column: string): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /UNIQUE constraint failed/i.test(message) && message.includes(column);
}

/**
 * Run a write that needs a generated number, retrying only on that collision.
 *
 * Every other failure propagates untouched on the first attempt. A retry loop
 * that swallowed, say, a foreign key violation would turn a caller's mistake
 * into five identical failures and then a misleading error about numbering.
 *
 * The generated number is passed to the callback rather than returned, because
 * the caller must use the same value in the row it writes and in whatever it
 * reports back. Generating one and then generating another inside the write is
 * how a record ends up with a number the response does not mention.
 */
export async function withGeneratedNumber<T>(
  prefix: string,
  column: string,
  now: Date,
  write: (recordNumber: string) => Promise<T>,
): Promise<T> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < NUMBER_ATTEMPTS; attempt++) {
    const recordNumber = generateNumber(prefix, now);
    try {
      return await write(recordNumber);
    } catch (error) {
      if (!isNumberCollision(error, column)) throw error;
      lastError = error;
    }
  }
  // Five collisions in a row on a 40-bit space is not bad luck; it is a signal
  // that something is wrong with the randomness or the column. Say so rather
  // than looping for ever.
  throw new Error(
    `Could not allocate a unique ${column} after ${NUMBER_ATTEMPTS} attempts: ${String(lastError)}`,
  );
}

/** The prefixes this product uses. Named once so no caller invents a sixth. */
export const NUMBER_PREFIX = {
  lead: 'LD',
  opportunity: 'OPP',
  case: 'CS',
} as const;
