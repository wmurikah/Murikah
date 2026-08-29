/**
 * Build Prompt 37: the upload centre's controls.
 *
 * WHAT THESE PROVE. A batch that fails is no longer a dead end reachable only
 * through somebody writing SQL for a console. It can be retried, deleted and
 * cleared, and every one of those is safe to press because the database is
 * asked what is really there before anything is written.
 *
 * Criteria 1, 3, 4, 8 and 13 of the phase are each a named test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createTestDb, type TestClient } from './support/db.ts';
import { seedHass, SEED } from './support/hassSeed.ts';
import { validateSoWorkbook, commitSoBatch } from '../../src/lib/cms/import/soImport.ts';
import { commitBatch } from '../../src/lib/cms/import/uploadCentre.ts';
import { previewRetry, retryImport, SKIPPED_MESSAGE } from '../../src/lib/cms/import/retry.ts';
import {
  planBatchDeletion,
  deleteBatch,
  previewClear,
  clearHistory,
  CLEAR_EVERYTHING_CONFIRMATION,
  IMPORT_BATCH_DELETED,
  IMPORT_HISTORY_CLEARED,
} from '../../src/lib/cms/import/batchAdmin.ts';
import { importProgress, dominantAction } from '../../src/lib/cms/import/progress.ts';
import { listBatches, exceptionQueues } from '../../src/lib/cms/import/uploadCentre.ts';
import { countRoundTrips, SUBREQUEST_BUDGET } from './support/subrequestBudget.ts';
import {
  resetCaseEventHandlers,
  resetLeadEventHandlers,
  resetSlaWiring,
} from '../../src/lib/cms/service/events.ts';

const here = dirname(fileURLToPath(import.meta.url));
const SO_FILE = readFileSync(join(here, 'support', 'SO-Ver1.xls'));
const CTX = {
  actorUserId: SEED.admin,
  ip: '10.0.0.10',
  userAgent: 'HassCMS Test',
  now: new Date('2026-08-27T10:00:00Z'),
} as const;
const UPLOAD = { filename: 'SO-Ver1.xls', uploadedBy: SEED.admin, sourceSystemId: 'SRC-EXCEL' };

const db = async (): Promise<TestClient> => {
  const c = createTestDb();
  await seedHass(c);
  resetCaseEventHandlers();
  resetLeadEventHandlers();
  resetSlaWiring();
  return c;
};
const asClient = (c: TestClient) => c as unknown as Parameters<typeof validateSoWorkbook>[0];
const count = async (c: TestClient, sql: string, args: unknown[] = []): Promise<number> =>
  Number(((await c.execute({ sql, args })).rows[0] as Record<string, unknown>)?.n ?? 0);
const totals = async (c: TestClient) => ({
  orders: await count(c, 'SELECT COUNT(*) AS n FROM sales_orders'),
  lines: await count(c, 'SELECT COUNT(*) AS n FROM sales_order_lines'),
  accounts: await count(c, 'SELECT COUNT(*) AS n FROM accounts'),
  products: await count(c, 'SELECT COUNT(*) AS n FROM products'),
  snapshots: await count(c, 'SELECT COUNT(*) AS n FROM record_snapshots'),
});

/** Import the real file, then put three documents back into a failed state. */
async function partialBatch(c: TestClient): Promise<string> {
  const validation = await validateSoWorkbook(asClient(c), SO_FILE, UPLOAD, CTX);
  const batchId = validation.batchId ?? '';
  await commitSoBatch(asClient(c), batchId, CTX);
  // Exactly the state a failed commit leaves: the document absent, its rows
  // REJECTED with a write-failure reason, its stamps cleared.
  await c.execute(`DELETE FROM sales_orders WHERE document_number IN ('4022','4057','4069')`);
  await c.execute({
    sql: `UPDATE import_rows SET row_status = 'REJECTED', imported_at = NULL, entity_id = NULL,
            error_message = 'The document could not be written: UNIQUE(...) on sales_order_lines.'
          WHERE import_batch_id = ?
            AND (source_record_key LIKE 'AFF-KE|4022|%'
              OR source_record_key LIKE 'AFF-KE|4057|%'
              OR source_record_key LIKE 'AFF-KE|4069|%')`,
    args: [batchId],
  });
  await c.execute({
    sql: `UPDATE import_batches SET status = 'PARTIAL' WHERE import_batch_id = ?`,
    args: [batchId],
  });
  return batchId;
}

