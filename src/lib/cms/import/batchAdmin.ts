/**
 * The controls an operator needs when a batch goes wrong: delete one, and
 * clear the history.
 *
 * WHY THIS EXISTS. Until now a failed batch was a dead end. Every recovery ran
 * through somebody writing SQL for the operator to paste into the Turso
 * console, which is not a system, and a console session is the one recovery
 * path with no audit trail, no confirmation and no protection against
 * deleting the wrong thing.
 *
 * WHAT PROTECTS A BATCH FROM DELETION. Not its status: a PARTIAL batch may
 * have committed three documents of 662, and its status says nothing about
 * which. The question is whether canonical records exist that point at it, and
 * that is asked of the database rather than inferred from a word.
 *
 * WHAT THE DATABASE DOES ON ITS OWN, verified against the schema rather than
 * assumed, because a delete that guesses at cascades is how evidence
 * disappears:
 *
 *   so_extract_rows    ON DELETE CASCADE   goes with the batch
 *   po_extract_rows    ON DELETE CASCADE   goes with the batch
 *   import_rows        ON DELETE CASCADE   goes with the batch
 *   unresolved_actors  ON DELETE CASCADE   goes with the batch
 *   record_snapshots   ON DELETE SET NULL  STAYS, losing only its batch pointer
 *   audit_events       no foreign key      untouched, and cannot be reached
 *
 * The `SET NULL` on record_snapshots is what makes this safe rather than
 * merely careful: a snapshot belongs to the sales order it describes, not to
 * the batch that happened to create it, and a CASCADE there would delete the
 * history of surviving orders. In practice it never fires on a permitted
 * delete, because a batch with snapshots pointing at it has written canonical
 * records and is refused.
 *
 * AND audit_events IS NEVER TOUCHED. It has no foreign key to reach it
 * through, and the operator's own trigger refuses a DELETE at the database
 * level (`trg_audit_events_no_delete`). Nothing below issues one. That is two
 * independent guarantees, which is the right number for evidence.
 */
import type { Client, InStatement } from '@libsql/client/web';
import type { WriteContext } from '../admin/guard.ts';
import { auditEventStmt } from '../repos/authRecords.ts';

type Stmt = Extract<InStatement, { sql: string }>;
const text = (v: unknown): string => String(v ?? '');
const num = (v: unknown): number => Number(v ?? 0);

/** The audit event a deletion writes. Never deleted, only appended. */
export const IMPORT_BATCH_DELETED = 'IMPORT_BATCH_DELETED';
export const IMPORT_HISTORY_CLEARED = 'IMPORT_HISTORY_CLEARED';

/**
 * What a batch has already put into the canonical tables.
 *
 * `documentsImported` is the one that decides: a row carrying `imported_at`
 * is a row whose document reached `sales_orders` or `purchase_orders`, and
 * deleting the batch would cut that document off from the evidence of where
 * it came from.
 *
 * Accounts and products are counted but do NOT protect the batch. They are
 * reference records that stand on their own, their creation is recorded in
 * `audit_events` which survives any delete, and refusing to tidy a failed
 * batch because it happened to name a new customer would make the control
 * useless on exactly the batches that need it.
 */
export interface CanonicalFootprint {
  readonly documentsImported: number;
  readonly snapshots: number;
  readonly accountsCreated: number;
  readonly productsCreated: number;
  /** True when a canonical document points at this batch. */
  readonly wroteCanonicalRecords: boolean;
}

/** Counts of what a delete would remove, for the confirmation. */
export interface BatchContents {
  readonly rows: number;
  readonly landedRows: number;
  readonly unresolvedActors: number;
}

export interface BatchDeletePlan {
  readonly batchId: string;
  readonly status: string;
  readonly filename: string;
  readonly contents: BatchContents;
  readonly footprint: CanonicalFootprint;
  /** Whether the delete may proceed. */
  readonly permitted: boolean;
  /** Why not, in words a person can act on. Null when permitted. */
  readonly refusal: string | null;
}

