/**
 * Build Prompt 36: the sales order commit, and the grain the extract has.
 *
 * TWO FAULTS, AND ONLY ONE OF THEM WAS THE ONE REPORTED.
 *
 * The reported one was `UNIQUE(sales_order_id, line_number)`: 1,386 rows
 * carry only 1,252 distinct (affiliate, document, line) keys, so the commit
 * appeared to be inserting the same line twice. It was not. The line write
 * already carried `ON CONFLICT(sales_order_id, line_number) DO UPDATE`, so
 * the constraint was never violated — the repeats silently upserted over each
 * other and the LAST row won, which is how an arbitrary loading authority
 * reached `sales_orders.loading_authority_at`. A wrong answer, not a crash.
 *
 * The one that actually failed in production was arithmetic. The commit cost
 * 4,444 outbound round trips for this file: 1,117 stage-instance probes, and
 * 662 each of order lookup, workflow-instance lookup, snapshot version read
 * and snapshot write. Cloudflare allows 50 per request on the Free plan and
 * 1,000 on paid, so the worker died partway through and the browser was told
 * "The import could not be completed."
 *
 * AND THE REPEAT IS A CROSS-PRODUCT, NOT A LIST OF LOADINGS. Measured across
 * all 97 repeated keys: none is byte-identical, only 35 differ solely on the
 * loading columns, and the rest also vary the credit-hold, invoice or approval
 * columns. The 14-row key is 7 loading authorities against 2 credit-hold
 * episodes, so counting rows would report fourteen loadings for a line that
 * was loaded seven times. Everything below counts DISTINCT timestamps.
 *
 * Criteria 1, 2, 4, 7 and 8 of the phase are each a named test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createTestDb, type TestClient } from './support/db.ts';
import { seedHass, SEED } from './support/hassSeed.ts';
import { countRoundTrips, CLOUDFLARE_FREE_SUBREQUEST_LIMIT } from './support/subrequestBudget.ts';
import {
  validateSoWorkbook,
  commitSoBatch,
  loadingAuthorities,
  earliestLoadingAuthority,
} from '../../src/lib/cms/import/soImport.ts';
import {
  parseConstraintError,
  constraintName,
  offendingValues,
  describeConstraintFailure,
  logWriteFailure,
} from '../../src/lib/cms/import/writeFailure.ts';
import {
  resetCaseEventHandlers,
  resetLeadEventHandlers,
  resetSlaWiring,
} from '../../src/lib/cms/service/events.ts';

const here = dirname(fileURLToPath(import.meta.url));
const SO_FILE = readFileSync(join(here, 'support', 'SO-Ver1.xls'));

const NOW = new Date('2026-08-27T10:00:00Z');
const CTX = {
  actorUserId: SEED.admin,
  ip: '10.0.0.10',
  userAgent: 'HassCMS Test',
  now: NOW,
} as const;
const UPLOAD = {
  filename: 'SO-Ver1.xls',
  uploadedBy: SEED.admin,
  sourceSystemId: 'SRC-EXCEL',
};

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

/**
 * The commit's own subrequest budget.
 *
 * NOT the 15 the analytics pages hold to. A commit legitimately writes
 * thousands of statements and the platform counts BATCHES, not statements, so
 * the number to defend is how many times it goes to the database at all. 50 is
 * Cloudflare's Free-plan ceiling, and holding the commit under it means the
 * import works on every plan rather than only the paid one. The measured cost
 * for this file is 39; the headroom is deliberate and small enough that a
 * per-document read reintroduced anywhere blows it immediately.
 */
const COMMIT_SUBREQUEST_BUDGET = CLOUDFLARE_FREE_SUBREQUEST_LIMIT;

// ---------------------------------------------------------------------------
// Criteria 1 and 2: the real file commits, and every row is kept.
// ---------------------------------------------------------------------------

