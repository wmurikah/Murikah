/**
 * The sales order importer, against the real SO-Ver1.xls shape.
 *
 * EVERY HEADER IS CLASSIFIED, NONE IS ASSUMED.
 * SO_HEADER_CLASSIFICATION below gives all 31 known headers exactly one of
 * four treatments: canonical data, workflow or event data, source-calculated
 * metric (preserved, NEVER a KPI), or raw-and-audit-only. A header the file
 * carries that this table does not know is classified 'unknown' and
 * reported in the mapping report, never dropped silently. The full payload
 * of every row lands in import_rows.raw_json regardless.
 *
 * THE GRAIN IS THE LINE; THE DOCUMENT IS THE UNIT OF INTEGRITY.
 * 1,386 rows describe 662 orders. Rows group by the normalised document
 * number; a document commits transactionally, and 662 is what the preview
 * reports as orders, with rows always shown separately.
 *
 * NOTHING IS INVENTED.
 * The extract has no currency, no value, no quantity, no price. Those
 * columns are NULL on every imported record, verified nullable before the
 * import starts (the operator's source-completeness script). A blank credit
 * column set means credit approval was NOT REQUIRED, which is a different
 * fact from credit taking no time. No account, user or product is ever
 * created by an upload: unresolved references become exceptions.
 */
import type { Client, InStatement } from '@libsql/client/web';
import { newId } from '../repos/authRecords.ts';
import { toDbTimestamp } from '../auth/session.ts';
import type { WriteContext } from '../admin/guard.ts';
import {
  buildMappingReport,
  parseWorkbook,
  cellToIdentifier,
  cellToNumber,
  cellToText,
  cellToTimestamp,
  hashCanonicalRow,
  hashFile,
  minutesBetween,
  type HeaderTreatment,
  type MappingReportLine,
  loadPriorHashes,
  rejectBatch,
  describeFailure,
} from './workbook.ts';
import {
  planLanding,
  landingStatements,
  clearLandingStatement,
  SO_LANDING_TABLE,
} from './landing.ts';
import { verifyColumns } from './completeness.ts';
import { insertSnapshot, SALES_ORDER_SNAPSHOT } from './snapshots.ts';

type Stmt = Extract<InStatement, { sql: string }>;
const text = (v: unknown): string => String(v ?? '');

export type { HeaderTreatment, MappingReportLine };

/** All 31 headers of the inspected extract, each with exactly one treatment. */
export const SO_HEADER_CLASSIFICATION: Readonly<
  Record<string, { treatment: HeaderTreatment; target: string }>
> = {
  AFFILIATE: { treatment: 'canonical', target: 'sales_orders.affiliate_id via configured mapping' },
  DOCUMENT_NUMBER: { treatment: 'canonical', target: 'sales_orders.document_number, normalised' },
  POSTING_DATE: { treatment: 'raw_only', target: 'raw_json only' },
  ACTUAL_ORDER_DATE_USER_INPUT: { treatment: 'raw_only', target: 'raw_json only' },
  CUSTOMER_CODE: {
    treatment: 'canonical',
    target: 'sales_orders.account_id via oracle_customer_code',
  },
  CUSTOMER_NAME: { treatment: 'raw_only', target: 'validation of the customer match, raw_json' },
  USER_NAME: { treatment: 'workflow', target: 'order creator via source_identities' },
  CREATE_DATE: { treatment: 'raw_only', target: 'raw_json (CREATE_DATE_TIME is canonical)' },
  CREATE_TIME: { treatment: 'raw_only', target: 'raw_json (CREATE_DATE_TIME is canonical)' },
  CREATE_DATE_TIME: { treatment: 'canonical', target: 'sales_orders.order_created_at' },
  APPROVAL_DATE1: { treatment: 'raw_only', target: 'raw_json (APPROVAL_DATE_TIME is canonical)' },
  APPROVAL_DATE: { treatment: 'raw_only', target: 'raw_json' },
  APPROVAL_TIME: { treatment: 'raw_only', target: 'raw_json' },
  APPROVAL_DATE_TIME: { treatment: 'workflow', target: 'finance stage completion timestamp' },
  FINANCE_VARIANCE: { treatment: 'source_metric', target: 'reconciliation view only, never a KPI' },
  DELAYED_RAISING_ORDERS: {
    treatment: 'source_metric',
    target: 'reconciliation view only, never a KPI',
  },
  APPROVAL_STATUS: { treatment: 'workflow', target: 'finance stage outcome (APPROVE or REJECT)' },
  APPROVER: { treatment: 'workflow', target: 'finance stage actor via source_identities' },
  CREDIT_HOLD_DATE: {
    treatment: 'workflow',
    target: 'credit stage start; blank means credit not required',
  },
  CREDIT_HOLD_NAME: { treatment: 'raw_only', target: 'raw_json' },
  RELEASED_FLAG: { treatment: 'workflow', target: 'credit stage outcome' },
  RELEASE_REASON_CODE: { treatment: 'workflow', target: 'sales_orders.credit_exception_reason' },
  CREDIT_HOLD_RELEASE_DATE: { treatment: 'workflow', target: 'credit stage completion timestamp' },
  HOLD_RELEASED_BY: { treatment: 'workflow', target: 'credit stage actor via source_identities' },
  CREDIT_VARIANCE: { treatment: 'source_metric', target: 'reconciliation view only, never a KPI' },
  INVOICE_CREATION_DATE: { treatment: 'canonical', target: 'sales_orders.invoice_created_at' },
  INVOICE_VARIANCE: { treatment: 'source_metric', target: 'reconciliation view only, never a KPI' },
  LINE_NUMBER: { treatment: 'canonical', target: 'sales_order_lines.line_number, normalised' },
  ORDERED_ITEM: {
    treatment: 'canonical',
    target: 'sales_order_lines.product_id via staged resolution',
  },
  LOADING_AUTHORITY_DATE: { treatment: 'canonical', target: 'sales_orders.loading_authority_at' },
  LOADING_AUTHORITY_VARIANCE: {
    treatment: 'source_metric',
    target: 'reconciliation view only, never a KPI',
  },
};

