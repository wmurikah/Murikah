/**
 * The type conversion for every extract, in one module, used by both
 * importers so the two cannot drift.
 *
 * A VALUE LANDS AS ITS RIGHT TYPE ON THE WAY IN. It is not written loosely
 * and repaired by a later report. Every rule below exists because the two
 * real files break it somewhere:
 *
 *   CUSTOMER_CODE      arrives as text and stays text. 100044 is an
 *                      identifier, not a quantity, and coercing it to a
 *                      number then back again is how 0100044 loses its
 *                      leading zero.
 *   DOCUMENT_NUMBER    arrives as an Excel float. 3988 must become "3988",
 *                      never "3988.0", or every re-upload of one file mints
 *                      a second order for the same document.
 *   LINE_NUMBER        the same, and it is part of the row's identity.
 *   purchase Number    arrives as text already, and is put through the same
 *                      function anyway, because "already text" is a property
 *                      of today's file rather than of the column.
 *   every date         arrives as an Excel day serial and becomes the
 *                      timestamp text the rest of this database uses.
 *
 * EMPTY IS NULL, NEVER THE EMPTY STRING. `WHERE x IS NULL` and `WHERE x = ''`
 * are different questions and the reports ask the first, so a blank cell that
 * landed as '' would be invisible to every one of them.
 *
 * UNKNOWN IS NOT ZERO. Currency, order value, quantity and unit price are
 * absent from the sales order extract, and supplier, currency and value from
 * the purchase order extract. Those columns are nullable precisely so the
 * absence can be recorded as absence. `cellToNumber` returns null for a blank
 * cell and never 0, and `absentNumber` states the same thing at a call site
 * where somebody might otherwise reach for a default.
 */

/** Days between 1899-12-30, Excel's epoch, and 1970-01-01. */
const EXCEL_EPOCH_OFFSET_DAYS = 25569;

/**
 * The timestamp text this database stores everywhere: `YYYY-MM-DD HH:MM:SS`,
 * UTC, second precision. It is ISO 8601 with the space separator SQLite's own
 * date functions and `CURRENT_TIMESTAMP` use, which is what makes an imported
 * timestamp comparable to one the application wrote.
 */
export type DbTimestamp = string;

/**
 * An Excel day serial to a timestamp. Serials carry float noise
 * (46144.502337962964 is 12:03:22 and a fraction), so this rounds to the
 * second, which is the precision the source actually has.
 */
export function excelSerialToTimestamp(serial: number): DbTimestamp {
  const ms = Math.round((serial - EXCEL_EPOCH_OFFSET_DAYS) * 86400 * 1000);
  const rounded = Math.round(ms / 1000) * 1000;
  const date = new Date(rounded);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    date.getUTCFullYear() +
    '-' +
    pad(date.getUTCMonth() + 1) +
    '-' +
    pad(date.getUTCDate()) +
    ' ' +
    pad(date.getUTCHours()) +
    ':' +
    pad(date.getUTCMinutes()) +
    ':' +
    pad(date.getUTCSeconds())
  );
}

/**
 * A cell that should be a timestamp, whatever shape Excel gave it.
 *
 * A serial becomes a timestamp; text already in the database's shape is
 * accepted and normalised (a bare date gains midnight, a `T` becomes a
 * space); anything else is null rather than a guess, because a date this
 * cannot read is a fact the importer does not have.
 */
export function cellToTimestamp(value: unknown): DbTimestamp | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return excelSerialToTimestamp(value);
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/.test(text)) {
    if (text.length === 10) return text + ' 00:00:00';
    const normalised = text.replace('T', ' ');
    return normalised.length === 16 ? normalised + ':00' : normalised;
  }
  return null;
}

/**
 * A cell that IDENTIFIES something: a document number, a line number, a
 * customer code, a product code.
 *
 * 3988, "3988.0" and " 3988 " are all the identifier "3988". The result is
 * always text, because an identifier is a name rather than a quantity: the
 * moment one is held as a number it acquires arithmetic it has no business
 * having, and a code with a leading zero loses it.
 */
export function cellToIdentifier(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    // An integral float is the common case: Excel hands back 3988 for a cell
    // that reads 3988. A genuinely fractional value keeps its fraction rather
    // than being truncated, because silently changing an identifier is worse
    // than carrying an odd-looking one to the exception queue.
    return Number.isInteger(value) ? String(value) : String(value).replace(/\.0+$/, '');
  }
  const text = String(value).trim();
  if (text === '') return null;
  if (/^\d+\.0+$/.test(text)) return text.replace(/\.0+$/, '');
  return text;
}

/** A cell that is prose or a label. Trimmed, and empty becomes NULL. */
export function cellToText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

/**
 * A cell that is genuinely a quantity.
 *
 * A blank cell is null, NEVER 0. Zero litres is a fact and an empty cell is
 * the absence of one, and a report cannot tell them apart once both are 0.
 */
export function cellToNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * What to write for a column the extract does not carry at all.
 *
 * Named rather than written as a bare `null` at the call site, so that a
 * reader of the INSERT sees a decision instead of an oversight, and so that
 * reaching for `0` here has to be a deliberate act of overwriting this.
 */
export const absentNumber: null = null;
export const absentText: null = null;

/**
 * Whether a value is a database NULL rather than an empty string.
 *
 * Used by the tests that assert criterion 14, and by the importers before a
 * write, so a value that has been through a JSON round trip cannot arrive as
 * '' and be stored as one.
 */
export function nullIfBlank<T extends string | null | undefined>(value: T): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}