test('criteria 1 and 2: 662 orders, 1,252 lines, IMPORTED, and all 1,386 rows landed', async () => {
  const c = await db();
  const validation = await validateSoWorkbook(asClient(c), SO_FILE, UPLOAD, CTX);
  assert.equal(validation.rejectedReason, null);

  // Criterion 2, asserted BEFORE the commit: landing is what validation does,
  // and it is the reason no loading event is ever lost whatever the canonical
  // model can hold. so_extract_rows is keyed (import_batch_id,
  // source_row_number), so the repeats cannot collide with each other.
  assert.equal(
    await count(c, `SELECT COUNT(*) AS n FROM so_extract_rows WHERE import_batch_id = ?`, [
      validation.batchId,
    ]),
    1386,
    'every row of the extract is in the landing table',
  );

  const ordersBefore = await count(c, 'SELECT COUNT(*) AS n FROM sales_orders');
  const linesBefore = await count(c, 'SELECT COUNT(*) AS n FROM sales_order_lines');

  const result = await commitSoBatch(asClient(c), validation.batchId ?? '', CTX);
  assert.equal(result.documentsCreated, 662);
  assert.equal(result.documentsSkipped, 0);
  assert.equal(result.linesWritten, 1252, 'one line per (affiliate, document, line), not per row');

  assert.equal(await count(c, 'SELECT COUNT(*) AS n FROM sales_orders'), ordersBefore + 662);
  assert.equal(await count(c, 'SELECT COUNT(*) AS n FROM sales_order_lines'), linesBefore + 1252);
  assert.equal(
    (
      (
        await c.execute({
          sql: `SELECT status FROM import_batches WHERE import_batch_id = ?`,
          args: [validation.batchId],
        })
      ).rows[0] as Record<string, unknown>
    )?.status,
    'IMPORTED',
  );
  c.close();
});

test('the commit stays inside a subrequest budget the platform can actually serve', async () => {
  const base = await db();
  const validation = await validateSoWorkbook(asClient(base), SO_FILE, UPLOAD, CTX);

  const counted = countRoundTrips(base);
  await commitSoBatch(counted.db as never, validation.batchId ?? '', CTX);
  const trips = counted.roundTrips();
  console.log(
    `[subrequests] sales order commit: ${trips} round trips, ${counted.statements()} statements`,
  );
  assert.ok(
    trips <= COMMIT_SUBREQUEST_BUDGET,
    `the sales order commit costs ${trips} subrequests for ${counted.statements()} statements, ` +
      `over the budget of ${COMMIT_SUBREQUEST_BUDGET}. It cost 4,444 before this phase and the ` +
      `worker died mid-request, which is what "The import could not be completed." was. ` +
      `Hoist the read out of the per-document loop rather than raising this budget.`,
  );
  base.close();
});

// ---------------------------------------------------------------------------
// Criterion 3: the rule, on the order the report names.
// ---------------------------------------------------------------------------

test('criterion 3: order 4022 keeps one line 1, and takes the EARLIEST of its two authorities', async () => {
  const c = await db();
  const validation = await validateSoWorkbook(asClient(c), SO_FILE, UPLOAD, CTX);
  await commitSoBatch(asClient(c), validation.batchId ?? '', CTX);

  const order = (
    await c.execute({
      sql: `SELECT sales_order_id, loading_authority_at, status FROM sales_orders
            WHERE document_number = '4022'`,
      args: [],
    })
  ).rows[0] as Record<string, unknown>;
  assert.notEqual(order, undefined);
  // THE RULE: the earliest loading authority anywhere on the order. 4022 line 1
  // was loaded at 15:12:15 and again at 15:34:06 on 12 May; the metric this
  // column feeds asks how long the customer waited for their FIRST truck.
  assert.equal(order.loading_authority_at, '2026-05-12 15:12:15');

  assert.equal(
    await count(
      c,
      `SELECT COUNT(*) AS n FROM sales_order_lines WHERE sales_order_id = ? AND line_number = 1`,
      [String(order.sales_order_id)],
    ),
    1,
    'two rows for line 1, one line',
  );

  // The one not chosen is recorded, not discarded.
  const snapshot = (
    await c.execute({
      sql: `SELECT snapshot_json FROM record_snapshots
            WHERE entity_type = 'SALES_ORDER' AND entity_id = ? AND is_current = 1`,
      args: [String(order.sales_order_id)],
    })
  ).rows[0] as Record<string, unknown>;
  const parsed = JSON.parse(String(snapshot.snapshot_json)) as {
    loadingAuthorities: string[];
    loadingAuthorityRule: string;
  };
  assert.deepEqual(parsed.loadingAuthorities, ['2026-05-12 15:12:15', '2026-05-12 15:34:06']);
  assert.equal(
    parsed.loadingAuthorityRule,
    'earliest',
    'the snapshot records the rule, not only its result',
  );
  c.close();
});