// ---------------------------------------------------------------------------
// Criterion 1: a PARTIAL batch retries from the screen and reaches a terminal state.
// ---------------------------------------------------------------------------

test('criterion 1: a PARTIAL batch retries with no file and reaches a terminal state', async () => {
  const c = await db();
  const batchId = await partialBatch(c);
  const before = await totals(c);
  assert.equal(
    await count(
      c,
      `SELECT COUNT(*) AS n FROM import_batches WHERE import_batch_id = ? AND status = 'PARTIAL'`,
      [batchId],
    ),
    1,
  );

  // Criterion 2, in the same run: the three figures, before anything is written.
  const preview = await previewRetry(asClient(c), batchId);
  assert.equal(preview?.alreadyImported, 659);
  assert.equal(preview?.willImport, 3);
  assert.equal(preview?.blocked, 0);
  assert.deepEqual(await totals(c), before, 'the preview writes nothing');

  const outcome = await retryImport(asClient(c), batchId, CTX, commitBatch as never);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.previousStatus, 'PARTIAL');
  assert.equal(outcome.newStatus, 'IMPORTED', 'a terminal state');
  // THREE, NOT 662. The 659 already there are left alone rather than rewritten,
  // which is the whole promise of the control.
  assert.equal(outcome.documentsImported, 3);

  const after = await totals(c);
  assert.equal(after.orders, before.orders + 3);
  assert.equal(after.accounts, before.accounts, 'no reference record is created again');
  assert.equal(after.products, before.products);
  c.close();
});

// ---------------------------------------------------------------------------
// Criteria 3 and 4: pressing retry on an imported batch, and pressing it twice.
// ---------------------------------------------------------------------------

test('criterion 3: retrying a fully imported batch changes nothing and says so', async () => {
  const c = await db();
  const validation = await validateSoWorkbook(asClient(c), SO_FILE, UPLOAD, CTX);
  await commitSoBatch(asClient(c), validation.batchId ?? '', CTX);
  const before = await totals(c);

  const preview = await previewRetry(asClient(c), validation.batchId ?? '');
  assert.match(preview?.refusal ?? '', /already been imported/);

  const outcome = await retryImport(
    asClient(c),
    validation.batchId ?? '',
    CTX,
    commitBatch as never,
  );
  assert.equal(outcome.nothingChanged, true);
  assert.match(outcome.message, /already been imported/);
  assert.deepEqual(
    await totals(c),
    before,
    'not one order, line, account, product or snapshot moved',
  );
  c.close();
});

test('criterion 4: pressing retry twice creates no duplicate order, line, account or product', async () => {
  const c = await db();
  const batchId = await partialBatch(c);
  await retryImport(asClient(c), batchId, CTX, commitBatch as never);
  const afterFirst = await totals(c);

  const second = await retryImport(asClient(c), batchId, CTX, commitBatch as never);
  assert.equal(second.nothingChanged, true, 'the second press is honest about doing nothing');
  assert.deepEqual(await totals(c), afterFirst, 'nothing is created twice');
  assert.equal(
    await count(
      c,
      `SELECT COUNT(*) AS n FROM (SELECT sales_order_id, line_number FROM sales_order_lines
         GROUP BY sales_order_id, line_number HAVING COUNT(*) > 1)`,
    ),
    0,
  );
  c.close();
});

// ---------------------------------------------------------------------------
// Criterion 5: a skipped row is distinguishable from a rejected one.
// ---------------------------------------------------------------------------