/**
 * The configured affiliate mapping. A mapping, not string containment: an
 * unmapped affiliate text leaves the row UNRESOLVED rather than guessing.
 */
export const SO_AFFILIATE_MAP: Readonly<Record<string, string>> = {
  'Hass Petroleum Kenya': 'AFF-KE',
  'Hass Petroleum Uganda': 'AFF-UG',
  'Hass Petroleum Tanzania': 'AFF-TZ',
  'Hass Petroleum Rwanda': 'AFF-RW',
  'Hass Petroleum Zambia': 'AFF-ZM',
};

/**
 * The prerequisite check, run with queries before anything imports: the
 * source-completeness script made the commercial columns nullable. Where it
 * has not been run, importing would turn "unknown" into constraint failures
 * or, worse, invented zeros, so the importer refuses to start.
 */
export async function verifySourceCompleteness(
  db: Client,
): Promise<{ ok: boolean; problems: string[] }> {
  const result = await verifyColumns(db, [
    { table: 'sales_orders', column: 'currency_code', requirement: 'NULLABLE' },
    { table: 'sales_orders', column: 'order_value', requirement: 'NULLABLE' },
    { table: 'sales_order_lines', column: 'quantity', requirement: 'NULLABLE' },
    { table: 'sales_order_lines', column: 'unit_price', requirement: 'NULLABLE' },
    { table: 'sales_order_lines', column: 'line_value', requirement: 'NULLABLE' },
  ]);
  return { ok: result.ok, problems: result.problems };
}

// ---- Normalised rows ---------------------------------------------------------

export interface NormalisedSoRow {
  sourceRowNumber: number;
  raw: Record<string, unknown>;
  affiliateText: string | null;
  affiliateId: string | null;
  documentNumber: string | null;
  lineNumber: number | null;
  customerCode: string | null;
  customerName: string | null;
  createdBy: string | null;
  orderCreatedAt: string | null;
  approvalAt: string | null;
  approvalStatus: string | null;
  approver: string | null;
  creditHoldAt: string | null;
  creditReleaseAt: string | null;
  creditReleasedBy: string | null;
  creditReleaseReason: string | null;
  creditRequired: boolean;
  invoiceCreatedAt: string | null;
  loadingAuthorityAt: string | null;
  orderedItem: string | null;
  sourceKey: string | null;
  rowHash: string;
}

async function normaliseRow(
  raw: Record<string, unknown>,
  sourceRowNumber: number,
): Promise<NormalisedSoRow> {
  const affiliateText = cellToText(raw.AFFILIATE);
  const affiliateId = affiliateText === null ? null : (SO_AFFILIATE_MAP[affiliateText] ?? null);
  const documentNumber = cellToIdentifier(raw.DOCUMENT_NUMBER);
  const lineNumber = cellToNumber(raw.LINE_NUMBER);
  // Credit was REQUIRED when the source recorded any credit activity at all.
  // All seven credit columns blank means the order never needed credit
  // approval, which is not the same fact as credit taking no time.
  const creditRequired =
    cellToText(raw.CREDIT_HOLD_DATE) !== null ||
    cellToText(raw.RELEASED_FLAG) !== null ||
    cellToText(raw.CREDIT_HOLD_NAME) !== null;

  const canonical = {
    affiliate: affiliateId ?? affiliateText,
    documentNumber,
    lineNumber,
    customerCode: cellToIdentifier(raw.CUSTOMER_CODE),
    createdBy: cellToText(raw.USER_NAME),
    orderCreatedAt: cellToTimestamp(raw.CREATE_DATE_TIME),
    approvalAt: cellToTimestamp(raw.APPROVAL_DATE_TIME),
    approvalStatus: cellToText(raw.APPROVAL_STATUS),
    approver: cellToText(raw.APPROVER),
    creditHoldAt: cellToTimestamp(raw.CREDIT_HOLD_DATE),
    creditReleaseAt: cellToTimestamp(raw.CREDIT_HOLD_RELEASE_DATE),
    creditReleasedBy: cellToText(raw.HOLD_RELEASED_BY),
    creditReleaseReason: cellToText(raw.RELEASE_REASON_CODE),
    invoiceCreatedAt: cellToTimestamp(raw.INVOICE_CREATION_DATE),
    loadingAuthorityAt: cellToTimestamp(raw.LOADING_AUTHORITY_DATE),
    orderedItem: cellToText(raw.ORDERED_ITEM),
  };
  return {
    sourceRowNumber,
    raw,
    affiliateText,
    affiliateId,
    documentNumber,
    lineNumber,
    customerCode: canonical.customerCode,
    customerName: cellToText(raw.CUSTOMER_NAME),
    createdBy: canonical.createdBy,
    orderCreatedAt: canonical.orderCreatedAt,
    approvalAt: canonical.approvalAt,
    approvalStatus: canonical.approvalStatus,
    approver: canonical.approver,
    creditHoldAt: canonical.creditHoldAt,
    creditReleaseAt: canonical.creditReleaseAt,
    creditReleasedBy: canonical.creditReleasedBy,
    creditReleaseReason: canonical.creditReleaseReason,
    creditRequired,
    invoiceCreatedAt: canonical.invoiceCreatedAt,
    loadingAuthorityAt: canonical.loadingAuthorityAt,
    orderedItem: canonical.orderedItem,
    // Identity only: nothing that changes over time belongs in the key.
    sourceKey:
      affiliateId !== null && documentNumber !== null && lineNumber !== null
        ? `${affiliateId}|${documentNumber}|${lineNumber}`
        : null,
    rowHash: await hashCanonicalRow(canonical),
  };
}

// ---- The mapping report ------------------------------------------------------

export function mappingReport(
  headers: string[],
  rows: Record<string, unknown>[],
): MappingReportLine[] {
  return buildMappingReport(SO_HEADER_CLASSIFICATION, headers, rows);
}

// ---- Validation --------------------------------------------------------------

