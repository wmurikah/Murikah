/**
 * Business-calendar arithmetic, with no date library.
 *
 * Timestamps are stored in UTC. Every calculation here happens in the
 * calendar's own timezone through the platform's Intl facilities:
 * `Intl.DateTimeFormat(..., { timeZone })` with formatToParts converts a UTC
 * instant to the local wall clock, and the reverse conversion finds the UTC
 * instant for a local wall time by guessing the offset and correcting it,
 * twice, which settles even across a daylight-saving transition. Nairobi has
 * no DST, but the calendar table carries a timezone column, and a calendar
 * for a zone that does must not drift an hour twice a year.
 *
 * The model is a walk over working windows. A calendar defines, per local
 * day: is the weekday flagged working, is the date a holiday, and the window
 * [workday_start, workday_end]. `addBusinessMinutes` consumes minutes window
 * by window; `businessMinutesBetween` measures them the same way. The case
 * that must work, and is tested: a four-business-hour rule created Friday
 * 16:00 with closing at 17:00 lands Monday at 11:00, three hours after
 * Monday opens, not Saturday morning.
 */

export interface CalendarSpec {
  timezone: string;
  /** "08:00" and "17:00", the local working window. */
  workdayStart: string;
  workdayEnd: string;
  /** Monday first, seven flags. */
  days: readonly [boolean, boolean, boolean, boolean, boolean, boolean, boolean];
  /** "YYYY-MM-DD" local dates. */
  holidays: ReadonlySet<string>;
}

interface LocalTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 0 = Monday ... 6 = Sunday, matching the flags. */
  weekday: number;
  /** "YYYY-MM-DD" for the holiday lookup. */
  date: string;
}

const WEEKDAYS: Record<string, number> = {
  Mon: 0,
  Tue: 1,
  Wed: 2,
  Thu: 3,
  Fri: 4,
  Sat: 5,
  Sun: 6,
};

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timezone: string): Intl.DateTimeFormat {
  let cached = formatters.get(timezone);
  if (cached === undefined) {
    cached = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hour12: false,
      hourCycle: 'h23',
    });
    formatters.set(timezone, cached);
  }
  return cached;
}

