/**
 * The one ingestion path.
 *
 * Sales orders and purchase orders arrive through this module and nowhere
 * else, and a third source type joins by adding an entry to IMPORTERS below
 * rather than by growing a second upload screen with its own history table.
 * The tables are the ones the schema already has: file_objects,
 * import_batches, import_rows, record_snapshots, unresolved_actors,
 * source_systems, source_identities, notifications and audit_events. No
 * SALES_ORDER_UPLOADS table exists, and none is wanted.
 *
 * INGESTION IS APPEND-ONLY; CANONICAL STATE IS VERSION-AWARE.
 * An upload adds rows and snapshots. It never replaces history, never
 * deletes a file, and never rewrites a previous batch. What changed is
 * visible because both versions are still there.
 *
 * VALIDATION WRITES NO CANONICAL TABLE.
 * Uploading and validating produce a batch, its rows and its exceptions. The
 * sales order or purchase order itself appears only when somebody commits,
 * which is a separate, permissioned action.
 *
 * THE HASH IS THE DUPLICATE RULE, NOT THE FILENAME.
 * A file renamed is the same file and is refused, naming the batch that
 * holds it. A different file with a familiar name is not a duplicate.
 */
import type { Client, InStatement } from '@libsql/client/web';
import { newId } from '../repos/authRecords.ts';
import { auditEventStmt } from '../repos/authRecords.ts';
import { toDbTimestamp } from '../auth/session.ts';
import type { WriteContext } from '../admin/guard.ts';
import { canViewImports, canViewPurchaseOrders, canViewSalesOrders } from '../permissions.ts';
import { notifyImportException } from '../notify/notifications.ts';
import {
  validateSoWorkbook,
  commitSoBatch,
  revalidateSoRows,
  SO_AFFILIATE_MAP,
  type SoValidation,
} from './soImport.ts';
import { validatePoWorkbook, commitPoBatch, revalidatePoRows } from './poImport.ts';
import {
  parseExtractFilename,
  checkClaimedPeriod,
  EXTRACT_PROCESS_FOR_IMPORT,
  type ExtractNameClaim,
} from './extractName.ts';
import { hashFile } from './workbook.ts';

type Stmt = Extract<InStatement, { sql: string }>;
const text = (v: unknown): string => String(v ?? '');
const nullableText = (v: unknown): string | null =>
  v === null || v === undefined ? null : String(v);

export type ImportType = 'SALES_ORDER' | 'PURCHASE_ORDER';
export const IMPORT_TYPES: readonly ImportType[] = ['SALES_ORDER', 'PURCHASE_ORDER'];

export const IMPORT_TYPE_LABELS: Readonly<Record<ImportType, string>> = {
  SALES_ORDER: 'Sales order extract',
  PURCHASE_ORDER: 'Purchase order extract',
};

/**
 * The permission that lets a principal read the source values of one import
 * type's rows. The Upload Centre shows anybody with DATA.IMPORTS.VIEW that a
 * row exists, what happened to it and why; the values inside it are order
 * data and need the order module.
 */
const ROW_READ_CHECK: Readonly<Record<ImportType, (p: readonly string[]) => boolean>> = {
  SALES_ORDER: canViewSalesOrders,
  PURCHASE_ORDER: canViewPurchaseOrders,
};

// ---- What a file has to be before it is read ---------------------------------

/**
 * Eight megabytes. A Worker has a bounded memory and a bounded execution
 * time, and a file larger than this is a conversation with the operator
 * about splitting the extract, not something to attempt and fail halfway
 * through.
 */
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

const OLE2_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

/**
 * What the bytes say the file is, never what the name claims.
 *
 * A legacy .xls is an OLE2 compound document; an .xlsx is a zip container.
 * A .exe renamed to .xls fails here, before SheetJS is handed anything, and
 * so does an empty file. SheetJS itself never evaluates a macro: it reads
 * cell values out of the container and has no execution engine attached.
 */
export function sniffWorkbook(bytes: Uint8Array): {
  ok: boolean;
  kind: 'XLS' | 'XLSX' | null;
  problem: string | null;
} {
  const starts = (magic: number[]) => magic.every((byte, index) => bytes[index] === byte);
  if (bytes.byteLength === 0) return { ok: false, kind: null, problem: 'The file is empty.' };
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      kind: null,
      problem: `The file is larger than the ${Math.round(MAX_UPLOAD_BYTES / 1048576)} MB limit.`,
    };
  }
  if (starts(OLE2_MAGIC)) return { ok: true, kind: 'XLS', problem: null };
  if (starts(ZIP_MAGIC)) return { ok: true, kind: 'XLSX', problem: null };
  return {
    ok: false,
    kind: null,
    problem: 'The file is not an Excel workbook. Its content does not match .xls or .xlsx.',
  };
}

/**
 * A filename safe to store and to show.
 *
 * Everything before the last slash or backslash is discarded, so
 * "../../etc/passwd" becomes "passwd" and can address nothing. Control
 * characters go, the length is capped, and an empty result becomes a
 * neutral name rather than nothing at all. The storage key never uses this
 * value alone: it is always prefixed by the batch id, which is unique.
 */
export function safeFilename(raw: string): string {
  const withoutPath = raw.split(/[\\/]/).pop() ?? '';
  const cleaned = withoutPath
    .split('')
    .filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
    .join('')
    .trim();
  const capped = cleaned.slice(0, 180);
  return capped === '' ? 'upload.xls' : capped;
}

/**
 * A source value made safe to re-present.
 *
 * Anything a spreadsheet would treat as a formula when the value is exported
 * and opened again is prefixed with an apostrophe, so a cell reading
 * "=cmd|' /c calc'!A1" is shown as text and never executed by the recipient's
 * Excel. The stored value is untouched: this is a display transformation, and
 * the raw payload in import_rows stays exactly as the source wrote it.
 */
export function escapeForDisplay(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

// ---- Upload and validate -----------------------------------------------------

/**
 * WHICH SYSTEM AN EXTRACT COMES FROM IS NOT A QUESTION.
 *
 * Both extracts this product accepts are Oracle EBS reports. The form used to
 * ask, and defaulted to CRM Web Form, so a sales order extract was routinely
 * recorded as arriving from a web form. That is not cosmetic: `source_identities`
 * resolves usernames against the source system, so the wrong value maps the
 * wrong people, or nobody. Deriving it removes both the question and the
 * default that was wrong more often than it was right.
 */
export const SOURCE_SYSTEM_FOR_IMPORT: Readonly<Record<ImportType, string>> = {
  SALES_ORDER: 'SRC-ORACLE',
  PURCHASE_ORDER: 'SRC-ORACLE',
};

/**
 * Where a derived fact came from, so the preview can show the reasoning
 * rather than a number that appeared from nowhere.
 */
export interface DerivationNote {
  /** The affiliate the file named, or null for a Group-wide extract. */
  affiliateLabel: string | null;
  /** The column the affiliate was read from, or null where there is none. */
  affiliateColumn: string | null;
  periodFrom: string | null;
  periodTo: string | null;
  /** The column the period was derived from. */
  periodColumn: string;
  /** Every distinct affiliate the file named. */
  affiliates: string[];
  /**
   * Headers the landing table has no column for. Their values are kept in
   * extra_json rather than dropped, and named here so a column that appears in
   * next month's extract announces itself instead of vanishing.
   */
  unmappedColumns: string[];
}

export interface UploadRequest {
  importType: ImportType;
  sourceSystemId: string;
  /**
   * The OPERATOR'S choice, where they made one — the fallback and the
   * override of the three-source resolution, never the default. Null means
   * "resolve it": the file's own column first, the filename token second.
   */
  affiliateId: string | null;
  filename: string;
  reportingPeriodFrom: string | null;
  reportingPeriodTo: string | null;
  bytes: Uint8Array;
  /**
   * Set when the operator overrides the entity of a batch already previewed:
   * the SAME file is re-sent with the chosen affiliate, and this names the
   * batch to rebuild in place. The bytes must hash-match that batch — an
   * override is a second reading of one file, never a door past the
   * duplicate rule for a different one.
   */
  overrideBatchId?: string | null;
}

// ---- The entity, resolved from three sources in order ------------------------

/** An affiliate as the upload screen needs it: id, name, and its token. */
export interface UploadAffiliate {
  affiliateId: string;
  affiliateName: string;
  /** The filename token from affiliates.extract_code, or null. */
  extractCode: string | null;
}

/** Every active affiliate, one read, serving lookup and error message alike. */
export async function listUploadAffiliates(db: Client): Promise<UploadAffiliate[]> {
  const result = await db.execute(
    `SELECT affiliate_id, affiliate_name, extract_code FROM affiliates
      WHERE active = 1 ORDER BY affiliate_name`,
  );
  return result.rows.map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    return {
      affiliateId: text(row.affiliate_id),
      affiliateName: text(row.affiliate_name),
      extractCode: nullableText(row.extract_code),
    };
  });
}