test('criterion 5: a row skipped as already imported is not a row that was rejected', async () => {
  const c = await db();
  const batchId = await partialBatch(c);
  // Somebody else writes one of the three documents in between — the case
  // where a document is canonical but THIS batch never stamped its rows.
  const account = String(
    (
      await c.execute(
        `SELECT account_id FROM accounts WHERE oracle_customer_code IS NOT NULL LIMIT 1`,
      )
    ).rows[0]?.account_id,
  );
  await c.execute({
    sql: `INSERT INTO sales_orders (sales_order_id, document_number, affiliate_id, account_id,
            order_created_at, finance_approval_required, credit_approval_required, status, created_at)
          VALUES ('SO-ELSEWHERE', '4022', 'AFF-KE', ?, '2026-05-01 00:00:00', 1, 0, 'READY',
                  '2026-05-01 00:00:00')`,
    args: [account],
  });

  await retryImport(asClient(c), batchId, CTX, commitBatch as never);

  const skipped = await count(
    c,
    `SELECT COUNT(*) AS n FROM import_rows
      WHERE import_batch_id = ? AND row_status = 'DUPLICATE' AND error_message = ?`,
    [batchId, SKIPPED_MESSAGE],
  );
  assert.ok(skipped > 0, 'the rows of the document somebody else wrote are marked skipped');

  // And a rejected row is a different thing, by status and by message.
  const rejected = await count(
    c,
    `SELECT COUNT(*) AS n FROM import_rows WHERE import_batch_id = ? AND row_status = 'REJECTED'`,
    [batchId],
  );
  assert.equal(
    await count(
      c,
      `SELECT COUNT(*) AS n FROM import_rows
        WHERE import_batch_id = ? AND row_status = 'REJECTED' AND error_message = ?`,
      [batchId, SKIPPED_MESSAGE],
    ),
    0,
    'no row is both skipped and rejected',
  );
  void rejected;
  c.close();
});

// ---------------------------------------------------------------------------
// Criterion 8: a batch that wrote records is refused, with the reason.
// ---------------------------------------------------------------------------

test('criterion 8: a batch that wrote canonical records cannot be deleted, and says why', async () => {
  const c = await db();
  const validation = await validateSoWorkbook(asClient(c), SO_FILE, UPLOAD, CTX);
  const batchId = validation.batchId ?? '';
  await commitSoBatch(asClient(c), batchId, CTX);

  const plan = await planBatchDeletion(asClient(c), batchId);
  assert.equal(plan?.permitted, false);
  assert.match(plan?.refusal ?? '', /cannot be deleted/);
  assert.match(plan?.refusal ?? '', /662/, 'the reason names how many records');
  assert.equal(plan?.footprint.documentsImported, 662);

  const outcome = await deleteBatch(asClient(c), batchId, CTX);
  assert.equal(outcome.ok, false);
  assert.equal(
    await count(c, `SELECT COUNT(*) AS n FROM import_batches WHERE import_batch_id = ?`, [batchId]),
    1,
    'the batch is still there',
  );
  c.close();
});

test('criteria 7, 10 and 11: a rejected batch deletes, audit_events only grows, and the deletion is recorded', async () => {
  const c = await db();
  await c.execute({
    sql: `INSERT INTO import_batches (import_batch_id, source_system_id, import_type,
            original_filename, file_sha256, uploaded_by_user_id, uploaded_at, rows_received, status)
          VALUES ('IMP-DEAD','SRC-EXCEL','SALES_ORDER','dead.xls','deadhash',?,'2026-08-01 00:00:00',5,'REJECTED')`,
    args: [SEED.admin],
  });
  await c.execute(
    `INSERT INTO import_rows (import_row_id, import_batch_id, source_row_number, row_hash,
       row_status, raw_json) VALUES ('IROW-D1','IMP-DEAD',1,'h','REJECTED','{}')`,
  );
  const auditBefore = await count(c, 'SELECT COUNT(*) AS n FROM audit_events');
  const snapshotsBefore = await count(c, 'SELECT COUNT(*) AS n FROM record_snapshots');

  const plan = await planBatchDeletion(asClient(c), 'IMP-DEAD');
  assert.equal(plan?.permitted, true);
  assert.equal(plan?.contents.rows, 1);

  const outcome = await deleteBatch(asClient(c), 'IMP-DEAD', CTX);
  assert.equal(outcome.ok, true);
  assert.equal(
    await count(c, `SELECT COUNT(*) AS n FROM import_rows WHERE import_batch_id = 'IMP-DEAD'`),
    0,
    'the rows cascaded',
  );

  // Criterion 10. audit_events is append-only at the database level
  // (trg_audit_events_no_delete) AND has no foreign key a cascade could reach
  // it through. Two independent guarantees, and this asserts the outcome.
  const auditAfter = await count(c, 'SELECT COUNT(*) AS n FROM audit_events');
  assert.equal(auditAfter, auditBefore + 1, 'audit_events only ever grows');
  assert.equal(
    await count(c, 'SELECT COUNT(*) AS n FROM record_snapshots'),
    snapshotsBefore,
    'record_snapshots is ON DELETE SET NULL, so nothing of it is lost',
  );

  // Criterion 11.
  const recorded = await c.execute({
    sql: `SELECT entity_id, action, before_json FROM audit_events WHERE event_type = ?`,
    args: [IMPORT_BATCH_DELETED],
  });
  assert.equal(recorded.rows.length, 1);
  const payload = JSON.parse(String(recorded.rows[0]?.before_json)) as Record<string, unknown>;
  assert.equal(recorded.rows[0]?.entity_id, 'IMP-DEAD');
  assert.equal(payload.status, 'REJECTED', 'the status at deletion');
  assert.equal(payload.rows, 1, 'and the counts');
  c.close();
});