export interface SoValidation {
  batchId: string | null;
  fileSha256: string;
  duplicateOfBatchId: string | null;
  /**
   * Set when the run could not finish. The batch is REJECTED by then, never
   * left at VALIDATING, and this is what the operator is told.
   */
  rejectedReason: string | null;
  rowsReceived: number;
  uniqueDocuments: number;
  rowsNew: number;
  rowsChanged: number;
  rowsDuplicate: number;
  rowsUnresolved: number;
  rowsRejected: number;
  unresolvedCustomers: { code: string; name: string | null; rows: number }[];
  unresolvedProducts: { item: string; rows: number }[];
  unresolvedUsers: string[];
  report: MappingReportLine[];
  dateRange: { from: string | null; to: string | null };
  affiliates: string[];
  /** Headers with no column in the landing table. Kept in extra_json. */
  unmappedColumns: string[];
}

interface ResolutionMaps {
  accounts: Map<string, string>;
  products: Map<string, string>;
  identities: Map<string, string>;
}

async function loadResolutionMaps(db: Client): Promise<ResolutionMaps> {
  const [accounts, products, identities] = await Promise.all([
    db.execute(
      `SELECT oracle_customer_code AS code, account_id FROM accounts WHERE oracle_customer_code IS NOT NULL`,
    ),
    db.execute(`SELECT product_code AS code, product_id FROM products WHERE active = 1`),
    db.execute(
      `SELECT s.external_username AS name, s.user_id FROM source_identities s WHERE s.active = 1`,
    ),
  ]);
  const toMap = (rows: unknown[], key: string, value: string, upper: boolean) => {
    const map = new Map<string, string>();
    for (const raw of rows as Record<string, unknown>[]) {
      const k = text(raw[key]);
      map.set(upper ? k.toUpperCase() : k, text(raw[value]));
    }
    return map;
  };
  return {
    accounts: toMap(accounts.rows as unknown[], 'code', 'account_id', false),
    products: toMap(products.rows as unknown[], 'code', 'product_id', true),
    identities: toMap(identities.rows as unknown[], 'name', 'user_id', true),
  };
}

/**
 * The staged product resolution: an exact product_code match after
 * whitespace normalisation ("JET - A1" is the code JET-A1), and nothing
 * else. There is no fuzzy stage on purpose, and no controlled-mapping table
 * exists in this schema yet: an item code such as GHOS50PG stays unresolved
 * until master data gives it a home.
 */
export function resolveProduct(products: Map<string, string>, item: string | null): string | null {
  if (item === null) return null;
  const normalised = item
    .toUpperCase()
    .replace(/\s*-\s*/g, '-')
    .trim();
  return products.get(normalised) ?? products.get(item.toUpperCase()) ?? null;
}