/**
 * Everything a delete needs to know, in one round trip.
 *
 * ONE STATEMENT, not six. This is called from a page, which holds a budget of
 * fifteen subrequests for everything it does, and a confirmation dialog that
 * spent six of them on counts would be the most expensive thing on the
 * screen.
 */
export async function planBatchDeletion(
  db: Client,
  batchId: string,
): Promise<BatchDeletePlan | null> {
  const found = await db.execute({
    sql: `SELECT b.status AS status, b.original_filename AS filename,
            (SELECT COUNT(*) FROM import_rows r WHERE r.import_batch_id = b.import_batch_id)
              AS rows_held,
            (SELECT COUNT(*) FROM so_extract_rows s WHERE s.import_batch_id = b.import_batch_id)
            + (SELECT COUNT(*) FROM po_extract_rows p WHERE p.import_batch_id = b.import_batch_id)
              AS landed_rows,
            (SELECT COUNT(*) FROM unresolved_actors a
              WHERE a.import_batch_id = b.import_batch_id) AS actors,
            -- A row carrying imported_at is a row whose document is canonical.
            (SELECT COUNT(DISTINCT r.entity_id) FROM import_rows r
              WHERE r.import_batch_id = b.import_batch_id AND r.imported_at IS NOT NULL
                AND r.entity_id IS NOT NULL) AS documents_imported,
            (SELECT COUNT(*) FROM record_snapshots sn
              WHERE sn.import_batch_id = b.import_batch_id) AS snapshots,
            -- Reference records this batch created. Counted for the
            -- confirmation, which says they stay; never a reason to refuse.
            (SELECT COUNT(*) FROM audit_events e
              WHERE e.event_type = 'ACCOUNT_CREATED'
                AND json_extract(e.after_json, '$.importBatchId') = b.import_batch_id)
              AS accounts_created,
            (SELECT COUNT(*) FROM audit_events e
              WHERE e.event_type = 'PRODUCT_CREATED'
                AND json_extract(e.after_json, '$.importBatchId') = b.import_batch_id)
              AS products_created
          FROM import_batches b WHERE b.import_batch_id = ? LIMIT 1`,
    args: [batchId],
  });
  const row = found.rows[0] as Record<string, unknown> | undefined;
  if (row === undefined) return null;

  const documentsImported = num(row.documents_imported);
  const snapshots = num(row.snapshots);
  const status = text(row.status);
  // A THIRD ARM, FOR THE CASE THE OTHER TWO MISS. A commit where every
  // document was already up to date finishes IMPORTED having written nothing:
  // an unchanged document is not stamped and takes no snapshot. Without this
  // arm a batch the history calls "Imported" would be deletable, which is
  // exactly the promise this control makes it must not be. PARTIAL is
  // deliberately NOT here: a PARTIAL batch that wrote nothing is the batch
  // this control exists for, and one that did write is caught by its stamps.
  const wroteCanonicalRecords = documentsImported > 0 || snapshots > 0 || status === 'IMPORTED';

  return {
    batchId,
    status,
    filename: text(row.filename),
    contents: {
      rows: num(row.rows_held),
      landedRows: num(row.landed_rows),
      unresolvedActors: num(row.actors),
    },
    footprint: {
      documentsImported,
      snapshots,
      accountsCreated: num(row.accounts_created),
      productsCreated: num(row.products_created),
      wroteCanonicalRecords,
    },
    permitted: !wroteCanonicalRecords,
    refusal: !wroteCanonicalRecords
      ? null
      : documentsImported === 0
        ? 'This batch cannot be deleted: it is marked as imported, so records in the ' +
          'system may depend on it. Only a batch that never wrote a record can be removed.'
        : `This batch cannot be deleted: it wrote ${documentsImported} ` +
          `${documentsImported === 1 ? 'record' : 'records'} that are still in the system. ` +
          `Deleting the batch would cut ${documentsImported === 1 ? 'that record' : 'those records'} ` +
          `off from the evidence of where ${documentsImported === 1 ? 'it' : 'they'} came from.`,
  };
}

export interface BatchDeleteOutcome {
  readonly ok: boolean;
  readonly batchId: string;
  readonly status: string;
  readonly deleted: BatchContents | null;
  readonly refusal: string | null;
}

