/**
 * The extract landing tables, and reprocessing a batch that never finished.
 *
 * Named extractLanding to keep it clear of landing.test.ts, which is about
 * where a signed-in user lands and has nothing to do with extracts.
 *
 * WHAT THE LANDING IS FOR. `import_rows` records what HAPPENED to a row. The
 * landing tables record what the row SAID, one column per header, so a
 * question about the source data is a query rather than a hunt for the
 * original spreadsheet. Every value goes somewhere: a header with a column of
 * its own goes there, a header without one goes to `extra_json` and is named
 * in the preview. Nothing is dropped in silence.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as XLSX from 'xlsx';
import { createTestDb, type TestClient } from './support/db.ts';
import { seedHass, SEED } from './support/hassSeed.ts';
import { countRoundTrips, CLOUDFLARE_FREE_SUBREQUEST_LIMIT } from './support/subrequestBudget.ts';
import { validatePoWorkbook } from '../../src/lib/cms/import/poImport.ts';
import { validateSoWorkbook } from '../../src/lib/cms/import/soImport.ts';
import { receiveUpload, reprocessBatch } from '../../src/lib/cms/import/uploadCentre.ts';
import { columnNameFor } from '../../src/lib/cms/import/landing.ts';
import {
  resetCaseEventHandlers,
  resetLeadEventHandlers,
  resetSlaWiring,
} from '../../src/lib/cms/service/events.ts';

const here = dirname(fileURLToPath(import.meta.url));
const SO_FILE = new Uint8Array(readFileSync(join(here, 'support', 'SO-Ver1.xls')));
const PO_FILE = new Uint8Array(readFileSync(join(here, 'support', 'PO-Ver1.xls')));
const CTX = {
  actorUserId: SEED.admin,
  ip: '10.0.0.10',
  userAgent: 'HassCMS Test',
  now: new Date('2026-08-27T10:00:00Z'),
} as const;

async function seeded(): Promise<TestClient> {
  const c = createTestDb();
  await seedHass(c);
  resetCaseEventHandlers();
  resetLeadEventHandlers();
  resetSlaWiring();
  return c;
}
const count = (c: TestClient, sql: string) =>
  Number((c.raw.prepare(sql).get() as Record<string, unknown>).n);
const columns = (c: TestClient, table: string) =>
  (c.raw.prepare(`PRAGMA table_info(${table})`).all() as Record<string, unknown>[]).length;

test('the header to column rule is lower case with underscores', () => {
  assert.equal(columnNameFor('DOCUMENT_NUMBER'), 'document_number');
  assert.equal(columnNameFor('purchase Number'), 'purchase_number');
  assert.equal(columnNameFor('  Req Description  '), 'req_description');
});

test('every purchase order row lands, in a table of 36 columns', async () => {
  const c = await seeded();
  const counted = countRoundTrips(c);
  const result = await validatePoWorkbook(
    counted.db as never,
    PO_FILE,
    {
      filename: 'PO-Ver1.xls',
      uploadedBy: SEED.admin,
      sourceSystemId: 'SRC-ORACLE',
      affiliateId: null,
    } as never,
    CTX as never,
  );
  assert.equal(columns(c, 'po_extract_rows'), 36);
  assert.equal(count(c, 'SELECT COUNT(*) AS n FROM po_extract_rows'), 45);
  assert.equal(result.rowsReceived, 45);
  assert.deepEqual(result.unmappedColumns, [], 'the table holds every header this extract has');
  assert.ok(counted.roundTrips() <= CLOUDFLARE_FREE_SUBREQUEST_LIMIT);
  c.close();
});

test('every sales order row lands, and the landing does not cost a round trip per row', async () => {
  const c = await seeded();
  const counted = countRoundTrips(c);
  const result = await validateSoWorkbook(
    counted.db as never,
    SO_FILE,
    { filename: 'SO-Ver1.xls', uploadedBy: SEED.admin, sourceSystemId: 'SRC-ORACLE' } as never,
    CTX as never,
  );
  assert.equal(columns(c, 'so_extract_rows'), 38);
  assert.equal(count(c, 'SELECT COUNT(*) AS n FROM so_extract_rows'), 1386);
  assert.equal(result.rowsReceived, 1386);
  assert.deepEqual(result.unmappedColumns, []);
  // The landing joins the importer's existing chunked writes rather than
  // opening a queue of its own, so 1,386 rows do not become 1,386 trips.
  assert.ok(
    counted.roundTrips() <= CLOUDFLARE_FREE_SUBREQUEST_LIMIT,
    `landing 1,386 rows cost ${counted.roundTrips()} subrequests`,
  );
  // And the values are the workbook's own.
  const first = c.raw
    .prepare(
      `SELECT affiliate, document_number, line_number FROM so_extract_rows
              WHERE source_row_number = 1`,
    )
    .get() as Record<string, unknown>;
  assert.equal(first.affiliate, 'Hass Petroleum Kenya');
  assert.equal(first.document_number, '3988');
  c.close();
});

test('a header with no column of its own lands in extra_json and is reported', async () => {
  const c = await seeded();
  const workbook = XLSX.read(PO_FILE, { type: 'buffer' });
  const grid = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0] ?? ''], {
    header: 1,
    raw: true,
  }) as unknown[][];
  (grid[0] as unknown[]).push('OPERATOR_NOTE');
  for (let i = 1; i < grid.length; i++) (grid[i] as unknown[]).push(`note ${i}`);
  const out = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(out, XLSX.utils.aoa_to_sheet(grid), 'Sheet 1');
  const bytes = new Uint8Array(XLSX.write(out, { type: 'array', bookType: 'xls' }) as ArrayBuffer);

  const result = await validatePoWorkbook(
    c as never,
    bytes,
    {
      filename: 'PO-plus.xls',
      uploadedBy: SEED.admin,
      sourceSystemId: 'SRC-ORACLE',
      affiliateId: null,
    } as never,
    CTX as never,
  );
  assert.deepEqual(result.unmappedColumns, ['OPERATOR_NOTE'], 'a new column announces itself');
  const landed = c.raw
    .prepare(`SELECT extra_json FROM po_extract_rows WHERE source_row_number = 1`)
    .get() as Record<string, unknown>;
  assert.deepEqual(JSON.parse(String(landed.extra_json)), { OPERATOR_NOTE: 'note 1' });
  c.close();
});

test('re-landing a batch replaces its rows rather than duplicating them', async () => {
  const c = await seeded();
  const upload = {
    importType: 'PURCHASE_ORDER',
    filename: 'PO-Ver1.xls',
    bytes: PO_FILE,
    sourceSystemId: 'SRC-ORACLE',
    affiliateId: null,
    reportingPeriodFrom: null,
    reportingPeriodTo: null,
  };
  const first = await receiveUpload(c as never, upload as never, CTX as never);
  assert.equal(count(c, 'SELECT COUNT(*) AS n FROM po_extract_rows'), 45);
  await reprocessBatch(c as never, first.batchId ?? '', CTX as never, async () => PO_FILE);
  assert.equal(
    count(c, 'SELECT COUNT(*) AS n FROM po_extract_rows'),
    45,
    'UNIQUE(import_batch_id, source_row_number) makes a re-landing a replacement',
  );
  c.close();
});

test('a batch stuck at VALIDATING reprocesses to a terminal state, as itself', async () => {
  const c = await seeded();
  const first = await receiveUpload(
    c as never,
    {
      importType: 'PURCHASE_ORDER',
      filename: 'PO-Ver1.xls',
      bytes: PO_FILE,
      sourceSystemId: 'SRC-ORACLE',
      affiliateId: null,
      reportingPeriodFrom: null,
      reportingPeriodTo: null,
    } as never,
    CTX as never,
  );
  const batchId = first.batchId ?? '';
  const before = c.raw
    .prepare(
      `SELECT uploaded_by_user_id, uploaded_at, file_sha256 FROM import_batches WHERE import_batch_id = ?`,
    )
    .get(batchId as never) as Record<string, unknown>;

  // Strand it exactly as the subrequest ceiling used to.
  c.raw
    .prepare(`UPDATE import_batches SET status = 'VALIDATING' WHERE import_batch_id = ?`)
    .run(batchId as never);
  c.raw.prepare(`DELETE FROM import_rows WHERE import_batch_id = ?`).run(batchId as never);
  c.raw.prepare(`DELETE FROM po_extract_rows WHERE import_batch_id = ?`).run(batchId as never);

  const batchesBefore = count(c, 'SELECT COUNT(*) AS n FROM import_batches');
  const canonicalBefore = count(c, 'SELECT COUNT(*) AS n FROM purchase_orders');
  const outcome = await reprocessBatch(c as never, batchId, CTX as never, async () => PO_FILE);

  assert.equal(outcome.batchId, batchId, 'the same batch, not a new one');
  assert.equal(outcome.previousStatus, 'VALIDATING');
  assert.equal(outcome.newStatus, 'READY', 'and it reaches a terminal state');
  assert.equal(
    count(c, 'SELECT COUNT(*) AS n FROM import_batches'),
    batchesBefore,
    'no duplicate batch is created',
  );
  assert.equal(
    count(c, 'SELECT COUNT(*) AS n FROM purchase_orders'),
    canonicalBefore,
    'and nothing canonical is written by a reprocess',
  );
  assert.equal(count(c, `SELECT COUNT(*) AS n FROM po_extract_rows`), 45);
  const after = c.raw
    .prepare(
      `SELECT uploaded_by_user_id, uploaded_at, file_sha256 FROM import_batches WHERE import_batch_id = ?`,
    )
    .get(batchId as never) as Record<string, unknown>;
  assert.deepEqual(after, before, 'the identity, uploader, timestamp and hash are untouched');

  const audit = c.raw
    .prepare(
      `SELECT after_json FROM audit_events WHERE entity_id = ? AND event_type = 'IMPORT_REPROCESSED'`,
    )
    .get(batchId as never) as Record<string, unknown>;
  assert.deepEqual(JSON.parse(String(audit.after_json)), {
    previousStatus: 'VALIDATING',
    newStatus: 'READY',
  });
  c.close();
});

test('reprocessing is refused on an imported batch', async () => {
  const c = await seeded();
  const first = await receiveUpload(
    c as never,
    {
      importType: 'PURCHASE_ORDER',
      filename: 'PO-Ver1.xls',
      bytes: PO_FILE,
      sourceSystemId: 'SRC-ORACLE',
      affiliateId: null,
      reportingPeriodFrom: null,
      reportingPeriodTo: null,
    } as never,
    CTX as never,
  );
  const batchId = first.batchId ?? '';
  c.raw
    .prepare(`UPDATE import_batches SET status = 'IMPORTED' WHERE import_batch_id = ?`)
    .run(batchId as never);
  const outcome = await reprocessBatch(c as never, batchId, CTX as never, async () => PO_FILE);
  assert.equal(outcome.ok, false);
  assert.match(String(outcome.reason), /already been imported/);
  const status = (
    c.raw
      .prepare(`SELECT status FROM import_batches WHERE import_batch_id = ?`)
      .get(batchId as never) as Record<string, unknown>
  ).status;
  assert.equal(status, 'IMPORTED', 'and the batch is left exactly as it was');
  c.close();
});

test('with no file storage connected, a reprocess still ends terminal', async () => {
  const c = await seeded();
  const first = await receiveUpload(
    c as never,
    {
      importType: 'PURCHASE_ORDER',
      filename: 'PO-Ver1.xls',
      bytes: PO_FILE,
      sourceSystemId: 'SRC-ORACLE',
      affiliateId: null,
      reportingPeriodFrom: null,
      reportingPeriodTo: null,
    } as never,
    CTX as never,
  );
  const batchId = first.batchId ?? '';
  c.raw
    .prepare(`UPDATE import_batches SET status = 'VALIDATING' WHERE import_batch_id = ?`)
    .run(batchId as never);
  // The default loader: this product has no file storage, so the bytes are not
  // retrievable. That is a rejection with a reason, not a batch left stranded.
  const outcome = await reprocessBatch(c as never, batchId, CTX as never);
  assert.equal(outcome.newStatus, 'REJECTED');
  assert.match(String(outcome.reason), /file storage is not connected/);
  c.close();
});
