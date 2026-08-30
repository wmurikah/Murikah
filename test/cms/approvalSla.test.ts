/**
 * Build Prompt 39, fault one: the statement that had never once been executed.
 *
 * `approvalBoard` shipped with `GROUP BY d.fn` over a `FROM ranked`, and `d` is
 * out of scope by that point. Every execution raised `no such column: d.fn`, so
 * both charts and both leaderboards on Home were empty while the page's footer
 * still printed the ranking threshold — which read as "ten completions exist
 * and the window found none of them" and sent the diagnosis after the date
 * window instead of the SQL. Nothing in the suite ran the query, because
 * nothing in the suite ran the query.
 *
 * SO THE FIRST TEST HERE IS THAT IT EXECUTES AT ALL, against the mirrored
 * live DDL. The rest prove the arithmetic and the one property the leaderboards
 * are built on: a figure and the list behind it are the same question, so the
 * destination's count equals the figure exactly. Where those two are written
 * twice they disagree, and a figure that disagrees with its own records is a
 * scope defect wearing a rounding note.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, type TestClient } from './support/db.ts';
import { seedHass } from './support/hassSeed.ts';
import {
  approvalBoard,
  approvalRecords,
  MINIMUM_RANKED_VOLUME,
} from '../../src/lib/cms/repos/approvalSla.ts';
import { periodFromToken, type ResolvedPeriod } from '../../src/lib/cms/analytics/period.ts';

/**
 * The adapter is a faithful subset of the libSQL client rather than a
 * structural match for it, so it is widened at the call sites the way every
 * other repository test in this suite widens it.
 */
const client = (db: TestClient) => db as never;

const TODAY = new Date('2026-08-30T09:00:00Z');
const period = (token: string): ResolvedPeriod => periodFromToken(token, TODAY) as ResolvedPeriod;

/**
 * Ten approvals of 10, 20 … 100 minutes, all in May 2026 and all by one person.
 *
 * The durations are chosen so every figure can be checked by hand: the median
 * is the mean of the fifth and sixth, the P90 is the ninth by the ceiling
 * index, and the tail the ninth and the tenth. Ten is also exactly
 * MINIMUM_RANKED_VOLUME, so the ranking threshold is exercised at its edge.
 */
async function seedTenApprovals(db: TestClient): Promise<void> {
  await seedHass(db);
  const rows: string[] = [];
  for (let i = 1; i <= 10; i += 1) {
    const n = String(i).padStart(2, '0');
    const day = String(9 + i).padStart(2, '0');
    const minutes = i * 10;
    const end = new Date(Date.UTC(2026, 4, 9 + i, 8, minutes))
      .toISOString()
      .slice(0, 19)
      .replace('T', ' ');
    rows.push(
      `INSERT INTO purchase_orders (purchase_order_id, document_number, affiliate_id, po_created_at, status)
         VALUES ('PO-T${n}', 'DOC-T${n}', 'AFF-KE', '2026-05-${day} 07:00:00', 'APPROVED')`,
      `INSERT INTO workflow_instances VALUES
         ('WFI-T${n}','WFD-002','PURCHASE_ORDER','PO-T${n}','COMPLETED','2026-05-${day} 08:00:00','${end}','WST-005',CURRENT_TIMESTAMP)`,
      `INSERT INTO workflow_stage_instances VALUES
         ('WSI-T${n}','WFI-T${n}','WST-005','USR-GAB','TEAM-FIN-KE','APPROVED','2026-05-${day} 08:00:00','2026-05-${day} 08:00:00','${end}','ok')`,
    );
  }
  for (const sql of rows) await db.execute(sql);
}

test('the board executes at all, which is the regression', async () => {
  const db = createTestDb();
  await seedTenApprovals(db);
  // Before the fix this threw `no such column: d.fn` for every process and
  // every period. It is asserted rather than merely awaited so the failure
  // reads as the SQL error it is.
  const board = await approvalBoard(client(db), 'PURCHASE_ORDER', period('2026-05'));
  assert.ok(board.functions.length > 0, 'the chart series is empty');
  assert.ok(board.leaders.length > 0, 'the leaderboard is empty');
  await approvalBoard(client(db), 'SALES_ORDER', period('2026-05'));
  db.close();
});