/**
 * Where the batch's entity came from, in words the preview can show.
 *
 * The three sources, in order of authority:
 *   column    the file's own AFFILIATE column — it wins, always;
 *   filename  the name's entity token, matched against extract_code — the
 *             purchase order path, and the point of this phase;
 *   operator  the selector, as fallback or as deliberate override.
 * 'none' is the honest fourth state: nothing resolved, Group-wide as before.
 */
export interface EntityResolution {
  affiliateId: string | null;
  affiliateName: string | null;
  source: 'column' | 'filename' | 'operator' | 'none';
  /** One plain sentence for the preview: what was resolved, and from where. */
  statement: string;
  /** What the filename claimed, where it parsed at all. */
  claim: ExtractNameClaim | null;
  warnings: string[];
  /** Set when the token matched nothing: the tokens that DO exist. */
  knownExtracts: { extractCode: string; affiliateName: string }[] | null;
}

/** The period cross-check: the filename's dates against the data's. */
export interface PeriodCheck {
  status: 'agrees' | 'differs' | 'unchecked' | 'unnamed';
  detail: string;
  claimFrom: string | null;
  claimTo: string | null;
  dataFrom: string | null;
  dataTo: string | null;
}

function periodCheckOf(
  claim: ExtractNameClaim | null,
  dataFrom: string | null,
  dataTo: string | null,
): PeriodCheck {
  if (claim === null) {
    return {
      status: 'unnamed',
      detail: 'The filename carries no period to check against.',
      claimFrom: null,
      claimTo: null,
      dataFrom,
      dataTo,
    };
  }
  const check = checkClaimedPeriod(claim, dataFrom, dataTo);
  return {
    status: check.status,
    detail: check.detail,
    claimFrom: claim.periodFrom,
    claimTo: claim.periodTo,
    dataFrom,
    dataTo,
  };
}

const knownTokens = (affiliates: UploadAffiliate[]) =>
  affiliates
    .filter((a): a is UploadAffiliate & { extractCode: string } => a.extractCode !== null)
    .map((a) => ({ extractCode: a.extractCode, affiliateName: a.affiliateName }));

/**
 * THREE WAYS AN UPLOAD CAN END, AND THE MIDDLE ONE IS NEW.
 *
 *   DUPLICATE     The same bytes. This file has been uploaded before.
 *   RESAVED       Different bytes, identical data. Excel re-saved the workbook
 *                 and every cell still says what it said. This is the case that
 *                 got through the byte check and imported a second time.
 *   READY         New data, validated, nothing written yet.
 *   REJECTED      The file could not be read or the batch could not validate.
 *   NEEDS_ENTITY  The filename names an entity this system does not know.
 *                 NOTHING was written — no batch, no rows — because importing
 *                 it Group-wide would silently lose the country, which is
 *                 worse than refusing. The outcome names the tokens that do
 *                 exist; the operator chooses, and the upload is sent again
 *                 with their choice.
 */
export type UploadStage = 'REJECTED' | 'DUPLICATE' | 'RESAVED' | 'READY' | 'NEEDS_ENTITY';

export interface UploadOutcome {
  /** What the file itself said, and which column said it. */
  derivation: DerivationNote | null;
  /** The entity, resolved column-first, filename second, operator third. */
  entity: EntityResolution | null;
  /** The filename's period against the data's — a cross-check, not a source. */
  periodCheck: PeriodCheck | null;
  stage: UploadStage;
  batchId: string | null;
  fileSha256: string | null;
  /** Set when the file was refused before a batch existed. */
  rejectedReason: string | null;
  duplicate: {
    batchId: string;
    filename: string;
    uploadedAt: string;
    uploadedBy: string;
  } | null;
  /** The workbook's data fingerprint, whatever the outcome. */
  contentSha256: string | null;
  /**
   * How many documents in this file already exist in the canonical tables.
   *
   * Set on a READY upload, because an operator about to import a file has a
   * right to know how much of it the system already holds. An extract re-run a
   * week later repeats every order that has not closed, and that is not a
   * fault: it is the reason the import is idempotent per document.
   */
  documentsAlreadyImported: number;
  summary: {
    rowsReceived: number;
    uniqueDocuments: number;
    /**
     * FOUR FIGURES, NOT TWO, AND NONE OF THEM DERIVED FROM ANOTHER.
     *
     * Rows, documents, order lines and additional loading events are four
     * different facts about one file, and the real extract makes that obvious:
     * 1,386 rows describe 662 documents over 1,252 order lines carrying 100
     * loading authorities beyond the first. A preview that showed only rows
     * and documents was how a commit came to write one order line 134 times
     * with the last row winning.
     *
     * Zero on a purchase order preview, which has no line grain at all.
     */
    orderLines: number;
    additionalLoadingEvents: number;
    rowsNew: number;
    rowsChanged: number;
    rowsDuplicate: number;
    rowsUnresolved: number;
    rowsRejected: number;
  } | null;
  /**
   * WHAT THE COMMIT WILL CREATE, SHOWN BEFORE IT DOES.
   *
   * The counts and the full lists, so nobody discovers 228 new accounts and
   * 108 new products after the fact. This is a preview and nothing here has
   * been written yet, so a person who does not like what they see can still
   * stop. Every created product goes to the Unclassified category: the
   * hierarchy drives approval routing, so a guessed category would route an
   * order to the wrong approver.
   */
  accountsToCreate: { code: string; name: string | null; rows: number }[];
  productsToCreate: { code: string; unitOfMeasure: string | null; rows: number }[];
  /** Codes that matched with a different name. Flagged for review, never overwritten. */
  nameMismatches: { code: string; storedName: string; fileName: string }[];
  /** A person is still never created. This is for an administrator to map. */
  unresolvedUsers: string[];
  unresolvedProducts: { item: string; rows: number }[];
  unresolvedCustomers: { code: string; name: string | null; rows: number }[];
  approvalLevelDistribution: { level: number; orders: number }[];
  report: { header: string; treatment: string; target: string; example: string }[];
}

function auditStmt(
  ctx: WriteContext,
  eventType: string,
  entityId: string,
  action: string,
  after: unknown,
): Stmt {
  return auditEventStmt({
    actorUserId: ctx.actorUserId,
    eventType,
    entityType: 'IMPORT_BATCH',
    entityId,
    action,
    beforeJson: null,
    // Counts and reasons only. The rows themselves already live in
    // import_rows, and copying them here would duplicate every source value
    // into a table nobody ever cleans.
    afterJson: after === null ? null : JSON.stringify(after),
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    now: ctx.now,
  }) as Stmt;
}

async function writeAudit(
  db: Client,
  ctx: WriteContext,
  eventType: string,
  entityId: string,
  action: string,
  after: unknown,
): Promise<void> {
  await db.batch([auditStmt(ctx, eventType, entityId, action, after)], 'write');
}

/**
 * Receive a file, check it, validate it and report. Nothing canonical is
 * written, and nothing is committed.
 *
 * The order is deliberate: content type and size before the bytes reach a
 * parser, the hash before a batch exists, and the batch before a single row
 * is read, so a failure at any point leaves either nothing at all or a batch
 * that says exactly how far it got.
 */
