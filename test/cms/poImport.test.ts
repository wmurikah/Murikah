/**
 * Phase 18: the purchase order importer, against the real PO-Ver1.xls.
 *
 * The extract shipped with the repository is the fixture, so every measured
 * fact the build was designed around is re-verified on each run: 45 rows, 45
 * orders, 29 headers, four approval levels used and three unused, three
 * NATURE values, and approver names in a form the users table does not hold.
 *
 * The synthetic workbooks alongside it exist for one reason: to prove that
 * nothing is written for four levels. A seven-level row makes seven stages
 * and a three-level row makes three, with no empty stage in either.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as XLSX from 'xlsx';
import { createTestDb, type TestClient } from './support/db.ts';
import { seedHass, SEED } from './support/hassSeed.ts';
import { minutesBetween, parseWorkbook } from '../../src/lib/cms/import/workbook.ts';
import {
  validatePoWorkbook,
  commitPoBatch,
  verifyPoSourceCompleteness,
  derivePoStatus,
  normalisePoRow,
  stageDurations,
  poDurations,
  readApprovals,
  PO_HEADER_CLASSIFICATION,
  MAX_APPROVAL_LEVELS,
} from '../../src/lib/cms/import/poImport.ts';
import {
  resetCaseEventHandlers,
  resetLeadEventHandlers,
  resetSlaWiring,
} from '../../src/lib/cms/service/events.ts';

const here = dirname(fileURLToPath(import.meta.url));
const PO_FILE = readFileSync(join(here, 'support', 'PO-Ver1.xls'));

const NOW = new Date('2026-08-27T10:00:00Z');
const CTX = {
  actorUserId: SEED.admin,
  ip: '10.0.0.10',
  userAgent: 'HassCMS Test',
  now: NOW,
} as const;

const db = async (): Promise<TestClient> => {
  const c = createTestDb();
  await seedHass(c);
  resetCaseEventHandlers();
  resetLeadEventHandlers();
  resetSlaWiring();
  return c;
};
const asClient = (c: TestClient) => c as unknown as Parameters<typeof validatePoWorkbook>[0];

const upload = (overrides: Partial<Parameters<typeof validatePoWorkbook>[2]> = {}) => ({
  filename: 'PO-Ver1.xls',
  uploadedBy: 'USR-CATH',
  sourceSystemId: 'SRC-EXCEL',
  affiliateId: 'AFF-KE',
  ...overrides,
});

/** The 29 headers, in the file's own order, for building synthetic rows. */
const HEADERS = parseWorkbook(PO_FILE).headers;

/** An Excel day serial for a UTC moment, the inverse of the reader's arithmetic. */
function serial(iso: string): number {
  return new Date(iso).getTime() / 86400000 + 25569;
}

/**
 * A synthetic workbook in the real file's shape, with the levels named. Only
 * the levels listed get an approval date, which is exactly how the real file
 * leaves levels five to seven.
 */
function syntheticWorkbook(
  orders: {
    purchaseNumber: string;
    levels: number;
    approvers?: (string | null)[];
    createdAt?: string;
  }[],
): Buffer {
  const prefixes = ['FIRST', 'SECOND', 'THIRD', 'FOURTH', 'FIFTH', 'SIXTH', 'SEVENTH'];
  const rows: unknown[][] = [HEADERS];
  for (const order of orders) {
    const created = order.createdAt ?? '2026-06-01T08:00:00Z';
    const record: Record<string, unknown> = {
      'purchase Number': order.purchaseNumber,
      'Req Description': `Synthetic order ${order.purchaseNumber}`,
      NATURE: 'PRODUCT',
      ORIGINAL_CREATION_DATE: serial(created),
      SUBMISSION_FOR_APPROVAL_DATE: serial(created) + 10 / 1440,
      TIME_DIFF_RAISEPO_TOAPROVALSUBMIT: 10,
      PURCHASE_ORDER_CREATED_BY: 'HAPPINESS.MUNUHE',
      AUTHORIZATION_STATUS: 'APPROVED',
    };
    for (let level = 1; level <= order.levels; level++) {
      const prefix = prefixes[level - 1];
      record[`${prefix}_APPROVAL_DATE`] = serial(created) + (10 + level * 30) / 1440;
      record[`${prefix}_APPROVER`] =
        order.approvers?.[level - 1] ?? `Mr. Synthetic Approver ${level}`;
      record[`${prefix}_APPROVALS_VARIANCE`] = level * 30;
    }
    rows.push(HEADERS.map((h) => record[h] ?? null));
  }
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, 'Sheet 1');
  return XLSX.write(book, { bookType: 'biff8', type: 'buffer' }) as Buffer;
}

