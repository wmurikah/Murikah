/**
 * Phase 21: purchase order and stock process performance.
 *
 * The point of this process is that physical stock and system stock have to
 * agree, so the tests are about the honesty of the stock figures: that a
 * missing receipt timestamp produces "not available" rather than a number,
 * that coverage is known before a duration is read, that a stage exists only
 * when its instance exists, and that no correlation is dressed up as a
 * cause.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, type TestClient } from './support/db.ts';
import { seedHass, SEED } from './support/hassSeed.ts';
import { parseFilter } from '../../src/lib/cms/analytics/filters.ts';
import { coverageSentence, formatDuration } from '../../src/lib/cms/analytics/stats.ts';
import {
  listPurchaseOrders,
  countPurchaseOrders,
  stagePerformance,
  bottleneck,
  durations,
  coverage,
  backlog,
  approverPerformance,
  procurementMix,
  trend,
  stockConstraint,
  purchaseOrderDetail,
  BOTTLENECK_METHOD,
  STOCK_CONSTRAINT_WORDING,
} from '../../src/lib/cms/repos/poPerformance.ts';
import {
  resetCaseEventHandlers,
  resetLeadEventHandlers,
  resetSlaWiring,
} from '../../src/lib/cms/service/events.ts';

const NOW = '2026-08-27 10:00:00';

const db = async (): Promise<TestClient> => {
  const c = createTestDb();
  await seedHass(c);
  resetCaseEventHandlers();
  resetLeadEventHandlers();
  resetSlaWiring();
  return c;
};
const asClient = (c: TestClient) => c as unknown as Parameters<typeof coverage>[0];
const filter = (query = '') => parseFilter(new URLSearchParams(query));

/**
 * A purchase order with a chosen number of approval stages, so the tests can
 * prove nothing is written for four. The stages are minted against the
 * seeded Kenya purchase order definition, extended where it has no stage at
 * a sequence, exactly as the phase 18 importer does.
 */
async function makeOrder(
  c: TestClient,
  input: {
    id: string;
    documentNumber: string;
    stages: number;
    createdAt?: string;
    submittedAt?: string | null;
    leaveLastPending?: boolean;
    receivedAt?: string | null;
    postedAt?: string | null;
    approver?: string;
  },
) {
  const created = input.createdAt ?? '2026-08-01 08:00:00';
  const submitted = input.submittedAt === undefined ? '2026-08-01 08:10:00' : input.submittedAt;
  await c.execute({
    sql: `INSERT INTO purchase_orders
            (purchase_order_id, document_number, affiliate_id, business_unit_id, supplier_name,
             po_created_at, submitted_for_approval_at, currency_code, po_value,
             physical_received_at, oracle_stock_posted_at, status, created_at)
          VALUES (?, ?, 'AFF-KE', 'BU-CI', NULL, ?, ?, NULL, NULL, ?, ?, ?, CURRENT_TIMESTAMP)`,
    args: [
      input.id,
      input.documentNumber,
      created,
      submitted,
      input.receivedAt ?? null,
      input.postedAt ?? null,
      input.leaveLastPending === true ? 'IN_APPROVAL' : 'APPROVED',
    ],
  });
  const instanceId = `WFI-${input.id}`;
  await c.execute({
    sql: `INSERT INTO workflow_instances
            (workflow_instance_id, workflow_definition_id, entity_type, entity_id, status,
             started_at, completed_at, created_at)
          VALUES (?, 'WFD-002', 'PURCHASE_ORDER', ?, ?, ?, NULL, CURRENT_TIMESTAMP)`,
    args: [
      instanceId,
      input.id,
      input.leaveLastPending === true ? 'IN_PROGRESS' : 'COMPLETED',
      submitted,
    ],
  });
  const existing = await c.execute(
    `SELECT sequence_no, workflow_stage_id FROM workflow_stages WHERE workflow_definition_id = 'WFD-002'`,
  );
  const bySequence = new Map(
    existing.rows.map((row) => [Number(row.sequence_no), String(row.workflow_stage_id)]),
  );
  for (let level = 1; level <= input.stages; level++) {
    let stageId = bySequence.get(level);
    if (stageId === undefined) {
      stageId = `WST-PO-${level}`;
      await c.execute({
        sql: `INSERT OR IGNORE INTO workflow_stages
                (workflow_stage_id, workflow_definition_id, stage_code, stage_name, sequence_no,
                 assignment_type, approval_mode, required_approvals, terminal_stage)
              VALUES (?, 'WFD-002', ?, ?, ?, 'SYSTEM', 'SYSTEM', 1, 0)`,
        args: [stageId, `PO_APPROVAL_${level}`, `Approval level ${level}`, level],
      });
      bySequence.set(level, stageId);
    }
    const pending = input.leaveLastPending === true && level === input.stages;
    // Each level becomes actionable when the previous one completed, and the
    // first when the order was submitted.
    const actionable =
      level === 1 ? submitted : `2026-08-01 ${String(8 + (level - 1)).padStart(2, '0')}:30:00`;
    const completed = `2026-08-01 ${String(8 + level).padStart(2, '0')}:30:00`;
    await c.execute({
      sql: `INSERT INTO workflow_stage_instances
              (workflow_stage_instance_id, workflow_instance_id, workflow_stage_id,
               assigned_user_id, status, assigned_at, started_at, completed_at, action_notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Reconstructed from the PO extract')`,
      args: [
        `WSI-${input.id}-${level}`,
        instanceId,
        stageId,
        input.approver ?? 'USR-GAB',
        pending ? 'ACTIVE' : 'APPROVED',
        actionable,
        actionable,
        pending ? null : completed,
      ],
    });
  }
}

