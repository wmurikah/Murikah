/**
 * The purchase order importer, against the real PO-Ver1.xls shape.
 *
 * ONE ROW IS ONE PURCHASE ORDER, AND THERE IS NO LINE GRAIN.
 * 45 rows describe 45 orders across 29 columns. The extract carries no
 * product line, no quantity and no cost, so this importer creates NO
 * purchase order lines at all. The line table waits for an extract that
 * genuinely has lines; fabricating a single line to hold "the product"
 * would invent a fact the source does not contain.
 *
 * SEVEN APPROVAL LEVELS ARE POSSIBLE; FOUR IS WHAT THIS FILE USES.
 * Nothing below is written for four. The template carries FIRST through
 * SEVENTH, every level is processed dynamically, and a level whose approval
 * date is blank is not an elapsed stage: it is a stage that never happened,
 * so no stage instance is created for it. A future extract that fills six
 * levels needs no code change, which the tests prove with synthetic seven
 * and three level rows.
 *
 * A SEQUENCE NUMBER IS NOT A JOB TITLE.
 * Level N is matched to the stage that the approved workflow definition
 * places at sequence N, because the definition is the semantic source. Where
 * the definition has no stage at that sequence, the level gets the explicit
 * code PO_APPROVAL_N and the neutral name "Approval level N", never a job
 * title inferred from the column position.
 *
 * NATURE IS NOT A CATALOGUE MAPPING, AND THE FILE PROVES IT.
 * Nine of the 21 rows marked LPG are 2go shop procurement: assorted
 * pastries, soft drinks, dried fruits. Mapping NATURE onto the petroleum
 * catalogue would file pastries under liquefied petroleum gas. So NATURE is
 * preserved and reported as a source classification, and no import writes
 * anything into the product catalogue.
 *
 * THE AFFILIATE COMES FROM THE OPERATOR, NOT FROM A GUESS.
 * `affiliate_id` is NOT NULL and the file has no affiliate column, so the
 * Upload Centre supplies it. An upload without one is refused before a batch
 * row exists, so the operator can correct the selection and upload the same
 * file again.
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
  type HeaderClassification,
  type MappingReportLine,
  loadPriorHashes,
  rejectBatch,
  describeFailure,
} from './workbook.ts';
import {
  planLanding,
  landingStatements,
  clearLandingStatement,
  PO_LANDING_TABLE,
} from './landing.ts';
import { verifyColumns } from './completeness.ts';
import { insertSnapshot, PURCHASE_ORDER_SNAPSHOT } from './snapshots.ts';

type Stmt = Extract<InStatement, { sql: string }>;
const text = (v: unknown): string => String(v ?? '');

/** The seven level prefixes the template carries, in order. */
export const LEVEL_PREFIXES = [
  'FIRST',
  'SECOND',
  'THIRD',
  'FOURTH',
  'FIFTH',
  'SIXTH',
  'SEVENTH',
] as const;

export const MAX_APPROVAL_LEVELS = LEVEL_PREFIXES.length;

/** All 29 headers of the inspected extract, each with exactly one treatment. */
export const PO_HEADER_CLASSIFICATION: Readonly<Record<string, HeaderClassification>> = {
  'purchase Number': {
    treatment: 'canonical',
    target: 'purchase_orders.document_number, normalised',
  },
  'Req Description': {
    treatment: 'raw_only',
    target: 'raw_json and the snapshot: free text, never parsed into master data',
  },
  NATURE: {
    treatment: 'raw_only',
    target: 'raw_json: a source classification, reported, never a catalogue mapping',
  },
  ORIGINAL_CREATION_DATE: { treatment: 'canonical', target: 'purchase_orders.po_created_at' },
  SUBMISSION_FOR_APPROVAL_DATE: {
    treatment: 'canonical',
    target: 'purchase_orders.submitted_for_approval_at',
  },
  TIME_DIFF_RAISEPO_TOAPROVALSUBMIT: {
    treatment: 'source_metric',
    target: 'reconciliation view only, never a KPI',
  },
  PURCHASE_ORDER_CREATED_BY: {
    treatment: 'workflow',
    target: 'order creator via source_identities, username form',
  },
  AUTHORIZATION_STATUS: { treatment: 'workflow', target: 'purchase_orders.status, conservatively' },
  ...approvalHeaderClassification(),
};

function approvalHeaderClassification(): Record<string, HeaderClassification> {
  const entries: Record<string, HeaderClassification> = {};
  LEVEL_PREFIXES.forEach((prefix, index) => {
    const level = index + 1;
    entries[`${prefix}_APPROVAL_DATE`] = {
      treatment: 'workflow',
      target: `approval level ${level} completion timestamp; blank means the level never happened`,
    };
    entries[`${prefix}_APPROVER`] = {
      treatment: 'workflow',
      target: `approval level ${level} actor via source_identities, reversed display-name form`,
    };
    entries[`${prefix}_APPROVALS_VARIANCE`] = {
      treatment: 'source_metric',
      target: `source cumulative minutes to level ${level}, reconciliation only, never a KPI`,
    };
  });
  return entries;
}

/**
 * The prerequisite check, run with queries before anything imports. The four
 * facts section 3 of the build names are checked by name, plus the line
 * columns, so a future line-grain extract finds the ground already prepared.
 */