export async function receiveUpload(
  db: Client,
  input: UploadRequest,
  ctx: WriteContext,
): Promise<UploadOutcome> {
  const empty: UploadOutcome = {
    derivation: null,
    entity: null,
    periodCheck: null,
    stage: 'REJECTED',
    batchId: null,
    fileSha256: null,
    rejectedReason: null,
    duplicate: null,
    contentSha256: null,
    documentsAlreadyImported: 0,
    summary: null,
    accountsToCreate: [],
    productsToCreate: [],
    nameMismatches: [],
    unresolvedUsers: [],
    unresolvedProducts: [],
    unresolvedCustomers: [],
    approvalLevelDistribution: [],
    report: [],
  };

  const sniffed = sniffWorkbook(input.bytes);
  if (!sniffed.ok) {
    return { ...empty, rejectedReason: sniffed.problem };
  }
  const filename = safeFilename(input.filename);
  const source = await db.execute({
    sql: `SELECT source_system_id FROM source_systems WHERE source_system_id = ? AND active = 1`,
    args: [input.sourceSystemId],
  });
  if (source.rows[0] === undefined) {
    return { ...empty, rejectedReason: 'The source system is unknown or inactive.' };
  }

  // THE FILENAME, READ AS A CLAIM. Parsed strictly or not at all: a name off
  // the PROCESS-ENTITY-FROMDATE-TODATE shape yields nothing and the upload
  // proceeds as it always did, with the operator choosing. Nothing the name
  // says is trusted on its own — the file's column outranks it, and the
  // operator confirms before commit.
  const claim = parseExtractFilename(filename);
  const operatorAffiliateId =
    input.affiliateId === null ? null : input.affiliateId.trim() === '' ? null : input.affiliateId;
  // One read serves the token lookup, the operator's name and the "these are
  // the eight that exist" message alike — and only runs when something needs
  // it, so an unnamed sales upload keeps its old cost.
  const affiliates =
    claim !== null || operatorAffiliateId !== null ? await listUploadAffiliates(db) : [];
  const nameOf = (affiliateId: string | null): string | null =>
    affiliateId === null
      ? null
      : (affiliates.find((a) => a.affiliateId === affiliateId)?.affiliateName ?? affiliateId);
  const byToken = (token: string): UploadAffiliate | null =>
    affiliates.find((a) => a.extractCode === token) ?? null;

  // THE OVERRIDE IS THE SAME FILE, PROVEN. Re-reading a previewed batch with
  // a different entity must not become a door past the duplicate rule, so the
  // bytes are hashed and must match the batch being overridden.
  const overrideBatchId = input.overrideBatchId ?? null;
  if (overrideBatchId !== null) {
    const target = await db.execute({
      sql: `SELECT import_type, file_sha256, status FROM import_batches
            WHERE import_batch_id = ? LIMIT 1`,
      args: [overrideBatchId],
    });
    const batch = target.rows[0] as Record<string, unknown> | undefined;
    if (batch === undefined) {
      return { ...empty, rejectedReason: 'The batch to override does not exist.' };
    }
    if (text(batch.import_type) !== input.importType) {
      return { ...empty, rejectedReason: 'The batch to override is a different data type.' };
    }
    if (text(batch.status) === 'IMPORTED') {
      return {
        ...empty,
        rejectedReason: 'That batch has already been imported; its entity cannot be changed here.',
      };
    }
    if ((await hashFile(input.bytes)) !== text(batch.file_sha256)) {
      return {
        ...empty,
        rejectedReason:
          'The file does not match the batch being overridden. Validate it as a new upload instead.',
      };
    }
  }

  const uploadInput = {
    filename,
    uploadedBy: ctx.actorUserId,
    sourceSystemId: input.sourceSystemId,
  };

  if (input.importType === 'PURCHASE_ORDER') {
    // RESOLVE BEFORE VALIDATING, because validation bakes the affiliate into
    // every row's source key and the commit writes what the key carries.
    const warnings: string[] = [];
    let entity: EntityResolution;
    if (operatorAffiliateId !== null) {
      // The operator's word: the fallback where nothing resolved, the
      // override where something did. Where the filename disagrees, that is
      // worth a line, not a refusal — a person outranks a name.
      if (claim !== null && claim.process === 'PURCHASE') {
        const named = byToken(claim.entityToken);
        if (named !== null && named.affiliateId !== operatorAffiliateId) {
          warnings.push(
            `The filename names ${claim.entityToken} (${named.affiliateName}); the operator chose ${nameOf(operatorAffiliateId)}.`,
          );
        }
      }
      entity = {
        affiliateId: operatorAffiliateId,
        affiliateName: nameOf(operatorAffiliateId),
        source: 'operator',
        statement: `Entity chosen by the operator: ${nameOf(operatorAffiliateId)}.`,
        claim,
        warnings,
        knownExtracts: null,
      };
    } else if (claim !== null && claim.process !== EXTRACT_PROCESS_FOR_IMPORT[input.importType]) {
      // A parsed name that claims the OTHER process is a mistake worth a
      // person's eye, not a token worth half-trusting: nothing was written,
      // and the operator decides what this file actually is.
      return {
        ...empty,
        stage: 'NEEDS_ENTITY',
        entity: {
          affiliateId: null,
          affiliateName: null,
          source: 'none',
          statement: 'No entity was resolved. The filename was not used.',
          claim,
          warnings: [
            `The file is named ${claim.process} but was uploaded as a ${IMPORT_TYPE_LABELS[input.importType].toLowerCase()}. ` +
              `Confirm what the file is, then choose its entity — or upload it under the other data type.`,
          ],
          knownExtracts: knownTokens(affiliates),
        },
        periodCheck: null,
      };
    } else if (claim !== null) {
      const named = byToken(claim.entityToken);
      if (named === null) {
        // AN UNKNOWN TOKEN IS AN EXCEPTION, NEVER A GUESS. Falling back to
        // Group-wide here would silently lose the country, which is worse
        // than refusing: nothing is written, the tokens that exist are
        // named, and the operator maps the file by choosing one.
        const tokens = knownTokens(affiliates);
        return {
          ...empty,
          stage: 'NEEDS_ENTITY',
          entity: {
            affiliateId: null,
            affiliateName: null,
            source: 'none',
            statement: `The filename names ${claim.entityToken}, which matches no affiliate.`,
            claim,
            warnings: [
              `${claim.entityToken} matches no affiliate. The ${tokens.length} that exist are ` +
                `${tokens.map((t) => t.extractCode).join(', ')}. Choose the entity this file belongs to; ` +
                `it will not be imported Group-wide by default.`,
            ],
            knownExtracts: tokens,
          },
          periodCheck: null,
        };
      }
      entity = {
        affiliateId: named.affiliateId,
        affiliateName: named.affiliateName,
        source: 'filename',
        statement: `Entity taken from the filename: ${claim.entityToken}, ${named.affiliateName}.`,
        claim,
        warnings,
        knownExtracts: null,
      };
    } else {
      entity = {
        affiliateId: null,
        affiliateName: null,
        source: 'none',
        statement:
          'Group-wide: the filename does not follow PROCESS-ENTITY-FROMDATE-TODATE and the file carries no affiliate column. The operator can choose an entity before committing.',
        claim: null,
        warnings,
        knownExtracts: null,
      };
    }

    const validation = await validatePoWorkbook(
      db,
      input.bytes,
      {
        ...uploadInput,
        affiliateId: entity.affiliateId,
        reprocessBatchId: overrideBatchId,
      },
      ctx,
    );
    if (validation.rejectedReason !== null) {
      return { ...empty, rejectedReason: validation.rejectedReason };
    }
    if (validation.duplicateOfBatchId !== null) {
      return {
        ...empty,
        stage: 'DUPLICATE',
        fileSha256: validation.fileSha256,
        contentSha256: validation.contentSha256,
        duplicate: await describeBatch(db, validation.duplicateOfBatchId),
      };
    }
    if (validation.resavedOfBatchId !== null) {
      return {
        ...empty,
        stage: 'RESAVED',
        fileSha256: validation.fileSha256,
        contentSha256: validation.contentSha256,
        duplicate: await describeBatch(db, validation.resavedOfBatchId),
      };
    }
    const batchId = validation.batchId ?? '';
    await recordPeriod(db, batchId, input, validation.dateRange);
    if (overrideBatchId === null) {
      await writeAudit(db, ctx, 'IMPORT_UPLOADED', batchId, 'UPLOAD', {
        importType: input.importType,
        filename,
        sha256: validation.fileSha256,
        // THE CONTENT FINGERPRINT LIVES HERE. There is no column for it and no
        // schema change in this phase; this event is the batch's own metadata
        // and is written exactly once per upload. See ./contentHash.ts.
        contentSha256: validation.contentSha256,
        affiliateId: validation.affiliateId,
        affiliateSource: entity.source,
        rowsReceived: validation.rowsReceived,
      });
    } else {
      // An entity override is the same batch read again, not a second upload:
      // one IMPORT_UPLOADED per file stays true, and the override is its own
      // named event with the choice that was made.
      await writeAudit(db, ctx, 'IMPORT_REPROCESSED', batchId, 'VALIDATE', {
        reason: 'entity_override',
        affiliateId: validation.affiliateId,
        affiliateSource: entity.source,
      });
    }
    await writeAudit(db, ctx, 'IMPORT_VALIDATED', batchId, 'VALIDATE', {
      rowsReceived: validation.rowsReceived,
      uniqueDocuments: validation.uniqueOrders,
      rowsNew: validation.rowsNew,
      rowsChanged: validation.rowsChanged,
      rowsDuplicate: validation.rowsDuplicate,
      rowsRejected: validation.rowsRejected,
      unresolvedActors: validation.unresolvedActors.length,
    });
    await notifyExceptions(db, ctx, batchId, validation.unresolvedActors.length);
    return {
      derivation: {
        // The purchase order extract has no affiliate column: 29 headers and
        // not one of them names an entity. The entity, where there is one,
        // came from the resolution above — the filename token or the
        // operator — and `entity` says which in as many words.
        affiliateLabel: entity.affiliateName,
        affiliateColumn: null,
        periodFrom: validation.dateRange.from,
        periodTo: validation.dateRange.to,
        periodColumn: 'ORIGINAL_CREATION_DATE',
        affiliates: [],
        unmappedColumns: validation.unmappedColumns,
      },
      entity,
      periodCheck: periodCheckOf(claim, validation.dateRange.from, validation.dateRange.to),
      stage: 'READY',
      batchId,
      fileSha256: validation.fileSha256,
      contentSha256: validation.contentSha256,
      documentsAlreadyImported: validation.documentsAlreadyImported,
      rejectedReason: null,
      duplicate: null,
      summary: {
        rowsReceived: validation.rowsReceived,
        uniqueDocuments: validation.uniqueOrders,
        // The purchase order extract has no line grain and no loading column,
        // which Build Prompt 33 established and this reports rather than
        // leaving a reader to wonder why two figures are missing.
        orderLines: 0,
        additionalLoadingEvents: 0,
        rowsNew: validation.rowsNew,
        rowsChanged: validation.rowsChanged,
        rowsDuplicate: validation.rowsDuplicate,
        rowsUnresolved: 0,
        rowsRejected: validation.rowsRejected,
      },
      // A purchase order extract creates NO reference records at all. NATURE
      // holds PRODUCT, LPG and LUBES, and Req Description carries a mixture of
      // fuel, LPG, lubricants and general procurement such as `MGL 19021` and
      // `TOP RICH-INV NO 11407`. None of that is a product code, and mapping
      // general procurement into the petroleum catalogue would file stationery
      // under liquefied petroleum gas. The extract has no line grain either,
      // so nothing here ever reaches products.
      accountsToCreate: [],
      productsToCreate: [],
      nameMismatches: [],
      unresolvedUsers: validation.unresolvedActors.map((a) => a.username),
      unresolvedProducts: [],
      unresolvedCustomers: [],
      approvalLevelDistribution: validation.approvalLevelDistribution,
      report: validation.report,
    };
  }

  const validation: SoValidation = await validateSoWorkbook(db, input.bytes, uploadInput, ctx);
  // The run did not finish. The batch is already REJECTED with its reason in
  // the audit trail; the operator is told what happened rather than shown a
  // batch that says it is still validating.
  if (validation.rejectedReason !== null) {
    return {
      ...empty,
      fileSha256: validation.fileSha256,
      rejectedReason: validation.rejectedReason,
    };
  }
  if (validation.duplicateOfBatchId !== null) {
    return {
      ...empty,
      stage: 'DUPLICATE',
      fileSha256: validation.fileSha256,
      contentSha256: validation.contentSha256,
      duplicate: await describeBatch(db, validation.duplicateOfBatchId),
    };
  }
  if (validation.resavedOfBatchId !== null) {
    return {
      ...empty,
      stage: 'RESAVED',
      fileSha256: validation.fileSha256,
      contentSha256: validation.contentSha256,
      duplicate: await describeBatch(db, validation.resavedOfBatchId),
    };
  }
  const batchId = validation.batchId ?? '';
  await recordPeriod(db, batchId, input, validation.dateRange);
  await writeAudit(db, ctx, 'IMPORT_UPLOADED', batchId, 'UPLOAD', {
    importType: input.importType,
    filename,
    sha256: validation.fileSha256,
    // THE CONTENT FINGERPRINT LIVES HERE. There is no column for it and no
    // schema change in this phase; this event is the batch's own metadata
    // and is written exactly once per upload. See ./contentHash.ts.
    contentSha256: validation.contentSha256,
    rowsReceived: validation.rowsReceived,
  });
  await writeAudit(db, ctx, 'IMPORT_VALIDATED', batchId, 'VALIDATE', {
    rowsReceived: validation.rowsReceived,
    uniqueDocuments: validation.uniqueDocuments,
    rowsNew: validation.rowsNew,
    rowsChanged: validation.rowsChanged,
    rowsDuplicate: validation.rowsDuplicate,
    rowsUnresolved: validation.rowsUnresolved,
    rowsRejected: validation.rowsRejected,
    unresolvedUsers: validation.unresolvedUsers.length,
    unresolvedProducts: validation.unresolvedProducts.length,
    unresolvedCustomers: validation.unresolvedCustomers.length,
  });
  const exceptions =
    validation.unresolvedUsers.length +
    validation.unresolvedProducts.length +
    validation.unresolvedCustomers.length;
  await notifyExceptions(db, ctx, batchId, exceptions);

  // THE COLUMN WINS, AND THE FILENAME IS A CROSS-CHECK. The sales extract
  // names its affiliate on every row, so the file's own word is the entity
  // whatever the name claims. Where the two disagree, the file is named for
  // one entity and contains another — a genuine mistake worth a warning
  // before commit, and exactly the case a filename alone would import
  // wrongly.
  const soEntity: EntityResolution = (() => {
    const warnings: string[] = [];
    let knownExtracts: EntityResolution['knownExtracts'] = null;
    const columnIds = new Set(
      validation.affiliates
        .map((label) => SO_AFFILIATE_MAP[label])
        .filter((id): id is string => id !== undefined),
    );
    if (claim !== null && claim.process !== 'SALES') {
      warnings.push(
        `The file is named ${claim.process} but was uploaded as a sales order extract. The name was not used; the AFFILIATE column decides.`,
      );
    } else if (claim !== null) {
      const named = byToken(claim.entityToken);
      if (named === null) {
        const tokens = knownTokens(affiliates);
        knownExtracts = tokens;
        warnings.push(
          `The filename names ${claim.entityToken}, which matches no affiliate. The ${tokens.length} that exist are ` +
            `${tokens.map((t) => t.extractCode).join(', ')}. The file's own AFFILIATE column decides for a sales extract, so the upload continues.`,
        );
      } else if (columnIds.size > 0 && !columnIds.has(named.affiliateId)) {
        warnings.push(
          `The file is named for ${named.affiliateName} (${claim.entityToken}), but its AFFILIATE column names ` +
            `${validation.affiliates.join(', ')}. The column is right and the name is the warning: check which file this is before committing.`,
        );
      }
    }
    const single = validation.affiliates.length === 1 ? (validation.affiliates[0] ?? null) : null;
    return {
      affiliateId: single === null ? null : (SO_AFFILIATE_MAP[single] ?? null),
      affiliateName: single,
      source: validation.affiliates.length > 0 ? 'column' : 'none',
      statement:
        validation.affiliates.length === 0
          ? 'No entity: the AFFILIATE column carried no readable values.'
          : validation.affiliates.length === 1
            ? `Entity taken from the file's own AFFILIATE column: ${single}. The filename was not needed.`
            : `Entities taken from the file's own AFFILIATE column: ${validation.affiliates.join(', ')}.`,
      claim,
      warnings,
      knownExtracts,
    };
  })();

  return {
    derivation: {
      affiliateLabel:
        validation.affiliates.length === 1 ? (validation.affiliates[0] ?? null) : null,
      affiliateColumn: 'AFFILIATE',
      periodFrom: validation.dateRange.from,
      periodTo: validation.dateRange.to,
      periodColumn: 'CREATE_DATE_TIME',
      affiliates: validation.affiliates,
      unmappedColumns: validation.unmappedColumns,
    },
    entity: soEntity,
    periodCheck: periodCheckOf(claim, validation.dateRange.from, validation.dateRange.to),
    stage: 'READY',
    batchId,
    fileSha256: validation.fileSha256,
    contentSha256: validation.contentSha256,
    documentsAlreadyImported: validation.documentsAlreadyImported,
    rejectedReason: null,
    duplicate: null,
    summary: {
      rowsReceived: validation.rowsReceived,
      uniqueDocuments: validation.uniqueDocuments,
      orderLines: validation.orderLines,
      additionalLoadingEvents: validation.additionalLoadingEvents,
      rowsNew: validation.rowsNew,
      rowsChanged: validation.rowsChanged,
      rowsDuplicate: validation.rowsDuplicate,
      rowsUnresolved: validation.rowsUnresolved,
      rowsRejected: validation.rowsRejected,
    },
    accountsToCreate: validation.accountsToCreate,
    productsToCreate: validation.productsToCreate,
    nameMismatches: validation.nameMismatches,
    unresolvedUsers: validation.unresolvedUsers,
    unresolvedProducts: validation.unresolvedProducts,
    unresolvedCustomers: validation.unresolvedCustomers,
    approvalLevelDistribution: [],
    report: validation.report,
  };
}