/**
 * Delete one batch, or refuse and say why.
 *
 * The delete itself is a single statement: every table that belongs to the
 * batch cascades, and the one that does not belong to it — record_snapshots —
 * keeps its rows by design. The audit row is written FIRST, in the same
 * transaction, because an audit event whose subject no longer exists is still
 * evidence and an unaudited deletion is not.
 */
export async function deleteBatch(
  db: Client,
  batchId: string,
  ctx: WriteContext,
): Promise<BatchDeleteOutcome> {
  const plan = await planBatchDeletion(db, batchId);
  if (plan === null) {
    return {
      ok: false,
      batchId,
      status: '',
      deleted: null,
      refusal: 'That batch does not exist.',
    };
  }
  if (!plan.permitted) {
    return {
      ok: false,
      batchId,
      status: plan.status,
      deleted: null,
      refusal: plan.refusal,
    };
  }

  await db.batch(
    [
      auditEventStmt({
        actorUserId: ctx.actorUserId,
        eventType: IMPORT_BATCH_DELETED,
        entityType: 'IMPORT_BATCH',
        entityId: batchId,
        action: 'DELETE',
        beforeJson: JSON.stringify({
          status: plan.status,
          filename: plan.filename,
          rows: plan.contents.rows,
          landedRows: plan.contents.landedRows,
          unresolvedActors: plan.contents.unresolvedActors,
          accountsCreated: plan.footprint.accountsCreated,
          productsCreated: plan.footprint.productsCreated,
        }),
        afterJson: null,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        now: ctx.now,
      }) as Stmt,
      // import_rows, so_extract_rows, po_extract_rows and unresolved_actors all
      // carry ON DELETE CASCADE and go with this. record_snapshots carries
      // ON DELETE SET NULL and stays. audit_events has no foreign key here and
      // is unreachable from it, which is the point.
      { sql: `DELETE FROM import_batches WHERE import_batch_id = ?`, args: [batchId] },
    ],
    'write',
  );

  return {
    ok: true,
    batchId,
    status: plan.status,
    deleted: plan.contents,
    refusal: null,
  };
}

// ---- Clearing the history ----------------------------------------------------

/**
 * What a clear covers.
 *
 * FOUR SCOPES RATHER THAN ONE BUTTON, because "delete everything" is rarely
 * what somebody means and a control that only offers it gets used for the
 * thing it is not meant for.
 *
 *   failed        REJECTED and VALIDATING. The batches that did not finish.
 *                 VALIDATING is here because a batch left at VALIDATING is
 *                 stuck rather than in progress: nothing resumes it.
 *   before        Everything uploaded before a date, whatever its status.
 *   no-records    Everything that never wrote a canonical record, whatever
 *                 its status or age. This is the protection rule turned into
 *                 a selection: it picks exactly the set that a delete would
 *                 permit, so nothing in it is ever skipped.
 *   everything    Every batch, and a typed confirmation, because the whole
 *                 point of the other three is that this one is rarely right.
 */
export type ClearScope = 'failed' | 'before' | 'no-records' | 'everything';

/** The word the operator types for the everything scope. */
/**
 * Not `DELETE`. That is the word on every destructive button anybody has ever
 * pressed, so typing it is muscle memory rather than deliberation, which is
 * the one thing a typed confirmation exists to buy.
 */
export const CLEAR_EVERYTHING_CONFIRMATION = 'DELETE ALL HISTORY';

export interface ClearSelection {
  readonly scope: ClearScope;
  /** Required by the `before` scope, ignored by the others. */
  readonly before?: string | null;
}

export interface ClearCandidate {
  readonly batchId: string;
  readonly status: string;
  readonly filename: string;
  readonly uploadedAt: string;
  readonly rows: number;
  readonly landedRows: number;
  readonly documentsImported: number;
  /** Whether this batch would be deleted, or skipped for writing records. */
  readonly protectedByRecords: boolean;
}