export async function validateSoWorkbook(
  db: Client,
  buffer: ArrayBuffer | Uint8Array,
  input: {
    filename: string;
    uploadedBy: string;
    sourceSystemId: string;
    /**
     * Set only when reprocessing: the batch to run again, in place.
     *
     * HOW THIS SEPARATES THE TWO CASES. `UNIQUE(file_sha256)` and the
     * duplicate check exist to answer one question: is somebody uploading a
     * file that has been uploaded before? Reprocessing is not a second
     * upload. It declares up front which batch it IS, so the question is
     * never asked, no batch row is created and no file_objects row is
     * written. The identity, the uploader, the upload timestamp and the file
     * hash all stay exactly as they were.
     */
    reprocessBatchId?: string | null;
  },
  ctx: WriteContext,
): Promise<SoValidation> {
  const completeness = await verifySourceCompleteness(db);
  if (!completeness.ok) {
    throw new Error(
      `Source-completeness prerequisite missing: ${completeness.problems.join('; ')}`,
    );
  }

  const fileSha256 = await hashFile(buffer);
  // REPROCESSING IS NOT A SECOND UPLOAD, so the duplicate question is not put
  // to it. An upload asks "have these bytes been seen before"; a reprocess has
  // already said which batch it is and is running that batch again.
  const reprocessOf = input.reprocessBatchId ?? null;
  const existing: { rows: Record<string, unknown>[] } =
    reprocessOf !== null
      ? { rows: [] }
      : await db.execute({
          sql: `SELECT import_batch_id FROM import_batches WHERE file_sha256 = ? LIMIT 1`,
          args: [fileSha256],
        });
  if (existing.rows[0] !== undefined) {
    // The exact file was uploaded before. The hash, not the filename, is the
    // rule; nothing is re-imported and the previous batch is named.
    return {
      batchId: null,
      fileSha256,
      duplicateOfBatchId: text(existing.rows[0].import_batch_id),
      rejectedReason: null,
      rowsReceived: 0,
      uniqueDocuments: 0,
      rowsNew: 0,
      rowsChanged: 0,
      rowsDuplicate: 0,
      rowsUnresolved: 0,
      rowsRejected: 0,
      unresolvedCustomers: [],
      unresolvedProducts: [],
      unresolvedUsers: [],
      report: [],
      dateRange: { from: null, to: null },
      affiliates: [],
      unmappedColumns: [],
    };
  }

  const sheet = parseWorkbook(buffer);
  const maps = await loadResolutionMaps(db);
  const batchId = reprocessOf ?? newId('IMP');
  const now = toDbTimestamp(ctx.now);

  // A reprocess keeps the batch it was given: the same identifier, uploader,
  // upload timestamp and file hash. Only its rows are rebuilt, and the status
  // is put back to VALIDATING for the duration of the run.
  const creationStatements = [
    {
      sql: `INSERT INTO file_objects (file_id, original_filename, storage_key, mime_type, size_bytes, sha256, uploaded_by_user_id, uploaded_at)
              VALUES (?, ?, ?, 'application/vnd.ms-excel', ?, ?, ?, ?)`,
      args: [
        newId('FILE'),
        input.filename,
        `imports/${batchId}/${input.filename}`,
        buffer instanceof Uint8Array ? buffer.byteLength : buffer.byteLength,
        fileSha256,
        input.uploadedBy,
        now,
      ],
    },
    {
      sql: `INSERT INTO import_batches
                (import_batch_id, source_system_id, import_type, original_filename, file_sha256,
                 uploaded_by_user_id, uploaded_at, rows_received, status)
              VALUES (?, ?, 'SALES_ORDER', ?, ?, ?, ?, ?, 'VALIDATING')`,
      args: [
        batchId,
        input.sourceSystemId,
        input.filename,
        fileSha256,
        input.uploadedBy,
        now,
        sheet.rows.length,
      ],
    },
  ];

  await db.batch(
    reprocessOf === null
      ? creationStatements
      : [
          // The same batch, run again: its previous rows and landing go, the
          // status returns to VALIDATING, and nothing about its identity moves.
          {
            sql: `DELETE FROM import_rows WHERE import_batch_id = ?`,
            args: [batchId],
          },
          {
            sql: `DELETE FROM unresolved_actors WHERE import_batch_id = ?`,
            args: [batchId],
          },
          {
            sql: `UPDATE import_batches
                    SET status = 'VALIDATING', rows_received = ?, rows_new = 0, rows_changed = 0,
                        rows_exact_duplicate = 0, rows_rejected = 0
                  WHERE import_batch_id = ?`,
            args: [sheet.rows.length, batchId],
          },
        ],
    'write',
  );
  // FROM HERE THE BATCH ROW EXISTS, SO EVERY EXIT MUST LEAVE IT TERMINAL.
  // A throw below used to leave the batch at VALIDATING for ever, with rows
  // received recorded and nothing else. Now it lands on REJECTED with the
  // reason in the audit trail.
  try {
    const documents = new Set<string>();
    const unresolvedCustomers = new Map<string, { name: string | null; rows: number }>();
    const unresolvedProducts = new Map<string, number>();
    const unresolvedUsers = new Set<string>();
    let rowsNew = 0;
    let rowsChanged = 0;
    let rowsDuplicate = 0;
    let rowsUnresolved = 0;
    let rowsRejected = 0;
    let from: string | null = null;
    let to: string | null = null;
    const affiliates = new Set<string>();
    const seenInBatch = new Map<string, string[]>();
    const statements: Stmt[] = [];

    // EVERY ROW NORMALISED FIRST, THEN ONE READ FOR THE PRIOR HASHES.
    //
    // This loop used to ask `SELECT DISTINCT row_hash` once per row, inside the
    // loop. On this extract that is 1,386 outbound subrequests for a single
    // validation, against a Cloudflare Free plan that allows 50 per request, so
    // the run died at the 51st: the batch row existed at VALIDATING with
    // rows_received set, and the statements that write import_rows and set
    // READY were never reached. Resolving the whole key space up front costs a
    // few reads whatever the extract's size.
    const normalised = [];
    for (let index = 0; index < sheet.rows.length; index++) {
      normalised.push(await normaliseRow(sheet.rows[index] ?? {}, index + 1));
    }
    const priorByKey = await loadPriorHashes(
      db,
      normalised.map((r) => r.sourceKey).filter((k): k is string => k !== null),
      batchId,
    );

    // The landing plan: which of this extract's headers this database can hold
    // in a column of their own, and which have to go to extra_json. One read.
    const landing = await planLanding(db, SO_LANDING_TABLE, sheet.headers);
    if (landing !== null) {
      // A re-landing replaces the batch's rows rather than adding to them.
      statements.push(clearLandingStatement(SO_LANDING_TABLE, batchId));
    }

    for (let index = 0; index < sheet.rows.length; index++) {
      const raw = sheet.rows[index] ?? {};
      const row = normalised[index]!;
      if (row.affiliateText !== null) affiliates.add(row.affiliateText);
      if (row.documentNumber !== null && row.affiliateId !== null) {
        documents.add(`${row.affiliateId}|${row.documentNumber}`);
      }
      if (row.orderCreatedAt !== null) {
        if (from === null || row.orderCreatedAt < from) from = row.orderCreatedAt;
        if (to === null || row.orderCreatedAt > to) to = row.orderCreatedAt;
      }

      let status: 'NEW' | 'CHANGED' | 'DUPLICATE' | 'REJECTED' | 'UNRESOLVED';
      let error: string | null = null;

      if (row.sourceKey === null || row.orderCreatedAt === null) {
        status = 'REJECTED';
        error = 'The row lacks an identity (affiliate, document, line) or a creation timestamp.';
        rowsRejected += 1;
      } else {
        const resolvedAccount =
          row.customerCode === null ? null : (maps.accounts.get(row.customerCode) ?? null);
        const resolvedProduct = resolveProduct(maps.products, row.orderedItem);
        const problems: string[] = [];
        if (resolvedAccount === null) {
          problems.push(`unknown Oracle customer code ${row.customerCode ?? '(blank)'}`);
          const key = row.customerCode ?? '(blank)';
          const entry = unresolvedCustomers.get(key) ?? { name: row.customerName, rows: 0 };
          entry.rows += 1;
          unresolvedCustomers.set(key, entry);
        }
        if (resolvedProduct === null && row.orderedItem !== null) {
          problems.push(`unmapped product ${row.orderedItem}`);
          unresolvedProducts.set(
            row.orderedItem,
            (unresolvedProducts.get(row.orderedItem) ?? 0) + 1,
          );
        }
        for (const actor of [row.createdBy, row.approver, row.creditReleasedBy]) {
          if (actor !== null && !maps.identities.has(actor.toUpperCase())) {
            unresolvedUsers.add(actor.toUpperCase());
          }
        }

        // Change detection at the line's own grain, against EVERY hash ever
        // seen for this key: the extract genuinely repeats keys inside one
        // file, sometimes with differing values, so "the last one" is not a
        // stable comparison point. A row whose exact values have been seen
        // before is a DUPLICATE; a known key with a new hash is CHANGED; an
        // unknown key is NEW. A byte-level reformat can therefore never
        // produce a false CHANGED, because its values have all been seen.
        const priorHashes = new Set(priorByKey.get(row.sourceKey) ?? []);
        for (const seen of seenInBatch.get(row.sourceKey) ?? []) priorHashes.add(seen);
        const batchSeen = seenInBatch.get(row.sourceKey) ?? [];
        batchSeen.push(row.rowHash);
        seenInBatch.set(row.sourceKey, batchSeen);

        if (problems.length > 0) {
          status = 'UNRESOLVED';
          error = problems.join('; ');
          rowsUnresolved += 1;
        } else if (priorHashes.size === 0) {
          status = 'NEW';
          rowsNew += 1;
        } else if (priorHashes.has(row.rowHash)) {
          status = 'DUPLICATE';
          rowsDuplicate += 1;
        } else {
          status = 'CHANGED';
          rowsChanged += 1;
        }
      }

      statements.push({
        sql: `INSERT INTO import_rows
              (import_row_id, import_batch_id, source_row_number, source_record_key, entity_type,
               row_hash, row_status, error_message, raw_json)
            VALUES (?, ?, ?, ?, 'SALES_ORDER', ?, ?, ?, ?)`,
        args: [
          newId('IROW'),
          batchId,
          row.sourceRowNumber,
          row.sourceKey,
          row.rowHash,
          status,
          error,
          JSON.stringify(raw),
        ],
      });
    }

    // EVERY PARSED ROW LANDED, AS THE WORKBOOK GAVE IT.
    //
    // These statements join the queue the loop already built, so a 1,386-row
    // extract lands in the same chunked writes as its import_rows and costs no
    // round trip of its own. Landing writes only to so_extract_rows: no
    // canonical row is created by a validation.
    if (landing !== null) {
      statements.push(
        ...landingStatements(
          landing,
          batchId,
          normalised.map((row, index) => ({
            sourceRowNumber: row.sourceRowNumber,
            sourceRecordKey: row.sourceKey,
            rowHash: row.rowHash,
            raw: sheet.rows[index] ?? {},
          })),
          now,
          newId,
        ),
      );
    }

    // Unresolved actors, once per username per batch, never a user created.
    for (const username of unresolvedUsers) {
      statements.push({
        sql: `INSERT INTO unresolved_actors
              (unresolved_actor_id, import_batch_id, source_system_id, external_username, status)
            VALUES (?, ?, ?, ?, 'OPEN')`,
        args: [newId('UACT'), batchId, input.sourceSystemId, username],
      });
    }
    statements.push({
      sql: `UPDATE import_batches SET rows_new = ?, rows_changed = ?, rows_exact_duplicate = ?,
            rows_rejected = ?, status = 'READY'
          WHERE import_batch_id = ?`,
      args: [rowsNew, rowsChanged, rowsDuplicate, rowsRejected, batchId],
    });
    // Chunked writes: a workbook of any size lands in slices, never one giant
    // statement array and never a whole table in memory at once.
    for (let start = 0; start < statements.length; start += 200) {
      await db.batch(statements.slice(start, start + 200), 'write');
    }

    return {
      batchId,
      fileSha256,
      duplicateOfBatchId: null,
      rejectedReason: null,
      rowsReceived: sheet.rows.length,
      uniqueDocuments: documents.size,
      rowsNew,
      rowsChanged,
      rowsDuplicate,
      rowsUnresolved,
      rowsRejected,
      unresolvedCustomers: [...unresolvedCustomers.entries()].map(([code, v]) => ({
        code,
        name: v.name,
        rows: v.rows,
      })),
      unresolvedProducts: [...unresolvedProducts.entries()].map(([item, rows]) => ({ item, rows })),
      unresolvedUsers: [...unresolvedUsers],
      report: mappingReport(sheet.headers, sheet.rows),
      dateRange: { from, to },
      affiliates: [...affiliates],
      unmappedColumns: landing === null ? [] : landing.unmapped,
    };
  } catch (error) {
    await rejectBatch(db, batchId, describeFailure(error), {
      actorUserId: ctx.actorUserId,
      now: toDbTimestamp(ctx.now),
      auditId: newId('AEV'),
    });
    return {
      batchId,
      fileSha256,
      duplicateOfBatchId: null,
      rejectedReason:
        'Validation could not be completed, so nothing was imported. ' + describeFailure(error),
      rowsReceived: sheet.rows.length,
      uniqueDocuments: 0,
      rowsNew: 0,
      rowsChanged: 0,
      rowsDuplicate: 0,
      rowsUnresolved: 0,
      rowsRejected: 0,
      unresolvedCustomers: [],
      unresolvedProducts: [],
      unresolvedUsers: [],
      report: [],
      dateRange: { from: null, to: null },
      affiliates: [],
      unmappedColumns: [],
    };
  }
}