// ---------------------------------------------------------------------------

test('the source-completeness prerequisite is verified with queries, not assumed', async () => {
  const c = await db();
  const result = await verifyPoSourceCompleteness(asClient(c));
  assert.equal(result.ok, true, result.problems.join('; '));
  const byColumn = new Map(result.checked.map((x) => [x.column, x.nullable]));
  // The two facts the build instructions name explicitly.
  assert.equal(byColumn.has('purchase_orders.submitted_for_approval_at'), true);
  assert.equal(byColumn.get('purchase_orders.po_value'), true);
  assert.equal(byColumn.get('purchase_orders.supplier_name'), true);
  assert.equal(byColumn.get('purchase_orders.currency_code'), true);
});

test('the real extract reads as 45 rows, 45 orders and 29 headers', async () => {
  const sheet = parseWorkbook(PO_FILE);
  assert.equal(sheet.rows.length, 45);
  assert.equal(sheet.headers.length, 29);

  const c = await db();
  const validation = await validatePoWorkbook(asClient(c), PO_FILE, upload(), CTX);
  assert.equal(validation.rowsReceived, 45);
  assert.equal(validation.uniqueOrders, 45);
  assert.equal(validation.rowsNew, 45);
  assert.equal(validation.rowsRejected, 0);
  assert.equal(validation.missingMandatory.length, 0);
  // Three source classifications, and LPG is the largest bucket.
  assert.deepEqual(
    [...validation.natureDistribution].sort((a, b) => a.nature.localeCompare(b.nature)),
    [
      { nature: 'LPG', rows: 21 },
      { nature: 'LUBES', rows: 13 },
      { nature: 'PRODUCT', rows: 11 },
    ],
  );
});

test('every one of the 29 headers is classified in the mapping report', async () => {
  const c = await db();
  const validation = await validatePoWorkbook(asClient(c), PO_FILE, upload(), CTX);
  assert.equal(validation.report.length, 29);
  assert.equal(
    validation.report.filter((line) => line.treatment === 'unknown').length,
    0,
    'no header of the real file may be unclassified',
  );
  assert.equal(Object.keys(PO_HEADER_CLASSIFICATION).length, 8 + MAX_APPROVAL_LEVELS * 3);
  // The source metrics are named as such and never as a measure.
  const timeDiff = validation.report.find((l) => l.header === 'TIME_DIFF_RAISEPO_TOAPROVALSUBMIT');
  assert.equal(timeDiff?.treatment, 'source_metric');
  assert.equal(
    validation.report.filter((l) => l.treatment === 'source_metric').length,
    1 + MAX_APPROVAL_LEVELS,
  );
});

