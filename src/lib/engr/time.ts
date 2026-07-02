/**
 * Time in East Africa Time (Africa/Nairobi, UTC+3, no daylight saving).
 *
 * The scheduler and dispatcher never read the wall clock directly; they take a
 * Clock, so the one-month and two-week boundaries can be set and tested. All
 * date decisions are made on calendar dates in EAT, held as 'YYYY-MM-DD'
 * strings, which sort and compare lexicographically.
 *
 * This module is pure (no imports, no bindings) so it can be unit tested with
 * node:test without the Astro or Cloudflare toolchain.
 */

/** A source of the current instant. Inject a fixed clock in tests. */
export interface Clock {
  now(): Date;
}

/** The real clock. Not used inside pure date logic, only at the entry points. */
export const systemClock: Clock = {
  now: () => new Date(),
};

/** A fixed clock for tests and previews. */
export function fixedClock(instant: Date): Clock {
  return { now: () => instant };
}

export const EAT_OFFSET_MINUTES = 180;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export interface EatParts {
  year: number;
  month: number; // 1 to 12
  day: number; // 1 to 31
  hour: number; // 0 to 23
  minute: number; // 0 to 59
}

/** The EAT wall-clock parts for an instant. */
export function eatParts(instant: Date): EatParts {
  const shifted = new Date(instant.getTime() + EAT_OFFSET_MINUTES * 60_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

/** The EAT calendar date of an instant, as 'YYYY-MM-DD'. */
export function eatDateString(instant: Date): string {
  const p = eatParts(instant);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

/** Minutes since EAT midnight, 0 to 1439, for quiet-hours comparisons. */
export function eatMinutesOfDay(instant: Date): number {
  const p = eatParts(instant);
  return p.hour * 60 + p.minute;
}

/** The first ten characters of any ISO or date string, its 'YYYY-MM-DD' date. */
export function toDateString(value: string): string {
  return value.slice(0, 10);
}

/** Add whole days to a 'YYYY-MM-DD' date, returning a 'YYYY-MM-DD' date. */
export function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

/** Add whole months to a 'YYYY-MM-DD' date, clamping to the month's last day. */
export function addMonths(dateStr: string, months: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const anchor = new Date(Date.UTC(y, m - 1, 1));
  anchor.setUTCMonth(anchor.getUTCMonth() + months);
  const year = anchor.getUTCFullYear();
  const month = anchor.getUTCMonth(); // 0 to 11
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(d, lastDay);
  return `${year}-${pad2(month + 1)}-${pad2(day)}`;
}

/** Whole days from a to b (b minus a), both 'YYYY-MM-DD'. Negative if b is before a. */
export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  const au = Date.UTC(ay, am - 1, ad);
  const bu = Date.UTC(by, bm - 1, bd);
  return Math.round((bu - au) / 86_400_000);
}

/** The current year and month in EAT as 'YYYYMM', for monthly usage counters. */
export function eatYearMonth(instant: Date): string {
  const p = eatParts(instant);
  return `${p.year}${pad2(p.month)}`;
}

/** The UTC ISO instant of EAT midnight for an instant's EAT date. */
export function eatStartOfDayIso(instant: Date): string {
  return new Date(`${eatDateString(instant)}T00:00:00+03:00`).toISOString();
}

// ---------------------------------------------------------------------------
// Preventive-maintenance window logic. Kept here, with no relative imports, so
// the whole module is unit testable with node:test. Reminders fire one month
// and two weeks before a due date; all comparisons are on EAT calendar dates.
// ---------------------------------------------------------------------------

export type PmFrequency =
  | 'WEEKLY'
  | 'MONTHLY'
  | 'QUARTERLY'
  | 'BIANNUAL'
  | 'ANNUAL'
  | 'CUSTOM_DAYS';

export interface OccurrenceStamps {
  notified1mAt: string | null;
  notified2wAt: string | null;
  allocated: boolean;
}

export interface PmDecision {
  fire1m: boolean;
  fire2w: boolean;
  missed: boolean;
}

/** The one-month and two-week lead dates before a due date. */
export function leadDates(dueDate: string): { oneMonthBefore: string; twoWeeksBefore: string } {
  return {
    oneMonthBefore: addMonths(dueDate, -1),
    twoWeeksBefore: addDays(dueDate, -14),
  };
}

/**
 * What the daily scan should do for an occurrence, given today's EAT date, its
 * due date and its stamps. A reminder fires only when its window is open, the
 * due date is not yet past, and it has not already fired. Once the due date has
 * passed without allocation, the occurrence is missed.
 */
export function decidePmActions(
  todayEat: string,
  dueDate: string,
  stamps: OccurrenceStamps,
): PmDecision {
  const { oneMonthBefore, twoWeeksBefore } = leadDates(dueDate);
  const notPast = todayEat <= dueDate;
  const fire1m = !stamps.notified1mAt && notPast && todayEat >= oneMonthBefore;
  const fire2w = !stamps.notified2wAt && notPast && todayEat >= twoWeeksBefore;
  const missed = !stamps.allocated && todayEat > dueDate;
  return { fire1m, fire2w, missed };
}

/**
 * A stamp that no longer matches the date is stale and must be cleared so the
 * reminder can re-fire when its window reopens. Used by the reschedule rule when
 * a due date moves further into the future.
 */
export function staleStamps(
  todayEat: string,
  newDueDate: string,
  stamps: OccurrenceStamps,
): { clear1m: boolean; clear2w: boolean } {
  const { oneMonthBefore, twoWeeksBefore } = leadDates(newDueDate);
  const clear1m = stamps.notified1mAt != null && todayEat < oneMonthBefore;
  const clear2w = stamps.notified2wAt != null && todayEat < twoWeeksBefore;
  return { clear1m, clear2w };
}

/** The next due date after rolling forward by the schedule's frequency. */
export function nextDueDate(
  dueDate: string,
  frequency: PmFrequency,
  intervalDays: number | null,
): string {
  switch (frequency) {
    case 'WEEKLY':
      return addDays(dueDate, 7);
    case 'MONTHLY':
      return addMonths(dueDate, 1);
    case 'QUARTERLY':
      return addMonths(dueDate, 3);
    case 'BIANNUAL':
      return addMonths(dueDate, 6);
    case 'ANNUAL':
      return addMonths(dueDate, 12);
    case 'CUSTOM_DAYS':
      return addDays(dueDate, intervalDays && intervalDays > 0 ? intervalDays : 30);
  }
}