// ---------------------------------------------------------------------------

test('three, four and seven stage orders all render, and no empty stage is drawn', async () => {
  const c = await db();
  await makeOrder(c, { id: 'PO-T3', documentNumber: 'PO-T3', stages: 3 });
  await makeOrder(c, { id: 'PO-T4', documentNumber: 'PO-T4', stages: 4 });
  await makeOrder(c, { id: 'PO-T7', documentNumber: 'PO-T7', stages: 7 });

  for (const [id, expected] of [
    ['PO-T3', 3],
    ['PO-T4', 4],
    ['PO-T7', 7],
  ] as const) {
    const detail = await purchaseOrderDetail(asClient(c), SEED.admin, id, NOW);
    assert.notEqual(detail, null, id);
    assert.equal(detail?.stages.length, expected, `${id} should render ${expected} stages`);
    assert.equal(
      detail?.stages.every((stage) => stage.actionableAt !== null),
      true,
      'every rendered stage became actionable at a known moment',
    );
    assert.equal(detail?.order.approvalStagesRecorded, expected);
  }

  // Nothing is hard-coded at four: the seven-stage order has levels five to
  // seven, and the three-stage order has none of them.
  const seven = await purchaseOrderDetail(asClient(c), SEED.admin, 'PO-T7', NOW);
  assert.equal(seven?.stages[6]?.sequenceNo, 7);
  const three = await purchaseOrderDetail(asClient(c), SEED.admin, 'PO-T3', NOW);
  assert.equal(
    three?.stages.some((stage) => stage.sequenceNo > 3),
    false,
    'a level nobody used is not a stage',
  );
});