test('every order uses four levels, and levels five to seven are never created', async () => {
  const c = await db();
  const validation = await validatePoWorkbook(asClient(c), PO_FILE, upload(), CTX);
  assert.deepEqual(validation.approvalLevelDistribution, [
    { level: 1, orders: 0 },
    { level: 2, orders: 0 },
    { level: 3, orders: 0 },
    { level: 4, orders: 45 },
    { level: 5, orders: 0 },
    { level: 6, orders: 0 },
    { level: 7, orders: 0 },
  ]);

  const committed = await commitPoBatch(asClient(c), validation.batchId ?? '', CTX);
  assert.equal(committed.ordersCreated, 45);
  assert.equal(committed.linesWritten, 0);

  const lines = await c.execute({
    sql: `SELECT COUNT(*) AS n FROM purchase_order_lines
          WHERE purchase_order_id IN (SELECT entity_id FROM import_rows WHERE import_batch_id = ?)`,
    args: [validation.batchId],
  });
  assert.equal(
    Number(lines.rows[0]?.n),
    0,
    'the extract has no line grain, so no line is invented',
  );

  const perOrder = await c.execute({
    sql: `SELECT po.document_number AS doc, COUNT(wsi.workflow_stage_instance_id) AS stages
          FROM purchase_orders po
          JOIN workflow_instances wi ON wi.entity_type = 'PURCHASE_ORDER' AND wi.entity_id = po.purchase_order_id
          JOIN workflow_stage_instances wsi ON wsi.workflow_instance_id = wi.workflow_instance_id
          WHERE po.purchase_order_id IN (SELECT entity_id FROM import_rows WHERE import_batch_id = ?)
          GROUP BY po.document_number`,
    args: [validation.batchId],
  });
  assert.equal(perOrder.rows.length, 45);
  for (const row of perOrder.rows) {
    assert.equal(Number(row.stages), 4, `${String(row.doc)} should hold four approval stages`);
  }

  // Level four has no configured stage in the seeded three-stage definition,
  // so it is minted once with a neutral sequence code and reused after that.
  const minted = await c.execute(
    `SELECT stage_code, stage_name, sequence_no FROM workflow_stages WHERE stage_code LIKE 'PO_APPROVAL_%'`,
  );
  assert.equal(minted.rows.length, 1);
  assert.equal(String(minted.rows[0]?.stage_code), 'PO_APPROVAL_4');
  assert.equal(String(minted.rows[0]?.stage_name), 'Approval level 4');
  assert.equal(Number(minted.rows[0]?.sequence_no), 4);
  const beyond = await c.execute(
    `SELECT COUNT(*) AS n FROM workflow_stages WHERE stage_code IN ('PO_APPROVAL_5','PO_APPROVAL_6','PO_APPROVAL_7')`,
  );
  assert.equal(Number(beyond.rows[0]?.n), 0);
});

test('a seven level row makes seven stages and a three level row makes three', async () => {
  const c = await db();
  const file = syntheticWorkbook([
    { purchaseNumber: 'SYN-7', levels: 7 },
    { purchaseNumber: 'SYN-3', levels: 3 },
  ]);
  const validation = await validatePoWorkbook(
    asClient(c),
    file,
    upload({ filename: 'synthetic.xls' }),
    CTX,
  );
  assert.equal(validation.rowsReceived, 2);
  assert.equal(validation.approvalLevelDistribution.find((d) => d.level === 7)?.orders, 1);
  assert.equal(validation.approvalLevelDistribution.find((d) => d.level === 3)?.orders, 1);

  await commitPoBatch(asClient(c), validation.batchId ?? '', CTX);
  const stages = async (doc: string) =>
    (
      await c.execute({
        sql: `SELECT ws.stage_code AS code, wsi.completed_at AS done
              FROM purchase_orders po
              JOIN workflow_instances wi ON wi.entity_type = 'PURCHASE_ORDER' AND wi.entity_id = po.purchase_order_id
              JOIN workflow_stage_instances wsi ON wsi.workflow_instance_id = wi.workflow_instance_id
              JOIN workflow_stages ws ON ws.workflow_stage_id = wsi.workflow_stage_id
              WHERE po.document_number = ? ORDER BY ws.sequence_no`,
        args: [doc],
      })
    ).rows;

  const seven = await stages('SYN-7');
  assert.equal(seven.length, 7);
  const three = await stages('SYN-3');
  assert.equal(three.length, 3);
  // No empty stage: every reconstructed stage carries its completion moment.
  for (const row of [...seven, ...three]) {
    assert.notEqual(row.done, null);
  }
});

