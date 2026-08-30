/**
 * What a run is doing, read from the database rather than held in a browser.
 *
 * WHY IT IS READ FROM THE SERVER. An operator who reloads mid-run must see the
 * same state, and a percentage kept in a page's memory dies with the page. So
 * progress is a query, the page renders it server-side on every load, and the
 * optional island polls the same query. There is one source of truth and the
 * refresh test is what proves it.
 *
 * WHAT IS ACTUALLY OBSERVABLE, MEASURED RATHER THAN WISHED FOR.
 *
 * This is the part that decides what may honestly be shown, and it is not what
 * a progress bar wants to hear. Reading the importers:
 *
 *   Uploading            The browser can measure a file transfer itself, and
 *                        it is the only phase the browser can measure. Real.
 *   Reading the workbook `parseWorkbook` reads the whole file, then every row
 *                        is normalised and hashed, and NOT ONE WRITE HAPPENS
 *                        during any of it. A query during this phase sees a
 *                        batch at VALIDATING with zero rows. There is nothing
 *                        to count, so nothing is counted: the phase is named
 *                        and no percentage is offered.
 *   Validating           The rows are flushed in chunks of 200 at the end of
 *                        validation (`soImport.ts`, the loop over `statements`),
 *                        so `COUNT(*) FROM import_rows` DOES rise while the
 *                        flush runs — 200 at a time — and `rows_received` was
 *                        written when the batch was created, before a single
 *                        row was read. Numerator and denominator are both real.
 *                        It is coarse: for 1,386 rows it steps in fourteenths.
 *   Importing            `commitSoBatch` stamps `imported_at` on each document's
 *                        rows inside that document's own write batch, and the
 *                        batches are flushed as the run proceeds. Counting
 *                        distinct stamped documents against the documents the
 *                        batch holds is real, and steps per write chunk.
 *
 * SO THE BAR IS ABSENT FOR ONE PHASE, DELIBERATELY. "Where a run cannot report
 * progress, say so plainly rather than showing a bar that does not move" is
 * the rule, and reading the workbook is that phase. Animating something there
 * would be inventing a number, which is worse than a spinner because it lies
 * with more confidence.
 *
 * ONE QUERY. This is polled, so it is one statement with subqueries rather
 * than four statements — a poll that cost four round trips every two seconds
 * would be the most expensive thing in the product.
 */
import type { Client } from '@libsql/client/web';

const text = (v: unknown): string => String(v ?? '');
const num = (v: unknown): number => Number(v ?? 0);

export type ImportPhase =
  | 'reading'
  | 'validating'
  | 'ready'
  | 'importing'
  | 'complete'
  | 'partial'
  | 'rejected';

export interface ImportProgress {
  readonly batchId: string;
  readonly phase: ImportPhase;
  /** The phase, as a person reads it. */
  readonly label: string;
  /** What happened, in a sentence somebody can act on. */
  readonly sentence: string;
  /**
   * The numerator and denominator, or null where the phase genuinely cannot
   * report one. NEVER a fabricated pair to keep a bar moving.
   */
  readonly done: number | null;
  readonly total: number | null;
  /** The unit being counted, for "840 of 1,386 rows". */
  readonly unit: 'rows' | 'documents' | null;
  /** 0-100, or null where there is nothing real to compute it from. */
  readonly percent: number | null;
  /** True while the run is still going, so a poller knows when to stop. */
  readonly running: boolean;
}

/**
 * The phase and the counts for one batch, in one round trip.
 *
 * `rows_received` is the denominator for validation and is written when the
 * batch row is created, before any row is read, so it is known from the first
 * moment there is anything to ask about.
 */