// ---- Commit ------------------------------------------------------------------

export interface SoCommitResult {
  documentsCreated: number;
  documentsUpdated: number;
  documentsUnchanged: number;
  documentsSkipped: number;
  linesWritten: number;
  workflowEventsAppended: number;
}

interface DocumentGroup {
  affiliateId: string;
  documentNumber: string;
  rows: NormalisedSoRow[];
}

/**
 * Derive the order status conservatively from what the extract proves.
 * No approval means pending finance; a rejected approval keeps the order
 * pending finance (the source records no post-rejection state); finance
 * complete with credit still open means pending credit; approvals complete
 * means ready; an invoice means invoiced; a loading authority after that
 * means loading. Loaded is never inferred: the file has no load timestamp,
 * so loaded_at stays NULL everywhere and no status claims otherwise.
 */
export function deriveSoStatus(head: NormalisedSoRow): string {
  const financeApproved = head.approvalStatus === 'APPROVE' && head.approvalAt !== null;
  const creditOpen = head.creditRequired && head.creditReleaseAt === null;
  if (!financeApproved) return 'PENDING_FINANCE';
  if (creditOpen) return 'PENDING_CREDIT';
  if (head.loadingAuthorityAt !== null) return 'LOADING';
  if (head.invoiceCreatedAt !== null) return 'INVOICED';
  return 'READY';
}

/**
 * A document that could not be written, recorded on its own rows.
 *
 * Nothing of it was written: the transaction that failed took every one of
 * its statements with it. What is left is the reason, on the rows the
 * document came from, so the batch's PARTIAL report can say exactly what did
 * not import rather than only that something did not.
 */
