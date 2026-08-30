/**
 * The same workbook, recognised after Excel has re-saved it.
 *
 * WHY THE FILE HASH IS NOT ENOUGH, AND IT IS NOT A THEORY. `import_batches`
 * carries `UNIQUE(file_sha256)`, which answers "are these the same bytes".
 * Opening `SO-Ver1.xls` and pressing save produces different bytes with
 * cell-for-cell identical data: the Composite Document container rewrites its
 * directory, its timestamps and its free-sector list, and Excel stamps the
 * writing application and the last-saved time into the summary stream. Not one
 * of those is data. The byte hash changes, the duplicate check passes, and the
 * file imports a second time.
 *
 * So there are two questions, and they need two answers:
 *
 *   file_sha256      Are these the same BYTES?     Cheap, exact, and blind to
 *                    a re-save.
 *   contentSha256    Is this the same DATA?        Reads every cell, ignores
 *                    everything that is not one.
 *
 * WHERE IT IS STORED, AND WHY THERE. There is no schema change in this phase,
 * `import_batches` has no spare column and no JSON column, and inventing a
 * meaning for `file_objects.sha256` or `original_filename` would leave a
 * column whose name lies about its contents. The hash therefore goes into the
 * batch's own metadata: the `after_json` of its `IMPORT_UPLOADED` audit event,
 * which is written once per upload and already carries the file hash, the
 * filename and the row count beside it.
 *
 * That is the same mechanism `./progress.ts` already reads `uniqueDocuments`
 * out of, so it is the existing convention in this module rather than a new
 * one, and `audit_events` is append-only by trigger, which is the right
 * property for a fingerprint: it cannot be quietly rewritten later.
 *
 * The cost is one query per upload against an unindexed `audit_events`. An
 * upload is a human action a few times a day, the predicate is narrowed to one
 * event type before the JSON is touched, and paying it here is better than
 * importing the same workbook twice.
 *
 * ---------------------------------------------------------------------------
 * THE NORMALISATION, WHICH IS THE WHOLE TRICK
 * ---------------------------------------------------------------------------
 *
 * A content hash is only worth having if two files that mean the same thing
 * produce the same digest. Every rule below exists because some harmless act
 * changes the bytes without changing the data.
 *
 * 1. COLUMN ORDER IS SORTED, NOT TAKEN FROM THE SHEET. Each cell is hashed as
 *    `header=value`, and the pairs are sorted by header. Moving a column
 *    changes the file and not the data.
 *
 * 2. ROW ORDER IS SORTED, NOT TAKEN FROM THE SHEET. Each row is digested on
 *    its own and the row digests are sorted before the fold. Re-sorting a
 *    report changes the file and not the data. A row that genuinely appears
 *    twice still appears twice, because duplicates are kept rather than
 *    de-duplicated.
 *
 * 3. ONE REPRESENTATION FOR AN EMPTY CELL. `null`, `undefined`, the empty
 *    string and a cell of nothing but whitespace are the same fact, and a cell
 *    that is empty is dropped from its row entirely. Dropping rather than
 *    tokenising is what makes an all-blank column invisible: whether the sheet
 *    carries it or not, the data is the same.
 *
 * 4. ONE SERIALISATION FOR A DATE, FROM THE PARSED VALUE. The workbook is read
 *    for hashing with `cellDates: true`, so SheetJS resolves a date-formatted
 *    cell to a real Date using the cell's own number format, and it is
 *    rendered as `D:` plus its ISO instant. The Excel day serial never reaches
 *    the hash: 46144.45520833333 and 46144.455208333336 are the same moment
 *    written to different float widths, and the serial would hash them apart.
 *
 * 5. ONE REPRESENTATION FOR A NUMBER. 3988 and 3988.0 hash identically,
 *    including when one of them arrives as the string "3988.0", because both
 *    canonicalise to `N:3988`. A value keeps its leading zeros: "007" is an
 *    identifier, not the number seven, and normalising it would collide two
 *    values that are genuinely different.
 *
 * 6. STRINGS ARE TRIMMED. Leading and trailing whitespace is a formatting
 *    accident. Case is NOT folded: "Nairobi" and "NAIROBI" are different
 *    values, and pretending otherwise would hide a real edit.
 *
 * Each value carries a one-letter type tag (`N:`, `D:`, `B:`, `T:`) so the
 * number 3988 and the text "3988" cannot be told apart only by luck. What is
 * deliberately NOT in the hash: the sheet name, the header order, the row
 * order, the file name, and every cell that has no value.
 */
