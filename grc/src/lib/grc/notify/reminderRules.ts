/**
 * The reminder schedule rules, pure and import-free so node strips types and
 * unit-tests this directly. The values themselves come from each organisation's
 * `config` rows (the Settings screen edits STALE_REMINDER_DAYS and
 * OVERDUE_REMINDER_DAY); these functions turn those stored strings into safe
 * numbers and weekdays, falling back to the shipped defaults when a value is
 * missing or nonsense.
 */

/** The default stale-draft window, when the organisation has not configured one. */
export const DEFAULT_STALE_REMINDER_DAYS = 3;

/** The default weekday for the weekly overdue reminder (Monday). */
export const DEFAULT_OVERDUE_REMINDER_DAY = 1;

/**
 * How far ahead the approaching-deadline reminder looks: an action plan due
 * within this many days (and not yet overdue) reminds its owners.
 */
export const DUE_SOON_DAYS = 3;

/** A configured positive integer of days, or the fallback when unset or nonsense. */
export function reminderDays(raw: string | undefined | null, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n <= 365 ? Math.floor(n) : fallback;
}

const WEEKDAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;

/**
 * Parse a configured weekday ("Monday", "monday", or a 0-6 number with Sunday
 * as 0, matching Date.getUTCDay) to its day index, or null when unrecognised.
 */
export function parseWeekday(raw: string | undefined | null): number | null {
  if (raw == null) return null;
  const v = raw.trim().toLowerCase();
  if (v === '') return null;
  if (/^[0-6]$/.test(v)) return Number(v);
  const index = WEEKDAYS.indexOf(v as (typeof WEEKDAYS)[number]);
  return index === -1 ? null : index;
}

/**
 * Whether the weekly overdue reminder runs today for an organisation, given its
 * configured day (defaulting to Monday when unset or unrecognised).
 */
export function overdueRunsToday(
  configuredDay: string | undefined | null,
  utcDay: number,
): boolean {
  return (parseWeekday(configuredDay) ?? DEFAULT_OVERDUE_REMINDER_DAY) === utcDay;
}