// ---------------------------------------------------------------------------
// Criterion 13: clear history skips a batch with records, and says how many.
// ---------------------------------------------------------------------------

test('criterion 13: clearing history skips a batch that wrote records, and says how many and why', async () => {
  const c = await db();
  // One batch that imported, one that never wrote anything.
  const validation = await validateSoWorkbook(asClient(c), SO_FILE, UPLOAD, CTX);
  await commitSoBatch(asClient(c), validation.batchId ?? '', CTX);
  await c.execute({
    sql: `INSERT INTO import_batches (import_batch_id, source_system_id, import_type,
            original_filename, file_sha256, uploaded_by_user_id, uploaded_at, rows_received, status)
          VALUES ('IMP-JUNK','SRC-EXCEL','SALES_ORDER','junk.xls','junkhash',?,'2026-07-01 00:00:00',3,'REJECTED')`,
    args: [SEED.admin],
  });

  // The seed carries batches of its own, so every assertion below is about
  // the two this test created rather than about the size of the history.
  const preview = await previewClear(asClient(c), { scope: 'everything' });
  const imported = preview.candidates.find((b) => b.batchId === validation.batchId);
  const junk = preview.candidates.find((b) => b.batchId === 'IMP-JUNK');
  assert.equal(imported?.protectedByRecords, true, 'the batch that imported is protected');
  assert.equal(junk?.protectedByRecords, false, 'the batch that wrote nothing is not');
  assert.equal(preview.skipped >= 1, true);
  assert.match(preview.skippedReason ?? '', /wrote records/);

  const outcome = await clearHistory(
    asClient(c),
    { scope: 'everything' },
    CTX,
    CLEAR_EVERYTHING_CONFIRMATION,
  );
  assert.equal(outcome.deleted >= 1, true);
  assert.equal(outcome.skipped >= 1, true);
  assert.match(outcome.skippedReason ?? '', /wrote records/);
  assert.equal(
    await count(c, `SELECT COUNT(*) AS n FROM import_batches WHERE import_batch_id = ?`, [
      validation.batchId,
    ]),
    1,
    'the imported batch was skipped, not deleted',
  );
  assert.equal(
    await count(c, `SELECT COUNT(*) AS n FROM import_batches WHERE import_batch_id = 'IMP-JUNK'`),
    0,
  );

  // Criterion 15: one audit row for the operation, not one per batch.
  assert.equal(
    await count(c, `SELECT COUNT(*) AS n FROM audit_events WHERE event_type = ?`, [
      IMPORT_HISTORY_CLEARED,
    ]),
    1,
  );
  c.close();
});