/**
 * The reporting period the operator stated, and where they stated none, the
 * range the file itself covers.
 *
 * The stated value always wins: an operator who says this extract is June is
 * making a claim about the reporting cycle, which is not the same as the
 * earliest and latest timestamp in the rows. Where they say nothing, the
 * derived range is better than an empty column, and it is derived rather
 * than invented.
 */
async function recordPeriod(
  db: Client,
  batchId: string,
  input: UploadRequest,
  derived: { from: string | null; to: string | null },
): Promise<void> {
  const from = input.reportingPeriodFrom ?? derived.from;
  const to = input.reportingPeriodTo ?? derived.to;
  if (from === null && to === null) return;
  await db.execute({
    sql: `UPDATE import_batches SET reporting_period_from = COALESCE(?, reporting_period_from),
            reporting_period_to = COALESCE(?, reporting_period_to)
          WHERE import_batch_id = ?`,
    args: [from, to, batchId],
  });
}

/** One aggregate notification, never one per row. */
async function notifyExceptions(
  db: Client,
  ctx: WriteContext,
  batchId: string,
  count: number,
): Promise<void> {
  if (count === 0) return;
  await notifyImportException(db, {
    userId: ctx.actorUserId,
    batchId,
    unresolvedCount: count,
    at: ctx.now,
  });
}

