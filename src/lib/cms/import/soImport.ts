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
import { newTraceId } from '../errors.ts';
import { logWriteFailure } from './writeFailure.ts';
import {
  planMasterData,
  createMasterData,
  normaliseProductCode,
  type AccountRequest,
  type ProductRequest,
  type MasterDataPlan,
  type NameMismatch,
} from './masterData.ts';

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
  /**
   * Distinct (affiliate, document, line) keys, which is how many
   * `sales_order_lines` rows a commit will write.
   *
   * NOT the row count. The real file's 1,386 rows describe 1,252 order lines,
   * because one line can be loaded more than once and the extract repeats the
   * line to say so.
   */
  orderLines: number;
  /**
   * Loading authorities beyond the first, summed over every ORDER.
   *
   * Distinct timestamps, never rows: the repeats are a cross-product of the
   * loading, credit-hold and invoice events, so a line loaded seven times
   * against two credit episodes appears fourteen times and has seven events.
   * Per order, because that is the grain of the column the rule fills.
   */
  additionalLoadingEvents: number;
  rowsNew: number;
  rowsChanged: number;
  rowsDuplicate: number;
  rowsUnresolved: number;
  rowsRejected: number;
  /**
   * Customers and products the extract names that do not exist yet.
   *
   * These are no longer refusals. Under the rule this phase adopts they are
   * what the commit WILL CREATE, and they are reported here so a person sees
   * the counts and the lists before committing: nobody should discover 228
   * new accounts after the fact. A preview is only a preview if it can still
   * be stopped, so nothing below is written at validation.
   */
  accountsToCreate: { code: string; name: string | null; rows: number }[];
  productsToCreate: { code: string; unitOfMeasure: string | null; rows: number }[];
  /** A code that matched with a different name. Flagged, never overwritten. */
  nameMismatches: { code: string; storedName: string; fileName: string }[];
  /**
   * What genuinely cannot be resolved and is not creatable: a blank customer
   * code names no customer, so there is nothing to create.
   */
  unresolvedCustomers: { code: string; name: string | null; rows: number }[];
  unresolvedProducts: { item: string; rows: number }[];
  /** Still never created. A user is an identity, not a reference record. */
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
      orderLines: 0,
      additionalLoadingEvents: 0,
      rowsNew: 0,
      rowsChanged: 0,
      rowsDuplicate: 0,
      rowsUnresolved: 0,
      rowsRejected: 0,
      accountsToCreate: [],
      productsToCreate: [],
      nameMismatches: [],
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

    // WHAT THIS FILE WOULD CREATE, PLANNED BUT NOT CREATED.
    //
    // The customers and products an extract names for the first time are no
    // longer refusals; they are records the commit will create. Planning them
    // here does two things: it lets a row whose customer does not exist YET
    // count as importable rather than unresolved, which is what left all
    // 1,386 rows of the real file in the exception queue; and it produces the
    // counts and lists the preview puts in front of a person before they
    // commit. Nothing is written at validation.
    const accountRowCounts = new Map<string, number>();
    const productRowCounts = new Map<string, number>();
    const accountRequests: AccountRequest[] = [];
    const productRequests: ProductRequest[] = [];
    for (const row of normalised) {
      if (row.customerCode !== null) {
        accountRowCounts.set(row.customerCode, (accountRowCounts.get(row.customerCode) ?? 0) + 1);
        accountRequests.push({
          code: row.customerCode,
          name: row.customerName,
          affiliateId: row.affiliateId,
        });
      }
      if (row.orderedItem !== null) {
        const code = normaliseProductCode(row.orderedItem);
        productRowCounts.set(code, (productRowCounts.get(code) ?? 0) + 1);
        // The sales order extract has all 31 of its headers classified and
        // none of them is a unit of measure, so this is always null here and
        // the stated default applies. It is passed rather than omitted so a
        // future extract that does carry one needs no change at this site.
        productRequests.push({ code, unitOfMeasure: null });
      }
    }
    // THE OTHER TWO FIGURES THE PREVIEW OWES A READER. Rows and documents were
    // never the whole story: 1,386 rows describe 662 documents over 1,252
    // order lines, and 100 of the loading authorities on those orders are
    // beyond the first. Four separate numbers, because collapsing any pair of
    // them is what let a commit quietly write one line 134 times.
    const orderLineKeys = new Set<string>();
    const authoritiesByOrder = new Map<string, Set<string>>();
    for (const row of normalised) {
      if (row.sourceKey !== null) orderLineKeys.add(row.sourceKey);
      if (row.affiliateId === null || row.documentNumber === null) continue;
      if (row.loadingAuthorityAt === null) continue;
      const order = `${row.affiliateId}|${row.documentNumber}`;
      const set = authoritiesByOrder.get(order) ?? new Set<string>();
      set.add(row.loadingAuthorityAt);
      authoritiesByOrder.set(order, set);
    }
    let additionalLoadingEvents = 0;
    for (const set of authoritiesByOrder.values()) additionalLoadingEvents += set.size - 1;

    const plan = await planMasterData(db, accountRequests, productRequests);
    const willCreateAccounts = new Set(plan.accountsToCreate.map((a) => a.code));
    const willCreateProducts = new Set(plan.productsToCreate.map((p) => p.code));

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
        // A CODE THE COMMIT WILL CREATE IS NOT A PROBLEM. Only a row that
        // names no customer at all is, because a blank code names nothing to
        // create and nothing to look up.
        if (resolvedAccount === null) {
          if (row.customerCode === null) {
            problems.push('the row names no Oracle customer code');
            const entry = unresolvedCustomers.get('(blank)') ?? { name: row.customerName, rows: 0 };
            entry.rows += 1;
            unresolvedCustomers.set('(blank)', entry);
          } else if (!willCreateAccounts.has(row.customerCode)) {
            // Planned but not creatable: the affiliate named no country, and
            // accounts.country_id cannot be NULL. Reported, never guessed.
            problems.push(`unknown Oracle customer code ${row.customerCode}`);
            const entry = unresolvedCustomers.get(row.customerCode) ?? {
              name: row.customerName,
              rows: 0,
            };
            entry.rows += 1;
            unresolvedCustomers.set(row.customerCode, entry);
          }
        }
        if (resolvedProduct === null && row.orderedItem !== null) {
          if (!willCreateProducts.has(normaliseProductCode(row.orderedItem))) {
            problems.push(`unmapped product ${row.orderedItem}`);
            unresolvedProducts.set(
              row.orderedItem,
              (unresolvedProducts.get(row.orderedItem) ?? 0) + 1,
            );
          }
        }
        for (const actor of [row.createdBy, row.approver, row.creditReleasedBy]) {
          if (actor !== null && !maps.identities.has(actor.toUpperCase())) {
            unresolvedUsers.add(actor.toUpperCase());
          }
        }

        // Change detection at the line's own grain, against every hash ever
        // seen for this key in the DATABASE. NEW is a key nothing has seen;
        // CHANGED is a known key whose values moved. Both are comparisons
        // against stored state.
        const priorHashes = new Set(priorByKey.get(row.sourceKey) ?? []);
        // A WITHIN-BATCH REPEAT IS A DIFFERENT QUESTION, AND IT GETS ITS OWN
        // ANSWER. 1,386 rows of the real file carry only 1,252 distinct
        // (affiliate, document, line) keys, because one order line can be
        // loaded more than once and the extract expresses that by repeating
        // the line — a cross-product of the loading, credit-hold and invoice
        // events, so a line loaded seven times against two credit episodes
        // appears fourteen times.
        //
        // Such a row is competing with a SIBLING IN THE SAME FILE, not with
        // the database, so neither NEW nor CHANGED describes it: both of those
        // are verdicts about stored state, and calling the second loading of a
        // truck a "change" to the first is simply false. It was being called
        // CHANGED 131 times and DUPLICATE 3 times, which is two wrong answers
        // rather than one.
        //
        // DUPLICATE, of the five the CHECK allows. Not REJECTED, which means
        // the row could not be read, and it was read and it landed. Not
        // UNRESOLVED, which means a reference is missing, and none is. Not
        // NEW or CHANGED, for the reason above. DUPLICATE is the only one of
        // the five that says what is actually true: this row adds no new
        // canonical record. Its loading authority is not lost — every row is
        // in so_extract_rows, the order carries the count and the range, and
        // the snapshot records the whole set beside the one that was chosen.
        const repeatOfEarlierRow = seenInBatch.has(row.sourceKey);
        const batchSeen = seenInBatch.get(row.sourceKey) ?? [];
        batchSeen.push(row.rowHash);
        seenInBatch.set(row.sourceKey, batchSeen);

        if (problems.length > 0) {
          status = 'UNRESOLVED';
          error = problems.join('; ');
          rowsUnresolved += 1;
        } else if (repeatOfEarlierRow) {
          status = 'DUPLICATE';
          error = 'A further event for an order line this file has already described.';
          rowsDuplicate += 1;
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
      orderLines: orderLineKeys.size,
      additionalLoadingEvents,
      rowsNew,
      rowsChanged,
      rowsDuplicate,
      rowsUnresolved,
      rowsRejected,
      accountsToCreate: plan.accountsToCreate.map((a) => ({
        code: a.code,
        name: a.name,
        rows: accountRowCounts.get(a.code) ?? 0,
      })),
      productsToCreate: plan.productsToCreate.map((p) => ({
        code: p.code,
        unitOfMeasure: p.unitOfMeasure,
        rows: productRowCounts.get(p.code) ?? 0,
      })),
      nameMismatches: plan.nameMismatches.map((m) => ({
        code: m.code,
        storedName: m.storedName,
        fileName: m.fileName,
      })),
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
      orderLines: 0,
      additionalLoadingEvents: 0,
      rowsNew: 0,
      rowsChanged: 0,
      rowsDuplicate: 0,
      rowsUnresolved: 0,
      rowsRejected: 0,
      accountsToCreate: [],
      productsToCreate: [],
      nameMismatches: [],
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
  /**
   * Loading authorities beyond the first, summed over every order.
   *
   * DISTINCT timestamps, not rows. A line loaded seven times against two
   * credit-hold episodes appears as fourteen rows, and reporting fourteen
   * would be repeating the extract's join back at the reader. Counted per
   * ORDER, which is the grain `sales_orders.loading_authority_at` has and the
   * grain the rule that fills it uses.
   */
  additionalLoadingEvents: number;
  /** Reference records this commit created, and the names it refused to overwrite. */
  accountsCreated: number;
  productsCreated: number;
  nameMismatches: number;
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
export function deriveSoStatus(
  head: NormalisedSoRow,
  /**
   * The order's loading authority, which is not necessarily the head row's.
   *
   * The commit stores the EARLIEST authority across the whole order, and the
   * status has to be derived from the same value or the two can disagree: an
   * order whose head row happens to carry no authority would be reported
   * INVOICED while its own column said LOADING. Defaulted to the head row so
   * every existing caller keeps its meaning.
   */
  orderLoadingAuthorityAt: string | null = head.loadingAuthorityAt,
): string {
  const financeApproved = head.approvalStatus === 'APPROVE' && head.approvalAt !== null;
  const creditOpen = head.creditRequired && head.creditReleaseAt === null;
  if (!financeApproved) return 'PENDING_FINANCE';
  if (creditOpen) return 'PENDING_CREDIT';
  if (orderLoadingAuthorityAt !== null) return 'LOADING';
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
async function isolateDocuments(
  db: Client,
  documents: readonly { importRowIds: Map<number, string> }[],
  reason: string,
): Promise<void> {
  const statements: Stmt[] = [];
  for (const document of documents) {
    for (const importRowId of document.importRowIds.values()) {
      // AND NOT ONE THAT WAS ALREADY REFUSED AT VALIDATION. A row rejected for
      // being malformed carries its own reason, and overwriting it with a
      // write failure would replace the true explanation with a later one that
      // is not about this row at all. It also matters to a retry, which
      // re-opens rejected rows: a validation rejection must stay rejected.
      statements.push({
        sql: `UPDATE import_rows SET row_status = 'REJECTED', error_message = ?
              WHERE import_row_id = ? AND imported_at IS NULL
                AND row_status <> 'REJECTED'`,
        args: [reason.slice(0, 400), importRowId],
      });
    }
  }
  // MANY DOCUMENTS PER BATCH, NOT ONE BATCH PER DOCUMENT. Isolation used to
  // cost a round trip per failed document, so a batch where everything failed
  // spent more subrequests being sorry than it did importing. The whole point
  // of this phase is that nothing in the commit is per document any more, and
  // that has to include the unhappy path.
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
/**
 * Plan and create the reference records a batch's rows name.
 *
 * Kept beside the commit rather than inside it because it is a distinct act
 * with its own rule: it decides what to CREATE, while the commit decides what
 * to write. Recomputing the plan against the live tables is what makes a
 * second upload of the same file a no-op, which is criterion 9.
 */
async function createMasterDataForBatch(
  db: Client,
  rows: readonly unknown[],
  batchId: string,
  ctx: WriteContext,
  now: string,
): Promise<{
  accounts: Map<string, string>;
  products: Map<string, string>;
  nameMismatches: readonly NameMismatch[];
}> {
  const accountRequests: AccountRequest[] = [];
  const productRequests: ProductRequest[] = [];
  for (const raw of rows) {
    const record = raw as Record<string, unknown>;
    const parsed = JSON.parse(text(record.raw_json)) as Record<string, unknown>;
    const row = await normaliseRow(parsed, Number(record.source_row_number));
    if (row.customerCode !== null) {
      accountRequests.push({
        code: row.customerCode,
        name: row.customerName,
        affiliateId: row.affiliateId,
      });
    }
    if (row.orderedItem !== null) {
      productRequests.push({ code: normaliseProductCode(row.orderedItem), unitOfMeasure: null });
    }
  }
  const plan: MasterDataPlan = await planMasterData(db, accountRequests, productRequests);
  return createMasterData(db, plan, batchId, ctx, now);
}

/**
 * Read a keyed lookup for a whole batch in a handful of round trips.
 *
 * WHY EVERY READ BELOW IS CHUNKED. The commit used to ask its questions one
 * document at a time: 662 documents cost 662 order lookups, 662 workflow
 * instance lookups, 662 snapshot version reads and 1,117 stage-instance
 * checks. Cloudflare allows 50 outbound subrequests per request on the Free
 * plan and 1,000 on paid, and `@libsql/client/web` spends one per execute, so
 * the real file cost 4,444 and the worker died partway through with nothing
 * to say for itself. That is the whole of "The import could not be
 * completed."
 *
 * An IN list cannot simply be unbounded either: SQLite's default
 * SQLITE_MAX_VARIABLE_NUMBER is 999, so a 1,386-row batch would break the
 * statement instead of the platform. 200 is comfortably inside it and turns
 * 662 reads into four.
 */
const IN_CHUNK = 200;

async function readInChunks(
  db: Client,
  values: readonly string[],
  sql: (placeholders: string) => string,
  onRow: (row: Record<string, unknown>) => void,
  extraArgs: readonly unknown[] = [],
): Promise<void> {
  for (let start = 0; start < values.length; start += IN_CHUNK) {
    const chunk = values.slice(start, start + IN_CHUNK);
    if (chunk.length === 0) continue;
    const result = await db.execute({
      sql: sql(chunk.map(() => '?').join(',')),
      args: [...extraArgs, ...chunk] as never[],
    });
    for (const raw of result.rows) onRow(raw as unknown as Record<string, unknown>);
  }
}

/**
 * The loading authorities an order carries, earliest first, de-duplicated.
 *
 * THE GRAIN THE EXTRACT ACTUALLY HAS. One order line can be loaded more than
 * once, and the file expresses that by repeating the line: 1,386 rows carry
 * only 1,252 distinct (affiliate, document, line) keys. A repeated row is not
 * a duplicate and not a change; it is another event.
 *
 * BUT THE REPEAT IS A CROSS-PRODUCT, NOT A LIST. Measured across all 97
 * repeated keys in the real file: the rows are a product of the event
 * dimensions, so a line with seven loading authorities and two credit-hold
 * episodes appears as FOURTEEN rows, not seven. Counting rows would report
 * fourteen loadings for a line that was loaded seven times. Everything below
 * therefore counts DISTINCT loading timestamps, which is the only figure the
 * source actually supports.
 */
export function loadingAuthorities(rows: readonly NormalisedSoRow[]): string[] {
  const distinct = new Set<string>();
  for (const row of rows) {
    if (row.loadingAuthorityAt !== null) distinct.add(row.loadingAuthorityAt);
  }
  // The timestamps are already `YYYY-MM-DD HH:MM:SS`, so lexical order IS
  // chronological order. They are NOT compared as the raw Excel serials the
  // landing table keeps, where a text sort only agrees with a numeric one by
  // accident of every serial in this file having five integer digits.
  return [...distinct].sort();
}

/**
 * THE RULE, IN ONE SENTENCE: the order's `loading_authority_at` is the
 * EARLIEST loading authority anywhere on the order.
 *
 * `sales_orders` holds one such column, per order rather than per line, and
 * this phase adds no schema. So one of several real events has to be chosen,
 * and the choice must be a documented rule rather than whichever row the
 * spreadsheet happened to put first — which is what it was, and what made the
 * figure unreproducible.
 *
 * EARLIEST, because of what the column feeds. The order-to-loading-authority
 * metric measures how long the customer waited for their first truck. The
 * later authorities are subsequent loads against the same order, and taking
 * one of those would report the wait as longer than the customer experienced
 * it — inflating the number that the SLA is judged on, on exactly the 73
 * orders that load more than once.
 *
 * The ones not chosen are not lost. Every row is in `so_extract_rows`, the
 * count and the range are shown on the order, and the preview reports the
 * additional events as a figure of their own.
 */
export function earliestLoadingAuthority(rows: readonly NormalisedSoRow[]): string | null {
  return loadingAuthorities(rows)[0] ?? null;
}

export async function commitSoBatch(
  db: Client,
  batchId: string,
  ctx: WriteContext,
): Promise<SoCommitResult> {
  const now = toDbTimestamp(ctx.now);
  const result: SoCommitResult = {
    documentsCreated: 0,
    documentsUpdated: 0,
    documentsUnchanged: 0,
    documentsSkipped: 0,
    linesWritten: 0,
    workflowEventsAppended: 0,
    accountsCreated: 0,
    productsCreated: 0,
    nameMismatches: 0,
    additionalLoadingEvents: 0,
  };

  const rowsResult = await db.execute({
    sql: `SELECT import_row_id, source_row_number, row_status, raw_json, imported_at
          FROM import_rows WHERE import_batch_id = ? ORDER BY source_row_number`,
    args: [batchId],
  });

  // ---- The reference records this batch names for the first time ------------
  //
  // BEFORE ANY ORDER IS WRITTEN, because a sales order's account_id and a
  // line's product_id are foreign keys: an order whose customer is created
  // halfway through the run would fail on the rows that came first. The plan
  // is recomputed here rather than carried from validation, so a record
  // somebody created by hand in between is found and not duplicated, and a
  // second upload of the same file creates nothing at all.
  const created = await createMasterDataForBatch(db, rowsResult.rows, batchId, ctx, now);
  result.accountsCreated = created.accounts.size;
  result.productsCreated = created.products.size;
  result.nameMismatches = created.nameMismatches.length;

  // Read AFTER the creation, so the maps contain what was just created.
  const maps = await loadResolutionMaps(db);

  const groups = new Map<
    string,
    DocumentGroup & {
      importRowIds: Map<number, string>;
      statuses: Map<number, string>;
      /** Rows this batch has already written. They are never actioned twice. */
      alreadyImported: Set<number>;
    }
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
      alreadyImported: new Set<number>(),
    };
    group.rows.push(row);
    group.importRowIds.set(row.sourceRowNumber, text(record.import_row_id));
    group.statuses.set(row.sourceRowNumber, text(record.row_status));
    if (record.imported_at !== null) group.alreadyImported.add(row.sourceRowNumber);
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

  // ---- Everything the loop needs to know, asked once ------------------------
  //
  // Four questions that used to be asked per document or per event. The
  // answers are the same either way; the difference is 3,103 round trips.

  // 1. Which of these documents already exist. Grouped by affiliate so the
  //    predicate stays (affiliate, document) rather than document alone, which
  //    would match another entity's identically numbered order.
  const orderIdByDocKey = new Map<string, string>();
  const documentsByAffiliate = new Map<string, string[]>();
  for (const group of groups.values()) {
    const list = documentsByAffiliate.get(group.affiliateId) ?? [];
    list.push(group.documentNumber);
    documentsByAffiliate.set(group.affiliateId, list);
  }
  for (const [affiliateId, documents] of documentsByAffiliate) {
    await readInChunks(
      db,
      documents,
      (placeholders) =>
        `SELECT sales_order_id, affiliate_id, document_number FROM sales_orders
         WHERE affiliate_id = ? AND document_number IN (${placeholders})`,
      (row) => {
        orderIdByDocKey.set(
          `${text(row.affiliate_id)}|${text(row.document_number)}`,
          text(row.sales_order_id),
        );
      },
      [affiliateId],
    );
  }

  // 2. The id every document will use, decided before any write, so the reads
  //    below can be asked about all of them at once. A minted id belongs to a
  //    document that does not exist yet, so it has no instance and no
  //    snapshot, and asking about it would be wasted.
  const orderIdFor = new Map<string, string>();
  for (const [key, group] of groups) {
    orderIdFor.set(key, orderIdByDocKey.get(key) ?? newId('SO'));
    void group;
  }
  const existingOrderIds = [...orderIdByDocKey.values()];

  // 3. The workflow instance of each existing order, and 4. which of its
  //    stages already have an instance. The stage check was 1,117 round trips
  //    on its own, one per event the extract described.
  const instanceByOrderId = new Map<string, string>();
  await readInChunks(
    db,
    existingOrderIds,
    (placeholders) =>
      `SELECT workflow_instance_id, entity_id FROM workflow_instances
       WHERE entity_type = 'SALES_ORDER' AND entity_id IN (${placeholders})`,
    (row) => instanceByOrderId.set(text(row.entity_id), text(row.workflow_instance_id)),
  );
  const stageInstanceKeys = new Set<string>();
  await readInChunks(
    db,
    [...instanceByOrderId.values()],
    (placeholders) =>
      `SELECT workflow_instance_id, workflow_stage_id FROM workflow_stage_instances
       WHERE workflow_instance_id IN (${placeholders})`,
    (row) =>
      stageInstanceKeys.add(`${text(row.workflow_instance_id)}|${text(row.workflow_stage_id)}`),
  );

  // 5. The snapshot version each existing order is on. insertSnapshot reads
  //    this per record and guards it with UNIQUE(entity_type, entity_id,
  //    version_no); the guard is kept below, the per-record read is not.
  const snapshotVersion = new Map<string, number>();
  await readInChunks(
    db,
    existingOrderIds,
    (placeholders) =>
      `SELECT entity_id, MAX(version_no) AS v FROM record_snapshots
       WHERE entity_type = 'SALES_ORDER' AND entity_id IN (${placeholders})
       GROUP BY entity_id`,
    (row) => snapshotVersion.set(text(row.entity_id), Number(row.v ?? 0)),
  );

  // ---- Plan every document, writing nothing ---------------------------------
  interface PlannedDocument {
    group: DocumentGroup & { importRowIds: Map<number, string>; statuses: Map<number, string> };
    salesOrderId: string;
    isNew: boolean;
    statements: Stmt[];
    lines: number;
    events: number;
    extraLoadings: number;
  }
  const planned: PlannedDocument[] = [];

  for (const [key, group] of groups) {
    // A ROW THAT HAS ALREADY LANDED IS NEVER ACTIONED AGAIN. `imported_at` is
    // the record that this batch wrote this row, and re-actioning it would
    // rewrite a canonical record that is already correct and mint a fresh
    // snapshot version for it. That is what made a retry of a PARTIAL batch
    // report importing 662 documents when three needed importing: the other
    // 659 were re-written for nothing. A commit is now idempotent at the row
    // level, which is what lets a retry press safely.
    const actionable = group.rows.filter((r) => {
      if (group.alreadyImported.has(r.sourceRowNumber)) return false;
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

    const existingId = orderIdByDocKey.get(key);
    const salesOrderId = orderIdFor.get(key)!;

    // THE ORDER'S LOADING AUTHORITY, BY THE RULE. Computed from every row of
    // the document, because a loading authority is a fact of the order
    // whatever status its row carries, and de-duplicated because the repeats
    // are a cross-product rather than a list of events.
    const authorities = loadingAuthorities(group.rows);
    const loadingAuthorityAt = authorities[0] ?? null;
    if (authorities.length > 1) result.additionalLoadingEvents += authorities.length - 1;

    // The credit-hold episodes the order carried, counted the same way: by
    // distinct (held at, released at), never by row.
    const creditHoldEpisodes = [
      ...new Set(
        group.rows
          .filter((r) => r.creditHoldAt !== null)
          .map((r) => `${r.creditHoldAt}|${r.creditReleaseAt ?? ''}`),
      ),
    ];

    // Derived from the SAME value the column will hold, so the two can never
    // report different things about one order.
    const status = deriveSoStatus(head, loadingAuthorityAt);
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
          loadingAuthorityAt,
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
          loadingAuthorityAt,
          status,
          salesOrderId,
        ],
      });
    }

    // ---- Lines: ONE per (affiliate, document, line) -------------------------
    //
    // The repeated rows describe one line loaded several times, so they
    // collapse to one `sales_order_lines` row. Every column of the line is
    // identical across the group by construction — the repeats differ only in
    // the event columns, which the line table does not hold — so there is no
    // ambiguity about what to write.
    //
    // The upsert stays. It is what makes a re-upload idempotent, and it is NOT
    // what made this correct: with 1,386 rows and 1,252 keys it was silently
    // overwriting a line 134 times and letting the last row win, which is how
    // an arbitrary loading authority reached the order.
    const byLine = new Map<number, NormalisedSoRow>();
    for (const row of actionable) {
      if (row.lineNumber === null) continue;
      if (!byLine.has(row.lineNumber)) byLine.set(row.lineNumber, row);
    }
    let lines = 0;
    for (const [lineNumber, row] of byLine) {
      const productId = resolveProduct(maps.products, row.orderedItem);
      if (productId === null) continue;
      statements.push({
        sql: `INSERT INTO sales_order_lines
                (sales_order_line_id, sales_order_id, line_number, product_id, quantity,
                 unit_price, line_value)
              VALUES (?, ?, ?, ?, NULL, NULL, NULL)
              ON CONFLICT(sales_order_id, line_number) DO UPDATE SET product_id = excluded.product_id`,
        args: [newId('SOL'), salesOrderId, lineNumber, productId],
      });
      lines += 1;
    }

    // ---- Workflow reconstruction, idempotent on (instance, stage) -----------
    let events = 0;
    const finance = stages.get('FINANCE_APPROVAL');
    if (finance !== undefined) {
      let workflowInstanceId = instanceByOrderId.get(salesOrderId);
      if (workflowInstanceId === undefined) {
        workflowInstanceId = newId('WFI');
        // Recorded so a second document for the same order in one batch, and
        // the stage checks below, both see the instance this run is minting.
        instanceByOrderId.set(salesOrderId, workflowInstanceId);
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
      const financeKey = `${workflowInstanceId}|${finance.stageId}`;
      if (!stageInstanceKeys.has(financeKey) && head.approvalAt !== null) {
        stageInstanceKeys.add(financeKey);
        statements.push({
          sql: `INSERT INTO workflow_stage_instances
                  (workflow_stage_instance_id, workflow_instance_id, workflow_stage_id,
                   assigned_user_id, status, assigned_at, started_at, completed_at, action_notes)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Reconstructed from the SO extract')`,
          args: [
            newId('WSI'),
            workflowInstanceId,
            finance.stageId,
            financeUser,
            head.approvalStatus === 'REJECT' ? 'REJECTED' : 'APPROVED',
            head.orderCreatedAt,
            head.orderCreatedAt,
            head.approvalAt,
          ],
        });
        events += 1;
      }
      const credit = stages.get('CREDIT_CHECK');
      if (credit !== undefined && head.creditRequired && head.creditHoldAt !== null) {
        const creditKey = `${workflowInstanceId}|${credit.stageId}`;
        if (!stageInstanceKeys.has(creditKey)) {
          stageInstanceKeys.add(creditKey);
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
              workflowInstanceId,
              credit.stageId,
              creditUser,
              head.creditReleaseAt === null ? 'ACTIVE' : 'APPROVED',
              head.creditHoldAt,
              head.creditHoldAt,
              head.creditReleaseAt,
            ],
          });
          events += 1;
        }
      }
    }

    // Every row the document consumed, including the repeats: they belong to
    // this order and their provenance says so, whatever the canonical model
    // could hold of them.
    for (const row of group.rows) {
      const importRowId = group.importRowIds.get(row.sourceRowNumber);
      const status = group.statuses.get(row.sourceRowNumber);
      if (importRowId === undefined) continue;
      // Including the repeats, which are DUPLICATE: they belong to this order
      // and their provenance says so, whatever the canonical model could hold
      // of them.
      if (status !== 'NEW' && status !== 'CHANGED' && status !== 'DUPLICATE') continue;
      statements.push({
        sql: `UPDATE import_rows SET entity_id = ?, imported_at = ? WHERE import_row_id = ?`,
        args: [salesOrderId, now, importRowId],
      });
    }

    // The snapshot, planned with the version this run allocates. The database
    // still guards it: UNIQUE(entity_type, entity_id, version_no) is what
    // makes two concurrent commits impossible to reconcile silently, and the
    // fallback below re-reads and retries exactly as before if it fires.
    const nextVersion = (snapshotVersion.get(salesOrderId) ?? 0) + 1;
    snapshotVersion.set(salesOrderId, nextVersion);
    const snapshotId = newId('SNAP');
    const headRow = actionable[0] ?? head;
    statements.push(
      {
        sql: `UPDATE record_snapshots SET is_current = 0
              WHERE entity_type = 'SALES_ORDER' AND entity_id = ? AND is_current = 1`,
        args: [salesOrderId],
      },
      {
        sql: `INSERT INTO record_snapshots
                (snapshot_id, entity_type, entity_id, import_batch_id, source_record_key,
                 version_no, row_hash, snapshot_json, captured_at, is_current)
              VALUES (?, 'SALES_ORDER', ?, ?, ?, ?, ?, ?, ?, 1)`,
        args: [
          snapshotId,
          salesOrderId,
          batchId,
          `${group.affiliateId}|${group.documentNumber}`,
          nextVersion,
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
            // The chosen one, the rule that chose it, and every one there was,
            // so the snapshot records the decision and not only its result.
            loadingAuthorityAt,
            loadingAuthorityRule: 'earliest',
            loadingAuthorities: authorities,
            // THE OTHER DIMENSION THE REPEATS CARRY. The rows are a
            // cross-product, and loading is only one of its axes: 38 lines in
            // the real file carry a SECOND credit-hold episode, which is why a
            // line loaded seven times can appear fourteen times. The canonical
            // model holds one credit envelope per order and this phase adds no
            // schema, so the count is recorded here rather than being lost
            // between a row count nobody can explain and a single date. Every
            // episode itself is in so_extract_rows.
            creditHoldEpisodes: creditHoldEpisodes.length,
            status,
            lines: [...byLine.keys()].sort((a, b) => a - b),
          }),
          now,
        ],
      },
      {
        sql: `UPDATE sales_orders SET latest_snapshot_id = ? WHERE sales_order_id = ?`,
        args: [snapshotId, salesOrderId],
      },
    );

    planned.push({
      group,
      salesOrderId,
      isNew: existingId === undefined,
      statements,
      lines,
      events,
      extraLoadings: Math.max(0, authorities.length - 1),
    });
  }

  // ---- Write, in chunks, isolating a document only when one actually fails ---
  //
  // THE DOCUMENT IS STILL THE UNIT OF INTEGRITY. It just is not the unit of
  // ROUND TRIPS any more. Documents are packed into batches until the
  // statement budget is reached and sent together; if a batch is refused,
  // its documents are retried one at a time so the broken one is isolated
  // with its own reason and the rest still land. The happy path costs a
  // handful of writes and the unhappy path costs what it used to.
  // ---- Write, in chunks, isolating a document only when one actually fails ---
  //
  // THE DOCUMENT IS STILL THE UNIT OF INTEGRITY. It just is not the unit of
  // ROUND TRIPS any more. Documents are packed into batches until the
  // statement budget is reached and sent together; if a batch is refused, its
  // documents are retried one at a time so the broken one is isolated with its
  // own reason and the rest still land.
  //
  // AND THE UNHAPPY PATH IS BOUNDED, which is the part that matters. Retrying
  // every document of every chunk individually would cost roughly 2 round
  // trips per document: on a batch where everything fails that is about 1,400
  // for this file, which is over Cloudflare's paid limit of 1,000 and 28 times
  // the free one. It would reproduce the exact production symptom — the worker
  // dies mid-flight, the batch is stranded at READY, and the browser says "The
  // import could not be completed." — while claiming to have fixed it.
  //
  // So there is a budget. A handful of bad documents in a good batch is worth
  // finding one by one. Hundreds of bad documents is not a hundred separate
  // problems, it is one systemic problem, and the honest answer is to stop
  // guessing, name the constraint from the failure already in hand, and mark
  // the rest without pretending each was examined.
  const WRITE_CHUNK = 400;
  // EIGHT, AND THE NUMBER IS THE PLATFORM'S NOT A TASTE. A retry of a failed
  // batch re-enters this path by definition, and the whole request has already
  // spent about 36 subrequests by the time it gets here. Cloudflare allows 50.
  // Twenty-four individual retries would put the worst case at 60 and kill the
  // request mid-flight — which is the exact failure this control exists to
  // recover from, reproduced by the recovery.
  const MAX_INDIVIDUAL_RETRIES = 8;

  const chunks: PlannedDocument[][] = [];
  let current: PlannedDocument[] = [];
  let size = 0;
  for (const document of planned) {
    if (current.length > 0 && size + document.statements.length > WRITE_CHUNK) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(document);
    size += document.statements.length;
  }
  if (current.length > 0) chunks.push(current);

  const succeed = (document: PlannedDocument) => {
    result.linesWritten += document.lines;
    result.workflowEventsAppended += document.events;
    if (document.isNew) result.documentsCreated += 1;
    else result.documentsUpdated += 1;
  };
  const failed: { document: PlannedDocument; reason: string }[] = [];
  const fail = (document: PlannedDocument, reason: string) => {
    failed.push({ document, reason });
    result.documentsSkipped += 1;
    result.additionalLoadingEvents -= document.extraLoadings;
  };

  let retriesLeft = MAX_INDIVIDUAL_RETRIES;
  let abandoned: PlannedDocument[] = [];
  let systemicReason: string | null = null;

  for (const [index, chunk] of chunks.entries()) {
    if (systemicReason !== null) {
      abandoned = abandoned.concat(chunk);
      continue;
    }
    const statements = chunk.flatMap((d) => d.statements);
    try {
      await db.batch(statements, 'write');
      for (const document of chunk) succeed(document);
      continue;
    } catch (error) {
      // A refused chunk says only that ONE of its documents is bad. Naming
      // which, with the table, the constraint and the values, is what the log
      // is for; the trace id is what a person quotes to find this line.
      const traceId = newTraceId();
      const report = await logWriteFailure(db, 'import.so.commit', traceId, statements, error);
      const reason =
        `The document could not be written: ${report.constraint}` +
        `${report.table === null ? '' : ` on ${report.table}`}. Trace ${traceId}.`;

      if (chunk.length === 1) {
        fail(chunk[0]!, reason);
        continue;
      }
      if (retriesLeft < chunk.length) {
        // Not enough budget to examine this chunk document by document. Every
        // remaining chunk is abandoned with the constraint that was actually
        // reported, rather than spending a thousand round trips discovering
        // the same thing 662 times.
        systemicReason =
          `${reason} The batch was stopped after ${index + 1} of ${chunks.length} write ` +
          `batches: too many documents were failing for each to be examined on its own.`;
        abandoned = abandoned.concat(chunk);
        continue;
      }
      // Retried one document at a time, which is the old behaviour, reached
      // only when something genuinely failed and the budget allows it.
      for (const document of chunk) {
        retriesLeft -= 1;
        try {
          await db.batch(document.statements, 'write');
          succeed(document);
        } catch (documentError) {
          const documentTrace = newTraceId();
          const documentReport = await logWriteFailure(
            db,
            'import.so.commit',
            documentTrace,
            document.statements,
            documentError,
          );
          fail(
            document,
            `The document could not be written: ${documentReport.constraint}` +
              `${documentReport.table === null ? '' : ` on ${documentReport.table}`}. ` +
              `Trace ${documentTrace}.`,
          );
        }
      }
    }
  }

  for (const document of abandoned) fail(document, systemicReason ?? 'The batch was stopped.');

  // One pass over everything that failed, grouped by the reason it failed for,
  // so the whole unhappy path costs a few round trips rather than one each.
  const byReason = new Map<string, PlannedDocument[]>();
  for (const entry of failed) {
    const list = byReason.get(entry.reason) ?? [];
    list.push(entry.document);
    byReason.set(entry.reason, list);
  }
  for (const [reason, documents] of byReason) {
    await isolateDocuments(
      db,
      documents.map((d) => ({ importRowIds: d.group.importRowIds })),
      reason,
    );
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
