/**
 * Retrying an import that failed to write, without a file and without SQL.
 *
 * WHAT WAS MISSING. A batch that validated and then failed to commit was a
 * dead end: PARTIAL, with no way forward from the screen. Every recovery ran
 * through somebody writing SQL for the operator to paste into a console.
 *
 * TWO ACTIONS, AND THEY ARE NOT THE SAME THING.
 *
 *   Revalidate          re-runs VALIDATION against the rows already landed.
 *                       The right action when the configuration changed
 *                       underneath the batch: a customer was mapped, a product
 *                       was classified, a person's identity was resolved.
 *                       Lives in uploadCentre.revalidateBatch.
 *   Retry the import    re-runs the COMMIT for a batch that validated but
 *                       failed to write. This module.
 *
 * Neither needs the original workbook, which matters because this environment
 * has no file storage: `reprocessBatch` does need it and therefore cannot run
 * at all. These two can.
 *
 * WHAT MAKES A RETRY SAFE TO PRESS TWICE. It never re-imports a document that
 * is already in the canonical tables. That is decided by asking the canonical
 * table itself, per document, before anything is written — not by trusting a
 * status word, and not by trusting `imported_at`, which records what THIS
 * batch did and would miss a document another batch had already written.
 *
 * A second press therefore finds every document already there, writes nothing,
 * and says so. That is the honest report, and it is the one thing an operator
 * needs to believe before they will press a recovery control at all.
 */
import type { Client, InStatement } from '@libsql/client/web';
import type { WriteContext } from '../admin/guard.ts';
import { parsePoSourceKey } from './poImport.ts';

type Stmt = Extract<InStatement, { sql: string }>;
const text = (v: unknown): string => String(v ?? '');

/**
 * How many document keys fit in one IN list.
 *
 * 400, not 200. SQLite allows 999 bound variables and this read is on the
 * batch page's budget of fifteen: 662 documents cost two reads at 400 and
 * four at 200, and the page has other things to spend on.
 */
const PROBE_CHUNK = 400;

export type RetryImportType = 'SALES_ORDER' | 'PURCHASE_ORDER';

/** A document, as the canonical tables identify one. */
export interface DocumentKey {
  /** Null for a Group-scope purchase order, which genuinely has no affiliate. */
  readonly affiliateId: string | null;
  readonly documentNumber: string;
}

/**
 * The document a row belongs to, from the key validation gave it.
 *
 * THE TWO IMPORT TYPES DISAGREE ABOUT WHAT A KEY IS, and a retry that used one
 * shape for both would look up the wrong thing for half its batches:
 *
 *   sales order      affiliate|document|line   — LINE grain, three parts
 *   purchase order   affiliate|document        — ORDER grain, two parts, with
 *                                                an EMPTY affiliate slot for a
 *                                                Group-scope batch
 *
 * Returns null for a row whose key is absent or malformed, which is a row that
 * never identified a document and cannot be retried into one.
 */
export function documentOf(
  importType: RetryImportType,
  sourceKey: string | null,
): DocumentKey | null {
  if (sourceKey === null || sourceKey === '') return null;
  if (importType === 'PURCHASE_ORDER') {
    const parts = parsePoSourceKey(sourceKey);
    if (parts.documentNumber === '') return null;
    return { affiliateId: parts.affiliateId, documentNumber: parts.documentNumber };
  }
  const parts = sourceKey.split('|');
  if (parts.length < 2) return null;
  const affiliateId = parts[0] ?? '';
  const documentNumber = parts[1] ?? '';
  if (documentNumber === '') return null;
  return { affiliateId: affiliateId === '' ? null : affiliateId, documentNumber };
}

/** `affiliate|document`, with an empty slot for a null affiliate. */
export function documentKeyString(key: DocumentKey): string {
  return `${key.affiliateId ?? ''}|${key.documentNumber}`;
}

/**
 * Which of these documents are already in the canonical tables.
 *
 * `affiliate_id IS ?` rather than `=`, because a Group-scope purchase order's
 * affiliate is NULL and `= NULL` is never true — the same trap that put a
 * document number into `affiliate_id` two phases ago.
 *
 * Chunked, set-based, and grouped by affiliate so the predicate stays an exact
 * prefix of `UNIQUE(affiliate_id, document_number)`. 662 documents cost four
 * reads rather than 662.
 */