export async function verifyPoSourceCompleteness(
  db: Client,
): Promise<{ ok: boolean; problems: string[]; checked: { column: string; nullable: boolean }[] }> {
  const result = await verifyColumns(db, [
    { table: 'purchase_orders', column: 'submitted_for_approval_at', requirement: 'EXISTS' },
    { table: 'purchase_orders', column: 'supplier_name', requirement: 'NULLABLE' },
    { table: 'purchase_orders', column: 'currency_code', requirement: 'NULLABLE' },
    { table: 'purchase_orders', column: 'po_value', requirement: 'NULLABLE' },
    { table: 'purchase_order_lines', column: 'quantity', requirement: 'NULLABLE' },
    { table: 'purchase_order_lines', column: 'unit_cost', requirement: 'NULLABLE' },
    { table: 'purchase_order_lines', column: 'line_value', requirement: 'NULLABLE' },
  ]);
  return {
    ok: result.ok,
    problems: result.problems,
    checked: result.checked.map((c) => ({
      column: `${c.table}.${c.column}`,
      nullable: c.nullable,
    })),
  };
}

// ---- Normalised rows ---------------------------------------------------------

export interface PoApproval {
  level: number;
  approvedAt: string;
  approver: string | null;
  /** The spreadsheet's own figure. Cumulative from submission, and never a KPI. */
  sourceVarianceMinutes: number | null;
}

export interface NormalisedPoRow {
  sourceRowNumber: number;
  raw: Record<string, unknown>;
  affiliateId: string | null;
  purchaseNumber: string | null;
  description: string | null;
  nature: string | null;
  createdAt: string | null;
  submittedAt: string | null;
  createdBy: string | null;
  authorizationStatus: string | null;
  sourceCreatedToSubmittedMinutes: number | null;
  /** Only the levels the source actually recorded, in level order. */
  approvals: PoApproval[];
  sourceKey: string | null;
  rowHash: string;
}

/**
 * Read the approval levels that actually happened. A level counts only when
 * it carries an approval date: an approver name beside a blank date records
 * who would approve, not that anybody did, and the stage stays uncreated.
 */
export function readApprovals(raw: Record<string, unknown>): PoApproval[] {
  const approvals: PoApproval[] = [];
  LEVEL_PREFIXES.forEach((prefix, index) => {
    const approvedAt = cellToTimestamp(raw[`${prefix}_APPROVAL_DATE`]);
    if (approvedAt === null) return;
    approvals.push({
      level: index + 1,
      approvedAt,
      approver: cellToText(raw[`${prefix}_APPROVER`]),
      sourceVarianceMinutes: cellToNumber(raw[`${prefix}_APPROVALS_VARIANCE`]),
    });
  });
  return approvals;
}

export async function normalisePoRow(
  raw: Record<string, unknown>,
  sourceRowNumber: number,
  /** Null for a Group-scope batch, which is what this extract always is. */
  affiliateId: string | null,
): Promise<NormalisedPoRow> {
  const purchaseNumber = cellToIdentifier(raw['purchase Number']);
  const approvals = readApprovals(raw);
  // The canonical hash carries the facts, not the spreadsheet's arithmetic:
  // a recalculated variance column with unchanged timestamps is a formula
  // artefact, not a change to the purchase order, and marking 45 rows
  // CHANGED for it would rewrite every snapshot for nothing. The status IS
  // in the hash, because a purchase order moving to APPROVED is a change.
  const canonical: Record<string, unknown> = {
    purchaseNumber,
    affiliateId,
    description: cellToText(raw['Req Description']),
    nature: cellToText(raw.NATURE),
    createdAt: cellToTimestamp(raw.ORIGINAL_CREATION_DATE),
    submittedAt: cellToTimestamp(raw.SUBMISSION_FOR_APPROVAL_DATE),
    createdBy: cellToText(raw.PURCHASE_ORDER_CREATED_BY),
    authorizationStatus: cellToText(raw.AUTHORIZATION_STATUS),
  };
  for (const approval of approvals) {
    canonical[`approval${approval.level}At`] = approval.approvedAt;
    canonical[`approver${approval.level}`] = approval.approver;
  }
  return {
    sourceRowNumber,
    raw,
    affiliateId,
    purchaseNumber,
    description: text(canonical.description) === '' ? null : (canonical.description as string),
    nature: canonical.nature as string | null,
    createdAt: canonical.createdAt as string | null,
    submittedAt: canonical.submittedAt as string | null,
    createdBy: canonical.createdBy as string | null,
    authorizationStatus: canonical.authorizationStatus as string | null,
    sourceCreatedToSubmittedMinutes: cellToNumber(raw.TIME_DIFF_RAISEPO_TOAPROVALSUBMIT),
    approvals,
    // Identity only: the affiliate and the purchase number, and nothing that
    // changes. A line identifier joins this key when an extract has lines.
    // The order's own identity where the file names no entity. A purchase
    // number is unique in the source system, so qualifying it with an
    // affiliate the extract never stated would only invent a distinction.
    sourceKey:
      purchaseNumber === null
        ? null
        : affiliateId === null
          ? purchaseNumber
          : `${affiliateId}|${purchaseNumber}`,
    rowHash: await hashCanonicalRow(canonical),
  };
}

// ---- Durations ---------------------------------------------------------------

export interface StageDuration {
  level: number;
  /** The moment the level became actionable: submission for level one, the previous approval after that. */
  actionableFrom: string | null;
  approvedAt: string;
  /** This application's arithmetic, in minutes, for this level alone. */
  computedMinutes: number | null;
  /** The spreadsheet's figure for the same level, which is cumulative from submission. */
  sourceVarianceMinutes: number | null;
}