test('typical is the median and slowest ten per cent is the P90', async () => {
  const db = createTestDb();
  await seedTenApprovals(db);
  const board = await approvalBoard(client(db), 'PURCHASE_ORDER', period('2026-05'));
  const row = board.leaders.find((leader) => leader.volume === 10);
  assert.ok(row !== undefined, 'the ten seeded approvals did not group into one row');
  assert.equal(row.volume, 10);
  // The fifth and sixth are 50 and 60.
  assert.equal(row.medianMinutes, 55);
  // ceil(0.9 * 10) = 9, and the ninth is 90.
  assert.equal(row.p90Minutes, 90);
  assert.equal(row.fastestMinutes, 10);
  assert.equal(row.slowestMinutes, 100);
  assert.equal(row.slowestDocumentNumber, 'DOC-T10');
  assert.equal(row.volume, MINIMUM_RANKED_VOLUME);
  db.close();
});

test('the destination count equals the figure, for volume', async () => {
  const db = createTestDb();
  await seedTenApprovals(db);
  const board = await approvalBoard(client(db), 'PURCHASE_ORDER', period('2026-05'));
  const row = board.leaders.find((leader) => leader.volume === 10);
  assert.ok(row !== undefined);
  const records = await approvalRecords(
    client(db),
    'PURCHASE_ORDER',
    'completed',
    row.fn,
    row.userId,
    period('2026-05'),
  );
  assert.equal(records.length, row.volume);
  db.close();
});

test('the destination count equals the figure, for the slowest tenth', async () => {
  const db = createTestDb();
  await seedTenApprovals(db);
  const board = await approvalBoard(client(db), 'PURCHASE_ORDER', period('2026-05'));
  const row = board.leaders.find((leader) => leader.volume === 10);
  assert.ok(row !== undefined);
  const tail = await approvalRecords(
    client(db),
    'PURCHASE_ORDER',
    'tail',
    row.fn,
    row.userId,
    period('2026-05'),
  );
  // Rows at or past the ceiling index: the ninth and the tenth.
  assert.equal(tail.length, row.tailCount);
  assert.equal(tail.length, 2);
  // Slowest first, and it opens only the tail rather than the whole set.
  assert.deepEqual(
    tail.map((record) => record.minutes),
    [100, 90],
  );
  db.close();
});

test('the destination count equals the figure, for pending', async () => {
  const db = createTestDb();
  await seedTenApprovals(db);
  const board = await approvalBoard(client(db), 'PURCHASE_ORDER', period('2026-05'));
  for (const row of board.leaders.filter((leader) => leader.pending > 0)) {
    const records = await approvalRecords(
      client(db),
      'PURCHASE_ORDER',
      'pending',
      row.fn,
      row.userId,
      period('2026-05'),
    );
    assert.equal(records.length, row.pending, `pending mismatch on ${row.fn}`);
    // The oldest is the first, and it is the record the figure links to.
    assert.equal(records[0]?.entityId, row.oldestPendingEntityId);
  }
  db.close();
});

test('every record carries the timestamps its duration came from', async () => {
  const db = createTestDb();
  await seedTenApprovals(db);
  const records = await approvalRecords(
    client(db),
    'PURCHASE_ORDER',
    'completed',
    'PO Finance Approval',
    'USR-GAB',
    period('2026-05'),
  );
  assert.ok(records.length > 0);
  for (const record of records) {
    assert.ok(record.startedAt !== null, 'a record has no start');
    assert.ok(record.completedAt !== null, 'a record has no completion');
    assert.ok(record.minutes !== null, 'a record has no duration');
  }
  // Exactly one row is marked as the median on an even count's lower middle
  // and one on the upper: two marks, whose mean is the printed figure.
  assert.equal(records.filter((record) => record.isMedian).length, 2);
  db.close();
});

test('a period holding nothing returns nothing, and all time still finds it', async () => {
  const db = createTestDb();
  await seedTenApprovals(db);
  // August 2026, three months after the extract: genuinely empty, and empty is
  // not an error. This is the SECOND fault, and it is a different one.
  const empty = await approvalBoard(client(db), 'PURCHASE_ORDER', period('2026-08'));
  assert.equal(
    empty.leaders.filter((row) => row.volume > 0).length,
    0,
    'August 2026 should hold no completions',
  );
  const all = await approvalBoard(client(db), 'PURCHASE_ORDER', {
    from: null,
    to: null,
  } as ResolvedPeriod);
  assert.ok(
    all.leaders.some((row) => row.volume === 10),
    'all time should still find the ten',
  );
  db.close();
});
