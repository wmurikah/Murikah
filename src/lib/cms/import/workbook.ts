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

// ---- The mapping report, shared by every importer -----------------------------

/**
 * What an importer does with a source column. A header the classification
 * table does not know is 'unknown': reported for review, never dropped, and
 * always present in raw_json regardless.
 */
export type HeaderTreatment = 'canonical' | 'workflow' | 'source_metric' | 'raw_only' | 'unknown';

export interface HeaderClassification {
  treatment: HeaderTreatment;
  target: string;
}

export interface MappingReportLine {
  header: string;
  treatment: HeaderTreatment;
  target: string;
  example: string;
}

/**
 * Every header the file actually carries, with its treatment, its target and
 * a real example value from the extract. The classification table is the
 * importer's; this rendering is shared, so no importer grows a second copy.
 */
export function buildMappingReport(
  classification: Readonly<Record<string, HeaderClassification>>,
  headers: string[],
  rows: Record<string, unknown>[],
): MappingReportLine[] {
  return headers.map((header) => {
    const known = classification[header];
    const example = rows
      .map((r) => r[header])
      .find((v) => v !== null && v !== undefined && v !== '');
    return {
      header,
      treatment: known?.treatment ?? 'unknown',
      target: known?.target ?? 'UNKNOWN HEADER: classified for review, imported into raw_json only',
      example: example === undefined ? 'no value in this extract' : String(example),
    };
  });
}

/**
 * Whole minutes between two "YYYY-MM-DD HH:MM:SS" stamps, or null where
 * either end is missing. Missing is missing: it never becomes zero, because
 * "the stage took no time" and "we do not know when the stage started" are
 * different facts and only one of them is true here.
 */
export function minutesBetween(from: string | null, to: string | null): number | null {
  if (from === null || to === null) return null;
  const parse = (stamp: string) => new Date(stamp.replace(' ', 'T') + 'Z').getTime();
  const start = parse(from);
  const end = parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.round((end - start) / 60000);
}

// ---- Change detection, in one read rather than one per row --------------------

/** As many keys as SQLite will bind in one statement, with room to spare. */
const KEY_CHUNK = 400;

/**
 * Every hash ever recorded against each of these source keys, outside this
 * batch.
 *
 * WHY THIS IS NOT A PER-ROW QUERY. Both importers used to ask this question
 * once per row, inside the row loop. On the sales order extract that is 1,386
 * outbound subrequests for one validation; Cloudflare's Free plan allows 50
 * per request, so the run died part-way through the loop and left the batch at
 * VALIDATING with an empty row table and every count zero. Asking once for the
 * whole key space costs a handful of reads whatever the extract's size, so a
 * validation's cost follows the number of DISTINCT keys in chunks, not the
 * number of rows.
 *
 * Chunked because a bind list has a limit, and returned as a map of key to the
 * set of hashes seen for it, which is the membership test the callers make.
 */
export async function loadPriorHashes(
  db: {
    execute: (stmt: {
      sql: string;
      args: (string | number | null)[];
    }) => Promise<{ rows: unknown[] }>;
  },
  keys: readonly string[],
  excludeBatchId: string,
): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  const distinct = [...new Set(keys)];
  for (let start = 0; start < distinct.length; start += KEY_CHUNK) {
    const slice = distinct.slice(start, start + KEY_CHUNK);
    const placeholders = slice.map(() => '?').join(', ');
    const result = await db.execute({
      sql:
        'SELECT DISTINCT source_record_key AS k, row_hash AS h FROM import_rows ' +
        'WHERE import_batch_id <> ? AND source_record_key IN (' +
        placeholders +
        ')',
      args: [excludeBatchId, ...slice],
    });
    for (const raw of result.rows) {
      const row = raw as Record<string, unknown>;
      const key = String(row.k);
      const existing = out.get(key);
      if (existing === undefined) out.set(key, new Set([String(row.h)]));
      else existing.add(String(row.h));
    }
  }
  return out;
}

// ---- Terminal states ---------------------------------------------------------

/**
 * Move a batch out of VALIDATING when the run cannot finish.
 *
 * VALIDATING IS NOT A RESTING PLACE. It means "a validation is in flight", and
 * a batch that still reads VALIDATING an hour later is telling the operator
 * something that is not true. Every exit from a validation therefore lands on
 * READY, PARTIAL or REJECTED, including the exit where the run threw.
 *
 * The batch table has no column for a reason and this phase adds no schema, so
 * the reason goes to `audit_events`, which the batch detail page already reads
 * and which is where an auditor would look for it anyway.
 */
export async function rejectBatch(
  db: {
    execute: (stmt: { sql: string; args: (string | number | null)[] }) => Promise<unknown>;
  },
  batchId: string,
  reason: string,
  audit: { actorUserId: string; now: string; auditId: string },
): Promise<void> {
  await db.execute({
    sql: `UPDATE import_batches SET status = 'REJECTED' WHERE import_batch_id = ?`,
    args: [batchId],
  });
  await db.execute({
    sql: `INSERT INTO audit_events
            (audit_event_id, actor_user_id, event_type, entity_type, entity_id, action,
             before_json, after_json, ip_address, user_agent, event_at)
          VALUES (?, ?, 'IMPORT_REJECTED', 'IMPORT_BATCH', ?, 'VALIDATE', NULL, ?, NULL, ?, ?)`,
    args: [
      audit.auditId,
      audit.actorUserId,
      batchId,
      JSON.stringify({ reason }),
      'upload-centre',
      audit.now,
    ],
  });
}

/**
 * A failure, in words an operator can act on and with nothing leaked.
 *
 * The message goes on screen and into the audit trail, so it names what broke
 * without carrying a stack trace or a row's contents into either.
 */
export function describeFailure(error: unknown): string {
  if (error instanceof Error && error.message !== '') {
    return error.message.length > 200 ? error.message.slice(0, 197) + '...' : error.message;
  }
  return 'The cause was not reported by the runtime.';
}