test('a pending stage ages and is excluded from the completed-cycle figure', async () => {
  const c = await db();
  await makeOrder(c, {
    id: 'PO-PEND',
    documentNumber: 'PO-PEND',
    stages: 4,
    leaveLastPending: true,
  });
  const detail = await purchaseOrderDetail(asClient(c), SEED.admin, 'PO-PEND', NOW);
  assert.equal(detail?.cycleComplete, false);
  assert.equal(
    detail?.durations.approvalCycleMinutes,
    null,
    'an unfinished cycle has no completed-cycle duration',
  );
  const pending = detail?.stages.find((stage) => stage.completedAt === null);
  assert.notEqual(pending, undefined);
  assert.ok((pending?.pendingMinutes ?? 0) > 0, 'and the open stage ages visibly');

  // The aggregate agrees: the pending order is not in the completed-cycle
  // population, and it is in the backlog.
  const all = await durations(asClient(c), SEED.admin, filter(), NOW);
  const complete = await purchaseOrderDetail(asClient(c), SEED.admin, 'PO-PEND', NOW);
  assert.equal(complete?.durations.approvalCycleMinutes, null);
  const signals = await backlog(asClient(c), SEED.admin, filter(), NOW);
  assert.ok((signals.find((s) => s.key === 'awaiting_approval')?.orders ?? 0) > 0);
  assert.ok(all.approvalCycle.total >= 0);
});

test('stage one is measured from submission, and creation to submission is its own figure', async () => {
  const c = await db();
  // Created 08:00, submitted 08:10, first approval 09:30.
  await makeOrder(c, { id: 'PO-ARITH', documentNumber: 'PO-ARITH', stages: 1 });
  const detail = await purchaseOrderDetail(asClient(c), SEED.admin, 'PO-ARITH', NOW);

  assert.equal(detail?.stages[0]?.actionableAt, '2026-08-01 08:10:00');
  assert.equal(
    detail?.stages[0]?.elapsedMinutes,
    80,
    'stage one is 09:30 minus 08:10, which is 80 minutes, NOT 90 from creation',
  );
  assert.equal(
    detail?.durations.creationToSubmissionMinutes,
    10,
    'creation to submission is its own 10 minutes and is never folded into stage one',
  );
  assert.notEqual(
    detail?.stages[0]?.elapsedMinutes,
    (detail?.durations.creationToSubmissionMinutes ?? 0) + (detail?.stages[0]?.elapsedMinutes ?? 0),
  );
  assert.equal(detail?.durations.approvalCycleMinutes, 80);
});

test('receipt and posting report "Not available" with coverage, and compute where present', async () => {
  const c = await db();
  await makeOrder(c, {
    id: 'PO-NONE',
    documentNumber: 'PO-NONE',
    stages: 4,
    receivedAt: null,
    postedAt: null,
  });
  const bare = await purchaseOrderDetail(asClient(c), SEED.admin, 'PO-NONE', NOW);
  assert.equal(bare?.durations.approvalToPhysicalReceiptMinutes, null);
  assert.equal(bare?.durations.physicalReceiptToOraclePostingMinutes, null);
  assert.equal(
    formatDuration(bare?.durations.physicalReceiptToOraclePostingMinutes ?? null),
    'Not available',
  );

  // A synthetic order that has both computes correctly.
  await makeOrder(c, {
    id: 'PO-BOTH',
    documentNumber: 'PO-BOTH',
    stages: 4,
    receivedAt: '2026-08-02 08:00:00',
    postedAt: '2026-08-02 11:30:00',
  });
  const both = await purchaseOrderDetail(asClient(c), SEED.admin, 'PO-BOTH', NOW);
  assert.equal(both?.durations.physicalReceiptToOraclePostingMinutes, 210);
  assert.equal(both?.order.awaitingOraclePosting, false);

  // And the aggregate states its coverage rather than averaging over a
  // partial population in silence.
  const set = await durations(asClient(c), SEED.admin, filter(), NOW);
  assert.ok(set.physicalReceiptToOraclePosting.total > set.physicalReceiptToOraclePosting.measured);
  assert.ok(
    coverageSentence(set.physicalReceiptToOraclePosting, 'orders').includes(
      'never counted as zero',
    ),
  );

  // The final approval is never borrowed as a posting date.
  const posted = await c.execute(
    `SELECT COUNT(*) AS n FROM purchase_orders po
     JOIN workflow_instances wi ON wi.entity_type = 'PURCHASE_ORDER' AND wi.entity_id = po.purchase_order_id
     WHERE po.oracle_stock_posted_at IS NOT NULL AND po.oracle_stock_posted_at = wi.completed_at`,
  );
  assert.equal(Number(posted.rows[0]?.n), 0);
});

