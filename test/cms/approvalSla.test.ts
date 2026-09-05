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
import { readFileSync } from 'node:fs';
import { createTestDb, type TestClient } from './support/db.ts';
import { seedHass, SEED } from './support/hassSeed.ts';
import {
  approvalBoard,
  approvalCycle,
  approvalRecords,
  approvalTrend,
  loadingAuthorityTrend,
  userApprovalTrend,
  EVERYONE,
  MINIMUM_RANKED_VOLUME,
  type ApprovalScope,
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
 * The period and the affiliate, as one value, exactly as a page passes them.
 *
 * Every query in the module takes this shape rather than a bare window, so a
 * test cannot narrow an aggregate by an affiliate and read its list back
 * unnarrowed — which is the divergence these assertions exist to catch.
 */
const scope = (token: string, affiliateId: string | null = null): ApprovalScope => {
  const chosen = period(token);
  return { from: chosen.from, to: chosen.to, affiliateId };
};
const allTime = (affiliateId: string | null = null): ApprovalScope => ({
  from: null,
  to: null,
  affiliateId,
});
const person = (userId: string | null) => ({ kind: 'PERSON' as const, userId });

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
  const board = await approvalBoard(client(db), 'PURCHASE_ORDER', scope('2026-05'));
  assert.ok(board.functions.length > 0, 'the chart series is empty');
  assert.ok(board.leaders.length > 0, 'the leaderboard is empty');
  await approvalBoard(client(db), 'SALES_ORDER', scope('2026-05'));
  db.close();
});

test('typical is the median and slowest ten per cent is the P90', async () => {
  const db = createTestDb();
  await seedTenApprovals(db);
  const board = await approvalBoard(client(db), 'PURCHASE_ORDER', scope('2026-05'));
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
  const board = await approvalBoard(client(db), 'PURCHASE_ORDER', scope('2026-05'));
  const row = board.leaders.find((leader) => leader.volume === 10);
  assert.ok(row !== undefined);
  const records = await approvalRecords(
    client(db),
    'PURCHASE_ORDER',
    'completed',
    row.fn,
    person(row.userId),
    scope('2026-05'),
  );
  assert.equal(records.length, row.volume);
  db.close();
});