/** A UTC instant as the calendar's local wall clock. */
export function toLocal(instant: Date, timezone: string): LocalTime {
  const parts: Record<string, string> = {};
  for (const part of formatter(timezone).formatToParts(instant)) {
    parts[part.type] = part.value;
  }
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  return {
    year,
    month,
    day,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: WEEKDAYS[parts.weekday ?? ''] ?? 0,
    date: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

/**
 * The UTC instant of a local wall time. Guess the offset from the target as
 * if it were UTC, read what that guess shows locally, correct by the
 * difference, and correct once more: the second pass settles a guess that
 * straddled a daylight-saving change. A wall time skipped by a spring-forward
 * transition lands on the instant after the gap, which is the standard,
 * least-surprising reading.
 */
export function fromLocal(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string,
): Date {
  let guess = Date.UTC(year, month - 1, day, hour, minute);
  for (let i = 0; i < 2; i++) {
    const seen = toLocal(new Date(guess), timezone);
    const seenAsUtc = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute);
    const wantAsUtc = Date.UTC(year, month - 1, day, hour, minute);
    guess += wantAsUtc - seenAsUtc;
  }
  return new Date(guess);
}

const parseHm = (value: string): { hour: number; minute: number } => {
  const [h, m] = value.split(':');
  return { hour: Number(h ?? 0), minute: Number(m ?? 0) };
};

function isWorkingDay(calendar: CalendarSpec, local: LocalTime): boolean {
  return (calendar.days[local.weekday] ?? false) && !calendar.holidays.has(local.date);
}

/** The next local day after the given one, at a wall time, as UTC. */
function nextDayAt(calendar: CalendarSpec, local: LocalTime, hour: number, minute: number): Date {
  // Adding a civil day through the local calendar: Date.UTC normalises
  // overflow (32 January becomes 1 February), which is exactly what walking
  // a wall-clock calendar needs.
  const next = new Date(Date.UTC(local.year, local.month - 1, local.day + 1));
  return fromLocal(
    next.getUTCFullYear(),
    next.getUTCMonth() + 1,
    next.getUTCDate(),
    hour,
    minute,
    calendar.timezone,
  );
}

const MAX_WALK_DAYS = 4000;

/**
 * The instant `minutes` of business time after `start`.
 *
 * Time before the window opens counts from opening; time after it closes
 * rolls to the next working day's opening. A start inside the window
 * consumes what remains of it first.
 */
export function addBusinessMinutes(calendar: CalendarSpec, start: Date, minutes: number): Date {
  const open = parseHm(calendar.workdayStart);
  const close = parseHm(calendar.workdayEnd);
  let remaining = minutes;
  let cursor = start;

  for (let step = 0; step < MAX_WALK_DAYS; step++) {
    const local = toLocal(cursor, calendar.timezone);
    if (!isWorkingDay(calendar, local)) {
      cursor = nextDayAt(calendar, local, open.hour, open.minute);
      continue;
    }
    const dayOpen = fromLocal(
      local.year,
      local.month,
      local.day,
      open.hour,
      open.minute,
      calendar.timezone,
    );
    const dayClose = fromLocal(
      local.year,
      local.month,
      local.day,
      close.hour,
      close.minute,
      calendar.timezone,
    );
    if (cursor >= dayClose) {
      cursor = nextDayAt(calendar, local, open.hour, open.minute);
      continue;
    }
    const from = cursor < dayOpen ? dayOpen : cursor;
    const available = Math.floor((dayClose.getTime() - from.getTime()) / 60000);
    if (remaining <= available) {
      return new Date(from.getTime() + remaining * 60000);
    }
    remaining -= available;
    cursor = nextDayAt(calendar, local, open.hour, open.minute);
  }
  throw new Error('Business-minute walk exceeded 4000 days: the calendar has no working days.');
}

/** Business minutes between two instants, measured by the same walk. */
export function businessMinutesBetween(calendar: CalendarSpec, from: Date, to: Date): number {
  if (to <= from) return 0;
  const open = parseHm(calendar.workdayStart);
  const close = parseHm(calendar.workdayEnd);
  let total = 0;
  let cursor = from;

  for (let step = 0; step < MAX_WALK_DAYS; step++) {
    if (cursor >= to) return total;
    const local = toLocal(cursor, calendar.timezone);
    if (!isWorkingDay(calendar, local)) {
      cursor = nextDayAt(calendar, local, open.hour, open.minute);
      continue;
    }
    const dayOpen = fromLocal(
      local.year,
      local.month,
      local.day,
      open.hour,
      open.minute,
      calendar.timezone,
    );
    const dayClose = fromLocal(
      local.year,
      local.month,
      local.day,
      close.hour,
      close.minute,
      calendar.timezone,
    );
    if (cursor >= dayClose) {
      cursor = nextDayAt(calendar, local, open.hour, open.minute);
      continue;
    }
    const windowFrom = cursor < dayOpen ? dayOpen : cursor;
    const windowTo = to < dayClose ? to : dayClose;
    if (windowTo > windowFrom) {
      total += Math.floor((windowTo.getTime() - windowFrom.getTime()) / 60000);
    }
    cursor = nextDayAt(calendar, local, open.hour, open.minute);
  }
  throw new Error('Business-minute walk exceeded 4000 days: the calendar has no working days.');
}

/**
 * Plain wall-clock arithmetic for a rule with business_hours_only = 0, kept
 * beside the calendar walk so every caller takes both paths from one module.
 */
export function addWallMinutes(start: Date, minutes: number): Date {
  return new Date(start.getTime() + minutes * 60000);
}

export function wallMinutesBetween(from: Date, to: Date): number {
  return to <= from ? 0 : Math.floor((to.getTime() - from.getTime()) / 60000);
}

/**
 * "30 minutes", "2 hours", "1 business day", "24 hours" or a bare number of
 * minutes, to minutes. A business day is the calendar's own working window,
 * so the caller passes its length. Returns null for anything unreadable
 * rather than guessing.
 */
export function parseDuration(input: string, workdayMinutes: number): number | null {
  const text = input.trim().toLowerCase();
  if (text === '') return null;
  if (/^\d+$/.test(text)) return Number(text);
  const match =
    /^(\d+(?:\.\d+)?)\s*(business\s+day|business\s+days|minute|minutes|min|mins|hour|hours|hr|hrs|h|day|days|d)$/.exec(
      text,
    );
  if (match === null) return null;
  const amount = Number(match[1]);
  const unit = match[2] ?? '';
  if (unit.startsWith('business')) return Math.round(amount * workdayMinutes);
  if (unit.startsWith('minute') || unit.startsWith('min')) return Math.round(amount);
  if (unit.startsWith('h')) return Math.round(amount * 60);
  return Math.round(amount * 24 * 60);
}