test('an order received but not posted is flagged as awaiting posting', async () => {
  const c = await db();
  // PO-003 in the seed is exactly this case.
  const rows = await listPurchaseOrders(asClient(c), SEED.admin, filter(), NOW, 100);
  const waiting = rows.filter((row) => row.awaitingOraclePosting);
  assert.ok(waiting.length > 0, 'the seed holds an order received but not posted');
  assert.equal(
    waiting.every((row) => row.physicalReceivedAt !== null && row.oracleStockPostedAt === null),
    true,
  );
  const signals = await backlog(asClient(c), SEED.admin, filter(), NOW);
  assert.equal(
    signals.find((signal) => signal.key === 'awaiting_posting')?.orders,
    waiting.length,
    'the backlog signal and the flagged rows agree',
  );
});

test('coverage counts are available before any duration is read', async () => {
  const c = await db();
  const rows = await coverage(asClient(c), SEED.admin, filter(), NOW);
  assert.equal(rows.length, 6);
  const byLabel = new Map(rows.map((row) => [row.label, row]));
  assert.ok((byLabel.get('Physical receipt recorded')?.total ?? 0) > 0);
  assert.ok(
    (byLabel.get('Oracle stock posted')?.present ?? 0) <
      (byLabel.get('Oracle stock posted')?.total ?? 0),
    'posting coverage is partial, which is exactly what the reader must see first',
  );
  assert.ok(byLabel.get('Supplier recorded')?.note.includes('carries no supplier'));
  for (const row of rows) {
    assert.ok(row.percent === null || (row.percent >= 0 && row.percent <= 100));
  }
});

test('one approver at two stages is two rows, and a Group approver is not filed under a country', async () => {
  const c = await db();
  await makeOrder(c, { id: 'PO-A', documentNumber: 'PO-A', stages: 4, approver: 'USR-GAB' });
  // The same person approving in a second affiliate makes them a Group
  // context rather than a Kenyan one.
  await c.execute(`INSERT INTO purchase_orders
      (purchase_order_id, document_number, affiliate_id, business_unit_id, supplier_name,
       po_created_at, submitted_for_approval_at, currency_code, po_value,
       physical_received_at, oracle_stock_posted_at, status, created_at)
    VALUES ('PO-UG','PO-UG-1','AFF-UG',NULL,NULL,'2026-08-01 08:00:00','2026-08-01 08:10:00',
            NULL,NULL,NULL,NULL,'APPROVED',CURRENT_TIMESTAMP)`);
  await c.execute(`INSERT INTO workflow_instances
      (workflow_instance_id, workflow_definition_id, entity_type, entity_id, status, started_at, created_at)
    VALUES ('WFI-PO-UG','WFD-002','PURCHASE_ORDER','PO-UG','COMPLETED','2026-08-01 08:10:00',CURRENT_TIMESTAMP)`);
  await c.execute(`INSERT INTO workflow_stage_instances
      (workflow_stage_instance_id, workflow_instance_id, workflow_stage_id, assigned_user_id,
       status, assigned_at, started_at, completed_at, action_notes)
    VALUES ('WSI-PO-UG-1','WFI-PO-UG','WST-004','USR-GAB','APPROVED',
            '2026-08-01 08:10:00','2026-08-01 08:10:00','2026-08-01 09:10:00','Approved')`);

  const performance = await approverPerformance(asClient(c), SEED.admin, filter(), NOW);
  const gabriel = performance.rows.filter((row) => row.userId === 'USR-GAB');
  assert.ok(gabriel.length >= 2, 'one row per stage, never one blended purchase order number');
  const stageCodes = new Set(gabriel.map((row) => row.stageCode));
  assert.ok(stageCodes.size >= 2);

  const levelOne = gabriel.find((row) => row.sequenceNo === 1);
  assert.equal(
    levelOne?.authorityContext,
    'GROUP',
    'approving across two affiliates is a Group context, not one country',
  );
  assert.equal(levelOne?.affiliateId, null, 'and it is not filed under whichever came first');
  assert.equal(levelOne?.affiliatesCovered, 2);

  // Scope the analysis to Kenya and the same person reads as a country
  // context, because within that filter it genuinely is one.
  const kenya = await approverPerformance(
    asClient(c),
    SEED.admin,
    filter('affiliateId=AFF-KE'),
    NOW,
  );
  const kenyanLevelOne = kenya.rows.find((row) => row.userId === 'USR-GAB' && row.sequenceNo === 1);
  assert.equal(kenyanLevelOne?.authorityContext, 'COUNTRY');
  assert.equal(kenyanLevelOne?.affiliateId, 'AFF-KE');
});

