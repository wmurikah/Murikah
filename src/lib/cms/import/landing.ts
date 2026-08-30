/**
 * Landing every parsed row, exactly as the workbook gave it.
 *
 * WHAT THESE TABLES ARE FOR. `import_rows` records what happened to a row:
 * its key, its hash, whether it was new or changed or rejected. It does not
 * record what the row SAID, except as a JSON blob nobody can query. The
 * landing tables hold the extract itself, one column per header, so a question
 * about the source data is a query rather than an archaeology exercise on a
 * spreadsheet somebody has to find again.
 *
 * NEVER DROP A VALUE. Every header goes somewhere. A header that matches a
 * column of the landing table is written to that column; a header that matches
 * nothing is written to `extra_json` and reported to the operator as an
 * unmapped column. Silence is the one outcome that is not available: a column
 * added to next month's extract must announce itself, not vanish.
 *
 * THE COLUMN LIST IS READ AT RUNTIME, not compiled in. The operator owns these
 * tables and this application never creates them, so the writer asks the
 * database what columns exist and maps to those. A header whose column has
 * been renamed, or a table that is one revision behind, then lands in
 * `extra_json` instead of throwing, which is the difference between a
 * validation that reports a surprise and one that dies of it.
 *
 * THIS IS PART OF VALIDATION, NOT OF THE COMMIT. Landing writes only to the
 * landing tables. No canonical row is created here, and the operator still has
 * to press Import valid records for anything to reach `sales_orders` or
 * `purchase_orders`.
 */
import type { Client } from '@libsql/client/web';

/** The header-to-column rule: lower case, non-alphanumerics to underscores. */
export function columnNameFor(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** The bookkeeping the importer adds, which no header may collide with. */
const BOOKKEEPING = new Set([
  'import_batch_id',
  'source_row_number',
  'source_record_key',
  'row_hash',
  'extra_json',
  'ingested_at',
]);

export interface LandingPlan {
  table: string;
  idColumn: string;
  /** Header to landing column, for the headers the table can hold. */
  mapped: Map<string, string>;
  /** Headers with no column of their own. They go to extra_json. */
  unmapped: string[];
}

/**
 * What this database can actually hold for this extract.
 *
 * One read. `PRAGMA table_info` is how the live column list is discovered, so
 * the plan reflects the operator's table rather than this repository's copy of
 * it.
 */
export async function planLanding(
  db: Client,
  table: string,
  headers: readonly string[],
): Promise<LandingPlan | null> {
  const info = await db.execute(`PRAGMA table_info(${table})`);
  if (info.rows.length === 0) return null;
  const columns = new Set<string>();
  let idColumn = '';
  for (const raw of info.rows) {
    const row = raw as unknown as Record<string, unknown>;
    const name = String(row.name);
    columns.add(name);
    if (Number(row.pk ?? 0) === 1) idColumn = name;
  }
  const mapped = new Map<string, string>();
  const unmapped: string[] = [];
  for (const header of headers) {
    const column = columnNameFor(header);
    if (column !== '' && columns.has(column) && !BOOKKEEPING.has(column))
      mapped.set(header, column);
    else unmapped.push(header);
  }
  return { table, idColumn, mapped, unmapped };
}

/** A cell as the landing table stores it: the source's own text, or null. */
function landedValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

export interface LandingRow {
  sourceRowNumber: number;
  sourceRecordKey: string | null;
  rowHash: string;
  raw: Record<string, unknown>;
}

export interface LandingStatement {
  sql: string;
  args: (string | number | null)[];
}

/**
 * The statements that land a batch, for the caller to send in ITS batches.
 *
 * Deliberately returns statements rather than executing them. Both importers
 * already accumulate their writes and flush them in chunks, and the whole
 * point of the previous change was that a row must not cost a round trip. This
 * joins that queue instead of opening a second one.
 *
 * INSERT OR REPLACE, not INSERT. `UNIQUE(import_batch_id, source_row_number)`
 * makes re-landing the same batch overwrite its own rows, which is what
 * reprocessing needs: the same batch run again, not a second copy of it.
 */
export function landingStatements(
  plan: LandingPlan,
  batchId: string,
  rows: readonly LandingRow[],
  now: string,
  newId: (prefix: string) => string,
): LandingStatement[] {
  const headers = [...plan.mapped.keys()];
  const columns = [
    plan.idColumn,
    'import_batch_id',
    'source_row_number',
    'source_record_key',
    'row_hash',
    ...headers.map((h) => plan.mapped.get(h)!),
    'extra_json',
    'ingested_at',
  ];
  const placeholders = columns.map(() => '?').join(', ');
  const sql = `INSERT OR REPLACE INTO ${plan.table} (${columns.join(', ')}) VALUES (${placeholders})`;

  return rows.map((row) => {
    // Anything the table cannot hold, kept verbatim and named.
    const extra: Record<string, unknown> = {};
    for (const header of plan.unmapped) {
      if (header in row.raw) extra[header] = row.raw[header] ?? null;
    }
    return {
      sql,
      args: [
        newId('LAND'),
        batchId,
        row.sourceRowNumber,
        row.sourceRecordKey,
        row.rowHash,
        ...headers.map((h) => landedValue(row.raw[h])),
        Object.keys(extra).length === 0 ? null : JSON.stringify(extra),
        now,
      ],
    };
  });
}

/**
 * Clear a batch's landed rows before re-landing them.
 *
 * INSERT OR REPLACE covers a row that comes back with the same row number, but
 * not one that has gone away: a reprocessed file with fewer rows would
 * otherwise keep the tail of the previous run. One delete makes the landing
 * reflect this run and only this run.
 */
export function clearLandingStatement(table: string, batchId: string): LandingStatement {
  return { sql: `DELETE FROM ${table} WHERE import_batch_id = ?`, args: [batchId] };
}

export const SO_LANDING_TABLE = 'so_extract_rows';
export const PO_LANDING_TABLE = 'po_extract_rows';