async function isolateDocument(
  db: Client,
  importRowIds: Map<number, string>,
  error: unknown,
): Promise<void> {
  const reason = `The document could not be written: ${String(error)}`.slice(0, 400);
  const statements: Stmt[] = [...importRowIds.values()].map((importRowId) => ({
    sql: `UPDATE import_rows SET row_status = 'REJECTED', error_message = ?
          WHERE import_row_id = ? AND imported_at IS NULL`,
    args: [reason, importRowId],
  }));
  for (let start = 0; start < statements.length; start += 200) {
    await db.batch(statements.slice(start, start + 200), 'write');
  }
}

/**
 * Commit the READY rows of a validated batch, document by document.
 *
 * Each document is one transaction: the order, its resolvable lines, its
 * workflow reconstruction and the batch bookkeeping either land together or
 * not at all, so a broken row can never leave half a sales order. Documents
 * whose rows are all UNRESOLVED or REJECTED are skipped whole and stay in
 * the exception queues; a document whose ORDER facts resolve but whose lines
 * carry unmapped products imports the order and the resolvable lines, and
 * the unmapped lines stay UNRESOLVED for revalidation. That is the stated
 * isolation policy.
 *
 * Workflow events are reconstructed against the seeded Kenya sales order
 * definition (FINANCE_APPROVAL, then CREDIT_CHECK where the credit columns
 * are populated), keyed on (instance, stage), so a repeat upload appends
 * nothing that already exists. The APPROVER value is not assumed to be
 * finance authority by column position; it is written to the FINANCE stage
 * because the extract's approval columns are the finance approval the
 * business described, and the stage code names that meaning explicitly.
 */