async function describeBatch(db: Client, batchId: string): Promise<UploadOutcome['duplicate']> {
  const found = await db.execute({
    sql: `SELECT b.import_batch_id AS id, b.original_filename AS filename, b.uploaded_at AS at,
            COALESCE(u.display_name, b.uploaded_by_user_id) AS who
          FROM import_batches b
          LEFT JOIN users u ON u.user_id = b.uploaded_by_user_id
          WHERE b.import_batch_id = ?`,
    args: [batchId],
  });
  const row = found.rows[0];
  if (row === undefined) return null;
  return {
    batchId: text(row.id),
    filename: escapeForDisplay(text(row.filename)),
    uploadedAt: text(row.at),
    uploadedBy: text(row.who),
  };
}

// ---- Commit ------------------------------------------------------------------

export interface CommitOutcome {
  status: 'IMPORTED' | 'PARTIAL';
  importType: ImportType;
  documentsCreated: number;
  documentsUpdated: number;
  documentsUnchanged: number;
  documentsSkipped: number;
  linesWritten: number;
  workflowEventsAppended: number;
  /** Reference records this commit created, and the names it refused to overwrite. */
  accountsCreated: number;
  productsCreated: number;
  nameMismatches: number;
  /** Loading authorities beyond the first, per order, that this commit recorded. */
  additionalLoadingEvents: number;
  /** What did not import, and why, in words rather than a status word. */
  skippedReasons: { reason: string; rows: number }[];
  /**
   * What DID import but is incomplete, and why.
   *
   * Separate from skippedReasons because the two are different facts and the
   * screen says so in different words: a skipped document is not in the
   * database, while a note here is about something that is. Putting "imported
   * without approval history" under a heading that reads "Not imported" would
   * be a message that contradicts itself.
   */
  notes: { note: string; count: number }[];
}

/**
 * Commit a validated batch through its own importer.
 *
 * Each importer commits at the logical document level, so a broken row can
 * never leave half a document behind. PARTIAL is reported with what did not
 * land and why, because "Upload successful" over a batch that skipped 40
 * documents is worse than no message at all.
 */
export async function commitBatch(
  db: Client,
  batchId: string,
  ctx: WriteContext,
): Promise<CommitOutcome> {
  const found = await db.execute({
    sql: `SELECT import_type, status FROM import_batches WHERE import_batch_id = ?`,
    args: [batchId],
  });
  const batch = found.rows[0];
  if (batch === undefined) throw new Error(`Unknown import batch ${batchId}.`);
  const importType = text(batch.import_type) as ImportType;

  const outcome: CommitOutcome =
    importType === 'PURCHASE_ORDER'
      ? await (async () => {
          const result = await commitPoBatch(db, batchId, ctx);
          return {
            status: result.ordersSkipped > 0 ? ('PARTIAL' as const) : ('IMPORTED' as const),
            importType,
            documentsCreated: result.ordersCreated,
            documentsUpdated: result.ordersUpdated,
            documentsUnchanged: result.ordersUnchanged,
            documentsSkipped: result.ordersSkipped,
            linesWritten: result.linesWritten,
            workflowEventsAppended: result.stageEventsAppended,
            // A purchase order import creates no reference records at all.
            accountsCreated: 0,
            productsCreated: 0,
            nameMismatches: 0,
            additionalLoadingEvents: 0,
            skippedReasons: [],
            notes:
              result.ordersWithoutWorkflowDefinition === 0
                ? []
                : [
                    {
                      // NOT SILENT. These orders imported, but their approval
                      // history did not, because no workflow definition matches
                      // their scope. Saying so is the difference between a gap
                      // somebody can act on and one they find months later.
                      note:
                        'Imported without approval history: no active PURCHASE_ORDER workflow ' +
                        'definition matches this batch. Configure one and reprocess the batch.',
                      count: result.ordersWithoutWorkflowDefinition,
                    },
                  ],
          };
        })()
      : await (async () => {
          const result = await commitSoBatch(db, batchId, ctx);
          return {
            status: result.documentsSkipped > 0 ? ('PARTIAL' as const) : ('IMPORTED' as const),
            importType,
            documentsCreated: result.documentsCreated,
            documentsUpdated: result.documentsUpdated,
            documentsUnchanged: result.documentsUnchanged,
            documentsSkipped: result.documentsSkipped,
            linesWritten: result.linesWritten,
            workflowEventsAppended: result.workflowEventsAppended,
            accountsCreated: result.accountsCreated,
            productsCreated: result.productsCreated,
            nameMismatches: result.nameMismatches,
            additionalLoadingEvents: result.additionalLoadingEvents,
            skippedReasons: [],
            notes:
              result.nameMismatches === 0
                ? []
                : [
                    {
                      note:
                        'Customer codes matched an account whose stored name differs from the ' +
                        'file. The stored name was kept; see Data → Created from import.',
                      count: result.nameMismatches,
                    },
                  ],
          };
        })();

  outcome.skippedReasons = await skippedReasons(db, batchId);
  await writeAudit(
    db,
    ctx,
    outcome.status === 'PARTIAL' ? 'IMPORT_PARTIAL' : 'IMPORT_COMMITTED',
    batchId,
    'COMMIT',
    {
      documentsCreated: outcome.documentsCreated,
      documentsUpdated: outcome.documentsUpdated,
      documentsUnchanged: outcome.documentsUnchanged,
      documentsSkipped: outcome.documentsSkipped,
      linesWritten: outcome.linesWritten,
      workflowEventsAppended: outcome.workflowEventsAppended,
      accountsCreated: outcome.accountsCreated,
      productsCreated: outcome.productsCreated,
      nameMismatches: outcome.nameMismatches,
      additionalLoadingEvents: outcome.additionalLoadingEvents,
      skippedReasons: outcome.skippedReasons,
      notes: outcome.notes,
    },
  );
  return outcome;
}