test('supplier, currency, value, receipt and posting are NULL, never zero and never borrowed', async () => {
  const c = await db();
  const validation = await validatePoWorkbook(asClient(c), PO_FILE, upload(), CTX);
  await commitPoBatch(asClient(c), validation.batchId ?? '', CTX);

  const imported = `SELECT entity_id FROM import_rows WHERE import_batch_id = ?`;
  const missing = await c.execute({
    sql: `SELECT COUNT(*) AS n FROM purchase_orders
          WHERE purchase_order_id IN (${imported})
            AND (supplier_name IS NOT NULL OR currency_code IS NOT NULL OR po_value IS NOT NULL
                 OR physical_received_at IS NOT NULL OR oracle_stock_posted_at IS NOT NULL)`,
    args: [validation.batchId],
  });
  assert.equal(Number(missing.rows[0]?.n), 0);
  const counted = await c.execute({
    sql: `SELECT COUNT(*) AS n FROM purchase_orders WHERE purchase_order_id IN (${imported})`,
    args: [validation.batchId],
  });
  assert.equal(Number(counted.rows[0]?.n), 45, 'all 45 orders were examined');

  // The final approval never becomes a posting date, which is the temptation
  // this assertion exists to refuse.
  const borrowed = await c.execute({
    sql: `SELECT COUNT(*) AS n FROM purchase_orders po
          JOIN workflow_instances wi ON wi.entity_type = 'PURCHASE_ORDER' AND wi.entity_id = po.purchase_order_id
          WHERE po.purchase_order_id IN (${imported})
            AND po.oracle_stock_posted_at IS NOT NULL
            AND po.oracle_stock_posted_at = wi.completed_at`,
    args: [validation.batchId],
  });
  assert.equal(Number(borrowed.rows[0]?.n), 0);

  const row = parseWorkbook(PO_FILE).rows[0] ?? {};
  const normalised = await normalisePoRow(row, 1, 'AFF-KE');
  const durations = poDurations(normalised);
  assert.equal(durations.submittedToPhysicalReceiptMinutes, null);
  assert.equal(durations.submittedToOraclePostingMinutes, null);
});

test('an unmapped approver becomes an unresolved actor and never a user', async () => {
  const c = await db();
  const usersBefore = await c.execute('SELECT COUNT(*) AS n FROM users');
  const validation = await validatePoWorkbook(asClient(c), PO_FILE, upload(), CTX);

  // Ten distinct source names: three creators in username form and seven
  // approvers in reversed titled display form. Neither form matches the users
  // table, which is exactly what the build instructions expect.
  assert.equal(validation.unresolvedActors.length, 10);
  const names = validation.unresolvedActors.map((a) => a.username);
  assert.ok(names.includes('MR. MUSEMBI GABRIEL MUSYOKA'));
  assert.ok(names.includes('HAPPINESS.MUNUHE'));

  const stored = await c.execute({
    sql: `SELECT external_username, status, affiliate_id FROM unresolved_actors WHERE import_batch_id = ?`,
    args: [validation.batchId],
  });
  assert.equal(stored.rows.length, 10);
  assert.equal(String(stored.rows[0]?.status), 'OPEN');
  assert.equal(String(stored.rows[0]?.affiliate_id), 'AFF-KE');

  const usersAfter = await c.execute('SELECT COUNT(*) AS n FROM users');
  assert.equal(Number(usersAfter.rows[0]?.n), Number(usersBefore.rows[0]?.n));

  // Once mapped, the same name lands on its stage rather than staying blank.
  await c.execute(`INSERT INTO source_identities (source_identity_id, source_system_id, user_id,
      external_username, affiliate_id, active, created_at)
    VALUES ('SID-GAB','SRC-EXCEL','USR-GAB','Mr. Musembi Gabriel Musyoka','AFF-KE',1,CURRENT_TIMESTAMP)`);
  await commitPoBatch(asClient(c), validation.batchId ?? '', CTX);
  const assigned = await c.execute(`
    SELECT COUNT(*) AS n FROM workflow_stage_instances WHERE assigned_user_id = 'USR-GAB'
      AND action_notes LIKE '%approval level 2'`);
  assert.equal(Number(assigned.rows[0]?.n), 40, 'Gabriel signs level two on 40 of the 45 orders');
});