export async function importProgress(db: Client, batchId: string): Promise<ImportProgress | null> {
  const found = await db.execute({
    sql: `SELECT b.status AS status, b.rows_received AS rows_received,
            b.import_type AS import_type,
            (SELECT COUNT(*) FROM import_rows r WHERE r.import_batch_id = b.import_batch_id)
              AS rows_landed,
            (SELECT COUNT(DISTINCT r.entity_id) FROM import_rows r
              WHERE r.import_batch_id = b.import_batch_id AND r.imported_at IS NOT NULL
                AND r.entity_id IS NOT NULL) AS documents_done,
            -- The documents this batch holds, from the count validation itself
            -- recorded. Re-deriving it from the keys would count LINES for a
            -- sales order, whose key is affiliate|document|line.
            (SELECT CAST(json_extract(ae.after_json, '$.uniqueDocuments') AS INTEGER)
               FROM audit_events ae
              WHERE ae.entity_type = 'IMPORT_BATCH' AND ae.entity_id = b.import_batch_id
                AND ae.event_type = 'IMPORT_VALIDATED'
              ORDER BY ae.event_at DESC LIMIT 1) AS documents_total
          FROM import_batches b WHERE b.import_batch_id = ? LIMIT 1`,
    args: [batchId],
  });
  const row = found.rows[0] as Record<string, unknown> | undefined;
  if (row === undefined) return null;

  const status = text(row.status);
  const rowsReceived = num(row.rows_received);
  const rowsLanded = num(row.rows_landed);
  const documentsDone = num(row.documents_done);
  const documentsTotal =
    row.documents_total === null || row.documents_total === undefined
      ? null
      : num(row.documents_total);

  const percentOf = (done: number, total: number | null): number | null =>
    total === null || total <= 0 ? null : Math.min(100, Math.round((done / total) * 100));

  if (status === 'VALIDATING') {
    // NOTHING HAS LANDED YET means the workbook is still being read, and that
    // stretch writes nothing at all. Say which phase it is and offer no
    // number, rather than a bar sitting at zero pretending to measure.
    if (rowsLanded === 0) {
      return {
        batchId,
        phase: 'reading',
        label: 'Reading the workbook',
        sentence:
          'Reading and checking the file. This step reports no percentage: nothing is written ' +
          'until the whole workbook has been read, so there is nothing to count yet.',
        done: null,
        total: rowsReceived > 0 ? rowsReceived : null,
        unit: null,
        percent: null,
        running: true,
      };
    }
    return {
      batchId,
      phase: 'validating',
      label: 'Validating',
      sentence: `Checking ${rowsReceived} rows against the customers, products and people this system knows.`,
      done: rowsLanded,
      total: rowsReceived,
      unit: 'rows',
      percent: percentOf(rowsLanded, rowsReceived),
      running: true,
    };
  }

  if (status === 'READY') {
    return {
      batchId,
      phase: 'ready',
      label: 'Ready',
      sentence: `Validation complete. ${rowsReceived} rows are ready to import; nothing has been written yet.`,
      done: rowsReceived,
      total: rowsReceived,
      unit: 'rows',
      percent: 100,
      running: false,
    };
  }

  if (status === 'IMPORTED') {
    return {
      batchId,
      phase: 'complete',
      label: 'Complete',
      sentence: `Imported. ${documentsTotal ?? documentsDone} documents were written.`,
      done: documentsDone,
      total: documentsTotal ?? documentsDone,
      unit: 'documents',
      percent: 100,
      running: false,
    };
  }

  if (status === 'PARTIAL') {
    const short = documentsTotal === null ? null : documentsTotal - documentsDone;
    return {
      batchId,
      phase: 'partial',
      label: 'Partly imported',
      sentence:
        short === null
          ? `${documentsDone} documents imported; some could not be written. Retry the import.`
          : `${documentsDone} of ${documentsTotal} documents imported. ${short} could not be ` +
            `written. Retry the import; the ones already in will be left alone.`,
      done: documentsDone,
      total: documentsTotal,
      unit: 'documents',
      percent: percentOf(documentsDone, documentsTotal),
      running: false,
    };
  }

  return {
    batchId,
    phase: 'rejected',
    label: 'Rejected',
    sentence:
      'This batch was refused and nothing was written. Open it to see the reason on the rows.',
    done: null,
    total: null,
    unit: null,
    percent: null,
    running: false,
  };
}

/**
 * The dominant action for a batch, and the sentence beside it.
 *
 * ONE ACTION PER STATE. The batch page leads with this rather than with the
 * overview table, because an operator arriving at a failed batch under mild
 * pressure once a month needs to be told what to do, not shown a table and
 * left to work it out.
 *
 * NO DEAD CONTROLS. Where an action cannot run, it is absent and its reason is
 * the sentence — never a greyed-out button with nothing to explain it.
 */
export interface BatchAction {
  /** What the button says. Null when there is nothing to press. */
  readonly label: string | null;
  /** Where it goes, for an action that is a link rather than a call. */
  readonly href: string | null;
  /** The id the client script binds to, for an action that calls an endpoint. */
  readonly action: 'commit' | 'retry' | 'revalidate' | null;
  /** What happened and what to do, in one sentence. */
  readonly sentence: string;
  /** Why the retry actions are unavailable, where they are. */
  readonly retryUnavailable: string | null;
}

export function dominantAction(status: string, batchId: string): BatchAction {
  switch (status) {
    case 'READY':
      return {
        label: 'Import valid records',
        href: null,
        action: 'commit',
        sentence:
          'Validated and ready. Nothing has been written yet; importing is a separate, deliberate step.',
        retryUnavailable: 'There is nothing to retry: this batch has not been imported yet.',
      };
    case 'PARTIAL':
      return {
        label: 'Retry the import',
        href: null,
        action: 'retry',
        sentence:
          'Some documents imported and some could not be written. Retrying writes only the ones ' +
          'that are missing; everything already imported is left alone.',
        retryUnavailable: null,
      };
    case 'REJECTED':
      return {
        label: 'Revalidate',
        href: null,
        action: 'revalidate',
        sentence:
          'This batch was refused and nothing was written. Revalidate it once the customer, ' +
          'product or person it was waiting on has been resolved, then import it.',
        retryUnavailable: null,
      };
    case 'VALIDATING':
      return {
        label: 'Revalidate',
        href: null,
        action: 'revalidate',
        sentence:
          'This batch never finished validating, so nothing is waiting to be imported. Nothing ' +
          'resumes it on its own: revalidate it to run the checks again.',
        retryUnavailable: 'There is nothing to retry: this batch never reached the import step.',
      };
    case 'IMPORTED':
      return {
        label: 'Open the records',
        href: `/app/orders?batch=${encodeURIComponent(batchId)}`,
        action: null,
        sentence: 'Imported. Every document in this batch is in the system.',
        retryUnavailable:
          'There is nothing to retry: this batch is fully imported. Retrying would not know what ' +
          'to do with the records it created, so it is not offered.',
      };
    default:
      return {
        label: null,
        href: null,
        action: null,
        sentence: `This batch is at ${status}.`,
        retryUnavailable: null,
      };
  }
}