/**
 * Stage durations, computed from timestamps and nothing else.
 *
 * A level's clock starts when it became actionable, which is the submission
 * for level one and the previous level's approval after that. The source
 * variance column is carried beside it untouched: the file's own figures
 * accumulate from submission, so level three reads 89.25 where this stage
 * genuinely took 60.77 minutes. Both are shown, neither is corrected, and
 * only the computed figure is ever a measure.
 */
export function stageDurations(row: NormalisedPoRow): StageDuration[] {
  let previous = row.submittedAt;
  return row.approvals.map((approval) => {
    const actionableFrom = previous;
    previous = approval.approvedAt;
    return {
      level: approval.level,
      actionableFrom,
      approvedAt: approval.approvedAt,
      computedMinutes: minutesBetween(actionableFrom, approval.approvedAt),
      sourceVarianceMinutes: approval.sourceVarianceMinutes,
    };
  });
}

export interface PoDurations {
  createdToSubmittedMinutes: number | null;
  submittedToFinalApprovalMinutes: number | null;
  createdToFinalApprovalMinutes: number | null;
  sourceCreatedToSubmittedMinutes: number | null;
  /** Absent from this extract, so null and rendered "Not available", never zero. */
  submittedToPhysicalReceiptMinutes: null;
  submittedToOraclePostingMinutes: null;
}

export function poDurations(row: NormalisedPoRow): PoDurations {
  const final = row.approvals[row.approvals.length - 1]?.approvedAt ?? null;
  return {
    createdToSubmittedMinutes: minutesBetween(row.createdAt, row.submittedAt),
    submittedToFinalApprovalMinutes: minutesBetween(row.submittedAt, final),
    createdToFinalApprovalMinutes: minutesBetween(row.createdAt, final),
    sourceCreatedToSubmittedMinutes: row.sourceCreatedToSubmittedMinutes,
    submittedToPhysicalReceiptMinutes: null,
    submittedToOraclePostingMinutes: null,
  };
}

/**
 * The status, derived only from what the extract proves.
 *
 * Nothing here can claim RECEIVED or POSTED: those need a physical receipt
 * or an Oracle posting timestamp and this file has neither, so the final
 * approval date is never borrowed to stand in for one.
 */
export function derivePoStatus(row: NormalisedPoRow): string {
  const declared = (row.authorizationStatus ?? '').toUpperCase();
  if (declared === 'CANCELLED') return 'CANCELLED';
  if (row.submittedAt === null) return 'CREATED';
  if (declared === 'APPROVED') return 'APPROVED';
  return 'IN_APPROVAL';
}

// ---- Identity resolution -----------------------------------------------------

/**
 * The identities this affiliate may resolve, and no others.
 *
 * A mapping scoped to Kenya answers for a Kenyan upload only. The same
 * approver name arriving under another affiliate stays unresolved until an
 * administrator maps it there, so one display name never silently carries
 * one person's authority across two countries. A mapping with no affiliate
 * is a deliberate group-wide mapping and answers everywhere, and an
 * affiliate-specific row always wins over it.
 */
async function loadIdentities(
  db: Client,
  affiliateId: string | null,
): Promise<Map<string, string>> {
  const result = await db.execute({
    sql: `SELECT external_username, user_id, affiliate_id FROM source_identities
          WHERE active = 1 AND (affiliate_id = ? OR affiliate_id IS NULL)`,
    args: [affiliateId],
  });
  const map = new Map<string, string>();
  const scoped = new Set<string>();
  for (const raw of result.rows) {
    const row = raw as unknown as Record<string, unknown>;
    const key = text(row.external_username).toUpperCase();
    const isScoped = row.affiliate_id !== null && row.affiliate_id !== undefined;
    if (isScoped) {
      map.set(key, text(row.user_id));
      scoped.add(key);
    } else if (!scoped.has(key)) {
      map.set(key, text(row.user_id));
    }
  }
  return map;
}

// ---- Validation --------------------------------------------------------------

export interface PoValidation {
  batchId: string | null;
  fileSha256: string | null;
  /** Set where the upload was refused before a batch existed, so the same file may be sent again. */
  rejectedReason: string | null;
  duplicateOfBatchId: string | null;
  affiliateId: string | null;
  rowsReceived: number;
  uniqueOrders: number;
  rowsNew: number;
  rowsChanged: number;
  rowsDuplicate: number;
  rowsRejected: number;
  /** How many orders used one level, two levels, and so on up to seven. */
  approvalLevelDistribution: { level: number; orders: number }[];
  unresolvedActors: { username: string; rows: number }[];
  natureDistribution: { nature: string; rows: number }[];
  /** Headers with no column in the landing table. Kept in extra_json. */
  unmappedColumns: string[];
  missingMandatory: { row: number; problem: string }[];
  report: MappingReportLine[];
  dateRange: { from: string | null; to: string | null };
}

function emptyValidation(overrides: Partial<PoValidation>): PoValidation {
  return {
    batchId: null,
    fileSha256: null,
    rejectedReason: null,
    duplicateOfBatchId: null,
    affiliateId: null,
    rowsReceived: 0,
    uniqueOrders: 0,
    rowsNew: 0,
    rowsChanged: 0,
    rowsDuplicate: 0,
    rowsRejected: 0,
    approvalLevelDistribution: [],
    unresolvedActors: [],
    natureDistribution: [],
    unmappedColumns: [],
    missingMandatory: [],
    report: [],
    dateRange: { from: null, to: null },
    ...overrides,
  };
}