test('the destination count equals the figure, for the slowest tenth', async () => {
  const db = createTestDb();
  await seedTenApprovals(db);
  const board = await approvalBoard(client(db), 'PURCHASE_ORDER', scope('2026-05'));
  const row = board.leaders.find((leader) => leader.volume === 10);
  assert.ok(row !== undefined);
  const tail = await approvalRecords(
    client(db),
    'PURCHASE_ORDER',
    'tail',
    row.fn,
    person(row.userId),
    scope('2026-05'),
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
  const board = await approvalBoard(client(db), 'PURCHASE_ORDER', scope('2026-05'));
  for (const row of board.leaders.filter((leader) => leader.pending > 0)) {
    const records = await approvalRecords(
      client(db),
      'PURCHASE_ORDER',
      'pending',
      row.fn,
      person(row.userId),
      scope('2026-05'),
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
    person('USR-GAB'),
    scope('2026-05'),
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
  const empty = await approvalBoard(client(db), 'PURCHASE_ORDER', scope('2026-08'));
  assert.equal(
    empty.leaders.filter((row) => row.volume > 0).length,
    0,
    'August 2026 should hold no completions',
  );
  const all = await approvalBoard(client(db), 'PURCHASE_ORDER', allTime());
  assert.ok(
    all.leaders.some((row) => row.volume === 10),
    'all time should still find the ten',
  );
  db.close();
});

/* -------------------------------------------------------------------------
 * BUILD PROMPT 41: THE PANELS THE CHART AND THE TABLE ARE DRAWN FROM
 * ------------------------------------------------------------------------- */

/**
 * A purchase order workflow of exactly `levels` levels, with one completed
 * approval at every one of them.
 *
 * THE TEMPLATE ALLOWS SEVEN AND THE EXTRACT USES FOUR, so the number is a
 * parameter here rather than a constant anywhere. The seed configures three;
 * this adds however many more are asked for and completes an approval at each,
 * which is what lets one assertion cover both "four today" and "seven when
 * somebody configures a fifth, sixth and seventh".
 */
async function seedPoLevels(db: TestClient, levels: number): Promise<void> {
  await seedHass(db);
  const existing = ['WST-004', 'WST-005', 'WST-006'];
  const stages: string[] = [];
  for (let n = 4; n <= levels; n += 1) {
    const id = `WST-9${String(n).padStart(2, '0')}`;
    existing.push(id);
    stages.push(
      `INSERT INTO workflow_stages VALUES
         ('${id}','WFD-002','PO_LEVEL_${n}','PO Level ${n}',${n},'TEAM',NULL,NULL,
          'TEAM-FIN-KE','ANY_ONE',1,NULL,0)`,
    );
  }
  for (const sql of stages) await db.execute(sql);

  // Ten orders, so a median and a P90 are both defined at every level.
  for (let order = 1; order <= 10; order += 1) {
    const o = String(order).padStart(2, '0');
    const day = String(9 + order).padStart(2, '0');
    await db.execute(
      `INSERT INTO purchase_orders (purchase_order_id, document_number, affiliate_id,
         po_created_at, status)
       VALUES ('PO-L${o}','DOC-L${o}','AFF-KE','2026-05-${day} 06:00:00','APPROVED')`,
    );
    await db.execute(
      `INSERT INTO workflow_instances VALUES
         ('WFI-L${o}','WFD-002','PURCHASE_ORDER','PO-L${o}','COMPLETED',
          '2026-05-${day} 07:00:00','2026-05-${day} 12:00:00','WST-006',CURRENT_TIMESTAMP)`,
    );
    for (const [index, stage] of existing.slice(0, levels).entries()) {
      // Each level takes (level * 5) + order minutes, so every level has a
      // distinct median and no level is empty.
      const minutes = (index + 1) * 5 + order;
      const end = new Date(Date.UTC(2026, 4, 9 + order, 7, minutes))
        .toISOString()
        .slice(0, 19)
        .replace('T', ' ');
      await db.execute(
        `INSERT INTO workflow_stage_instances VALUES
           ('WSI-L${o}-${index}','WFI-L${o}','${stage}','USR-GAB','TEAM-FIN-KE','APPROVED',
            '2026-05-${day} 07:00:00','2026-05-${day} 07:00:00','${end}','ok')`,
      );
    }
  }
}

test('the chart draws the levels that exist: four today, seven when seven are configured', async () => {
  // FOUR, AND NOT ONE EMPTY LEVEL. The number is read from the workflow rather
  // than assumed anywhere, which is the property this asserts.
  const four = createTestDb();
  await seedPoLevels(four, 4);
  const board = await approvalBoard(client(four), 'PURCHASE_ORDER', scope('2026-05'));
  assert.equal(board.functions.length, 4, 'four configured levels should draw four bars');
  assert.deepEqual(
    board.functions.map((f) => f.order),
    [1, 2, 3, 4],
    'the bars are the levels in sequence',
  );
  for (const f of board.functions) {
    assert.ok(f.volume > 0, `${f.fn} drew an empty bar`);
    assert.ok(f.medianMinutes !== null, `${f.fn} has no typical figure`);
  }
  four.close();

  // SEVEN, WITH NO CODE CHANGE. The template allows seven and this proves the
  // chart follows the configuration rather than the current extract.
  const seven = createTestDb();
  await seedPoLevels(seven, 7);
  const wide = await approvalBoard(client(seven), 'PURCHASE_ORDER', scope('2026-05'));
  assert.equal(wide.functions.length, 7, 'seven configured levels should draw seven bars');
  assert.deepEqual(
    wide.functions.map((f) => f.order),
    [1, 2, 3, 4, 5, 6, 7],
  );
  for (const f of wide.functions) assert.ok(f.volume > 0, `${f.fn} drew an empty bar`);
  seven.close();
});

/**
 * One person, two functions, two rows, and never an average of the two.
 *
 * Gabriel Musembi approves at level 1 and again at level 2. Those are different
 * jobs with different queues, and blending them into a single figure would let
 * a fast level flatter a slow one and would answer a question nobody asked.
 */
test('a person acting in two functions appears once under each and is never blended', async () => {
  const db = createTestDb();
  await seedPoLevels(db, 4);
  const board = await approvalBoard(client(db), 'PURCHASE_ORDER', scope('2026-05'));
  const gabriel = board.leaders.filter((row) => row.userId === SEED.gabriel);
  assert.equal(gabriel.length, 4, 'Gabriel Musembi should have one row per level he acted in');
  assert.equal(new Set(gabriel.map((row) => row.fn)).size, 4, 'the four rows are four functions');

  const levelOne = gabriel.find((row) => row.order === 1);
  const levelTwo = gabriel.find((row) => row.order === 2);
  assert.ok(levelOne !== undefined && levelTwo !== undefined);
  // Level one takes 5 + n minutes and level two 10 + n, so the two rows must
  // differ. A single blended row would show neither figure.
  assert.notEqual(levelOne.medianMinutes, levelTwo.medianMinutes);
  assert.equal(levelOne.volume, 10);
  assert.equal(levelTwo.volume, 10);
  // And the two rows' records are two different sets.
  const first = await approvalRecords(
    client(db),
    'PURCHASE_ORDER',
    'completed',
    levelOne.fn,
    person(SEED.gabriel),
    scope('2026-05'),
  );
  const second = await approvalRecords(
    client(db),
    'PURCHASE_ORDER',
    'completed',
    levelTwo.fn,
    person(SEED.gabriel),
    scope('2026-05'),
  );
  assert.equal(first.length, levelOne.volume);
  assert.equal(second.length, levelTwo.volume);
  assert.notDeepEqual(
    first.map((r) => r.minutes),
    second.map((r) => r.minutes),
  );
  db.close();
});

/**
 * THE DESTINATION COUNT EQUALS THE FIGURE, FOR A BAR.
 *
 * A bar is the whole function across everybody, and its figures come from a
 * partition by function alone. Listing it with the per-person partition would
 * cut the tail at a different index and hold a different number of rows, which
 * is the class of defect where a figure disagrees with its own list. Three
 * figures are checked on every function: the volume, the slowest tenth, and the
 * typical figure's marked median row.
 */
test('the destination count equals the figure, for every bar on both charts', async () => {
  const db = createTestDb();
  await seedPoLevels(db, 4);
  for (const process of ['PURCHASE_ORDER', 'SALES_ORDER'] as const) {
    const board = await approvalBoard(client(db), process, allTime());
    assert.ok(board.functions.length > 0, `${process} drew no bars`);
    for (const f of board.functions) {
      const completed = await approvalRecords(
        client(db),
        process,
        'completed',
        f.fn,
        EVERYONE,
        allTime(),
      );
      assert.equal(completed.length, f.volume, `${process} ${f.fn}: volume`);

      const tail = await approvalRecords(client(db), process, 'tail', f.fn, EVERYONE, allTime());
      assert.equal(tail.length, f.tailCount, `${process} ${f.fn}: slowest tenth`);
      // The tail reads slowest first, so the figure itself — the value at the
      // ceiling index — is the LAST row in the list, and the cut is at exactly
      // the index the figure was read at.
      assert.equal(tail[tail.length - 1]?.minutes, f.p90Minutes, `${process} ${f.fn}: P90`);

      const typical = await approvalRecords(
        client(db),
        process,
        'typical',
        f.fn,
        EVERYONE,
        allTime(),
      );
      assert.equal(typical.length, f.volume, `${process} ${f.fn}: typical holds the same set`);
      const marked = typical.filter((record) => record.isMedian);
      assert.ok(marked.length > 0, `${process} ${f.fn}: no median row is marked`);
    }
  }
  db.close();
});

/**
 * A GROUP-WIDE PURCHASE ORDER IS IN SCOPE FOR EVERY AFFILIATE.
 *
 * The extract carries no affiliate column, so a purchase order genuinely has
 * none, and the schema declares the column nullable for exactly that reason.
 * Excluding those rows the moment somebody used the control would empty the
 * whole purchase order panel, which reads exactly like a period with no work in
 * it and is the worst available answer.
 */
test('the affiliate narrows sales orders and never hides a Group-wide purchase order', async () => {
  const db = createTestDb();
  await seedPoLevels(db, 4);
  // One purchase order with no affiliate at all, exactly as the importer writes
  // them: it is Group-wide, not unassigned.
  await db.execute(
    `INSERT INTO purchase_orders (purchase_order_id, document_number, affiliate_id,
       po_created_at, status)
     VALUES ('PO-GRP','DOC-GRP',NULL,'2026-05-20 06:00:00','APPROVED')`,
  );
  await db.execute(
    `INSERT INTO workflow_instances VALUES
       ('WFI-GRP','WFD-002','PURCHASE_ORDER','PO-GRP','COMPLETED',
        '2026-05-20 07:00:00','2026-05-20 09:00:00','WST-006',CURRENT_TIMESTAMP)`,
  );
  await db.execute(
    `INSERT INTO workflow_stage_instances VALUES
       ('WSI-GRP','WFI-GRP','WST-004','USR-GAB','TEAM-FIN-KE','APPROVED',
        '2026-05-20 07:00:00','2026-05-20 07:00:00','2026-05-20 07:44:00','ok')`,
  );

  const groupWide = async (affiliate: string | null) => {
    const records = await approvalRecords(
      client(db),
      'PURCHASE_ORDER',
      'completed',
      'PO Cost Review',
      EVERYONE,
      scope('2026-05', affiliate),
    );
    return records.some((record) => record.entityId === 'PO-GRP');
  };
  assert.ok(await groupWide(null), 'the Group-wide order is missing with no affiliate chosen');
  assert.ok(await groupWide(SEED.affKenya), 'the Group-wide order vanished under Kenya');
  assert.ok(await groupWide(SEED.affUganda), 'the Group-wide order vanished under Uganda');

  // And the narrowing is real where the data carries an affiliate: every sales
  // order in the seed is Kenyan, so Uganda holds none of them.
  const kenya = await approvalBoard(client(db), 'SALES_ORDER', allTime(SEED.affKenya));
  const uganda = await approvalBoard(client(db), 'SALES_ORDER', allTime(SEED.affUganda));
  assert.ok(
    kenya.functions.some((f) => f.volume > 0),
    'the Kenyan sales orders should be in scope under Kenya',
  );
  assert.equal(
    uganda.functions.reduce((n, f) => n + f.volume, 0),
    0,
    'a Kenyan sales order must not appear under Uganda',
  );

  // The figure and the list narrow together, which is the property that makes
  // the count on the destination equal the figure that opened it.
  for (const f of kenya.functions) {
    const records = await approvalRecords(
      client(db),
      'SALES_ORDER',
      'completed',
      f.fn,
      EVERYONE,
      allTime(SEED.affKenya),
    );
    assert.equal(records.length, f.volume, `${f.fn} narrowed differently from its list`);
  }
  db.close();
});

/**
 * THE TREND'S MEDIAN IS THE BAR'S MEDIAN, computed the same way.
 *
 * Two medians on one page computed two ways is how a trend and a bar quietly
 * disagree about the same month with nothing on the screen saying so. Over a
 * period that is exactly one bucket the two must be the same number.
 */
test('the trend buckets each function and agrees with the bar over one bucket', async () => {
  const db = createTestDb();
  await seedPoLevels(db, 4);
  const day = scope('2026-05-10');
  const board = await approvalBoard(client(db), 'PURCHASE_ORDER', day);
  const points = await approvalTrend(client(db), 'PURCHASE_ORDER', day, 'DAY');
  assert.ok(points.length > 0, 'the trend returned nothing for a day that holds approvals');
  assert.deepEqual(
    [...new Set(points.map((p) => p.bucket))],
    ['2026-05-10'],
    'a single day buckets to a single day',
  );
  for (const f of board.functions) {
    const point = points.find((p) => p.fn === f.fn);
    assert.ok(point !== undefined, `${f.fn} is on the chart and missing from the trend`);
    assert.equal(point.medianMinutes, f.medianMinutes, `${f.fn}: the two medians disagree`);
    assert.equal(point.volume, f.volume, `${f.fn}: the two volumes disagree`);
  }

  // A month spreads across days, which is what the axis draws.
  const month = await approvalTrend(client(db), 'PURCHASE_ORDER', scope('2026-05'), 'DAY');
  assert.ok(
    new Set(month.map((p) => p.bucket)).size > 1,
    'a month should hold more than one daily bucket',
  );
  db.close();
});

test('user trends average transactions directly across products and retain their counts', async () => {
  const db = createTestDb();
  await seedPoLevels(db, 4);
  const points = await userApprovalTrend(client(db), 'PURCHASE_ORDER', scope('2026-05'));
  assert.ok(points.length > 0);
  assert.ok(points.every((point) => point.bucket === '2026-05'));
  assert.ok(points.every((point) => point.volume > 0 && point.averageMinutes >= 0));

  const source = readFileSync('src/lib/cms/repos/approvalSla.ts', 'utf8');
  const implementation = source.slice(source.indexOf('export async function userApprovalTrend'));
  assert.match(implementation, /AVG\(d\.measured_minutes\)/);
  assert.match(implementation, /GROUP BY d\.affiliate_id, d\.user_id/);
  assert.ok(!/GROUP BY[^`]*grp/.test(implementation.slice(0, implementation.indexOf('`;', 1))));
  db.close();
});

test('Loading Authority trend is entity-level and uses the canonical function population', async () => {
  const db = createTestDb();
  await seedHass(db);
  const points = await loadingAuthorityTrend(client(db), scope('2026-05'));
  assert.ok(points.every((point) => point.affiliateId && point.volume > 0));
  const source = readFileSync('src/lib/cms/repos/approvalSla.ts', 'utf8');
  const implementation = source.slice(
    source.indexOf('export async function loadingAuthorityTrend'),
  );
  assert.match(implementation, /src\.fn = 'Loading authority'/);
  assert.match(implementation, /GROUP BY d\.affiliate_id, substr\(d\.completed_at/);
  assert.ok(!/user_id|person/.test(implementation.slice(0, implementation.indexOf('\n}'))));
  db.close();
});

/**
 * The end-to-end span, and its denominator.
 *
 * A median of medians is not a median, so the strip cannot be assembled from
 * the bars. This is the statement that answers it, and it is measured over the
 * orders rather than over the levels.
 */
test('the approval cycle is measured per order, with the orders it covers', async () => {
  const db = createTestDb();
  await seedPoLevels(db, 4);
  const cycle = await approvalCycle(client(db), 'PURCHASE_ORDER', scope('2026-05'));
  assert.equal(cycle.orders, 10, 'ten orders were seeded and ten should be measured');
  // Every order starts at 07:00 and its last level ends at 07:(20 + n), so the
  // spans run 21 to 30 minutes and the median is the mean of the fifth and
  // sixth: 25 and 26.
  assert.equal(cycle.medianMinutes, 25.5);
  assert.equal(cycle.p90Minutes, 29);
  db.close();
});