test('one approver name under two affiliates resolves to two authority contexts', async () => {
  const c = await db();
  // Kenya maps the name to Gabriel. Uganda maps nothing, so the same name
  // there stays unresolved rather than borrowing Kenya's authority.
  await c.execute(`INSERT INTO source_identities (source_identity_id, source_system_id, user_id,
      external_username, affiliate_id, active, created_at)
    VALUES ('SID-KE-GAB','SRC-EXCEL','USR-GAB','Mr. Shared Approver','AFF-KE',1,CURRENT_TIMESTAMP)`);

  const kenya = syntheticWorkbook([
    { purchaseNumber: 'SHARED-KE', levels: 1, approvers: ['Mr. Shared Approver'] },
  ]);
  const uganda = syntheticWorkbook([
    { purchaseNumber: 'SHARED-UG', levels: 1, approvers: ['Mr. Shared Approver'] },
  ]);

  const keValidation = await validatePoWorkbook(
    asClient(c),
    kenya,
    upload({ filename: 'ke.xls', affiliateId: 'AFF-KE' }),
    CTX,
  );
  await commitPoBatch(asClient(c), keValidation.batchId ?? '', CTX);
  const ugValidation = await validatePoWorkbook(
    asClient(c),
    uganda,
    upload({ filename: 'ug.xls', affiliateId: 'AFF-UG' }),
    CTX,
  );
  await commitPoBatch(asClient(c), ugValidation.batchId ?? '', CTX);

  assert.ok(!keValidation.unresolvedActors.some((a) => a.username === 'MR. SHARED APPROVER'));
  assert.ok(ugValidation.unresolvedActors.some((a) => a.username === 'MR. SHARED APPROVER'));

  const stageAssignee = async (doc: string) =>
    (
      await c.execute({
        sql: `SELECT wsi.assigned_user_id AS who FROM purchase_orders po
              JOIN workflow_instances wi ON wi.entity_id = po.purchase_order_id
              JOIN workflow_stage_instances wsi ON wsi.workflow_instance_id = wi.workflow_instance_id
              WHERE po.document_number = ?`,
        args: [doc],
      })
    ).rows[0]?.who ?? null;
  assert.equal(stageAssignee !== null, true);
  assert.equal(await stageAssignee('SHARED-KE'), 'USR-GAB');
  assert.equal(await stageAssignee('SHARED-UG'), null);
});

test('a shop procurement order never reaches the petroleum catalogue', async () => {
  const c = await db();
  const sheet = parseWorkbook(PO_FILE);
  const pastries = sheet.rows.find((r) =>
    String(r['Req Description'] ?? '')
      .toLowerCase()
      .includes('pastries'),
  );
  assert.notEqual(pastries, undefined);
  // The row is classified LPG by the source. Mapping NATURE onto the
  // catalogue would file pastries under liquefied petroleum gas, which is
  // why NATURE is reported and never mapped.
  assert.equal(String(pastries?.NATURE), 'LPG');

  const validation = await validatePoWorkbook(asClient(c), PO_FILE, upload(), CTX);
  await commitPoBatch(asClient(c), validation.batchId ?? '', CTX);

  const products = await c.execute('SELECT product_id FROM products ORDER BY product_id');
  assert.deepEqual(
    products.rows.map((r) => String(r.product_id)),
    ['PROD-AGO', 'PROD-JET', 'PROD-LPG', 'PROD-LUBE', 'PROD-PMS'],
    'the catalogue is exactly what the seed configured: no import writes a product',
  );
  const lines = await c.execute({
    sql: `SELECT COUNT(*) AS n FROM purchase_order_lines
          WHERE purchase_order_id IN (SELECT entity_id FROM import_rows WHERE import_batch_id = ?)`,
    args: [validation.batchId],
  });
  assert.equal(Number(lines.rows[0]?.n), 0);

  const imported = await c.execute({
    sql: `SELECT document_number FROM purchase_orders WHERE document_number = ?`,
    args: [String(pastries?.['purchase Number'])],
  });
  assert.equal(imported.rows.length, 1, 'the order itself still imports');
});

