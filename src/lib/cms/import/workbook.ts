/**
 * Reading legacy .xls workbooks with SheetJS, and the normalisations every
 * importer shares.
 *
 * SheetJS parses the Composite Document container directly and NEVER
 * executes anything: macros in a workbook are inert bytes to it, there is no
 * evaluation engine attached, and this module only ever reads cell values.
 * The uploaded file itself is never modified.
 *
 * EXCEL STORES DATES AS DAY SERIALS AND NUMBERS AS FLOATS.
 * 46144.45520833333 is a moment in time; 3988 in a text-shaped column is a
 * document number that must become the string "3988", not "3988.0", or every
 * re-upload of the same file mints a new order. The two normalisers below
 * are those rules, used by every importer so the hashing is stable.
 */
import * as XLSX from 'xlsx';

export interface ParsedSheet {
  sheetName: string;
  /** Discovered at runtime, in file order. Never assumed. */
  headers: string[];
  /** One record per data row, keyed by the discovered headers. */
  rows: Record<string, unknown>[];
}

export function parseWorkbook(buffer: ArrayBuffer | Uint8Array): ParsedSheet {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  const sheetName = workbook.SheetNames[0] ?? '';
  const sheet = workbook.Sheets[sheetName];
  if (sheet === undefined) throw new Error('The workbook has no sheets.');
  const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true });
  const headerRow = (grid[0] ?? []).map((h) => String(h ?? '').trim());
  const rows: Record<string, unknown>[] = [];
  for (const line of grid.slice(1)) {
    if (
      !Array.isArray(line) ||
      line.every((cell) => cell === null || cell === undefined || cell === '')
    ) {
      continue;
    }
    const record: Record<string, unknown> = {};
    headerRow.forEach((header, index) => {
      if (header !== '') record[header] = line[index] ?? null;
    });
    rows.push(record);
  }
  return { sheetName, headers: headerRow.filter((h) => h !== ''), rows };
}

/** Days between 1899-12-30 (Excel's epoch) and 1970-01-01. */
const EXCEL_EPOCH_OFFSET_DAYS = 25569;

/**
 * An Excel day serial to "YYYY-MM-DD HH:MM:SS". Serials carry float noise
 * (46144.502337962964 is 12:03:22 and a bit), so the result is rounded to
 * the nearest second, which is the precision the source data actually has.
 */
export function excelSerialToTimestamp(serial: number): string {
  const ms = Math.round((serial - EXCEL_EPOCH_OFFSET_DAYS) * 86400 * 1000);
  const rounded = Math.round(ms / 1000) * 1000;
  const date = new Date(rounded);
  const pad = (n: number) => String(n).padStart(2, '0');
  const y = date.getUTCFullYear();
  const mo = pad(date.getUTCMonth() + 1);
  const d = pad(date.getUTCDate());
  const h = pad(date.getUTCHours());
  const mi = pad(date.getUTCMinutes());
  const se = pad(date.getUTCSeconds());
  return y + '-' + mo + '-' + d + ' ' + h + ':' + mi + ':' + se;
}

/** A cell that should be a timestamp, whatever shape Excel gave it. */
export function cellToTimestamp(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return excelSerialToTimestamp(value);
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/.test(text)) {
    return text.length === 10 ? text + ' 00:00:00' : text.replace('T', ' ');
  }
  return null;
}

/**
 * A cell that identifies something: 3988 and "3988.0" and " 3988 " are all
 * the document "3988". Without this, every re-upload creates a new order.
 */
export function cellToIdentifier(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Number.isInteger(value) ? String(value) : String(value).replace(/\.0+$/, '');
  }
  const text = String(value).trim();
  if (text === '') return null;
  if (/^\d+\.0+$/.test(text)) return text.replace(/\.0+$/, '');
  return text;
}

export function cellToText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

export function cellToNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The canonical row hash. Keys sorted, values normalised to one
 * representation each (identifiers, timestamps and trimmed text), nulls as
 * one token. A harmless Excel reformat that changes float widths or
 * whitespace produces the same hash; a real change does not.
 */
export async function hashCanonicalRow(canonical: Record<string, unknown>): Promise<string> {
  const keys = Object.keys(canonical).sort();
  const parts = keys.map((key) => {
    const value = canonical[key];
    const rendered = value === null || value === undefined ? String.fromCharCode(0) : String(value);
    return key + '=' + rendered;
  });
  const bytes = new TextEncoder().encode(parts.join(String.fromCharCode(1)));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The whole file's hash, for the exact-file duplicate rule. */
export async function hashFile(buffer: ArrayBuffer | Uint8Array): Promise<string> {
  const view = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const digest = await crypto.subtle.digest('SHA-256', view as never);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