export async function alreadyCanonical(
  db: Client,
  importType: RetryImportType,
  keys: readonly DocumentKey[],
): Promise<Set<string>> {
  const table = importType === 'PURCHASE_ORDER' ? 'purchase_orders' : 'sales_orders';
  const byAffiliate = new Map<string | null, string[]>();
  for (const key of keys) {
    const list = byAffiliate.get(key.affiliateId) ?? [];
    list.push(key.documentNumber);
    byAffiliate.set(key.affiliateId, list);
  }

  const found = new Set<string>();
  for (const [affiliateId, documents] of byAffiliate) {
    const unique = [...new Set(documents)];
    for (let start = 0; start < unique.length; start += PROBE_CHUNK) {
      const chunk = unique.slice(start, start + PROBE_CHUNK);
      const result = await db.execute({
        sql: `SELECT affiliate_id, document_number FROM ${table}
              WHERE affiliate_id IS ? AND document_number IN (${chunk.map(() => '?').join(',')})`,
        args: [affiliateId, ...chunk] as never[],
      });
      for (const raw of result.rows) {
        const row = raw as unknown as Record<string, unknown>;
        found.add(
          documentKeyString({
            affiliateId: row.affiliate_id === null ? null : text(row.affiliate_id),
            documentNumber: text(row.document_number),
          }),
        );
      }
    }
  }
  return found;
}

/**
 * The three figures, decided before anything is written.
 *
 * THE OPERATOR DECIDES WITH THESE IN FRONT OF THEM. A recovery control that
 * reports what it did only afterwards is one nobody presses on a system they
 * have already been burned by.
 */
export interface RetryPreview {
  readonly batchId: string;
  readonly importType: RetryImportType;
  readonly status: string;
  /** Documents already in the canonical tables. A retry will not touch these. */
  readonly alreadyImported: number;
  /** Documents a retry will attempt. */
  readonly willImport: number;
  /** Documents that still cannot be written, with the reason each time. */
  readonly blocked: number;
  readonly blockedReasons: { reason: string; documents: number }[];
  /** True when there is nothing at all for a retry to do. */
  readonly nothingToDo: boolean;
  /** Null when the batch may be retried; a sentence when it may not. */
  readonly refusal: string | null;
  /**
   * The rows each preparation move addresses, by id.
   *
   * Carried out of the preview rather than recomputed, so the retry costs no
   * second read of 1,386 rows, and so the rows the operator was shown figures
   * for are exactly the rows that get touched.
   */
  readonly rowPlan?: { reopen: string[]; markSkipped: string[] };
}

/** A batch at IMPORTED has nothing to retry, and says so rather than trying. */
export const RETRYABLE_STATUSES = new Set(['READY', 'PARTIAL', 'REJECTED']);

export async function previewRetry(db: Client, batchId: string): Promise<RetryPreview | null> {
  const found = await db.execute({
    sql: `SELECT import_type, status FROM import_batches WHERE import_batch_id = ? LIMIT 1`,
    args: [batchId],
  });
  const batch = found.rows[0] as Record<string, unknown> | undefined;
  if (batch === undefined) return null;
  const importType = text(batch.import_type) as RetryImportType;
  const status = text(batch.status);

  const empty = {
    batchId,
    importType,
    status,
    alreadyImported: 0,
    willImport: 0,
    blocked: 0,
    blockedReasons: [] as { reason: string; documents: number }[],
    nothingToDo: true,
    rowPlan: { reopen: [] as string[], markSkipped: [] as string[] },
  };
  if (status === 'IMPORTED') {
    return {
      ...empty,
      refusal:
        'This batch has already been imported. There is nothing to retry; open the records it created.',
    };
  }
  if (!RETRYABLE_STATUSES.has(status)) {
    return {
      ...empty,
      refusal:
        status === 'VALIDATING'
          ? 'This batch never finished validating, so there is nothing to import yet. Revalidate it first.'
          : `A batch at ${status} cannot be retried.`,
    };
  }

  const rows = await db.execute({
    sql: `SELECT import_row_id, source_record_key, row_status, imported_at, error_message
          FROM import_rows WHERE import_batch_id = ?`,
    args: [batchId],
  });

  // Group the rows by the DOCUMENT they belong to, which is the grain a commit
  // works in and therefore the grain a retry has to report in.
  interface DocumentState {
    key: DocumentKey;
    actionable: number;
    unresolved: number;
    rejected: number;
    rejectionReason: string | null;
    /** Row ids, so the preparation below can address rows without re-reading. */
    rejectedRowIds: string[];
    openRowIds: string[];
  }
  const documents = new Map<string, DocumentState>();
  for (const raw of rows.rows) {
    const row = raw as unknown as Record<string, unknown>;
    const key = documentOf(
      importType,
      row.source_record_key === null ? null : text(row.source_record_key),
    );
    if (key === null) continue;
    const id = documentKeyString(key);
    const state =
      documents.get(id) ??
      ({
        key,
        actionable: 0,
        unresolved: 0,
        rejected: 0,
        rejectionReason: null,
        rejectedRowIds: [],
        openRowIds: [],
      } as DocumentState);
    const rowStatus = text(row.row_status);
    const rowId = text(row.import_row_id);
    const alreadyLanded = row.imported_at !== null;
    if (rowStatus === 'UNRESOLVED') state.unresolved += 1;
    else if (rowStatus === 'REJECTED') {
      state.rejected += 1;
      if (!alreadyLanded) state.rejectedRowIds.push(rowId);
      if (state.rejectionReason === null && row.error_message !== null) {
        state.rejectionReason = text(row.error_message);
      }
    } else {
      state.actionable += 1;
      if (!alreadyLanded) state.openRowIds.push(rowId);
    }
    documents.set(id, state);
  }

  const canonical = await alreadyCanonical(
    db,
    importType,
    [...documents.values()].map((d) => d.key),
  );

  let alreadyImported = 0;
  let willImport = 0;
  const blocked = new Map<string, number>();
  // The rows each move addresses, collected while the documents are being
  // classified so the preparation costs no second read.
  const reopen: string[] = [];
  const markSkipped: string[] = [];
  for (const [id, state] of documents) {
    if (canonical.has(id)) {
      alreadyImported += 1;
      // Everything still open on an already-canonical document is passed over
      // rather than re-written.
      markSkipped.push(...state.openRowIds, ...state.rejectedRowIds);
      continue;
    }
    // A retry re-attempts rows a COMMIT rejected as well as rows that never
    // ran, because a commit rejection is exactly the failure being retried.
    if (state.actionable > 0 || state.rejected > 0) {
      willImport += 1;
      reopen.push(...state.rejectedRowIds);
      continue;
    }
    // Nothing actionable left: every row is waiting on a mapping, which a
    // retry cannot supply. Revalidate is the action for that, not this.
    const reason =
      state.unresolved > 0
        ? 'Waiting on a mapping. Revalidate the batch once the customer, product or person is resolved.'
        : (state.rejectionReason ?? 'No importable rows.');
    blocked.set(reason, (blocked.get(reason) ?? 0) + 1);
  }

  const blockedTotal = [...blocked.values()].reduce((a, b) => a + b, 0);
  return {
    batchId,
    importType,
    status,
    alreadyImported,
    willImport,
    blocked: blockedTotal,
    blockedReasons: [...blocked].map(([reason, count]) => ({ reason, documents: count })),
    nothingToDo: willImport === 0,
    refusal: null,
    rowPlan: { reopen, markSkipped },
  };
}