/** Why rows did not import, grouped, so PARTIAL means something exact. */
async function skippedReasons(
  db: Client,
  batchId: string,
): Promise<{ reason: string; rows: number }[]> {
  const result = await db.execute({
    sql: `SELECT COALESCE(error_message, row_status) AS reason, COUNT(*) AS rows_affected
          FROM import_rows
          WHERE import_batch_id = ? AND imported_at IS NULL
            AND row_status IN ('REJECTED','UNRESOLVED')
          GROUP BY COALESCE(error_message, row_status)
          ORDER BY COUNT(*) DESC`,
    args: [batchId],
  });
  return result.rows.map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    return { reason: escapeForDisplay(text(row.reason)), rows: Number(row.rows_affected) };
  });
}

// ---- Revalidate --------------------------------------------------------------

export interface RevalidateOutcome {
  rowsExamined: number;
  rowsResolved: number;
  rowsStillUnresolved: number;
  actorsResolved: number;
}

/**
 * Reprocess a batch's eligible unresolved rows in place.
 *
 * Re-uploading the same file to pick up a new mapping is refused by the hash
 * rule, by design, so this path is not optional: it is how a mapping made
 * today reaches rows that arrived last week. The batch keeps its identity,
 * its rows keep their source row numbers and raw payloads, and nothing that
 * already imported is reconsidered.
 */
export async function revalidateBatch(
  db: Client,
  batchId: string,
  ctx: WriteContext,
): Promise<RevalidateOutcome> {
  const found = await db.execute({
    sql: `SELECT import_type FROM import_batches WHERE import_batch_id = ?`,
    args: [batchId],
  });
  const batch = found.rows[0];
  if (batch === undefined) throw new Error(`Unknown import batch ${batchId}.`);
  const importType = text(batch.import_type) as ImportType;
  const result =
    importType === 'PURCHASE_ORDER'
      ? await revalidatePoRows(db, batchId)
      : await revalidateSoRows(db, batchId);
  await writeAudit(db, ctx, 'IMPORT_ROW_REPROCESSED', batchId, 'REVALIDATE', {
    rowsExamined: result.rowsExamined,
    rowsResolved: result.rowsResolved,
    rowsStillUnresolved: result.rowsStillUnresolved,
    actorsResolved: result.actorsResolved,
  });
  return {
    rowsExamined: result.rowsExamined,
    rowsResolved: result.rowsResolved,
    rowsStillUnresolved: result.rowsStillUnresolved,
    actorsResolved: result.actorsResolved,
  };
}

// ---- Unresolved actors -------------------------------------------------------

export interface UnresolvedActorRow {
  unresolvedActorId: string;
  username: string;
  sourceSystem: string;
  affiliateId: string | null;
  firstSeenBatchId: string;
  firstSeenAt: string;
  importType: string;
  affectedRows: number;
}

/**
 * The unresolved user queue: who the source named, where it came from, when
 * it first appeared and how many rows are waiting on it.
 */
export async function listUnresolvedActors(db: Client): Promise<UnresolvedActorRow[]> {
  const result = await db.execute(`
    SELECT ua.unresolved_actor_id AS id, ua.external_username AS username,
           COALESCE(ss.system_name, ua.source_system_id) AS source_system,
           ua.affiliate_id AS affiliate_id, ua.import_batch_id AS batch_id,
           b.uploaded_at AS first_seen, b.import_type AS import_type,
           (SELECT COUNT(*) FROM import_rows ir
             WHERE ir.import_batch_id = ua.import_batch_id
               AND UPPER(ir.raw_json) LIKE '%' || UPPER(ua.external_username) || '%') AS affected
    FROM unresolved_actors ua
    JOIN import_batches b ON b.import_batch_id = ua.import_batch_id
    LEFT JOIN source_systems ss ON ss.source_system_id = ua.source_system_id
    WHERE ua.status = 'OPEN'
    ORDER BY b.uploaded_at DESC, ua.external_username`);
  return result.rows.map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    return {
      unresolvedActorId: text(row.id),
      username: escapeForDisplay(text(row.username)),
      sourceSystem: text(row.source_system),
      affiliateId: nullableText(row.affiliate_id),
      firstSeenBatchId: text(row.batch_id),
      firstSeenAt: text(row.first_seen),
      importType: text(row.import_type),
      affectedRows: Number(row.affected),
    };
  });
}

export type MapActorResult =
  | { ok: true; sourceIdentityId: string; revalidated: RevalidateOutcome | null }
  | { ok: false; reason: string };

/**
 * Map a source username to an existing user.
 *
 * NOBODY IS CREATED HERE. A name in an extract is evidence that a person
 * exists somewhere, not authority to mint an account with no email, no
 * assignment and no role. A genuinely new colleague goes through user
 * administration, and this screen then maps their source name to them.
 *
 * The mapping is stored on source_identities, so the next upload resolves
 * the same name with nobody touching it again.
 */
export async function mapUnresolvedActor(
  db: Client,
  input: {
    unresolvedActorId: string;
    userId: string;
    revalidate: boolean;
  },
  ctx: WriteContext,
): Promise<MapActorResult> {
  const found = await db.execute({
    sql: `SELECT unresolved_actor_id, import_batch_id, source_system_id, external_username,
            affiliate_id, status
          FROM unresolved_actors WHERE unresolved_actor_id = ?`,
    args: [input.unresolvedActorId],
  });
  const actor = found.rows[0];
  if (actor === undefined) return { ok: false, reason: 'not_found' };
  if (text(actor.status) !== 'OPEN') return { ok: false, reason: 'already_resolved' };

  const user = await db.execute({
    sql: `SELECT user_id, status FROM users WHERE user_id = ?`,
    args: [input.userId],
  });
  const target = user.rows[0];
  if (target === undefined) return { ok: false, reason: 'unknown_user' };
  if (text(target.status) !== 'ACTIVE') return { ok: false, reason: 'inactive_user' };

  const username = text(actor.external_username);
  const sourceSystemId = text(actor.source_system_id);
  const affiliateId = nullableText(actor.affiliate_id);
  const now = toDbTimestamp(ctx.now);

  const existing = await db.execute({
    sql: `SELECT source_identity_id FROM source_identities
          WHERE source_system_id = ? AND external_username = ?`,
    args: [sourceSystemId, username],
  });
  const sourceIdentityId =
    existing.rows[0] === undefined ? newId('SID') : text(existing.rows[0].source_identity_id);

  await db.batch(
    [
      existing.rows[0] === undefined
        ? {
            sql: `INSERT INTO source_identities
                    (source_identity_id, source_system_id, user_id, external_username,
                     affiliate_id, active, created_at)
                  VALUES (?, ?, ?, ?, ?, 1, ?)`,
            args: [sourceIdentityId, sourceSystemId, input.userId, username, affiliateId, now],
          }
        : {
            sql: `UPDATE source_identities SET user_id = ?, affiliate_id = ?, active = 1
                  WHERE source_identity_id = ?`,
            args: [input.userId, affiliateId, sourceIdentityId],
          },
      {
        sql: `UPDATE unresolved_actors SET status = 'MAPPED', mapped_user_id = ?,
                resolved_by_user_id = ?, resolved_at = ?
              WHERE unresolved_actor_id = ?`,
        args: [input.userId, ctx.actorUserId, now, input.unresolvedActorId],
      },
      auditEventStmt({
        actorUserId: ctx.actorUserId,
        eventType: 'UNRESOLVED_ACTOR_MAPPED',
        entityType: 'SOURCE_IDENTITY',
        entityId: sourceIdentityId,
        action: 'MAP',
        beforeJson: null,
        afterJson: JSON.stringify({
          externalUsername: username,
          sourceSystemId,
          affiliateId,
          userId: input.userId,
          fromBatchId: text(actor.import_batch_id),
        }),
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        now: ctx.now,
      }) as Stmt,
    ],
    'write',
  );

  const revalidated = input.revalidate
    ? await revalidateBatch(db, text(actor.import_batch_id), ctx)
    : null;
  return { ok: true, sourceIdentityId, revalidated };
}