export interface ClearPreview {
  readonly scope: ClearScope;
  readonly candidates: ClearCandidate[];
  /** What will go. */
  readonly batches: number;
  readonly rows: number;
  readonly landedRows: number;
  /** What will be skipped, and why. */
  readonly skipped: number;
  readonly skippedReason: string | null;
}

/** The WHERE clause for a scope, as SQL and arguments. */
function scopePredicate(selection: ClearSelection): { sql: string; args: unknown[] } {
  switch (selection.scope) {
    case 'failed':
      return { sql: `b.status IN ('REJECTED','VALIDATING')`, args: [] };
    case 'before':
      return { sql: `b.uploaded_at < ?`, args: [selection.before ?? ''] };
    case 'no-records':
      // THE PROTECTION RULE AS A SELECTION, and it must be its exact
      // complement — including the IMPORTED arm. A scope that selected
      // batches the delete then skips would report "12 selected, 12 skipped",
      // which is a control that does nothing and cannot say why.
      return {
        sql: `b.status <> 'IMPORTED'
              AND NOT EXISTS (SELECT 1 FROM import_rows r
                               WHERE r.import_batch_id = b.import_batch_id
                                 AND r.imported_at IS NOT NULL)
              AND NOT EXISTS (SELECT 1 FROM record_snapshots sn
                               WHERE sn.import_batch_id = b.import_batch_id)`,
        args: [],
      };
    case 'everything':
      return { sql: `1 = 1`, args: [] };
  }
}

/**
 * What a clear would do, before it does it.
 *
 * ONE READ for the whole selection, however many batches it covers. The
 * per-batch counts come back as columns rather than as a query each, for the
 * same reason the commit stopped asking per document: a page has fifteen
 * subrequests to spend on everything it shows.
 */
export async function previewClear(
  db: Client,
  selection: ClearSelection,
  limit = 500,
): Promise<ClearPreview> {
  const predicate = scopePredicate(selection);
  const result = await db.execute({
    sql: `SELECT b.import_batch_id AS id, b.status AS status,
            b.original_filename AS filename, b.uploaded_at AS uploaded_at,
            (SELECT COUNT(*) FROM import_rows r WHERE r.import_batch_id = b.import_batch_id)
              AS rows_held,
            (SELECT COUNT(*) FROM so_extract_rows s WHERE s.import_batch_id = b.import_batch_id)
            + (SELECT COUNT(*) FROM po_extract_rows p WHERE p.import_batch_id = b.import_batch_id)
              AS landed_rows,
            (SELECT COUNT(DISTINCT r.entity_id) FROM import_rows r
              WHERE r.import_batch_id = b.import_batch_id AND r.imported_at IS NOT NULL
                AND r.entity_id IS NOT NULL) AS documents_imported,
            (SELECT COUNT(*) FROM record_snapshots sn
              WHERE sn.import_batch_id = b.import_batch_id) AS snapshots
          FROM import_batches b
          WHERE ${predicate.sql}
          ORDER BY b.uploaded_at DESC
          LIMIT ?`,
    args: [...predicate.args, limit] as never[],
  });

  const candidates: ClearCandidate[] = result.rows.map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    const documentsImported = num(row.documents_imported);
    return {
      batchId: text(row.id),
      status: text(row.status),
      filename: text(row.filename),
      uploadedAt: text(row.uploaded_at),
      rows: num(row.rows_held),
      landedRows: num(row.landed_rows),
      documentsImported,
      // The same three arms as planBatchDeletion, so a batch the preview says
      // will go is a batch the delete will actually take.
      protectedByRecords:
        documentsImported > 0 || num(row.snapshots) > 0 || text(row.status) === 'IMPORTED',
    };
  });

  const going = candidates.filter((c) => !c.protectedByRecords);
  const skipped = candidates.length - going.length;
  return {
    scope: selection.scope,
    candidates,
    batches: going.length,
    rows: going.reduce((total, c) => total + c.rows, 0),
    landedRows: going.reduce((total, c) => total + c.landedRows, 0),
    skipped,
    skippedReason:
      skipped === 0
        ? null
        : `${skipped} ${skipped === 1 ? 'batch was' : 'batches were'} skipped: ` +
          `${skipped === 1 ? 'it wrote records' : 'they wrote records'} that are still in the ` +
          `system, and deleting the ${skipped === 1 ? 'batch' : 'batches'} would cut those ` +
          `records off from the evidence of where they came from.`,
  };
}