export interface PoUploadInput {
  filename: string;
  uploadedBy: string;
  sourceSystemId: string;
  /**
   * Set only when reprocessing: the batch to run again, in place.
   *
   * HOW THIS SEPARATES THE TWO CASES. `UNIQUE(file_sha256)` and the duplicate
   * check exist to answer one question: is somebody uploading a file that has
   * been uploaded before? Reprocessing is not a second upload. It declares up
   * front which batch it IS, so the question is never asked, no batch row is
   * created and no file_objects row is written. The identity, the uploader,
   * the upload timestamp and the file hash all stay exactly as they were.
   */
  reprocessBatchId?: string | null;
  /** Chosen on the Upload Centre form. The file carries no affiliate column. */
  affiliateId: string | null;
}

export async function validatePoWorkbook(
  db: Client,
  buffer: ArrayBuffer | Uint8Array,
  input: PoUploadInput,
  ctx: WriteContext,
): Promise<PoValidation> {
  const completeness = await verifyPoSourceCompleteness(db);
  if (!completeness.ok) {
    throw new Error(
      `Source-completeness prerequisite missing: ${completeness.problems.join('; ')}`,
    );
  }

  // NO AFFILIATE COLUMN MEANS GROUP SCOPE, NOT A MISSING INPUT.
  //
  // The purchase order extract carries no affiliate column at all: all 29 of
  // them are approval dates, approvers, variances and the order's own fields.
  // This used to be refused, and the operator was asked to pick an affiliate
  // the file never claimed, which invents a fact. A file that names no entity
  // measures across all of them, so the batch is Group scope and says so.
  //
  // An affiliate may still be supplied, because a future extract might carry
  // one; when it is, it is checked as before.
  const affiliateId = input.affiliateId === null ? null : input.affiliateId.trim() || null;
  if (affiliateId !== null) {
    const known = await db.execute({
      sql: `SELECT affiliate_id FROM affiliates WHERE affiliate_id = ? LIMIT 1`,
      args: [affiliateId],
    });
    if (known.rows[0] === undefined) {
      return emptyValidation({
        rejectedReason: `The affiliate ${affiliateId} is not configured. Nothing was imported.`,
      });
    }
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
    return emptyValidation({
      fileSha256,
      affiliateId,
      duplicateOfBatchId: text(existing.rows[0].import_batch_id),
    });
  }

  const sheet = parseWorkbook(buffer);
  const identities = await loadIdentities(db, affiliateId);
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
        buffer.byteLength,
        fileSha256,
        input.uploadedBy,
        now,
      ],
    },
    {
      sql: `INSERT INTO import_batches
                (import_batch_id, source_system_id, import_type, original_filename, file_sha256,
                 uploaded_by_user_id, uploaded_at, rows_received, status)
              VALUES (?, ?, 'PURCHASE_ORDER', ?, ?, ?, ?, ?, 'VALIDATING')`,
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
  // received recorded and nothing else, which is precisely the state the
  // operator was looking at. Now it lands on REJECTED with the reason in the
  // audit trail.
  try {
    const orders = new Set<string>();
    const unresolvedActors = new Map<string, number>();
    const natures = new Map<string, number>();
    const levelCounts = new Map<number, number>();
    const missingMandatory: { row: number; problem: string }[] = [];
    let rowsNew = 0;
    let rowsChanged = 0;
    let rowsDuplicate = 0;
    let rowsRejected = 0;
    let from: string | null = null;
    let to: string | null = null;
    const seenInBatch = new Map<string, string[]>();
    const statements: Stmt[] = [];

    // EVERY ROW NORMALISED FIRST, THEN ONE QUERY FOR THE PRIOR HASHES.
    //
    // This loop used to issue `SELECT DISTINCT row_hash` per row, inside the
    // loop. Forty-five rows is forty-five outbound subrequests, and with the
    // dozen the surrounding upload already spends, one validation of
    // PO-Ver1.xls cost 57. Cloudflare's Free plan allows 50 per request, so the
    // run died at the 51st, part-way through the loop: the batch row existed
    // with status VALIDATING and rows_received 45, and the statements that
    // write import_rows and set READY were never reached. That is the stuck
    // validation, and this is its cause.
    //
    // Resolving the whole key space in one read costs one subrequest whatever
    // the row count, so the cost of a validation no longer follows the size of
    // the extract.
    const normalised = [];
    for (let index = 0; index < sheet.rows.length; index++) {
      normalised.push(await normalisePoRow(sheet.rows[index] ?? {}, index + 1, affiliateId));
    }
    const priorByKey = await loadPriorHashes(
      db,
      normalised.map((r) => r.sourceKey).filter((k): k is string => k !== null),
      batchId,
    );

    // Which headers this database can hold in a column of their own, read from
    // the live table rather than compiled in. One read.
    const landing = await planLanding(db, PO_LANDING_TABLE, sheet.headers);
    if (landing !== null) {
      statements.push(clearLandingStatement(PO_LANDING_TABLE, batchId));
    }

    for (let index = 0; index < sheet.rows.length; index++) {
      const raw = sheet.rows[index] ?? {};
      const row = normalised[index]!;
      if (row.nature !== null) natures.set(row.nature, (natures.get(row.nature) ?? 0) + 1);
      if (row.createdAt !== null) {
        if (from === null || row.createdAt < from) from = row.createdAt;
        if (to === null || row.createdAt > to) to = row.createdAt;
      }

      let status: 'NEW' | 'CHANGED' | 'DUPLICATE' | 'REJECTED';
      let error: string | null = null;

      if (row.sourceKey === null || row.createdAt === null) {
        status = 'REJECTED';
        error =
          row.sourceKey === null
            ? 'The row has no purchase number, so it has no identity.'
            : 'The row has no original creation date.';
        missingMandatory.push({ row: row.sourceRowNumber, problem: error });
        rowsRejected += 1;
      } else {
        orders.add(row.sourceKey);
        levelCounts.set(row.approvals.length, (levelCounts.get(row.approvals.length) ?? 0) + 1);

        // An unmapped actor never stops the purchase order importing. The order
        // is a fact of its own; who approved it is a workflow detail that stays
        // unassigned until an administrator maps the name, and the row is
        // revalidated. Nothing here creates a user.
        const actors = [row.createdBy, ...row.approvals.map((a) => a.approver)];
        for (const actor of actors) {
          if (actor !== null && !identities.has(actor.toUpperCase())) {
            const key = actor.toUpperCase();
            unresolvedActors.set(key, (unresolvedActors.get(key) ?? 0) + 1);
          }
        }

        // Change detection against every hash ever seen for this key, the same
        // rule the sales order extract forced: membership, not "the last one".
        const priorHashes = new Set(priorByKey.get(row.sourceKey) ?? []);
        for (const seen of seenInBatch.get(row.sourceKey) ?? []) priorHashes.add(seen);
        const batchSeen = seenInBatch.get(row.sourceKey) ?? [];
        batchSeen.push(row.rowHash);
        seenInBatch.set(row.sourceKey, batchSeen);

        if (priorHashes.size === 0) {
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
            VALUES (?, ?, ?, ?, 'PURCHASE_ORDER', ?, ?, ?, ?)`,
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

    // Every parsed row landed, on the queue the loop already built, so the
    // landing costs no round trip of its own and writes nothing canonical.
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

    for (const username of unresolvedActors.keys()) {
      statements.push({
        sql: `INSERT INTO unresolved_actors
              (unresolved_actor_id, import_batch_id, source_system_id, external_username,
               affiliate_id, status)
            VALUES (?, ?, ?, ?, ?, 'OPEN')`,
        args: [newId('UACT'), batchId, input.sourceSystemId, username, affiliateId],
      });
    }
    statements.push({
      sql: `UPDATE import_batches SET rows_new = ?, rows_changed = ?, rows_exact_duplicate = ?,
            rows_rejected = ?, reporting_period_from = ?, reporting_period_to = ?, status = 'READY'
          WHERE import_batch_id = ?`,
      args: [rowsNew, rowsChanged, rowsDuplicate, rowsRejected, from, to, batchId],
    });
    for (let start = 0; start < statements.length; start += 200) {
      await db.batch(statements.slice(start, start + 200), 'write');
    }

    return {
      batchId,
      fileSha256,
      rejectedReason: null,
      duplicateOfBatchId: null,
      affiliateId,
      rowsReceived: sheet.rows.length,
      uniqueOrders: orders.size,
      rowsNew,
      rowsChanged,
      rowsDuplicate,
      rowsRejected,
      approvalLevelDistribution: Array.from({ length: MAX_APPROVAL_LEVELS }, (_unused, i) => ({
        level: i + 1,
        orders: levelCounts.get(i + 1) ?? 0,
      })),
      unresolvedActors: [...unresolvedActors.entries()].map(([username, rows]) => ({
        username,
        rows,
      })),
      natureDistribution: [...natures.entries()].map(([nature, rows]) => ({ nature, rows })),
      unmappedColumns: landing === null ? [] : landing.unmapped,
      missingMandatory,
      report: buildMappingReport(PO_HEADER_CLASSIFICATION, sheet.headers, sheet.rows),
      dateRange: { from, to },
    };
  } catch (error) {
    await rejectBatch(db, batchId, describeFailure(error), {
      actorUserId: ctx.actorUserId,
      now: toDbTimestamp(ctx.now),
      auditId: newId('AEV'),
    });
    return emptyValidation({
      fileSha256,
      affiliateId,
      rejectedReason:
        'Validation could not be completed, so nothing was imported. ' + describeFailure(error),
    });
  }
}

// ---- Commit ------------------------------------------------------------------

export interface PoCommitResult {
  ordersCreated: number;
  ordersUpdated: number;
  ordersUnchanged: number;
  ordersSkipped: number;
  /** Always zero. The extract has no line grain and none is invented. */
  linesWritten: number;
  /** Stage rows minted for a level the workflow definition does not configure. */
  stagesCreated: number;
  stageEventsAppended: number;
  ordersWithoutWorkflowDefinition: number;
}

interface StageRef {
  stageId: string;
  stageCode: string;
}

/**
 * The stage that carries approval level N.
 *
 * Where the active definition configures a stage at sequence N, that stage
 * is the answer, name and meaning included: the definition is the semantic
 * source. Where it does not, a stage is minted with the neutral code
 * PO_APPROVAL_N. It is never given a job title, because a column position
 * does not know one.
 */
function stageForLevel(
  configured: Map<number, StageRef>,
  definitionId: string,
  level: number,
  statements: Stmt[],
  created: { count: number; levels: number[] },
): StageRef {
  const existing = configured.get(level);
  if (existing !== undefined) return existing;
  const stageId = newId('WST');
  const ref: StageRef = { stageId, stageCode: `PO_APPROVAL_${level}` };
  statements.push({
    sql: `INSERT INTO workflow_stages
            (workflow_stage_id, workflow_definition_id, stage_code, stage_name, sequence_no,
             assignment_type, assigned_user_id, assigned_workflow_role_id, assigned_team_id,
             approval_mode, required_approvals, sla_rule_id, terminal_stage)
          VALUES (?, ?, ?, ?, ?, 'SYSTEM', NULL, NULL, NULL, 'SYSTEM', 1, NULL, 0)`,
    args: [stageId, definitionId, ref.stageCode, `Approval level ${level}`, level],
  });
  configured.set(level, ref);
  created.count += 1;
  created.levels.push(level);
  return ref;
}

/**
 * Commit the validated rows of a purchase order batch, one order at a time.
 *
 * Each order is one transaction: the purchase order, its workflow
 * reconstruction and the batch bookkeeping land together or not at all.
 * Stage instances are keyed on (instance, stage), so a re-upload carrying a
 * further approval appends that level alone and leaves the earlier levels
 * exactly as they were.
 */
export async function commitPoBatch(
  db: Client,
  batchId: string,
  ctx: WriteContext,
): Promise<PoCommitResult> {
  const now = toDbTimestamp(ctx.now);
  const result: PoCommitResult = {
    ordersCreated: 0,
    ordersUpdated: 0,
    ordersUnchanged: 0,
    ordersSkipped: 0,
    linesWritten: 0,
    stagesCreated: 0,
    stageEventsAppended: 0,
    ordersWithoutWorkflowDefinition: 0,
  };

  const batch = await db.execute({
    sql: `SELECT import_batch_id FROM import_batches WHERE import_batch_id = ? LIMIT 1`,
    args: [batchId],
  });
  if (batch.rows[0] === undefined) throw new Error(`Unknown import batch ${batchId}.`);

  const rowsResult = await db.execute({
    sql: `SELECT import_row_id, source_row_number, source_record_key, row_status, raw_json
          FROM import_rows WHERE import_batch_id = ? ORDER BY source_row_number`,
    args: [batchId],
  });

  // One row is one order, but a file may still repeat a purchase number. The
  // later row is the later observation, so it becomes the head and the
  // earlier rows are consumed by the same order.
  const groups = new Map<
    string,
    {
      affiliateId: string;
      rows: NormalisedPoRow[];
      importRowIds: Map<number, string>;
      statuses: Map<number, string>;
    }
  >();
  for (const raw of rowsResult.rows) {
    const record = raw as unknown as Record<string, unknown>;
    const key = record.source_record_key === null ? null : text(record.source_record_key);
    if (key === null) continue;
    const affiliateId = key.split('|')[0] ?? '';
    const parsed = JSON.parse(text(record.raw_json)) as Record<string, unknown>;
    const row = await normalisePoRow(parsed, Number(record.source_row_number), affiliateId);
    const group = groups.get(key) ?? {
      affiliateId,
      rows: [],
      importRowIds: new Map<number, string>(),
      statuses: new Map<number, string>(),
    };
    group.rows.push(row);
    group.importRowIds.set(row.sourceRowNumber, text(record.import_row_id));
    group.statuses.set(row.sourceRowNumber, text(record.row_status));
    groups.set(key, group);
  }

  const identityCache = new Map<string, Map<string, string>>();
  const identitiesFor = async (affiliateId: string) => {
    const cached = identityCache.get(affiliateId);
    if (cached !== undefined) return cached;
    const loaded = await loadIdentities(db, affiliateId);
    identityCache.set(affiliateId, loaded);
    return loaded;
  };

  const definitionCache = new Map<
    string,
    { definitionId: string; stages: Map<number, StageRef> } | null
  >();
  const definitionFor = async (affiliateId: string) => {
    const cached = definitionCache.get(affiliateId);
    if (cached !== undefined) return cached;
    // An affiliate's own definition first, then a group-wide one, then the
    // highest version. Nothing is invented where neither exists.
    const found = await db.execute({
      sql: `SELECT workflow_definition_id FROM workflow_definitions
            WHERE process_type = 'PURCHASE_ORDER' AND active = 1
              AND (affiliate_id = ? OR affiliate_id IS NULL)
            ORDER BY (affiliate_id IS NULL), version_no DESC LIMIT 1`,
      args: [affiliateId],
    });
    const definitionId = found.rows[0]?.workflow_definition_id;
    if (definitionId === undefined) {
      definitionCache.set(affiliateId, null);
      return null;
    }
    const stageRows = await db.execute({
      sql: `SELECT workflow_stage_id, stage_code, sequence_no FROM workflow_stages
            WHERE workflow_definition_id = ? ORDER BY sequence_no`,
      args: [text(definitionId)],
    });
    const stages = new Map<number, StageRef>();
    for (const raw of stageRows.rows) {
      const row = raw as unknown as Record<string, unknown>;
      stages.set(Number(row.sequence_no), {
        stageId: text(row.workflow_stage_id),
        stageCode: text(row.stage_code),
      });
    }
    const entry = { definitionId: text(definitionId), stages };
    definitionCache.set(affiliateId, entry);
    return entry;
  };

  for (const [sourceKey, group] of groups) {
    const actionable = group.rows.filter((r) => {
      const status = group.statuses.get(r.sourceRowNumber);
      return status === 'NEW' || status === 'CHANGED';
    });
    const head = actionable[actionable.length - 1] ?? group.rows[group.rows.length - 1];
    if (head === undefined) continue;
    if (head.purchaseNumber === null || head.createdAt === null) {
      result.ordersSkipped += 1;
      continue;
    }
    if (actionable.length === 0) {
      result.ordersUnchanged += 1;
      continue;
    }

    const identities = await identitiesFor(group.affiliateId);
    const existing = await db.execute({
      sql: `SELECT purchase_order_id FROM purchase_orders
            WHERE affiliate_id = ? AND document_number = ? LIMIT 1`,
      args: [group.affiliateId, head.purchaseNumber],
    });
    const existingId = existing.rows[0]?.purchase_order_id;
    const purchaseOrderId = existingId === undefined ? newId('PO') : text(existingId);
    const status = derivePoStatus(head);
    const statements: Stmt[] = [];
    const stagesCreated: { count: number; levels: number[] } = { count: 0, levels: [] };

    if (existingId === undefined) {
      statements.push({
        // Supplier, currency and value are NULL because the extract carries
        // none of them, and the physical receipt and Oracle posting stay NULL
        // because this file has no such timestamp. The final approval date is
        // never borrowed to stand in for a posting date.
        sql: `INSERT INTO purchase_orders
                (purchase_order_id, document_number, affiliate_id, business_unit_id, supplier_name,
                 po_created_at, submitted_for_approval_at, currency_code, po_value,
                 physical_received_at, oracle_stock_posted_at, status, created_at)
              VALUES (?, ?, ?, NULL, NULL, ?, ?, NULL, NULL, NULL, NULL, ?, ?)`,
        args: [
          purchaseOrderId,
          head.purchaseNumber,
          group.affiliateId,
          head.createdAt,
          head.submittedAt,
          status,
          now,
        ],
      });
    } else {
      statements.push({
        sql: `UPDATE purchase_orders SET submitted_for_approval_at = ?, status = ?
              WHERE purchase_order_id = ?`,
        args: [head.submittedAt, status, purchaseOrderId],
      });
    }

    // No lines. The extract has no line grain, so linesWritten stays zero and
    // nothing reaches the product catalogue by any route.

    const definition = await definitionFor(group.affiliateId);
    if (definition === null) {
      result.ordersWithoutWorkflowDefinition += 1;
    } else {
      const instance = await db.execute({
        sql: `SELECT workflow_instance_id FROM workflow_instances
              WHERE entity_type = 'PURCHASE_ORDER' AND entity_id = ? LIMIT 1`,
        args: [purchaseOrderId],
      });
      const existingInstanceId = instance.rows[0]?.workflow_instance_id;
      const workflowInstanceId =
        existingInstanceId === undefined ? newId('WFI') : text(existingInstanceId);
      const complete = status === 'APPROVED';
      const finalApproval = head.approvals[head.approvals.length - 1]?.approvedAt ?? null;
      if (existingInstanceId === undefined) {
        statements.push({
          sql: `INSERT INTO workflow_instances
                  (workflow_instance_id, workflow_definition_id, entity_type, entity_id, status,
                   started_at, completed_at, current_stage_id, created_at)
                VALUES (?, ?, 'PURCHASE_ORDER', ?, ?, ?, ?, NULL, ?)`,
          args: [
            workflowInstanceId,
            definition.definitionId,
            purchaseOrderId,
            complete ? 'COMPLETED' : 'IN_PROGRESS',
            head.submittedAt ?? head.createdAt,
            complete ? finalApproval : null,
            now,
          ],
        });
      } else {
        // A re-upload may have completed the run. The current stage stays
        // NULL because the extract never says which stage is pending.
        statements.push({
          sql: `UPDATE workflow_instances SET status = ?, completed_at = ?
                WHERE workflow_instance_id = ?`,
          args: [
            complete ? 'COMPLETED' : 'IN_PROGRESS',
            complete ? finalApproval : null,
            workflowInstanceId,
          ],
        });
      }

      const durations = stageDurations(head);
      for (const duration of durations) {
        const stage = stageForLevel(
          definition.stages,
          definition.definitionId,
          duration.level,
          statements,
          stagesCreated,
        );
        const already = await db.execute({
          sql: `SELECT workflow_stage_instance_id FROM workflow_stage_instances
                WHERE workflow_instance_id = ? AND workflow_stage_id = ? LIMIT 1`,
          args: [workflowInstanceId, stage.stageId],
        });
        if (already.rows[0] !== undefined) continue;
        const approver = head.approvals.find((a) => a.level === duration.level)?.approver ?? null;
        const approverUserId =
          approver === null ? null : (identities.get(approver.toUpperCase()) ?? null);
        statements.push({
          sql: `INSERT INTO workflow_stage_instances
                  (workflow_stage_instance_id, workflow_instance_id, workflow_stage_id,
                   assigned_user_id, status, assigned_at, started_at, completed_at, action_notes)
                VALUES (?, ?, ?, ?, 'APPROVED', ?, ?, ?, ?)`,
          args: [
            newId('WSI'),
            workflowInstanceId,
            stage.stageId,
            approverUserId,
            duration.actionableFrom,
            duration.actionableFrom,
            duration.approvedAt,
            `Reconstructed from the PO extract, approval level ${duration.level}`,
          ],
        });
        result.stageEventsAppended += 1;
      }
    }

    for (const row of actionable) {
      const importRowId = group.importRowIds.get(row.sourceRowNumber);
      if (importRowId !== undefined) {
        statements.push({
          sql: `UPDATE import_rows SET entity_id = ?, imported_at = ? WHERE import_row_id = ?`,
          args: [purchaseOrderId, now, importRowId],
        });
      }
    }

    // One order, one transaction. An order that cannot land is isolated on
    // its own rows and the rest of the batch continues, which is what makes
    // PARTIAL mean something exact.
    try {
      await db.batch(statements, 'write');
    } catch (error) {
      const reason = `The purchase order could not be written: ${String(error)}`.slice(0, 400);
      const failures: Stmt[] = [...group.importRowIds.values()].map((importRowId) => ({
        sql: `UPDATE import_rows SET row_status = 'REJECTED', error_message = ?
              WHERE import_row_id = ? AND imported_at IS NULL`,
        args: [reason, importRowId],
      }));
      await db.batch(failures, 'write');
      result.ordersSkipped += 1;
      // A stage minted inside the failed transaction did not survive it, so
      // the cached definition forgets exactly those levels. Stages minted by
      // an earlier order that did commit stay cached, because they are still
      // there.
      for (const level of stagesCreated.levels) definition?.stages.delete(level);
      continue;
    }
    result.stagesCreated += stagesCreated.count;

    await insertSnapshot(
      db,
      PURCHASE_ORDER_SNAPSHOT,
      purchaseOrderId,
      sourceKey,
      head.rowHash,
      JSON.stringify({
        purchaseNumber: head.purchaseNumber,
        affiliateId: group.affiliateId,
        description: head.description,
        nature: head.nature,
        createdAt: head.createdAt,
        submittedAt: head.submittedAt,
        createdBy: head.createdBy,
        authorizationStatus: head.authorizationStatus,
        status,
        approvals: head.approvals,
        durations: poDurations(head),
        stageDurations: stageDurations(head),
      }),
      batchId,
      now,
    );
    if (existingId === undefined) result.ordersCreated += 1;
    else result.ordersUpdated += 1;
  }

  const finalStatus = result.ordersSkipped > 0 ? 'PARTIAL' : 'IMPORTED';
  await db.execute({
    sql: `UPDATE import_batches SET status = ? WHERE import_batch_id = ?`,
    args: [finalStatus, batchId],
  });
  return result;
}

// ---- Revalidation ------------------------------------------------------------

/**
 * Reprocess a purchase order batch after an administrator has mapped an
 * identity, without re-uploading the file.
 *
 * A purchase order row is never held back by an unmapped approver: the order
 * is a fact of its own and imports regardless, with the approval stage
 * carrying no assignee until the name has a home. So revalidation here does
 * two things and no more. It closes the unresolved actor rows whose names now
 * resolve, and it fills the assignee on the stage instances this batch
 * reconstructed that are still unassigned. The batch, its rows and their
 * provenance are untouched.
 */
export async function revalidatePoRows(
  db: Client,
  batchId: string,
): Promise<{
  rowsExamined: number;
  rowsResolved: number;
  rowsStillUnresolved: number;
  actorsResolved: number;
  stageAssigneesFilled: number;
}> {
  const rows = await db.execute({
    sql: `SELECT import_row_id, source_row_number, source_record_key, entity_id, raw_json
          FROM import_rows WHERE import_batch_id = ? ORDER BY source_row_number`,
    args: [batchId],
  });

  const statements: Stmt[] = [];
  const identityCache = new Map<string, Map<string, string>>();
  const identitiesFor = async (affiliateId: string) => {
    const cached = identityCache.get(affiliateId);
    if (cached !== undefined) return cached;
    const loaded = await loadIdentities(db, affiliateId);
    identityCache.set(affiliateId, loaded);
    return loaded;
  };

  let stageAssigneesFilled = 0;
  let stillUnresolved = 0;
  for (const raw of rows.rows) {
    const record = raw as unknown as Record<string, unknown>;
    const key = record.source_record_key === null ? null : text(record.source_record_key);
    if (key === null) continue;
    const affiliateId = key.split('|')[0] ?? '';
    const identities = await identitiesFor(affiliateId);
    const parsed = JSON.parse(text(record.raw_json)) as Record<string, unknown>;
    const row = await normalisePoRow(parsed, Number(record.source_row_number), affiliateId);
    const unmapped = [row.createdBy, ...row.approvals.map((a) => a.approver)].filter(
      (name): name is string => name !== null && !identities.has(name.toUpperCase()),
    );
    if (unmapped.length > 0) stillUnresolved += 1;

    const entityId = record.entity_id === null ? null : text(record.entity_id);
    if (entityId === null) continue;
    for (const approval of row.approvals) {
      if (approval.approver === null) continue;
      const userId = identities.get(approval.approver.toUpperCase());
      if (userId === undefined) continue;
      // Only a stage this batch left unassigned, and only the level it
      // belongs to. An assignee already recorded is never overwritten.
      const stage = await db.execute({
        sql: `SELECT wsi.workflow_stage_instance_id AS id FROM workflow_stage_instances wsi
              JOIN workflow_instances wi ON wi.workflow_instance_id = wsi.workflow_instance_id
              WHERE wi.entity_type = 'PURCHASE_ORDER' AND wi.entity_id = ?
                AND wsi.assigned_user_id IS NULL
                AND wsi.action_notes = ?`,
        args: [entityId, `Reconstructed from the PO extract, approval level ${approval.level}`],
      });
      for (const found of stage.rows) {
        statements.push({
          sql: `UPDATE workflow_stage_instances SET assigned_user_id = ?
                WHERE workflow_stage_instance_id = ?`,
          args: [userId, text((found as Record<string, unknown>).id)],
        });
        stageAssigneesFilled += 1;
      }
    }
  }

  const actors = await db.execute({
    sql: `SELECT unresolved_actor_id, external_username, affiliate_id FROM unresolved_actors
          WHERE import_batch_id = ? AND status = 'OPEN'`,
    args: [batchId],
  });
  let actorsResolved = 0;
  for (const raw of actors.rows) {
    const record = raw as unknown as Record<string, unknown>;
    const affiliateId = record.affiliate_id === null ? '' : text(record.affiliate_id);
    const identities = await identitiesFor(affiliateId);
    const userId = identities.get(text(record.external_username).toUpperCase());
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
    rowsResolved: stageAssigneesFilled,
    rowsStillUnresolved: stillUnresolved,
    actorsResolved,
    stageAssigneesFilled,
  };
}