test('criteria 12 and 14: the four scopes select what they say, and Everything needs the typed phrase', async () => {
  const c = await db();
  const insert = (id: string, status: string, at: string) =>
    c.execute({
      sql: `INSERT INTO import_batches (import_batch_id, source_system_id, import_type,
              original_filename, file_sha256, uploaded_by_user_id, uploaded_at, rows_received, status)
            VALUES (?, 'SRC-EXCEL','SALES_ORDER', ?, ?, ?, ?, 1, ?)`,
      args: [id, `${id}.xls`, `hash-${id}`, SEED.admin, at, status],
    });
  await insert('TST-REJ', 'REJECTED', '2026-01-01 00:00:00');
  await insert('TST-VAL', 'VALIDATING', '2026-02-01 00:00:00');
  await insert('TST-RDY', 'READY', '2026-09-01 00:00:00');

  // Scoped to the three this test created: the seed carries batches too, and
  // a scope assertion about the size of the history would be about the seed.
  const mine = (ids: string[]) => ids.filter((id) => id.startsWith('IMP-')).sort();
  const failed = await previewClear(asClient(c), { scope: 'failed' });
  const failedIds = failed.candidates.map((b) => b.batchId);
  assert.ok(failedIds.includes('TST-REJ'), 'REJECTED is failed');
  assert.ok(failedIds.includes('TST-VAL'), 'VALIDATING is failed too: nothing resumes it');
  assert.equal(failedIds.includes('TST-RDY'), false, 'READY is not failed');
  void mine;

  const before = await previewClear(asClient(c), { scope: 'before', before: '2026-06-01' });
  const beforeIds = before.candidates.map((b) => b.batchId);
  assert.ok(beforeIds.includes('TST-REJ') && beforeIds.includes('TST-VAL'));
  assert.equal(beforeIds.includes('TST-RDY'), false, 'September is not before June');

  const none = await previewClear(asClient(c), { scope: 'no-records' });
  const noneIds = none.candidates.map((b) => b.batchId);
  for (const id of ['TST-REJ', 'TST-VAL', 'TST-RDY']) assert.ok(noneIds.includes(id));
  assert.equal(none.skipped, 0, 'the scope is the protection rule, so nothing in it is skipped');

  const all = await previewClear(asClient(c), { scope: 'everything' });
  const allIds = all.candidates.map((b) => b.batchId);
  for (const id of ['TST-REJ', 'TST-VAL', 'TST-RDY']) assert.ok(allIds.includes(id));

  // Criterion 14, checked on the SERVER: a confirmation enforced only in a
  // browser is one an API call does not have to make.
  const refused = await clearHistory(asClient(c), { scope: 'everything' }, CTX, 'DELETE');
  assert.match(refused.refusal ?? '', /DELETE ALL HISTORY/);
  assert.equal(refused.deleted, 0);
  assert.equal(
    await count(c, `SELECT COUNT(*) AS n FROM import_batches WHERE import_batch_id LIKE 'TST-%'`),
    3,
    'nothing went without the phrase',
  );

  const done = await clearHistory(
    asClient(c),
    { scope: 'everything' },
    CTX,
    CLEAR_EVERYTHING_CONFIRMATION,
  );
  assert.equal(done.deleted >= 3, true);
  assert.equal(
    await count(c, `SELECT COUNT(*) AS n FROM import_batches WHERE import_batch_id LIKE 'TST-%'`),
    0,
    'and all three went with it',
  );
  c.close();
});

// ---------------------------------------------------------------------------
// Criteria 17 to 21: progress is real, and every state has one action.
// ---------------------------------------------------------------------------

test('criterion 17: the progress percentage comes from real counts, or is absent', async () => {
  const c = await db();
  const validation = await validateSoWorkbook(asClient(c), SO_FILE, UPLOAD, CTX);
  const batchId = validation.batchId ?? '';

  // READY: validation finished. The denominator is rows_received, written when
  // the batch was created, before a single row was read.
  const ready = await importProgress(asClient(c), batchId);
  assert.equal(ready?.phase, 'ready');
  assert.equal(ready?.total, 1386);
  assert.equal(ready?.percent, 100);
  assert.equal(ready?.running, false);

  // VALIDATING with nothing landed is the workbook still being read, and that
  // stretch writes nothing at all. No percentage is offered, and the sentence
  // says why rather than a bar sitting at zero pretending to measure.
  await c.execute({
    sql: `UPDATE import_batches SET status = 'VALIDATING' WHERE import_batch_id = ?`,
    args: [batchId],
  });
  await c.execute({ sql: `DELETE FROM import_rows WHERE import_batch_id = ?`, args: [batchId] });
  const reading = await importProgress(asClient(c), batchId);
  assert.equal(reading?.phase, 'reading');
  assert.equal(reading?.percent, null, 'no invented percentage');
  assert.equal(reading?.done, null);
  assert.match(reading?.sentence ?? '', /reports no percentage/);
  assert.equal(reading?.running, true);

  // AND THE STRETCH THAT CAN BE COUNTED. Validation flushes its rows in
  // chunks, so once the flush is under way the count is real and rises: the
  // numerator is rows landed and the denominator is rows_received, which was
  // written when the batch was created, before a single row was read.
  await c.execute({
    sql: `INSERT INTO import_rows (import_row_id, import_batch_id, source_row_number, row_hash,
            row_status, raw_json)
          SELECT 'IROW-P' || value, ?, value, 'h', 'NEW', '{}'
            FROM (WITH RECURSIVE n(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM n
                  WHERE value < 840) SELECT value FROM n)`,
    args: [batchId],
  });
  const midway = await importProgress(asClient(c), batchId);
  assert.equal(midway?.phase, 'validating');
  assert.equal(midway?.done, 840, 'the numerator is rows actually landed');
  assert.equal(midway?.total, 1386, 'the denominator is rows_received, known from the start');
  assert.equal(midway?.unit, 'rows');
  assert.equal(midway?.percent, 61, '840 of 1,386, and the arithmetic is the source');
  c.close();
});