import * as XLSX from 'xlsx';

/** The digest of a workbook's data, independent of how it was saved. */
export interface WorkbookContent {
  /** SHA-256 of the normalised cells, hex. */
  readonly contentSha256: string;
  /** Rows that carried at least one value, for the message. */
  readonly rows: number;
  /** Columns that carried at least one value anywhere. */
  readonly columns: number;
}

const hex = (digest: ArrayBuffer): string =>
  [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');

const sha256 = async (value: string): Promise<string> =>
  hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));

/**
 * A number as one string, whatever float width it arrived in.
 *
 * `String(3988)` and `String(3988.0)` are both "3988" in JavaScript, which
 * does most of the work; this handles the two cases it does not. Negative zero
 * becomes zero, because a spreadsheet that renders "0" should not hash two
 * ways. Exponent notation is expanded, because `String(1e21)` is "1e+21" and
 * the same magnitude typed into a cell could arrive either way.
 */
export function canonicalNumber(value: number): string {
  if (!Number.isFinite(value)) return 'nan';
  if (Object.is(value, -0)) return '0';
  const plain = String(value);
  if (!plain.includes('e') && !plain.includes('E')) return plain;
  const expanded = value.toFixed(20);
  return expanded.includes('.') ? expanded.replace(/0+$/, '').replace(/\.$/, '') : expanded;
}

/**
 * True where a string is a number written as text and normalising it loses
 * nothing.
 *
 * The leading-zero rule is the important half. "3988.0" and 3988 are the same
 * quantity written twice, so they must hash together. "007" and 7 are not: one
 * is an identifier whose zeros are part of it, and folding them would make two
 * different documents look like one. So a string normalises only when its
 * canonical form is character-for-character what it already said, apart from
 * trailing zeros after a decimal point.
 */
function numericText(trimmed: string): number | null {
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

/**
 * One cell, as the hash sees it, or null where the cell holds nothing.
 *
 * Exported because the test asserts the rules directly rather than inferring
 * them from two digests being equal, which would pass for the wrong reason if
 * both were empty.
 */
export function normaliseCell(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : `D:${value.toISOString()}`;
  }
  if (typeof value === 'number') return `N:${canonicalNumber(value)}`;
  if (typeof value === 'boolean') return `B:${value ? '1' : '0'}`;
  const trimmed = String(value).trim();
  if (trimmed === '') return null;
  const asNumber = numericText(trimmed);
  return asNumber === null ? `T:${trimmed}` : `N:${canonicalNumber(asNumber)}`;
}

/** One row, as a string: `header=value` pairs, empties dropped, sorted. */
export function normaliseRow(row: Record<string, unknown>): string | null {
  const parts: string[] = [];
  for (const header of Object.keys(row)) {
    const name = header.trim();
    if (name === '') continue;
    const cell = normaliseCell(row[header]);
    if (cell === null) continue;
    parts.push(`${name}=${cell}`);
  }
  if (parts.length === 0) return null;
  parts.sort();
  return parts.join(String.fromCharCode(1));
}

/**
 * The content digest of an uploaded workbook.
 *
 * Read separately from the importers' own parse, and deliberately so. They
 * read with `cellDates: false` because their column classification knows which
 * columns are dates and converts the serials itself; this read wants SheetJS
 * to make that judgement from each cell's number format, which is the only way
 * to tell a date from a quantity without knowing the report. The second parse
 * costs CPU on a file already in memory and no round trips, which is the right
 * trade for a check that stops a whole extract landing twice.
 */
export async function workbookContent(buffer: ArrayBuffer | Uint8Array): Promise<WorkbookContent> {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheetName = workbook.SheetNames[0] ?? '';
  const sheet = workbook.Sheets[sheetName];
  if (sheet === undefined) throw new Error('The workbook has no sheets.');
  const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true });
  const headers = (grid[0] ?? []).map((h) => String(h ?? '').trim());

  const columns = new Set<string>();
  const digests: string[] = [];
  for (const line of grid.slice(1)) {
    if (!Array.isArray(line)) continue;
    const record: Record<string, unknown> = {};
    headers.forEach((header, index) => {
      if (header !== '') record[header] = line[index] ?? null;
    });
    const normalised = normaliseRow(record);
    if (normalised === null) continue;
    for (const header of headers) {
      if (header !== '' && normaliseCell(record[header]) !== null) columns.add(header);
    }
    digests.push(await sha256(normalised));
  }

  // SORTED, so the sheet's own row order cannot reach the digest. Duplicates
  // survive the sort, because two identical rows are two rows.
  digests.sort();
  return {
    contentSha256: await sha256(digests.join(String.fromCharCode(2))),
    rows: digests.length,
    columns: columns.size,
  };
}