export async function commitSoBatch(
  db: Client,
  batchId: string,
  ctx: WriteContext,
): Promise<SoCommitResult> {
  const now = toDbTimestamp(ctx.now);
  const maps = await loadResolutionMaps(db);
  const result: SoCommitResult = {
    documentsCreated: 0,
    documentsUpdated: 0,
    documentsUnchanged: 0,
    documentsSkipped: 0,
    linesWritten: 0,
    workflowEventsAppended: 0,
  };

  const rowsResult = await db.execute({
    sql: `SELECT import_row_id, source_row_number, row_status, raw_json FROM import_rows
          WHERE import_batch_id = ? ORDER BY source_row_number`,
    args: [batchId],
  });

  const groups = new Map<
    string,
    DocumentGroup & { importRowIds: Map<number, string>; statuses: Map<number, string> }
  >();
  for (const raw of rowsResult.rows) {
    const record = raw as unknown as Record<string, unknown>;
    const parsed = JSON.parse(text(record.raw_json)) as Record<string, unknown>;
    const row = await normaliseRow(parsed, Number(record.source_row_number));
    if (row.affiliateId === null || row.documentNumber === null) continue;
    const key = `${row.affiliateId}|${row.documentNumber}`;
    const group = groups.get(key) ?? {
      affiliateId: row.affiliateId,
      documentNumber: row.documentNumber,
      rows: [],
      importRowIds: new Map<number, string>(),
      statuses: new Map<number, string>(),
    };
    group.rows.push(row);
    group.importRowIds.set(row.sourceRowNumber, text(record.import_row_id));
    group.statuses.set(row.sourceRowNumber, text(record.row_status));
    groups.set(key, group);
  }

  const definition = await db.execute({
    sql: `SELECT ws.workflow_stage_id, ws.stage_code, ws.workflow_definition_id
          FROM workflow_stages ws
          JOIN workflow_definitions wd ON wd.workflow_definition_id = ws.workflow_definition_id
          WHERE wd.process_type = 'SALES_ORDER' AND wd.active = 1
          ORDER BY ws.sequence_no`,
    args: [],
  });
  const stages = new Map<string, { stageId: string; definitionId: string }>();
  for (const raw of definition.rows) {
    const row = raw as unknown as Record<string, unknown>;
    stages.set(text(row.stage_code), {
      stageId: text(row.workflow_stage_id),
      definitionId: text(row.workflow_definition_id),
    });
  }

  for (const group of groups.values()) {
    const actionable = group.rows.filter((r) => {
      const status = group.statuses.get(r.sourceRowNumber);
      return status === 'NEW' || status === 'CHANGED';
    });
    const anyUsable = group.rows.some((r) => {
      const status = group.statuses.get(r.sourceRowNumber);
      return status === 'NEW' || status === 'CHANGED' || status === 'DUPLICATE';
    });
    const head = group.rows[0];
    if (head === undefined) continue;
    const accountId =
      head.customerCode === null ? null : (maps.accounts.get(head.customerCode) ?? null);
    if (!anyUsable || accountId === null || head.orderCreatedAt === null) {
      result.documentsSkipped += 1;
      continue;
    }
    if (actionable.length === 0) {
      result.documentsUnchanged += 1;
      continue;
    }

    const existing = await db.execute({
      sql: `SELECT sales_order_id FROM sales_orders WHERE affiliate_id = ? AND document_number = ? LIMIT 1`,
      args: [group.affiliateId, group.documentNumber],
    });
    const existingId = existing.rows[0]?.sales_order_id;
    const salesOrderId = existingId === undefined ? newId('SO') : text(existingId);
    const status = deriveSoStatus(head);
    const statements: Stmt[] = [];

    if (existingId === undefined) {
      statements.push({
        // Currency, value, quantity and price are NULL because the extract
        // carries none of them. NULL, never zero, never an invented KES.
        sql: `INSERT INTO sales_orders
                (sales_order_id, document_number, affiliate_id, business_unit_id, account_id,
                 order_created_at, currency_code, order_value, finance_approval_required,
                 credit_approval_required, credit_exception_reason, invoice_number,
                 invoice_created_at, loading_authority_at, loaded_at, status, created_at)
              VALUES (?, ?, ?, NULL, ?, ?, NULL, NULL, 1, ?, ?, NULL, ?, ?, NULL, ?, ?)`,
        args: [
          salesOrderId,
          group.documentNumber,
          group.affiliateId,
          accountId,
          head.orderCreatedAt,
          head.creditRequired ? 1 : 0,
          head.creditReleaseReason,
          head.invoiceCreatedAt,
          head.loadingAuthorityAt,
          status,
          now,
        ],
      });
    } else {
      statements.push({
        sql: `UPDATE sales_orders SET credit_approval_required = ?, credit_exception_reason = ?,
                invoice_created_at = ?, loading_authority_at = ?, status = ?
              WHERE sales_order_id = ?`,
        args: [
          head.creditRequired ? 1 : 0,
          head.creditReleaseReason,
          head.invoiceCreatedAt,
          head.loadingAuthorityAt,
          status,
          salesOrderId,
        ],
      });
    }

    // Lines: only rows whose product resolves. Unresolved lines stay in the
    // exception queue for revalidation; the order does not wait for them.
    for (const row of actionable) {
      const productId = resolveProduct(maps.products, row.orderedItem);
      if (productId === null || row.lineNumber === null) continue;
      statements.push({
        sql: `INSERT INTO sales_order_lines
                (sales_order_line_id, sales_order_id, line_number, product_id, quantity,
                 unit_price, line_value)
              VALUES (?, ?, ?, ?, NULL, NULL, NULL)
              ON CONFLICT(sales_order_id, line_number) DO UPDATE SET product_id = excluded.product_id`,
        args: [newId('SOL'), salesOrderId, row.lineNumber, productId],
      });
      result.linesWritten += 1;
    }

    // Workflow reconstruction, idempotent on (instance, stage).
    const finance = stages.get('FINANCE_APPROVAL');
    if (finance !== undefined) {
      const instance = await db.execute({
        sql: `SELECT workflow_instance_id FROM workflow_instances
              WHERE entity_type = 'SALES_ORDER' AND entity_id = ? LIMIT 1`,
        args: [salesOrderId],
      });
      let workflowInstanceId = instance.rows[0]?.workflow_instance_id as string | undefined;
      if (workflowInstanceId === undefined) {
        workflowInstanceId = newId('WFI');
        statements.push({
          sql: `INSERT INTO workflow_instances
                  (workflow_instance_id, workflow_definition_id, entity_type, entity_id, status,
                   started_at, completed_at, created_at)
                VALUES (?, ?, 'SALES_ORDER', ?, 'COMPLETED', ?, ?, ?)`,
          args: [
            workflowInstanceId,
            finance.definitionId,
            salesOrderId,
            head.orderCreatedAt,
            head.approvalAt,
            now,
          ],
        });
      }
      const financeUser =
        head.approver === null ? null : (maps.identities.get(head.approver.toUpperCase()) ?? null);
      const financeExists = await db.execute({
        sql: `SELECT workflow_stage_instance_id FROM workflow_stage_instances
              WHERE workflow_instance_id = ? AND workflow_stage_id = ? LIMIT 1`,
        args: [String(workflowInstanceId), finance.stageId],
      });
      if (financeExists.rows[0] === undefined && head.approvalAt !== null) {
        statements.push({
          sql: `INSERT INTO workflow_stage_instances
                  (workflow_stage_instance_id, workflow_instance_id, workflow_stage_id,
                   assigned_user_id, status, assigned_at, started_at, completed_at, action_notes)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Reconstructed from the SO extract')`,
          args: [
            newId('WSI'),
            String(workflowInstanceId),
            finance.stageId,
            financeUser,
            head.approvalStatus === 'REJECT' ? 'REJECTED' : 'APPROVED',
            head.orderCreatedAt,
            head.orderCreatedAt,
            head.approvalAt,
          ],
        });
        result.workflowEventsAppended += 1;
      }
      const credit = stages.get('CREDIT_CHECK');
      if (credit !== undefined && head.creditRequired && head.creditHoldAt !== null) {
        const creditExists = await db.execute({
          sql: `SELECT workflow_stage_instance_id FROM workflow_stage_instances
                WHERE workflow_instance_id = ? AND workflow_stage_id = ? LIMIT 1`,
          args: [String(workflowInstanceId), credit.stageId],
        });
        if (creditExists.rows[0] === undefined) {
          const creditUser =
            head.creditReleasedBy === null
              ? null
              : (maps.identities.get(head.creditReleasedBy.toUpperCase()) ?? null);
          statements.push({
            sql: `INSERT INTO workflow_stage_instances
                    (workflow_stage_instance_id, workflow_instance_id, workflow_stage_id,
                     assigned_user_id, status, assigned_at, started_at, completed_at, action_notes)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Reconstructed from the SO extract credit columns')`,
            args: [
              newId('WSI'),
              String(workflowInstanceId),
              credit.stageId,
              creditUser,
              head.creditReleaseAt === null ? 'ACTIVE' : 'APPROVED',
              head.creditHoldAt,
              head.creditHoldAt,
              head.creditReleaseAt,
            ],
          });
          result.workflowEventsAppended += 1;
        }
      }
    }

    // The rows this document consumed become part of the same transaction.
    for (const row of actionable) {
      const importRowId = group.importRowIds.get(row.sourceRowNumber);
      if (importRowId !== undefined) {
        statements.push({
          sql: `UPDATE import_rows SET entity_id = ?, imported_at = ? WHERE import_row_id = ?`,
          args: [salesOrderId, now, importRowId],
        });
      }
    }

    // The document is the unit of integrity: everything above lands in one
    // transaction, and a document that cannot land is isolated here rather
    // than taking the rest of the batch down with it. That is the stated
    // policy, and the batch reports PARTIAL with the reason attached to the
    // rows that failed.
    try {
      await db.batch(statements, 'write');
    } catch (error) {
      await isolateDocument(db, group.importRowIds, error);
      result.documentsSkipped += 1;
      result.linesWritten -= actionable.filter(
        (row) => resolveProduct(maps.products, row.orderedItem) !== null && row.lineNumber !== null,
      ).length;
      continue;
    }
    // The snapshot after the canonical write, per the ordering rule:
    // latest_snapshot_id moves only once both have committed.
    const headRow = actionable[0] ?? head;
    await insertSnapshot(
      db,
      SALES_ORDER_SNAPSHOT,
      salesOrderId,
      `${group.affiliateId}|${group.documentNumber}`,
      headRow.rowHash,
      JSON.stringify({
        documentNumber: group.documentNumber,
        affiliateId: group.affiliateId,
        accountId,
        orderCreatedAt: head.orderCreatedAt,
        approvalAt: head.approvalAt,
        approvalStatus: head.approvalStatus,
        creditRequired: head.creditRequired,
        invoiceCreatedAt: head.invoiceCreatedAt,
        loadingAuthorityAt: head.loadingAuthorityAt,
        status,
        lines: group.rows.map((r) => ({ line: r.lineNumber, item: r.orderedItem })),
      }),
      batchId,
      now,
    );
    if (existingId === undefined) result.documentsCreated += 1;
    else result.documentsUpdated += 1;
  }

  const finalStatus = result.documentsSkipped > 0 ? 'PARTIAL' : 'IMPORTED';
  await db.execute({
    sql: `UPDATE import_batches SET status = ? WHERE import_batch_id = ?`,
    args: [finalStatus, batchId],
  });
  return result;
}