export interface RetryOutcome {
  readonly ok: boolean;
  readonly batchId: string;
  readonly previousStatus: string;
  readonly newStatus: string;
  /** The three figures as they stood before the run. */
  readonly preview: RetryPreview | null;
  /** What the commit actually did. Null when nothing ran. */
  readonly documentsImported: number;
  readonly documentsSkipped: number;
  /** True when the retry found everything already imported and wrote nothing. */
  readonly nothingChanged: boolean;
  readonly refusal: string | null;
  readonly message: string;
}

/**
 * Prepare a batch's rows for a retry, in ONE round trip.
 *
 * TWO OPPOSITE MOVES, AND GETTING EITHER BACKWARDS MAKES THE RETRY A LIE.
 *
 * 1. ROWS OF DOCUMENTS THAT ARE NOT YET CANONICAL ARE RE-OPENED, as NEW.
 *    A commit only actions rows whose status is NEW or CHANGED. When a
 *    document fails to write, its rows are set to REJECTED — so a retry that
 *    simply called the commit again would find nothing to do, write nothing,
 *    and report success. It would look like a working retry and be a no-op
 *    every time.
 *
 *    NEW rather than CHANGED, of the two a commit acts on. Nothing canonical
 *    exists for this document, so this is still its first landing; CHANGED
 *    would claim its values moved since a version that was never written.
 *
 * 2. ROWS OF DOCUMENTS THAT ARE ALREADY CANONICAL ARE MARKED SKIPPED, as
 *    DUPLICATE, which a commit does NOT action. The document is passed over
 *    entirely rather than re-written. Without this the commit would UPDATE a
 *    record that is already correct and mint a new snapshot version for it —
 *    a change — and the retry would have broken its one promise.
 *
 *    DUPLICATE of the five values `row_status` permits, and NOT REJECTED: this
 *    row is not wrong, and one word for "already landed" and "could not be
 *    written" would tell an operator the opposite of what happened. The
 *    `error_message` separates it from the other reasons a row is DUPLICATE:
 *
 *      skipped, already imported   row_status='DUPLICATE' AND error_message LIKE 'Skipped:%'
 *      rejected, could not write   row_status='REJECTED'
 *
 * BY ROW ID, IN CHUNKED STATEMENTS, IN ONE BATCH. Addressing rows by their
 * document key would mean a statement per document — 662 round trips for the
 * sales order file, which is the cost the whole import was rebuilt to escape.
 * The ids come from the preview, which has already read every row.
 */