// ---------------------------------------------------------------------------
// Criterion 4: the fourteen-row line.
// ---------------------------------------------------------------------------

test('criterion 4: the 14-row line commits as ONE line carrying SEVEN loading events', async () => {
  const c = await db();
  const validation = await validateSoWorkbook(asClient(c), SO_FILE, UPLOAD, CTX);
  await commitSoBatch(asClient(c), validation.batchId ?? '', CTX);

  // The landing table kept all fourteen rows, which is the point of having it.
  assert.equal(
    await count(
      c,
      `SELECT COUNT(*) AS n FROM so_extract_rows
       WHERE document_number = '115064745' AND line_number = '2'`,
    ),
    14,
  );

  const order = (
    await c.execute({
      sql: `SELECT sales_order_id, loading_authority_at FROM sales_orders
            WHERE document_number = '115064745'`,
      args: [],
    })
  ).rows[0] as Record<string, unknown>;
  assert.equal(
    await count(
      c,
      `SELECT COUNT(*) AS n FROM sales_order_lines WHERE sales_order_id = ? AND line_number = 2`,
      [String(order.sales_order_id)],
    ),
    1,
    'fourteen rows, one line',
  );

  const parsed = JSON.parse(
    String(
      (
        await c.execute({
          sql: `SELECT snapshot_json FROM record_snapshots
                WHERE entity_type = 'SALES_ORDER' AND entity_id = ? AND is_current = 1`,
          args: [String(order.sales_order_id)],
        })
      ).rows[0]?.snapshot_json,
    ),
  ) as { loadingAuthorities: string[] };

  // SEVEN, NOT FOURTEEN. The fourteen rows are seven loading authorities
  // against two credit-hold episodes; reporting fourteen would be repeating
  // the extract's join back at the reader as though it were fourteen trucks.
  assert.equal(parsed.loadingAuthorities.length, 7);
  assert.equal(parsed.loadingAuthorities[0], '2026-05-23 10:47:45');
  assert.equal(parsed.loadingAuthorities[6], '2026-06-12 09:44:34');
  assert.equal(order.loading_authority_at, '2026-05-23 10:47:45', 'the earliest of the seven');

  // And the two credit-hold episodes are genuinely there, which is why the
  // row count is fourteen and not seven.
  assert.equal(
    await count(
      c,
      `SELECT COUNT(DISTINCT credit_hold_date) AS n FROM so_extract_rows
       WHERE document_number = '115064745' AND line_number = '2'`,
    ),
    2,
  );
  c.close();
});

// ---------------------------------------------------------------------------
// Criterion 5: four figures, and criterion 6: the row_status.
// ---------------------------------------------------------------------------

test('criteria 5 and 6: the preview reports four figures, and a repeat is DUPLICATE not CHANGED', async () => {
  const c = await db();
  const validation = await validateSoWorkbook(asClient(c), SO_FILE, UPLOAD, CTX);

  // Four separate figures. Collapsing any pair of them is what let one order
  // line be written 134 times with the last row winning.
  assert.equal(validation.rowsReceived, 1386);
  assert.equal(validation.uniqueDocuments, 662);
  assert.equal(validation.orderLines, 1252);
  // Per ORDER, matching the grain of the column the rule fills: 762 distinct
  // authorities over 662 orders. The per-LINE figure is 82, which is a
  // different and equally true number about a different thing, and publishing
  // one under the other's name is how two screens come to disagree.
  assert.equal(validation.additionalLoadingEvents, 100);

  // Criterion 6. Not CHANGED: that is a verdict about stored state, and these
  // rows compete with a sibling in the same file. DUPLICATE of the five the
  // CHECK allows, because it is the only one that says "this row adds no new
  // canonical record", which is exactly true.
  assert.equal(validation.rowsChanged, 0, 'a within-batch repeat is never CHANGED');
  assert.equal(validation.rowsDuplicate, 134, '1,386 rows less 1,252 distinct line keys');
  assert.equal(validation.rowsNew, 1252);

  const statuses = await c.execute({
    sql: `SELECT row_status, COUNT(*) AS n FROM import_rows
          WHERE import_batch_id = ? GROUP BY row_status ORDER BY row_status`,
    args: [validation.batchId],
  });
  assert.deepEqual(
    statuses.rows.map((r) => [String(r.row_status), Number(r.n)]),
    [
      ['DUPLICATE', 134],
      ['NEW', 1252],
    ],
  );
  c.close();
});

