/**
 * The extract filename, read as a CLAIM.
 *
 * The monthly extracts arrive named PROCESS-ENTITY-FROMDATE-TODATE:
 *
 *   SALES-KE-01AUG2026-24AUG2026.xls
 *   PURCHASE-DRC-01AUG2026-24AUG2026.xls
 *   SALES-TERMINAL-01AUG2026-24AUG2026.xls
 *
 * The purchase order extract carries no affiliate column at all, so this name
 * is the ONLY place its country exists. That makes the name worth reading —
 * and worth distrusting. Anyone can rename a file, so nothing parsed here is
 * evidence: it PROPOSES, the file's own columns outrank it, and the operator
 * confirms before anything is written. The resolution order lives in
 * uploadCentre.ts; this module only answers "what does the name say".
 *
 * STRICT, AND LOUD ABOUT FAILING. A name that does not match the shape
 * exactly yields null — no prefix sniffing, no "first two letters", no
 * loose date reading. Half-understanding a name is how a mis-shaped name
 * imports as the wrong country; refusing to parse costs one operator
 * selection and loses nothing. The one relaxation is the extension's case,
 * because Windows saves .XLS and the extension claims nothing.
 *
 * Pure over its input: no database, no DOM, no clock. The token is matched
 * against affiliates.extract_code by the caller, never interpreted here.
 */

export type ExtractProcess = 'SALES' | 'PURCHASE';

/** Which process token each import type expects to find in the name. */
export const EXTRACT_PROCESS_FOR_IMPORT: Readonly<Record<string, ExtractProcess>> = {
  SALES_ORDER: 'SALES',
  PURCHASE_ORDER: 'PURCHASE',
};

export interface ExtractNameClaim {
  process: ExtractProcess;
  /** The entity token, exactly as the name carries it. Not yet an affiliate. */
  entityToken: string;
  /** ISO dates, YYYY-MM-DD, derived from the DDMMMYYYY pair. */
  periodFrom: string;
  periodTo: string;
}

const SHAPE =
  /^(SALES|PURCHASE)-([A-Z][A-Z0-9]*)-(\d{2})([A-Z]{3})(\d{4})-(\d{2})([A-Z]{3})(\d{4})\.(?:xls|xlsx)$/;

const MONTHS: Readonly<Record<string, number>> = {
  JAN: 1,
  FEB: 2,
  MAR: 3,
  APR: 4,
  MAY: 5,
  JUN: 6,
  JUL: 7,
  AUG: 8,
  SEP: 9,
  OCT: 10,
  NOV: 11,
  DEC: 12,
};

/**
 * A DDMMMYYYY token as an ISO date, or null.
 *
 * A real calendar date, verified by round-trip: 31FEB2026 builds a Date that
 * lands in March, the round-trip disagrees, and the token is refused rather
 * than quietly becoming the 3rd of March. The year is bounded to the range a
 * reporting extract can honestly claim.
 */
function isoDate(day: string, monthToken: string, year: string): string | null {
  const month = MONTHS[monthToken];
  if (month === undefined) return null;
  const dayNumber = Number(day);
  const yearNumber = Number(year);
  if (yearNumber < 2000 || yearNumber > 2100) return null;
  const candidate = new Date(Date.UTC(yearNumber, month - 1, dayNumber));
  if (
    candidate.getUTCFullYear() !== yearNumber ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== dayNumber
  ) {
    return null;
  }
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${yearNumber}-${pad(month)}-${pad(dayNumber)}`;
}

/**
 * Parse an extract filename, or refuse.
 *
 * Null for anything that is not exactly the shape: a missing segment, a
 * lowercase process, an unknown month, an impossible day, a range that runs
 * backwards. The caller falls back to the operator selecting, which is what
 * happened for every upload before this phase and remains the honest floor.
 */
export function parseExtractFilename(filename: string): ExtractNameClaim | null {
  // The extension is the one case-insensitive part; everything else must be
  // exactly as the extract writer emits it.
  const normalised = filename.replace(/\.(XLS|XLSX|Xls|Xlsx|xls|xlsx)$/, (ext) =>
    ext.toLowerCase(),
  );
  const match = SHAPE.exec(normalised);
  if (match === null) return null;
  const [, process, entityToken, fromDay, fromMonth, fromYear, toDay, toMonth, toYear] = match;
  const periodFrom = isoDate(fromDay!, fromMonth!, fromYear!);
  const periodTo = isoDate(toDay!, toMonth!, toYear!);
  if (periodFrom === null || periodTo === null) return null;
  // A window that ends before it starts is not a period anybody exported; a
  // name that claims one is malformed, not merely surprising.
  if (periodTo < periodFrom) return null;
  return {
    process: process as ExtractProcess,
    entityToken: entityToken!,
    periodFrom,
    periodTo,
  };
}

/**
 * The filename's period against the period the DATA derived — a cross-check,
 * never a source. The data's range is what is in the file; the name is what
 * somebody called it. They agree when every dated row falls inside the named
 * window; anything else is worth a person's eye before commit, because it
 * means a wrong export range or a renamed file.
 *
 * Data stamps arrive as `YYYY-MM-DD HH:MM[:SS]`; only the date part is
 * compared, since the name has no time of day to be right or wrong about.
 */
export function checkClaimedPeriod(
  claim: ExtractNameClaim,
  dataFrom: string | null,
  dataTo: string | null,
): { status: 'agrees' | 'differs' | 'unchecked'; detail: string } {
  if (dataFrom === null || dataTo === null) {
    return { status: 'unchecked', detail: 'The file has no dated rows to compare against.' };
  }
  const dayOf = (stamp: string) => stamp.slice(0, 10);
  const from = dayOf(dataFrom);
  const to = dayOf(dataTo);
  if (from >= claim.periodFrom && to <= claim.periodTo) {
    return {
      status: 'agrees',
      detail: `The data (${from} to ${to}) falls inside the period the filename claims (${claim.periodFrom} to ${claim.periodTo}).`,
    };
  }
  return {
    status: 'differs',
    detail:
      `The filename says ${claim.periodFrom} to ${claim.periodTo}, but the data runs ` +
      `${from} to ${to}. Somebody exported the wrong range or renamed a file. ` +
      `The data is what is in the file, and it is what the period stays derived from.`,
  };
}