test('a re-upload with a further approval appends only the new stage', async () => {
  const c = await db();
  const three = syntheticWorkbook([{ purchaseNumber: 'GROW-1', levels: 3 }]);
  const first = await validatePoWorkbook(
    asClient(c),
    three,
    upload({ filename: 'grow-a.xls' }),
    CTX,
  );
  await commitPoBatch(asClient(c), first.batchId ?? '', CTX);

  const before = await c.execute(`
    SELECT ws.sequence_no AS seq, wsi.workflow_stage_instance_id AS id, wsi.completed_at AS done
    FROM purchase_orders po
    JOIN workflow_instances wi ON wi.entity_id = po.purchase_order_id
    JOIN workflow_stage_instances wsi ON wsi.workflow_instance_id = wi.workflow_instance_id
    JOIN workflow_stages ws ON ws.workflow_stage_id = wsi.workflow_stage_id
    WHERE po.document_number = 'GROW-1' ORDER BY ws.sequence_no`);
  assert.equal(before.rows.length, 3);

  const four = syntheticWorkbook([{ purchaseNumber: 'GROW-1', levels: 4 }]);
  const second = await validatePoWorkbook(
    asClient(c),
    four,
    upload({ filename: 'grow-b.xls' }),
    CTX,
  );
  assert.equal(second.rowsChanged, 1, 'the further approval is a change, not a duplicate');
  assert.equal(second.rowsNew, 0);
  const committed = await commitPoBatch(asClient(c), second.batchId ?? '', CTX);
  assert.equal(committed.ordersUpdated, 1);
  assert.equal(committed.ordersCreated, 0);
  assert.equal(committed.stageEventsAppended, 1, 'only level four is appended');

  const after = await c.execute(`
    SELECT ws.sequence_no AS seq, wsi.workflow_stage_instance_id AS id, wsi.completed_at AS done
    FROM purchase_orders po
    JOIN workflow_instances wi ON wi.entity_id = po.purchase_order_id
    JOIN workflow_stage_instances wsi ON wsi.workflow_instance_id = wi.workflow_instance_id
    JOIN workflow_stages ws ON ws.workflow_stage_id = wsi.workflow_stage_id
    WHERE po.document_number = 'GROW-1' ORDER BY ws.sequence_no`);
  assert.equal(after.rows.length, 4);
  // Stages one to three are the same rows, untouched.
  for (let i = 0; i < 3; i++) {
    assert.equal(String(after.rows[i]?.id), String(before.rows[i]?.id));
    assert.equal(String(after.rows[i]?.done), String(before.rows[i]?.done));
  }

  const orders = await c.execute(
    `SELECT COUNT(*) AS n FROM purchase_orders WHERE document_number = 'GROW-1'`,
  );
  assert.equal(Number(orders.rows[0]?.n), 1, 'a re-upload never mints a second order');
  const snapshots = await c.execute(`
    SELECT version_no, is_current FROM record_snapshots
    WHERE entity_type = 'PURCHASE_ORDER' AND source_record_key = 'AFF-KE|GROW-1' ORDER BY version_no`);
  assert.deepEqual(
    snapshots.rows.map((r) => [Number(r.version_no), Number(r.is_current)]),
    [
      [1, 0],
      [2, 1],
    ],
  );
});

test('the identical file uploaded twice changes nothing and names the first batch', async () => {
  const c = await db();
  const first = await validatePoWorkbook(asClient(c), PO_FILE, upload(), CTX);
  await commitPoBatch(asClient(c), first.batchId ?? '', CTX);

  const again = await validatePoWorkbook(
    asClient(c),
    PO_FILE,
    upload({ filename: 'PO-Ver1-copy.xls' }),
    CTX,
  );
  assert.equal(again.batchId, null);
  assert.equal(again.duplicateOfBatchId, first.batchId);
  assert.equal(again.rowsReceived, 0);

  const batches = await c.execute(
    `SELECT COUNT(*) AS n FROM import_batches WHERE import_type = 'PURCHASE_ORDER' AND uploaded_at >= '2026-08-27'`,
  );
  assert.equal(Number(batches.rows[0]?.n), 1, 'the duplicate upload creates no batch');

  // A byte-level reformat is not a change either: the same values hash the same.
  const book = XLSX.read(PO_FILE, { type: 'buffer' });
  const resaved = XLSX.write(book, { bookType: 'biff8', type: 'buffer' }) as Buffer;
  const reformatted = await validatePoWorkbook(
    asClient(c),
    resaved,
    upload({ filename: 'PO-Ver1-resaved.xls' }),
    CTX,
  );
  assert.equal(reformatted.rowsChanged, 0, 'a re-save must never look like 45 changes');
  assert.equal(reformatted.rowsDuplicate, 45);
});

