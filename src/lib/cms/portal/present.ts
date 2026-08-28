/**
 * Presentation for the customer portal, kept out of the pages so that six
 * screens cannot drift into six house styles.
 *
 * Every function here takes a value the repository already made
 * customer-safe. None of them map an internal code to a label: that mapping
 * lives in tenant.ts and happens in the repository, before a page ever sees
 * a row, so a page cannot accidentally render a raw internal status by
 * forgetting to call something.
 */

/** Timestamps arrive as `YYYY-MM-DD HH:MM:SS` from the database. */
function parts(value: string): { date: string; time: string } | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const [date, time] = trimmed.replace('T', ' ').split(' ');
  if (date === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return { date, time: (time ?? '').slice(0, 5) };
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/**
 * "14 August 2026". Long-form rather than 14/08/2026, because a customer
 * reading a date once should not have to work out whether the day or the
 * month came first. No date library: three substrings and a lookup.
 */
export function portalDate(value: string | null): string {
  if (value === null) return 'Not available';
  const split = parts(value);
  if (split === null) return value;
  const [year, month, day] = split.date.split('-');
  const name = MONTHS[Number(month) - 1];
  if (name === undefined) return value;
  return `${Number(day)} ${name} ${year}`;
}

/** The same date with the time, for anything that changed during a day. */
export function portalDateTime(value: string | null): string {
  if (value === null) return 'Not available';
  const split = parts(value);
  if (split === null) return value;
  const date = portalDate(value);
  return split.time === '' ? date : `${date} at ${split.time}`;
}

export type PortalTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

/**
 * The colour of an order status badge.
 *
 * Nothing here is red. A customer's order being at "Processing" is not an
 * alarm, and colouring their own screen with our internal urgency would
 * invite a phone call about a state that is entirely normal. Delay is said
 * in words, once, where it applies.
 */
export function orderTone(status: string): PortalTone {
  if (status === 'Completed') return 'success';
  if (status === 'Cancelled') return 'neutral';
  if (status === 'Invoiced' || status === 'Ready' || status === 'Loading') return 'info';
  return 'neutral';
}

/** The colour of a request status badge. Only "waiting for you" stands out. */
export function caseTone(status: string): PortalTone {
  if (status === 'Resolved' || status === 'Closed') return 'success';
  if (status === 'Waiting for your reply') return 'warning';
  if (status === 'Cancelled') return 'neutral';
  return 'info';
}

/** The colour of the external promise, which is the one thing worth flagging. */
export function slaTone(state: string): PortalTone {
  if (state === 'Taking longer than our target') return 'warning';
  if (state === 'Completed') return 'success';
  if (state === 'On track') return 'info';
  return 'neutral';
}

/**
 * A file size in words. Bytes are how a database stores it and not how a
 * person reads it, and a missing size says so rather than reading as zero.
 */
export function portalSize(bytes: number | null): string {
  if (bytes === null) return 'Size not recorded';
  if (bytes < 1024) return `${bytes} bytes`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}