// ---- History, detail and the row inspector -----------------------------------

export interface BatchSummaryRow {
  batchId: string;
  importType: string;
  filename: string;
  sourceSystem: string;
  uploadedBy: string;
  uploadedAt: string;
  reportingPeriodFrom: string | null;
  reportingPeriodTo: string | null;
  rowsReceived: number;
  rowsNew: number;
  rowsChanged: number;
  rowsDuplicate: number;
  rowsRejected: number;
  status: string;
  /** Documents, counted from the rows, and never mixed with the row counts. */
  uniqueDocuments: number;
}

export async function listBatches(db: Client, limit = 50): Promise<BatchSummaryRow[]> {
  const result = await db.execute({
    sql: `SELECT b.import_batch_id AS id, b.import_type AS import_type,
            b.original_filename AS filename,
            COALESCE(ss.system_name, b.source_system_id) AS source_system,
            COALESCE(u.display_name, b.uploaded_by_user_id) AS uploaded_by,
            b.uploaded_at AS uploaded_at, b.reporting_period_from AS period_from,
            b.reporting_period_to AS period_to, b.rows_received AS rows_received,
            b.rows_new AS rows_new, b.rows_changed AS rows_changed,
            b.rows_exact_duplicate AS rows_duplicate, b.rows_rejected AS rows_rejected,
            b.status AS status,
            (SELECT COUNT(DISTINCT ir.source_record_key) FROM import_rows ir
              WHERE ir.import_batch_id = b.import_batch_id AND ir.source_record_key IS NOT NULL)
              AS distinct_keys,
            -- DOCUMENTS, NOT KEYS. A sales order row's key is
            -- affiliate|document|line, so counting distinct keys counts LINES:
            -- SO-Ver1.xls has 1,386 rows over 662 orders and 1,252 distinct
            -- line keys, and reporting 1,252 documents would overstate the
            -- month by nearly a factor of two. The count validation actually
            -- made is already recorded on its IMPORT_VALIDATED event, so it is
            -- read back from there rather than re-derived from a key whose
            -- grain differs per import type. Purchase order keys are the order
            -- itself, so the fallback below is correct for them and for any
            -- batch written before this event carried the figure.
            (SELECT CAST(json_extract(ae.after_json, '$.uniqueDocuments') AS INTEGER)
               FROM audit_events ae
              WHERE ae.entity_type = 'IMPORT_BATCH'
                AND ae.entity_id = b.import_batch_id
                AND ae.event_type = 'IMPORT_VALIDATED'
              ORDER BY ae.event_at DESC LIMIT 1) AS audited_documents
          FROM import_batches b
          LEFT JOIN source_systems ss ON ss.source_system_id = b.source_system_id
          LEFT JOIN users u ON u.user_id = b.uploaded_by_user_id
          ORDER BY b.uploaded_at DESC
          LIMIT ?`,
    args: [limit],
  });
  return result.rows.map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    return {
      batchId: text(row.id),
      importType: text(row.import_type),
      filename: escapeForDisplay(text(row.filename)),
      sourceSystem: text(row.source_system),
      uploadedBy: text(row.uploaded_by),
      uploadedAt: text(row.uploaded_at),
      reportingPeriodFrom: nullableText(row.period_from),
      reportingPeriodTo: nullableText(row.period_to),
      rowsReceived: Number(row.rows_received),
      rowsNew: Number(row.rows_new),
      rowsChanged: Number(row.rows_changed),
      rowsDuplicate: Number(row.rows_duplicate),
      rowsRejected: Number(row.rows_rejected),
      status: text(row.status),
      uniqueDocuments:
        row.audited_documents === null || row.audited_documents === undefined
          ? Number(row.distinct_keys)
          : Number(row.audited_documents),
    };
  });
}

export interface ExceptionQueue {
  queue: string;
  rows: number;
  example: string | null;
}

/**
 * The non-actor exceptions, grouped into queues.
 *
 * There is no exceptions table and none is added: the rows are the record,
 * carrying REJECTED or UNRESOLVED and their own error message, and the
 * queues below are a reading of those messages rather than a second copy of
 * them.
 */
export async function exceptionQueues(db: Client, batchId: string): Promise<ExceptionQueue[]> {
  const result = await db.execute({
    sql: `SELECT row_status, error_message, COUNT(*) AS rows_affected
          FROM import_rows
          WHERE import_batch_id = ? AND row_status IN ('REJECTED','UNRESOLVED')
          GROUP BY row_status, error_message`,
    args: [batchId],
  });
  const queues = new Map<string, { rows: number; example: string | null }>();
  for (const raw of result.rows) {
    const row = raw as unknown as Record<string, unknown>;
    const message = text(row.error_message);
    const queue = classifyException(message, text(row.row_status));
    const entry = queues.get(queue) ?? { rows: 0, example: null };
    entry.rows += Number(row.rows_affected);
    entry.example = entry.example ?? (message === '' ? null : escapeForDisplay(message));
    queues.set(queue, entry);
  }
  return [...queues.entries()]
    .map(([queue, value]) => ({ queue, rows: value.rows, example: value.example }))
    .sort((a, b) => b.rows - a.rows);
}

/** The six queues the build names, decided from the row's own message. */
export function classifyException(message: string, status: string): string {
  const lower = message.toLowerCase();
  if (lower.includes('customer code')) return 'Unresolved customer';
  if (lower.includes('product')) return 'Unresolved product';
  if (lower.includes('affiliate')) return 'Unresolved affiliate';
  if (lower.includes('date') || lower.includes('timestamp')) return 'Invalid date';
  if (lower.includes('identity') || lower.includes('lacks') || lower.includes('no purchase number'))
    return 'Missing required data';
  return status === 'REJECTED' ? 'Missing required data' : 'Other';
}

export interface RowInspection {
  importRowId: string;
  batchId: string;
  importType: string;
  sourceRowNumber: number;
  sourceRecordKey: string | null;
  rowStatus: string;
  errorMessage: string | null;
  rowHash: string;
  entityId: string | null;
  importedAt: string | null;
  /** Present only where the caller holds the data type's own module access. */
  rawSource: Record<string, string> | null;
  snapshotVersion: number | null;
  /** Says plainly why a field is absent, rather than showing an empty panel. */
  withheld: string | null;
}

/**
 * One row, as far as this caller may see it.
 *
 * The batch-level facts, which say that a row exists, what happened to it
 * and why, belong to the Upload Centre and need DATA.IMPORTS.VIEW. The
 * source values inside the row are sales order or purchase order data, and
 * need that module's own view permission. A person who may run imports but
 * may not read purchase orders sees the row and its outcome, and is told
 * plainly that the values are withheld.
 */
export async function inspectRow(
  db: Client,
  importRowId: string,
  permissions: readonly string[],
): Promise<RowInspection | null> {
  if (!canViewImports(permissions)) return null;
  const found = await db.execute({
    sql: `SELECT ir.import_row_id AS id, ir.import_batch_id AS batch_id, b.import_type AS import_type,
            ir.source_row_number AS row_number, ir.source_record_key AS source_key,
            ir.row_status AS row_status, ir.error_message AS error_message,
            ir.row_hash AS row_hash, ir.entity_id AS entity_id, ir.imported_at AS imported_at,
            ir.raw_json AS raw_json,
            (SELECT MAX(version_no) FROM record_snapshots rs
              WHERE rs.entity_type = b.import_type AND rs.entity_id = ir.entity_id) AS version_no
          FROM import_rows ir
          JOIN import_batches b ON b.import_batch_id = ir.import_batch_id
          WHERE ir.import_row_id = ?`,
    args: [importRowId],
  });
  const row = found.rows[0];
  if (row === undefined) return null;
  const importType = text(row.import_type) as ImportType;
  const check = ROW_READ_CHECK[importType];
  const mayReadValues = check !== undefined && check(permissions);

  let rawSource: Record<string, string> | null = null;
  if (mayReadValues) {
    const parsed = JSON.parse(text(row.raw_json)) as Record<string, unknown>;
    rawSource = {};
    for (const [key, value] of Object.entries(parsed)) {
      rawSource[key] = value === null || value === undefined ? '' : escapeForDisplay(String(value));
    }
  }
  return {
    importRowId: text(row.id),
    batchId: text(row.batch_id),
    importType,
    sourceRowNumber: Number(row.row_number),
    sourceRecordKey: nullableText(row.source_key),
    rowStatus: text(row.row_status),
    errorMessage: row.error_message === null ? null : escapeForDisplay(text(row.error_message)),
    rowHash: text(row.row_hash),
    entityId: nullableText(row.entity_id),
    importedAt: nullableText(row.imported_at),
    rawSource,
    snapshotVersion: row.version_no === null ? null : Number(row.version_no),
    withheld: mayReadValues
      ? null
      : `The source values are ${IMPORT_TYPE_LABELS[importType].toLowerCase()} data. Reading them needs that module's view permission, which this account does not hold.`,
  };
}