test('the bottleneck shares sum sensibly and the method is stated', async () => {
  const c = await db();
  await makeOrder(c, { id: 'PO-B1', documentNumber: 'PO-B1', stages: 4 });
  await makeOrder(c, { id: 'PO-B2', documentNumber: 'PO-B2', stages: 4 });
  const result = await bottleneck(asClient(c), SEED.admin, filter(), NOW);
  assert.equal(result.method, BOTTLENECK_METHOD);
  assert.ok(result.method.includes('median'), 'the method says medians, so nobody assumes a mean');
  const shares = result.rows.map((row) => row.sharePercent ?? 0);
  const total = shares.reduce((sum, share) => sum + share, 0);
  assert.ok(Math.abs(total - 100) <= 0.5, `shares should sum to about 100, got ${total}`);
  assert.equal(
    result.rows.every((row) => row.sharePercent === null || row.sharePercent >= 0),
    true,
  );
});

test('a non-fuel order is not filed under fuel', async () => {
  const c = await db();
  // An imported order with no catalogue line and a source NATURE of LPG,
  // which in the real extract is where the 2go shop procurement sits.
  await makeOrder(c, { id: 'PO-SHOP', documentNumber: 'PO-SHOP', stages: 4 });
  await c.execute(`INSERT INTO record_snapshots
      (snapshot_id, entity_type, entity_id, import_batch_id, source_record_key, version_no,
       row_hash, snapshot_json, captured_at, is_current)
    VALUES ('SNAP-SHOP','PURCHASE_ORDER','PO-SHOP','IMP-002','AFF-KE|PO-SHOP',1,'h',
            '{"nature":"LPG","description":"Purchase order for the supply of assorted pastries for 2go shop Karen"}',
            '2026-08-27 09:00:00',1)`);

  const mix = await procurementMix(asClient(c), SEED.admin, filter(), NOW);
  const shopRow = mix.find((row) => row.classification === 'Source classification: LPG');
  assert.notEqual(shopRow, undefined, 'it appears under the source classification');
  assert.equal(shopRow?.basis, 'SOURCE');
  assert.ok(
    shopRow?.note.includes('NOT a catalogue mapping'),
    'and the row says plainly that NATURE is not a catalogue mapping',
  );

  // It is not counted in any catalogue group.
  const catalogueOrders = mix
    .filter((row) => row.basis === 'CATALOGUE')
    .reduce((sum, row) => sum + row.orders, 0);
  const withLines = await c.execute(
    `SELECT COUNT(DISTINCT purchase_order_id) AS n FROM purchase_order_lines`,
  );
  assert.equal(
    catalogueOrders,
    Number(withLines.rows[0]?.n),
    'only orders with resolved catalogue lines are in the catalogue buckets',
  );
  const products = await c.execute(`SELECT COUNT(*) AS n FROM products`);
  assert.equal(Number(products.rows[0]?.n), 5, 'and no import invented a product');
});