// ---------------------------------------------------------------------------
// Criterion 7: a provoked failure names the table, the constraint and the values.
// ---------------------------------------------------------------------------

test('criterion 7: a provoked constraint failure names the table, the constraint and the values', async () => {
  const c = await db();

  // Every class SQLite reports differently, each provoked for real rather than
  // asserted from a remembered message format.
  const cases: { label: string; statements: { sql: string; args: unknown[] }[] }[] = [
    {
      label: 'NOT NULL',
      statements: [
        {
          sql: `INSERT INTO sales_orders
                  (sales_order_id, document_number, affiliate_id, account_id, order_created_at,
                   status, created_at)
                VALUES (?, ?, ?, NULL, ?, 'READY', ?)`,
          args: ['SO-X', 'DOC-X', 'AFF-KE', '2026-05-01 00:00:00', '2026-05-01 00:00:00'],
        },
      ],
    },
    {
      label: 'FOREIGN KEY',
      statements: [
        {
          sql: `INSERT INTO sales_orders
                  (sales_order_id, document_number, affiliate_id, account_id, order_created_at,
                   status, created_at)
                VALUES (?, ?, ?, ?, ?, 'READY', ?)`,
          args: [
            'SO-Y',
            'DOC-Y',
            'AFF-KE',
            'ACC-DOES-NOT-EXIST',
            '2026-05-01 00:00:00',
            '2026-05-01 00:00:00',
          ],
        },
      ],
    },
    {
      label: 'CHECK',
      statements: [
        {
          sql: `INSERT INTO sales_order_lines
                  (sales_order_line_id, sales_order_id, line_number, product_id, quantity,
                   unit_price, line_value)
                VALUES (?, ?, ?, ?, ?, NULL, NULL)`,
          args: ['SOL-Z', 'SO-001', 0, 'PROD-AGO', null],
        },
      ],
    },
  ];

  for (const one of cases) {
    let raised: unknown = null;
    try {
      await c.batch(one.statements as never, 'write');
    } catch (error) {
      raised = error;
    }
    assert.notEqual(raised, null, `${one.label} must genuinely fail`);
    const report = await describeConstraintFailure(asClient(c), one.statements as never, raised);
    assert.equal(report.kind, one.label, `${one.label} is classified as itself`);
    // The detail is what reaches the log, and it must name the constraint.
    assert.ok(
      report.detail.length > String(raised).length,
      `${one.label}: the description must add something to the driver's own sentence`,
    );
  }

  // The UNIQUE case, with its values, which is the one the report asked for.
  const duplicate = [
    {
      sql: `INSERT INTO sales_order_lines
              (sales_order_line_id, sales_order_id, line_number, product_id, quantity,
               unit_price, line_value)
            VALUES (?, ?, ?, ?, NULL, NULL, NULL)`,
      args: ['SOL-DUP', 'SO-001', 1, 'PROD-AGO'],
    },
  ];
  let uniqueError: unknown = null;
  try {
    await c.batch(duplicate as never, 'write');
    await c.batch(duplicate as never, 'write');
  } catch (error) {
    uniqueError = error;
  }
  assert.notEqual(uniqueError, null);
  const parsed = parseConstraintError(uniqueError);
  assert.equal(parsed?.kind, 'UNIQUE');
  assert.equal(parsed?.table, 'sales_order_lines');
  assert.deepEqual([...(parsed?.columns ?? [])].sort(), ['line_number', 'sales_order_id']);
  assert.match(constraintName(parsed!), /UNIQUE\(/);

  const values = offendingValues(duplicate as never, parsed!);
  assert.equal(values.length, 1);
  assert.equal(values[0]?.sales_order_id, 'SO-001');
  assert.equal(values[0]?.line_number, 1, 'the rejected values, not just the column names');

  // And the whole thing, as it reaches the log, with a trace id a person quotes.
  const logged: string[] = [];
  const realError = console.error;
  console.error = (...parts: unknown[]) => void logged.push(parts.map(String).join(' '));
  try {
    await logWriteFailure(asClient(c), 'test.commit', 'TRACE-123', duplicate as never, uniqueError);
  } finally {
    console.error = realError;
  }
  assert.equal(logged.length, 1);
  assert.match(logged[0]!, /TRACE-123/);
  assert.match(logged[0]!, /sales_order_lines/, 'the table');
  assert.match(logged[0]!, /UNIQUE\(/, 'the constraint');
  assert.match(logged[0]!, /SO-001/, 'the values');
  c.close();
});

// ---------------------------------------------------------------------------
// Criterion 8: a second upload duplicates nothing.
// ---------------------------------------------------------------------------

test('criterion 8: a second upload creates no duplicate order, line or loading event', async () => {
  const c = await db();
  const first = await validateSoWorkbook(asClient(c), SO_FILE, UPLOAD, CTX);
  await commitSoBatch(asClient(c), first.batchId ?? '', CTX);

  const orders = await count(c, 'SELECT COUNT(*) AS n FROM sales_orders');
  const lines = await count(c, 'SELECT COUNT(*) AS n FROM sales_order_lines');
  const authorities = (
    await c.execute({
      sql: `SELECT loading_authority_at FROM sales_orders WHERE document_number = '115064745'`,
      args: [],
    })
  ).rows[0]?.loading_authority_at;

  // A reprocess rather than a re-upload, so the file-hash duplicate rule does
  // not answer for us: this has to be the commit recognising its own records.
  const second = await validateSoWorkbook(
    asClient(c),
    SO_FILE,
    { ...UPLOAD, reprocessBatchId: first.batchId },
    CTX,
  );
  const result = await commitSoBatch(asClient(c), second.batchId ?? '', CTX);
  assert.equal(result.documentsCreated, 0, 'no order is created twice');
  assert.equal(result.workflowEventsAppended, 0, 'no workflow event is appended twice');

  assert.equal(await count(c, 'SELECT COUNT(*) AS n FROM sales_orders'), orders);
  assert.equal(await count(c, 'SELECT COUNT(*) AS n FROM sales_order_lines'), lines);
  assert.equal(
    (
      await c.execute({
        sql: `SELECT loading_authority_at FROM sales_orders WHERE document_number = '115064745'`,
        args: [],
      })
    ).rows[0]?.loading_authority_at,
    authorities,
    'the chosen loading authority is the same one, because the rule is a rule',
  );
  // And no line gained a second row under any order.
  assert.equal(
    await count(
      c,
      `SELECT COUNT(*) AS n FROM (
         SELECT sales_order_id, line_number FROM sales_order_lines
         GROUP BY sales_order_id, line_number HAVING COUNT(*) > 1)`,
    ),
    0,
  );
  c.close();
});

// ---------------------------------------------------------------------------
// The rule itself, as a function, so it is testable without a database.
// ---------------------------------------------------------------------------

test('the loading-authority rule de-duplicates, orders chronologically, and takes the first', () => {
  const row = (loadingAuthorityAt: string | null) =>
    ({ loadingAuthorityAt }) as unknown as Parameters<typeof loadingAuthorities>[0][number];

  // The cross-product shape: the same authority arriving twice is one event.
  assert.deepEqual(
    loadingAuthorities([
      row('2026-05-23 10:47:46'),
      row('2026-05-23 10:47:45'),
      row('2026-05-23 10:47:46'),
    ]),
    ['2026-05-23 10:47:45', '2026-05-23 10:47:46'],
  );
  assert.equal(
    earliestLoadingAuthority([row('2026-06-12 09:44:34'), row('2026-05-23 10:47:45')]),
    '2026-05-23 10:47:45',
  );
  // A row that carries no authority contributes none, rather than a null event.
  assert.deepEqual(loadingAuthorities([row(null), row(null)]), []);
  assert.equal(earliestLoadingAuthority([row(null)]), null);
});