export const SKIPPED_MESSAGE =
  'Skipped: this document is already in the canonical tables. Nothing was rewritten.';

/** Ids per UPDATE. SQLite allows 999 bound variables; this leaves room. */
const ROW_CHUNK = 200;

async function prepareRows(
  db: Client,
  plan: { reopen: readonly string[]; markSkipped: readonly string[] },
): Promise<{ reopened: number; skipped: number }> {
  const statements: Stmt[] = [];
  for (let start = 0; start < plan.reopen.length; start += ROW_CHUNK) {
    const chunk = plan.reopen.slice(start, start + ROW_CHUNK);
    statements.push({
      sql: `UPDATE import_rows SET row_status = 'NEW', error_message = NULL
             WHERE import_row_id IN (${chunk.map(() => '?').join(',')})`,
      args: [...chunk],
    });
  }
  for (let start = 0; start < plan.markSkipped.length; start += ROW_CHUNK) {
    const chunk = plan.markSkipped.slice(start, start + ROW_CHUNK);
    statements.push({
      sql: `UPDATE import_rows SET row_status = 'DUPLICATE', error_message = ?
             WHERE import_row_id IN (${chunk.map(() => '?').join(',')})`,
      args: [SKIPPED_MESSAGE, ...chunk],
    });
  }
  if (statements.length > 0) await db.batch(statements, 'write');
  return { reopened: plan.reopen.length, skipped: plan.markSkipped.length };
}

/**
 * Retry the import.
 *
 * `runCommit` is injected rather than imported so this module does not depend
 * on the Upload Centre, which depends on the importers, which would close a
 * cycle. The caller passes `commitBatch`.
 */
export async function retryImport(
  db: Client,
  batchId: string,
  ctx: WriteContext,
  runCommit: (
    db: Client,
    batchId: string,
    ctx: WriteContext,
  ) => Promise<{ documentsCreated: number; documentsUpdated: number; documentsSkipped: number }>,
): Promise<RetryOutcome> {
  const preview = await previewRetry(db, batchId);
  if (preview === null) {
    return {
      ok: false,
      batchId,
      previousStatus: '',
      newStatus: '',
      preview: null,
      documentsImported: 0,
      documentsSkipped: 0,
      nothingChanged: true,
      refusal: 'That batch does not exist.',
      message: 'That batch does not exist.',
    };
  }
  if (preview.refusal !== null) {
    return {
      ok: false,
      batchId,
      previousStatus: preview.status,
      newStatus: preview.status,
      preview,
      documentsImported: 0,
      documentsSkipped: 0,
      nothingChanged: true,
      refusal: preview.refusal,
      message: preview.refusal,
    };
  }

  // EVERYTHING ALREADY THERE: say so, and change nothing. This is the second
  // press, and it has to be honest about having done nothing rather than
  // reporting a successful import of zero documents.
  if (preview.nothingToDo) {
    const message =
      preview.alreadyImported > 0
        ? `Nothing to do: all ${preview.alreadyImported} ${
            preview.alreadyImported === 1 ? 'document is' : 'documents are'
          } already imported. No record was changed.`
        : preview.blocked > 0
          ? `Nothing could be retried: ${preview.blocked} ${
              preview.blocked === 1 ? 'document is' : 'documents are'
            } still blocked. ${preview.blockedReasons[0]?.reason ?? ''}`.trim()
          : 'Nothing to do: this batch has no importable documents.';
    return {
      ok: true,
      batchId,
      previousStatus: preview.status,
      newStatus: preview.status,
      preview,
      documentsImported: 0,
      documentsSkipped: preview.blocked,
      nothingChanged: true,
      refusal: null,
      message,
    };
  }

  await prepareRows(db, preview.rowPlan ?? { reopen: [], markSkipped: [] });
  const result = await runCommit(db, batchId, ctx);
  const after = await db.execute({
    sql: `SELECT status FROM import_batches WHERE import_batch_id = ? LIMIT 1`,
    args: [batchId],
  });
  const newStatus = text((after.rows[0] as Record<string, unknown> | undefined)?.status ?? '');
  const imported = result.documentsCreated + result.documentsUpdated;

  return {
    ok: newStatus === 'IMPORTED' || imported > 0,
    batchId,
    previousStatus: preview.status,
    newStatus,
    preview,
    documentsImported: imported,
    documentsSkipped: result.documentsSkipped,
    nothingChanged: imported === 0,
    refusal: null,
    message:
      result.documentsSkipped === 0
        ? `Imported ${imported} ${imported === 1 ? 'document' : 'documents'}. ` +
          `${preview.alreadyImported} already imported and left alone.`
        : `Imported ${imported} of ${imported + result.documentsSkipped} documents. ` +
          `${result.documentsSkipped} could not be written; open the batch to see why.`,
  };
}