/** The audit event whose `after_json` carries an upload's fingerprints. */
export const UPLOAD_EVENT = 'IMPORT_UPLOADED';

export interface ContentMatch {
  readonly batchId: string;
  readonly filename: string;
  readonly uploadedAt: string;
}

/**
 * The earlier batch whose data is identical to this workbook's, if there is
 * one.
 *
 * Scoped to the same import type, because a sales order extract and a purchase
 * order extract could not collide and narrowing the predicate costs nothing.
 * The join is to `import_batches` so a batch whose history was cleared cannot
 * be named: the audit row survives a deletion by design, and pointing an
 * operator at a batch that no longer exists would be worse than saying
 * nothing.
 */
export async function findContentMatch(
  db: {
    execute: (stmt: {
      sql: string;
      args: (string | number | null)[];
    }) => Promise<{ rows: unknown[] }>;
  },
  contentSha256: string,
  importType: string,
  excludeBatchId: string | null,
): Promise<ContentMatch | null> {
  const found = await db.execute({
    sql: `SELECT b.import_batch_id AS id, b.original_filename AS filename, b.uploaded_at AS at
            FROM audit_events ae
            JOIN import_batches b ON b.import_batch_id = ae.entity_id
           WHERE ae.entity_type = 'IMPORT_BATCH' AND ae.event_type = ?
             AND b.import_type = ?
             AND b.import_batch_id <> ?
             AND json_extract(ae.after_json, '$.contentSha256') = ?
           ORDER BY b.uploaded_at ASC LIMIT 1`,
    args: [UPLOAD_EVENT, importType, excludeBatchId ?? '', contentSha256],
  });
  const row = found.rows[0] as Record<string, unknown> | undefined;
  if (row === undefined) return null;
  return {
    batchId: String(row.id ?? ''),
    filename: String(row.filename ?? ''),
    uploadedAt: String(row.at ?? ''),
  };
}

/**
 * The one duplicate decision, for both importers.
 *
 * THERE ARE THREE ANSWERS AND THE ORDER MATTERS. A byte-identical file is also
 * content-identical, so bytes are asked first: an operator who uploads exactly
 * the same file should be told exactly that, not told it was re-saved when it
 * was not touched at all.
 *
 * A reprocess is asked neither question. It has already declared which batch it
 * is and is running that batch again; "have I seen this before" answers itself
 * with "yes, you are it".
 */
export type DuplicateKind = 'bytes' | 'content' | 'new';

export interface DuplicateDecision {
  readonly kind: DuplicateKind;
  readonly fileSha256: string;
  readonly contentSha256: string;
  /** The earlier batch, for 'bytes' and 'content'. */
  readonly match: ContentMatch | null;
}

export async function decideDuplicate(
  db: {
    execute: (stmt: {
      sql: string;
      args: (string | number | null)[];
    }) => Promise<{ rows: unknown[] }>;
  },
  buffer: ArrayBuffer | Uint8Array,
  input: { importType: string; reprocessBatchId: string | null; fileSha256: string },
): Promise<DuplicateDecision> {
  const content = await workbookContent(buffer);
  const reprocessOf = input.reprocessBatchId;
  if (reprocessOf !== null) {
    return {
      kind: 'new',
      fileSha256: input.fileSha256,
      contentSha256: content.contentSha256,
      match: null,
    };
  }

  const sameBytes = await db.execute({
    sql: `SELECT import_batch_id AS id, original_filename AS filename, uploaded_at AS at
            FROM import_batches WHERE file_sha256 = ? LIMIT 1`,
    args: [input.fileSha256],
  });
  const byteRow = sameBytes.rows[0] as Record<string, unknown> | undefined;
  if (byteRow !== undefined) {
    return {
      kind: 'bytes',
      fileSha256: input.fileSha256,
      contentSha256: content.contentSha256,
      match: {
        batchId: String(byteRow.id ?? ''),
        filename: String(byteRow.filename ?? ''),
        uploadedAt: String(byteRow.at ?? ''),
      },
    };
  }

  const sameContent = await findContentMatch(
    db,
    content.contentSha256,
    input.importType,
    reprocessOf,
  );
  return {
    kind: sameContent === null ? 'new' : 'content',
    fileSha256: input.fileSha256,
    contentSha256: content.contentSha256,
    match: sameContent,
  };
}