test('the computed stage duration and the source variance are shown side by side', async () => {
  const sheet = parseWorkbook(PO_FILE);
  let cumulativeMatches = 0;
  let perStageDiffers = 0;
  for (const [index, raw] of sheet.rows.entries()) {
    const row = await normalisePoRow(raw, index + 1, 'AFF-KE');
    const durations = stageDurations(row);
    assert.equal(durations.length, 4);
    // Level one is the only level where the two agree, because the source
    // figures accumulate from submission while a stage duration does not.
    for (const duration of durations) {
      assert.notEqual(duration.computedMinutes, null);
      // The cumulative figure measured once from submission, so the
      // comparison is not four roundings deep.
      const running = minutesBetween(row.submittedAt, duration.approvedAt) ?? 0;
      const source = duration.sourceVarianceMinutes ?? 0;
      if (Math.abs(source - running) <= 1) cumulativeMatches += 1;
      if (duration.level > 1 && Math.abs(source - (duration.computedMinutes ?? 0)) > 1) {
        perStageDiffers += 1;
      }
    }
    // The creation to submission metric does agree with the source column.
    const overall = poDurations(row);
    assert.ok(
      Math.abs(
        (overall.createdToSubmittedMinutes ?? 0) - (overall.sourceCreatedToSubmittedMinutes ?? 0),
      ) <= 1,
    );
  }
  assert.equal(cumulativeMatches, 45 * 4, 'every source variance is cumulative from submission');
  assert.ok(perStageDiffers > 100, 'and so differs from the per stage duration nearly everywhere');
});

test('an upload with no affiliate is refused before anything is written', async () => {
  const c = await db();
  const rejected = await validatePoWorkbook(
    asClient(c),
    PO_FILE,
    upload({ affiliateId: null }),
    CTX,
  );
  assert.equal(rejected.batchId, null);
  assert.ok(rejected.rejectedReason?.includes('no affiliate'));
  const batches = await c.execute(
    `SELECT COUNT(*) AS n FROM import_batches WHERE uploaded_at >= '2026-08-27'`,
  );
  assert.equal(Number(batches.rows[0]?.n), 0);

  const unknown = await validatePoWorkbook(
    asClient(c),
    PO_FILE,
    upload({ affiliateId: 'AFF-NOWHERE' }),
    CTX,
  );
  assert.ok(unknown.rejectedReason?.includes('not configured'));

  // Nothing was recorded, so the same bytes import cleanly once corrected.
  const corrected = await validatePoWorkbook(asClient(c), PO_FILE, upload(), CTX);
  assert.equal(corrected.rowsNew, 45);
});

test('status is derived conservatively and never claims receipt or posting', async () => {
  const base = { 'purchase Number': 'X-1', ORIGINAL_CREATION_DATE: serial('2026-06-01T08:00:00Z') };
  const created = await normalisePoRow({ ...base }, 1, 'AFF-KE');
  assert.equal(derivePoStatus(created), 'CREATED');

  const inApproval = await normalisePoRow(
    {
      ...base,
      SUBMISSION_FOR_APPROVAL_DATE: serial('2026-06-01T08:10:00Z'),
      FIRST_APPROVAL_DATE: serial('2026-06-01T09:00:00Z'),
      AUTHORIZATION_STATUS: 'IN PROCESS',
    },
    1,
    'AFF-KE',
  );
  assert.equal(derivePoStatus(inApproval), 'IN_APPROVAL');

  const approved = await normalisePoRow(
    {
      ...base,
      SUBMISSION_FOR_APPROVAL_DATE: serial('2026-06-01T08:10:00Z'),
      FIRST_APPROVAL_DATE: serial('2026-06-01T09:00:00Z'),
      AUTHORIZATION_STATUS: 'APPROVED',
    },
    1,
    'AFF-KE',
  );
  assert.equal(derivePoStatus(approved), 'APPROVED');

  // Every real row says APPROVED, and none of them may reach RECEIVED or POSTED.
  const sheet = parseWorkbook(PO_FILE);
  for (const raw of sheet.rows) {
    const row = await normalisePoRow(raw, 1, 'AFF-KE');
    assert.equal(derivePoStatus(row), 'APPROVED');
  }
});

test('an approver name with no approval date is not an elapsed stage', async () => {
  const approvals = readApprovals({
    FIRST_APPROVAL_DATE: serial('2026-06-01T09:00:00Z'),
    FIRST_APPROVER: 'Mr. One',
    SECOND_APPROVER: 'Mr. Two',
    THIRD_APPROVALS_VARIANCE: 44,
  });
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0]?.level, 1);
});