test('criterion 20: every one of the five states has one dominant action and a sentence', () => {
  const states = ['VALIDATING', 'READY', 'PARTIAL', 'REJECTED', 'IMPORTED'];
  const seen = new Map<string, string>();
  for (const status of states) {
    const action = dominantAction(status, 'IMP-1');
    assert.ok(action.sentence.length > 20, `${status} must say what it means`);
    assert.ok(
      action.label !== null,
      `${status} must offer one action, or be absent rather than dead`,
    );
    seen.set(status, action.label ?? '');
  }
  assert.equal(seen.get('READY'), 'Import valid records');
  assert.equal(seen.get('PARTIAL'), 'Retry the import');
  assert.equal(seen.get('IMPORTED'), 'Open the records');

  // Criterion 21: the retry actions are unavailable on IMPORTED and say why,
  // rather than being present and dead.
  const imported = dominantAction('IMPORTED', 'IMP-1');
  assert.notEqual(imported.retryUnavailable, null);
  assert.match(imported.retryUnavailable ?? '', /fully imported/);
  assert.equal(imported.action, null, 'no endpoint-calling action is offered');
  assert.notEqual(imported.href, null, 'the action is to open the records');
});

// ---------------------------------------------------------------------------
// Criterion 25: every page this phase touches stays inside its budget.
// ---------------------------------------------------------------------------

test('criterion 25: the upload, batch and history pages stay inside the subrequest budget', async () => {
  const c = await db();
  const validation = await validateSoWorkbook(asClient(c), SO_FILE, UPLOAD, CTX);
  const batchId = validation.batchId ?? '';

  /** Everything the history list asks for. */
  const history = countRoundTrips(c);
  await listBatches(history.db as never);
  console.log(`[subrequests] /app/data/history: ${history.roundTrips()} round trips`);
  assert.ok(history.roundTrips() <= SUBREQUEST_BUDGET);

  /**
   * Everything the batch page asks for, INCLUDING what this phase added: the
   * progress query and the delete plan. The retry figures are fetched by the
   * island afterwards rather than on the render, which is what keeps this
   * page inside the budget while still showing the operator the numbers.
   */
  const batch = countRoundTrips(c);
  await listBatches(batch.db as never, 200);
  await importProgress(batch.db as never, batchId);
  await planBatchDeletion(batch.db as never, batchId);
  await exceptionQueues(batch.db as never, batchId);
  await batch.db.execute({
    sql: `SELECT import_row_id FROM import_rows WHERE import_batch_id = ? LIMIT 200`,
    args: [batchId],
  });
  await batch.db.execute({
    sql: `SELECT event_type FROM audit_events WHERE entity_id = ? LIMIT 50`,
    args: [batchId],
  });
  console.log(`[subrequests] /app/data/history/[batchId]: ${batch.roundTrips()} round trips`);
  assert.ok(
    batch.roundTrips() <= SUBREQUEST_BUDGET,
    `the batch page costs ${batch.roundTrips()} subrequests, over the budget of ` +
      `${SUBREQUEST_BUDGET}. The progress query and the delete plan are one round trip each ` +
      `by design; anything per-document would not fit.`,
  );

  // And the retry preview, which the island fetches on its own request.
  const preview = countRoundTrips(c);
  await previewRetry(preview.db as never, batchId);
  console.log(`[subrequests] retry preview: ${preview.roundTrips()} round trips`);
  assert.ok(preview.roundTrips() <= SUBREQUEST_BUDGET);
  c.close();
});