// ---- The data quality panel --------------------------------------------------

export interface DataQuality {
  unresolvedUsers: number;
  unresolvedCustomerRows: number;
  unresolvedProductRows: number;
  rejectedRows: number;
  recentPartialImports: { batchId: string; filename: string; uploadedAt: string }[];
}

/** A light panel, deliberately: counts and a short list, no analytics. */
export async function dataQuality(db: Client): Promise<DataQuality> {
  const [actors, rows, partial] = await Promise.all([
    db.execute(`SELECT COUNT(*) AS n FROM unresolved_actors WHERE status = 'OPEN'`),
    db.execute(`SELECT error_message, row_status, COUNT(*) AS n FROM import_rows
                WHERE row_status IN ('REJECTED','UNRESOLVED') AND imported_at IS NULL
                GROUP BY error_message, row_status`),
    db.execute(`SELECT import_batch_id AS id, original_filename AS filename, uploaded_at AS at
                FROM import_batches WHERE status = 'PARTIAL'
                ORDER BY uploaded_at DESC LIMIT 5`),
  ]);
  let unresolvedCustomerRows = 0;
  let unresolvedProductRows = 0;
  let rejectedRows = 0;
  for (const raw of rows.rows) {
    const row = raw as unknown as Record<string, unknown>;
    const count = Number(row.n);
    const queue = classifyException(text(row.error_message), text(row.row_status));
    if (queue === 'Unresolved customer') unresolvedCustomerRows += count;
    else if (queue === 'Unresolved product') unresolvedProductRows += count;
    if (text(row.row_status) === 'REJECTED') rejectedRows += count;
  }
  return {
    unresolvedUsers: Number(actors.rows[0]?.n ?? 0),
    unresolvedCustomerRows,
    unresolvedProductRows,
    rejectedRows,
    recentPartialImports: partial.rows.map((raw) => {
      const row = raw as unknown as Record<string, unknown>;
      return {
        batchId: text(row.id),
        filename: escapeForDisplay(text(row.filename)),
        uploadedAt: text(row.at),
      };
    }),
  };
}

// ---- Reprocessing a batch that never finished --------------------------------

/** The statuses a batch can be reprocessed from. IMPORTED is not one. */
export const REPROCESSABLE = new Set(['VALIDATING', 'REJECTED', 'PARTIAL']);

/** Whether this batch is sitting somewhere it should not be left. */
export function isNonTerminal(status: string): boolean {
  return status === 'VALIDATING';
}

/**
 * Fetch the stored workbook for a batch.
 *
 * A SEAM, DELIBERATELY. `file_objects` records a `storage_key` and a hash but
 * NOT the bytes, and this product has no file storage connected: the portal's
 * own download path says so to the customer in as many words. Until a store
 * exists, this returns null and a reprocess ends REJECTED with that as its
 * recorded reason, which is a terminal state and an honest one. When a store
 * is connected this function is the only thing that changes.
 */
export type StoredWorkbookLoader = (db: Client, batchId: string) => Promise<Uint8Array | null>;

export const storedWorkbookUnavailable: StoredWorkbookLoader = async () => null;

/**
 * Whether the stored workbook can be read back at all.
 *
 * False until a store is connected, and the screen uses it to say so BEFORE
 * somebody presses Reprocess rather than after. An action that is offered,
 * pressed, and then explains it was never going to work is a worse answer than
 * one that says what it needs up front.
 */
export const FILE_STORAGE_CONNECTED = false;

/** What to tell a person when a batch cannot be recovered. */
export const NO_FILE_STORAGE_MESSAGE =
  'This batch cannot be reprocessed: the uploaded workbook is not retrievable, because file storage is not connected to this environment. Upload the file again to replace it.';

export interface ReprocessOutcome {
  ok: boolean;
  batchId: string;
  previousStatus: string;
  newStatus: string;
  /** Present when the run could not be attempted or could not finish. */
  reason: string | null;
}

/**
 * Run an existing batch again, in place.
 *
 * THE SAME BATCH, NOT A NEW ONE. The identifier, the uploader, the upload
 * timestamp and the file hash are all untouched; what is rebuilt is the rows,
 * the landing and the counts. A batch stuck at VALIDATING is the case this
 * exists for, and it must not require the operator to find the workbook again.
 *
 * NOTHING CANONICAL IS WRITTEN. A reprocess ends where a first run would end,
 * at READY or PARTIAL or REJECTED. The commit stays a separate, deliberate act.
 */
export async function reprocessBatch(
  db: Client,
  batchId: string,
  ctx: WriteContext,
  loadWorkbook: StoredWorkbookLoader = storedWorkbookUnavailable,
): Promise<ReprocessOutcome> {
  const found = await db.execute({
    sql: `SELECT status, import_type, original_filename, source_system_id
          FROM import_batches WHERE import_batch_id = ? LIMIT 1`,
    args: [batchId],
  });
  const row = found.rows[0] as Record<string, unknown> | undefined;
  if (row === undefined) {
    return {
      ok: false,
      batchId,
      previousStatus: '',
      newStatus: '',
      reason: 'That batch does not exist.',
    };
  }
  const previousStatus = String(row.status);
  if (!REPROCESSABLE.has(previousStatus)) {
    // An imported batch has written canonical rows. Running it again would
    // mean deciding what to do with those, which is a different act with a
    // different name, so it is refused here rather than half-attempted.
    return {
      ok: false,
      batchId,
      previousStatus,
      newStatus: previousStatus,
      reason:
        previousStatus === 'IMPORTED'
          ? 'That batch has already been imported. Reprocessing would not know what to do with the documents it created, so it is refused.'
          : `A batch at ${previousStatus} cannot be reprocessed.`,
    };
  }

  const bytes = await loadWorkbook(db, batchId);
  if (bytes === null) {
    const reason =
      'The stored workbook could not be read: file storage is not connected to this environment, so the original bytes are not retrievable. Upload the file again.';
    await db.execute({
      sql: `UPDATE import_batches SET status = 'REJECTED' WHERE import_batch_id = ?`,
      args: [batchId],
    });
    await writeAudit(db, ctx, 'IMPORT_REPROCESSED', batchId, 'VALIDATE', {
      previousStatus,
      newStatus: 'REJECTED',
      reason,
    });
    return { ok: false, batchId, previousStatus, newStatus: 'REJECTED', reason };
  }

  const importType = String(row.import_type) as ImportType;
  const filename = String(row.original_filename);
  const sourceSystemId = String(row.source_system_id);
  const uploadInput = {
    filename,
    uploadedBy: ctx.actorUserId,
    sourceSystemId,
    reprocessBatchId: batchId,
  };

  if (importType === 'PURCHASE_ORDER') {
    await validatePoWorkbook(db, bytes, { ...uploadInput, affiliateId: null }, ctx);
  } else {
    await validateSoWorkbook(db, bytes, uploadInput, ctx);
  }

  const after = await db.execute({
    sql: `SELECT status FROM import_batches WHERE import_batch_id = ? LIMIT 1`,
    args: [batchId],
  });
  const newStatus = String((after.rows[0] as Record<string, unknown> | undefined)?.status ?? '');
  await writeAudit(db, ctx, 'IMPORT_REPROCESSED', batchId, 'VALIDATE', {
    previousStatus,
    newStatus,
  });
  return { ok: newStatus !== 'REJECTED', batchId, previousStatus, newStatus, reason: null };
}