export interface ClearOutcome {
  readonly scope: ClearScope;
  readonly deleted: number;
  readonly rows: number;
  readonly landedRows: number;
  readonly skipped: number;
  readonly skippedReason: string | null;
  readonly refusal: string | null;
}

/** How many batch ids fit in one DELETE. SQLite allows 999 bound variables. */
const DELETE_CHUNK = 200;

/**
 * Run the clear.
 *
 * SKIPPED, NOT REFUSED AND NOT SILENTLY DELETED. A batch that wrote records is
 * left alone and counted, because failing the whole operation over one
 * protected batch would make the control unusable on a history that contains
 * any successful import — which is every real history.
 *
 * ONE AUDIT ROW FOR THE OPERATION, with the counts. Not one per batch: an
 * operator clearing two hundred batches wants one line saying what they did,
 * and two hundred lines saying it two hundred times is how an audit trail
 * stops being read. Each deleted batch id is in the payload, so nothing about
 * which batches went is lost.
 */
export async function clearHistory(
  db: Client,
  selection: ClearSelection,
  ctx: WriteContext,
  confirmation?: string,
): Promise<ClearOutcome> {
  if (selection.scope === 'everything' && confirmation !== CLEAR_EVERYTHING_CONFIRMATION) {
    // CHECKED ON THE SERVER, whatever the screen did. A confirmation enforced
    // only in the browser is a confirmation an API call does not have to make.
    return {
      scope: selection.scope,
      deleted: 0,
      rows: 0,
      landedRows: 0,
      skipped: 0,
      skippedReason: null,
      refusal: `Type ${CLEAR_EVERYTHING_CONFIRMATION} to clear the entire import history.`,
    };
  }
  if (selection.scope === 'before' && (selection.before ?? '') === '') {
    return {
      scope: selection.scope,
      deleted: 0,
      rows: 0,
      landedRows: 0,
      skipped: 0,
      skippedReason: null,
      refusal: 'Choose the date to clear before.',
    };
  }

  const preview = await previewClear(db, selection);
  const going = preview.candidates.filter((c) => !c.protectedByRecords);
  if (going.length === 0) {
    return {
      scope: selection.scope,
      deleted: 0,
      rows: 0,
      landedRows: 0,
      skipped: preview.skipped,
      skippedReason: preview.skippedReason,
      refusal: null,
    };
  }

  const statements: Stmt[] = [
    auditEventStmt({
      actorUserId: ctx.actorUserId,
      eventType: IMPORT_HISTORY_CLEARED,
      entityType: 'IMPORT_BATCH',
      // The operation spans many batches, so it belongs to none of them. The
      // scope is the subject, and every batch id is in the payload.
      entityId: `SCOPE:${selection.scope}`,
      action: 'DELETE',
      beforeJson: JSON.stringify({
        scope: selection.scope,
        before: selection.before ?? null,
        batches: going.length,
        rows: preview.rows,
        landedRows: preview.landedRows,
        skipped: preview.skipped,
        batchIds: going.map((c) => c.batchId),
      }),
      afterJson: null,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      now: ctx.now,
    }) as Stmt,
  ];
  for (let start = 0; start < going.length; start += DELETE_CHUNK) {
    const chunk = going.slice(start, start + DELETE_CHUNK);
    statements.push({
      sql: `DELETE FROM import_batches WHERE import_batch_id IN (${chunk
        .map(() => '?')
        .join(',')})`,
      args: chunk.map((c) => c.batchId),
    });
  }
  await db.batch(statements, 'write');

  return {
    scope: selection.scope,
    deleted: going.length,
    rows: preview.rows,
    landedRows: preview.landedRows,
    skipped: preview.skipped,
    skippedReason: preview.skippedReason,
    refusal: null,
  };
}