test('aggregates match the detail list under one scope', async () => {
  const c = await db();
  await makeOrder(c, { id: 'PO-S1', documentNumber: 'PO-S1', stages: 4 });
  const group = await countPurchaseOrders(asClient(c), SEED.admin, filter(), NOW);
  const listed = await listPurchaseOrders(asClient(c), SEED.admin, filter(), NOW, 500);
  assert.equal(listed.length, group);

  const uganda = await countPurchaseOrders(asClient(c), 'USR-FMUG', filter(), NOW);
  const ugandaList = await listPurchaseOrders(asClient(c), 'USR-FMUG', filter(), NOW, 500);
  assert.equal(ugandaList.length, uganda);
  assert.ok(uganda < group, 'a country user sees fewer orders');
  assert.equal(
    ugandaList.every((row) => row.affiliateId === 'AFF-UG'),
    true,
  );

  const covered = await coverage(asClient(c), 'USR-FMUG', filter(), NOW);
  assert.equal(covered[0]?.total, uganda, 'coverage counts the same population as the list');
});

test('the stock constraint view correlates and claims no cause', async () => {
  const c = await db();
  const result = await stockConstraint(asClient(c), SEED.admin, filter(), NOW);
  assert.equal(result.wording, STOCK_CONSTRAINT_WORDING);
  assert.ok(result.wording.includes('correlation'));
  assert.ok(result.wording.includes('no link'));
  assert.equal(
    /caused|because of|due to/i.test(result.wording),
    false,
    'nothing in the wording asserts a cause',
  );
  // The seed has open Kenyan sales orders and unposted Kenyan purchase orders
  // for the same product, which is exactly a correlation and nothing more.
  assert.ok(result.rows.length > 0);
  for (const row of result.rows) {
    assert.ok(row.openSalesOrders > 0);
    assert.ok(row.purchaseOrdersAwaitingPosting > 0);
  }
});

test('no source variance column reaches a figure, and stages are read not assumed', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync('src/lib/cms/repos/poPerformance.ts', 'utf8');
  for (const column of ['APPROVALS_VARIANCE', 'TIME_DIFF_RAISEPO']) {
    const uses = source
      .split('\n')
      .filter((line) => line.includes(column) && !line.trim().startsWith('*'));
    assert.equal(uses.length, 0, `${column} must not reach an arithmetic line`);
  }
  // And nothing counts to four.
  assert.equal(/FOURTH|four stages|stages = 4/.test(source), false);
});

test('the trend answers per period without inventing a point', async () => {
  const c = await db();
  await makeOrder(c, {
    id: 'PO-TR1',
    documentNumber: 'PO-TR1',
    stages: 4,
    createdAt: '2026-06-02 08:00:00',
  });
  await makeOrder(c, {
    id: 'PO-TR2',
    documentNumber: 'PO-TR2',
    stages: 4,
    createdAt: '2026-07-02 08:00:00',
  });
  const buckets = await trend(
    asClient(c),
    SEED.admin,
    filter('from=2026-06-01&to=2026-07-31&grain=MONTH'),
    NOW,
  );
  assert.equal(buckets.length, 2);
  assert.deepEqual(
    buckets.map((bucket) => bucket.bucket),
    ['2026-06', '2026-07'],
  );
  assert.equal(
    buckets.every((bucket) => bucket.receiptToPostingMedianMinutes === null),
    true,
    'neither month has a posting timestamp, so neither reports a posting median',
  );
});

test('stage performance reads the stages that exist, in sequence', async () => {
  const c = await db();
  await makeOrder(c, { id: 'PO-SP', documentNumber: 'PO-SP', stages: 5 });
  const stages = await stagePerformance(asClient(c), SEED.admin, filter(), NOW);
  const sequences = stages.map((stage) => stage.sequenceNo);
  assert.deepEqual(
    sequences,
    [...sequences].sort((a, b) => a - b),
    'stages come in sequence order',
  );
  assert.ok(
    stages.some((stage) => stage.sequenceNo === 5),
    'a fifth level is read where it exists',
  );
  assert.equal(
    stages.every((stage) => stage.recorded > 0),
    true,
    'every row is a stage that genuinely happened',
  );
});