// ---- Reconciliation, for the source-history view -----------------------------

/**
 * The source spreadsheet's own variance beside the application's arithmetic,
 * for diagnosis and nothing else. FINANCE_VARIANCE and its siblings never
 * become a KPI; the dashboard computes durations from timestamps, and this
 * pair of figures is how an administrator sees when the spreadsheet's
 * formula and the timestamps disagree.
 */
export function varianceComparison(raw: Record<string, unknown>): {
  sourceFinanceVariance: number | null;
  computedFinanceMinutes: number | null;
} {
  const created = cellToTimestamp(raw.CREATE_DATE_TIME);
  const approved = cellToTimestamp(raw.APPROVAL_DATE_TIME);
  const source = cellToNumber(raw.FINANCE_VARIANCE);
  return {
    sourceFinanceVariance: source,
    computedFinanceMinutes: minutesBetween(created, approved),
  };
}

// ---- Revalidation ------------------------------------------------------------

export interface RevalidationResult {
  rowsExamined: number;
  rowsResolved: number;
  rowsStillUnresolved: number;
  actorsResolved: number;
}

/**
 * Reprocess the unresolved rows of a batch that has already been validated,
 * in place.
 *
 * The point of this path is that re-uploading the file to pick up a new
 * mapping is exactly what the file-hash rule forbids. So the rows stay where
 * they are, keeping their batch, their source row numbers and their raw
 * payload, and only their resolution is asked again. A row whose account and
 * product now resolve moves out of UNRESOLVED and becomes importable; a row
 * whose mapping is still missing keeps its error message and waits.
 *
 * Nothing else is touched: rows already imported are not reconsidered, and
 * no canonical table is written here.
 */
export async function revalidateSoRows(db: Client, batchId: string): Promise<RevalidationResult> {
  const maps = await loadResolutionMaps(db);
  const rows = await db.execute({
    sql: `SELECT import_row_id, source_row_number, source_record_key, row_hash, raw_json
          FROM import_rows
          WHERE import_batch_id = ? AND row_status = 'UNRESOLVED' AND imported_at IS NULL
          ORDER BY source_row_number`,
    args: [batchId],
  });

  const statements: Stmt[] = [];
  let resolved = 0;
  let stillUnresolved = 0;
  for (const raw of rows.rows) {
    const record = raw as unknown as Record<string, unknown>;
    const parsed = JSON.parse(text(record.raw_json)) as Record<string, unknown>;
    const row = await normaliseRow(parsed, Number(record.source_row_number));
    const problems: string[] = [];
    const account = row.customerCode === null ? null : maps.accounts.get(row.customerCode);
    if (account === undefined || account === null) {
      problems.push(`unknown Oracle customer code ${row.customerCode ?? '(blank)'}`);
    }
    if (resolveProduct(maps.products, row.orderedItem) === null && row.orderedItem !== null) {
      problems.push(`unmapped product ${row.orderedItem}`);
    }
    if (problems.length > 0) {
      stillUnresolved += 1;
      statements.push({
        sql: `UPDATE import_rows SET error_message = ? WHERE import_row_id = ?`,
        args: [problems.join('; '), text(record.import_row_id)],
      });
      continue;
    }
    // The hash rule decides NEW against CHANGED exactly as it did at
    // validation: a key nothing has ever carried is new.
    const prior = await db.execute({
      sql: `SELECT DISTINCT row_hash FROM import_rows
            WHERE source_record_key = ? AND import_batch_id <> ?`,
      args: [text(record.source_record_key), batchId],
    });
    const status = prior.rows.length === 0 ? 'NEW' : 'CHANGED';
    resolved += 1;
    statements.push({
      sql: `UPDATE import_rows SET row_status = ?, error_message = NULL WHERE import_row_id = ?`,
      args: [status, text(record.import_row_id)],
    });
  }

  // A mapped identity closes its unresolved actor row for this batch.
  const actors = await db.execute({
    sql: `SELECT unresolved_actor_id, external_username FROM unresolved_actors
          WHERE import_batch_id = ? AND status = 'OPEN'`,
    args: [batchId],
  });
  let actorsResolved = 0;
  for (const raw of actors.rows) {
    const record = raw as unknown as Record<string, unknown>;
    const userId = maps.identities.get(text(record.external_username).toUpperCase());
    if (userId === undefined) continue;
    actorsResolved += 1;
    statements.push({
      sql: `UPDATE unresolved_actors SET status = 'MAPPED', mapped_user_id = ?
            WHERE unresolved_actor_id = ?`,
      args: [userId, text(record.unresolved_actor_id)],
    });
  }

  for (let start = 0; start < statements.length; start += 200) {
    await db.batch(statements.slice(start, start + 200), 'write');
  }
  return {
    rowsExamined: rows.rows.length,
    rowsResolved: resolved,
    rowsStillUnresolved: stillUnresolved,
    actorsResolved,
  };
}
