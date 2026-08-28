/**
 * Phase 19: the unified Upload Centre, end to end with both real files.
 *
 * The acceptance the build asks for is a sequence rather than a list of
 * units: upload, validate, review, commit, open the record, upload a later
 * changed extract, prove the snapshot, the absent duplicate and the single
 * appended event, then send the identical file again and watch the hash
 * refuse it. These tests are that sequence, run against SO-Ver1.xls and
 * PO-Ver1.xls rather than against a fixture written to pass.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as XLSX from 'xlsx';
import { createTestDb, type TestClient } from './support/db.ts';
import { seedHass, SEED } from './support/hassSeed.ts';
import { parseWorkbook, cellToIdentifier } from '../../src/lib/cms/import/workbook.ts';
import { insertSnapshot, SALES_ORDER_SNAPSHOT } from '../../src/lib/cms/import/snapshots.ts';
import {
  receiveUpload,
  commitBatch,
  revalidateBatch,
  listBatches,
  listUnresolvedActors,
  mapUnresolvedActor,
  exceptionQueues,
  inspectRow,
  dataQuality,
  sniffWorkbook,
  safeFilename,
  escapeForDisplay,
  MAX_UPLOAD_BYTES,
} from '../../src/lib/cms/import/uploadCentre.ts';
import {
  canUploadImportType,
  IMPORTS_UPLOAD,
  SALES_ORDER_UPLOAD,
  PURCHASE_ORDER_UPLOAD,
  SALES_ORDER_VIEW,
  IMPORTS_VIEW,
} from '../../src/lib/cms/permissions.ts';
import {
  resetCaseEventHandlers,
  resetLeadEventHandlers,
  resetSlaWiring,
} from '../../src/lib/cms/service/events.ts';

const here = dirname(fileURLToPath(import.meta.url));
const SO_FILE = readFileSync(join(here, 'support', 'SO-Ver1.xls'));
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
const asClient = (c: TestClient) => c as unknown as Parameters<typeof receiveUpload>[0];

const soUpload = (bytes: Uint8Array, filename = 'SO-Ver1.xls') => ({
  importType: 'SALES_ORDER' as const,
  sourceSystemId: 'SRC-EXCEL',
  affiliateId: null,
  filename,
  reportingPeriodFrom: '2026-06-01',
  reportingPeriodTo: '2026-06-30',
  bytes,
});
const poUpload = (bytes: Uint8Array, filename = 'PO-Ver1.xls') => ({
  importType: 'PURCHASE_ORDER' as const,
  sourceSystemId: 'SRC-EXCEL',
  affiliateId: 'AFF-KE',
  filename,
  reportingPeriodFrom: null,
  reportingPeriodTo: null,
  bytes,
});

/** Map one real sales order document's master data, as an administrator would. */
async function mapSoMasterData(c: TestClient) {
  const sheet = parseWorkbook(SO_FILE);
  const byDoc = new Map<string, Record<string, unknown>[]>();
  for (const row of sheet.rows) {
    const doc = cellToIdentifier(row.DOCUMENT_NUMBER) ?? '';
    byDoc.set(doc, [...(byDoc.get(doc) ?? []), row]);
  }
  let best = '';
  let max = 0;
  for (const [doc, rows] of byDoc) {
    if (rows.length > max) {
      max = rows.length;
      best = doc;
    }
  }
  const rows = byDoc.get(best) ?? [];
  const customerCode = String(rows[0]?.CUSTOMER_CODE ?? '');
  await c.execute({
    sql: `INSERT INTO accounts (account_id, account_name, account_type, oracle_customer_code,
            country_id, affiliate_id, status, created_at, updated_at)
          VALUES ('ACC-IMP', 'Imported Test Customer', 'CUSTOMER', ?, 'CTR-KE', 'AFF-KE',
                  'ACTIVE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    args: [customerCode],
  });
  const items = [...new Set(rows.map((r) => String(r.ORDERED_ITEM ?? '')))];
  for (const [index, item] of items.entries()) {
    await c.execute({
      sql: `INSERT INTO products (product_id, product_code, product_name, product_category_id,
              unit_of_measure, active, created_at)
            VALUES (?, ?, ?, 'PC-LUBE', 'UNIT', 1, CURRENT_TIMESTAMP)`,
      args: [`PROD-IMP-${index}`, item, `Mapped item ${item}`],
    });
  }
  return { documentNumber: best, customerCode };
}

/** The same file with one cell edited, saved back through SheetJS. */
function editedSalesOrderFile(documentNumber: string): Buffer {
  const book = XLSX.read(SO_FILE, { type: 'buffer' });
  const name = book.SheetNames[0] ?? '';
  const sheet = book.Sheets[name];
  const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true });
  const headers = (grid[0] ?? []).map((h) => String(h ?? '').trim());
  const documentColumn = headers.indexOf('DOCUMENT_NUMBER');
  const invoiceColumn = headers.indexOf('INVOICE_CREATION_DATE');
  for (const line of grid.slice(1)) {
    if (!Array.isArray(line)) continue;
    if (cellToIdentifier(line[documentColumn]) !== documentNumber) continue;
    const current = line[invoiceColumn];
    if (typeof current === 'number') line[invoiceColumn] = current + 1;
  }
  const rebuilt = XLSX.utils.aoa_to_sheet(grid);
  const out = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(out, rebuilt, name);
  return XLSX.write(out, { bookType: 'biff8', type: 'buffer' }) as Buffer;
}

// ---------------------------------------------------------------------------

test('a file is judged by its content, its name is defused, and a formula is never re-presented live', () => {
  assert.equal(sniffWorkbook(new Uint8Array(SO_FILE)).kind, 'XLS');
  assert.equal(sniffWorkbook(new Uint8Array(PO_FILE)).kind, 'XLS');

  // A renamed executable is refused before any parser sees it.
  const notAWorkbook = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);
  const sniffed = sniffWorkbook(notAWorkbook);
  assert.equal(sniffed.ok, false);
  assert.ok(sniffed.problem?.includes('not an Excel workbook'));
  assert.equal(sniffWorkbook(new Uint8Array(0)).ok, false);
  assert.equal(sniffWorkbook(new Uint8Array(MAX_UPLOAD_BYTES + 1)).ok, false);

  // Path traversal cannot survive the filename.
  assert.equal(safeFilename('../../../etc/passwd'), 'passwd');
  assert.equal(safeFilename('C:\\Windows\\System32\\evil.xls'), 'evil.xls');
  assert.equal(safeFilename('   '), 'upload.xls');

  // Formula injection is neutralised where a value is shown again.
  assert.equal(escapeForDisplay('=cmd|calc'), "'=cmd|calc");
  assert.equal(escapeForDisplay('+1+1'), "'+1+1");
  assert.equal(escapeForDisplay('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(escapeForDisplay('-2'), "'-2");
  assert.equal(escapeForDisplay('AGO'), 'AGO');
});

test('an upload needs the Upload Centre code and the data type code, never a title', () => {
  const financeReader = [IMPORTS_VIEW, SALES_ORDER_VIEW];
  assert.equal(canUploadImportType(financeReader, 'SALES_ORDER'), false);

  const halfGranted = [IMPORTS_UPLOAD, PURCHASE_ORDER_UPLOAD];
  assert.equal(canUploadImportType(halfGranted, 'PURCHASE_ORDER'), true);
  assert.equal(
    canUploadImportType(halfGranted, 'SALES_ORDER'),
    false,
    'the purchase order door being open never opens the sales order one',
  );

  const typeOnly = [SALES_ORDER_UPLOAD];
  assert.equal(canUploadImportType(typeOnly, 'SALES_ORDER'), false);
});

test('the sales order file goes upload, validate, review, commit, and the record opens', async () => {
  const c = await db();
  const mapped = await mapSoMasterData(c);

  const ordersBefore = await c.execute('SELECT COUNT(*) AS n FROM sales_orders');

  const outcome = await receiveUpload(asClient(c), soUpload(new Uint8Array(SO_FILE)), CTX);
  assert.equal(outcome.stage, 'READY');
  assert.equal(outcome.summary?.rowsReceived, 1386);
  assert.equal(outcome.summary?.uniqueDocuments, 662);
  assert.notEqual(outcome.summary?.rowsReceived, outcome.summary?.uniqueDocuments);
  assert.equal(outcome.report.length, 31);
  // The stated reporting period is the operator's claim and is kept as given.
  const stated = (await listBatches(asClient(c), 5)).find((b) => b.batchId === outcome.batchId);
  assert.equal(stated?.reportingPeriodFrom, '2026-06-01');
  assert.equal(stated?.reportingPeriodTo, '2026-06-30');
  assert.ok(outcome.unresolvedCustomers.length > 0, 'the first real month is mostly exceptions');

  // Validation wrote nothing canonical: the order table is exactly as it was.
  const afterValidation = await c.execute('SELECT COUNT(*) AS n FROM sales_orders');
  assert.equal(Number(afterValidation.rows[0]?.n), Number(ordersBefore.rows[0]?.n));

  const batchId = outcome.batchId ?? '';
  const queues = await exceptionQueues(asClient(c), batchId);
  assert.ok(queues.some((q) => q.queue === 'Unresolved customer'));

  const committed = await commitBatch(asClient(c), batchId, CTX);
  assert.equal(committed.status, 'PARTIAL', 'most documents have no mapped customer yet');
  assert.ok(committed.documentsCreated >= 1);
  assert.ok(committed.documentsSkipped > 0);
  assert.ok(
    committed.skippedReasons.length > 0,
    'PARTIAL states what did not import and why, never only "Upload successful"',
  );

  const order = await c.execute({
    sql: `SELECT sales_order_id, status, currency_code, order_value FROM sales_orders WHERE document_number = ?`,
    args: [mapped.documentNumber],
  });
  assert.equal(order.rows.length, 1);
  assert.equal(order.rows[0]?.currency_code, null);
  assert.equal(order.rows[0]?.order_value, null);

  const audits = await c.execute({
    sql: `SELECT event_type, after_json FROM audit_events
          WHERE entity_type = 'IMPORT_BATCH' AND entity_id = ? ORDER BY event_at`,
    args: [batchId],
  });
  const types = audits.rows.map((r) => String(r.event_type));
  assert.deepEqual(types, ['IMPORT_UPLOADED', 'IMPORT_VALIDATED', 'IMPORT_PARTIAL']);
  for (const row of audits.rows) {
    const after = String(row.after_json ?? '');
    assert.ok(
      !after.includes('CUSTOMER_NAME') && !after.includes('ORDERED_ITEM'),
      'no raw row ever reaches audit_events; the rows already live in import_rows',
    );
  }

  // The aggregate notification, one for the batch, never one per row.
  const notifications = await c.execute({
    sql: `SELECT COUNT(*) AS n FROM notifications WHERE notification_type = 'IMPORT_EXCEPTION'
          AND entity_id = ?`,
    args: [batchId],
  });
  assert.equal(Number(notifications.rows[0]?.n), 1);
});

test('a later changed extract writes a new snapshot, no second order and one appended event', async () => {
  const c = await db();
  const mapped = await mapSoMasterData(c);
  const first = await receiveUpload(asClient(c), soUpload(new Uint8Array(SO_FILE)), CTX);
  await commitBatch(asClient(c), first.batchId ?? '', CTX);

  const orderId = String(
    (
      await c.execute({
        sql: `SELECT sales_order_id FROM sales_orders WHERE document_number = ?`,
        args: [mapped.documentNumber],
      })
    ).rows[0]?.sales_order_id,
  );
  const eventsBefore = await c.execute({
    sql: `SELECT COUNT(*) AS n FROM workflow_stage_instances wsi
          JOIN workflow_instances wi ON wi.workflow_instance_id = wsi.workflow_instance_id
          WHERE wi.entity_type = 'SALES_ORDER' AND wi.entity_id = ?`,
    args: [orderId],
  });

  const changed = editedSalesOrderFile(mapped.documentNumber);
  const second = await receiveUpload(
    asClient(c),
    soUpload(new Uint8Array(changed), 'SO-Ver1-July.xls'),
    CTX,
  );
  assert.equal(second.stage, 'READY');
  assert.ok((second.summary?.rowsChanged ?? 0) > 0, 'the edited rows are CHANGED');
  await commitBatch(asClient(c), second.batchId ?? '', CTX);

  const orders = await c.execute({
    sql: `SELECT COUNT(*) AS n FROM sales_orders WHERE document_number = ?`,
    args: [mapped.documentNumber],
  });
  assert.equal(Number(orders.rows[0]?.n), 1, 'a changed extract never mints a second order');

  const snapshots = await c.execute({
    sql: `SELECT version_no, is_current FROM record_snapshots
          WHERE entity_type = 'SALES_ORDER' AND entity_id = ? ORDER BY version_no`,
    args: [orderId],
  });
  assert.deepEqual(
    snapshots.rows.map((r) => [Number(r.version_no), Number(r.is_current)]),
    [
      [1, 0],
      [2, 1],
    ],
    'the old snapshot is preserved and is no longer current',
  );
  const pointer = await c.execute({
    sql: `SELECT latest_snapshot_id FROM sales_orders WHERE sales_order_id = ?`,
    args: [orderId],
  });
  const current = await c.execute({
    sql: `SELECT snapshot_id FROM record_snapshots WHERE entity_type = 'SALES_ORDER'
          AND entity_id = ? AND is_current = 1`,
    args: [orderId],
  });
  assert.equal(String(pointer.rows[0]?.latest_snapshot_id), String(current.rows[0]?.snapshot_id));

  const eventsAfter = await c.execute({
    sql: `SELECT COUNT(*) AS n FROM workflow_stage_instances wsi
          JOIN workflow_instances wi ON wi.workflow_instance_id = wsi.workflow_instance_id
          WHERE wi.entity_type = 'SALES_ORDER' AND wi.entity_id = ?`,
    args: [orderId],
  });
  assert.equal(
    Number(eventsAfter.rows[0]?.n),
    Number(eventsBefore.rows[0]?.n),
    'nothing already recorded is appended twice',
  );
});

test('the purchase order file runs the same path and the exact file is then refused', async () => {
  const c = await db();
  const outcome = await receiveUpload(asClient(c), poUpload(new Uint8Array(PO_FILE)), CTX);
  assert.equal(outcome.stage, 'READY');
  assert.equal(outcome.summary?.rowsReceived, 45);
  assert.equal(outcome.summary?.uniqueDocuments, 45);
  assert.equal(outcome.approvalLevelDistribution.find((d) => d.level === 4)?.orders, 45);
  assert.equal(outcome.report.length, 29);

  const committed = await commitBatch(asClient(c), outcome.batchId ?? '', CTX);
  assert.equal(committed.status, 'IMPORTED');
  assert.equal(committed.documentsCreated, 45);
  assert.equal(committed.linesWritten, 0);

  // The same bytes under a different name are still the same file.
  const again = await receiveUpload(
    asClient(c),
    poUpload(new Uint8Array(PO_FILE), 'purchase-orders-final-FINAL.xls'),
    CTX,
  );
  assert.equal(again.stage, 'DUPLICATE');
  assert.equal(again.duplicate?.batchId, outcome.batchId);
  assert.equal(again.duplicate?.filename, 'PO-Ver1.xls');
  assert.equal(again.duplicate?.uploadedBy, 'Catherine Mwangi');

  const batches = await listBatches(asClient(c), 10);
  const mine = batches.filter((b) => b.uploadedAt >= '2026-08-27');
  assert.equal(mine.length, 1, 'the refused upload created no batch');
  assert.equal(mine[0]?.rowsReceived, 45);
  assert.equal(mine[0]?.uniqueDocuments, 45);
  // The operator stated no period for this one, so the batch carries the
  // range the file itself covers, derived rather than invented.
  assert.equal(mine[0]?.reportingPeriodFrom, '2026-05-01 06:42:45');
  assert.ok((mine[0]?.reportingPeriodTo ?? '') > (mine[0]?.reportingPeriodFrom ?? ''));
});

test('a name mapped once is recognised on the next upload, with no re-upload of the first file', async () => {
  const c = await db();
  const first = await receiveUpload(asClient(c), poUpload(new Uint8Array(PO_FILE)), CTX);
  await commitBatch(asClient(c), first.batchId ?? '', CTX);

  const queue = await listUnresolvedActors(asClient(c));
  const gabriel = queue.find((a) => a.username === 'MR. MUSEMBI GABRIEL MUSYOKA');
  assert.notEqual(gabriel, undefined);
  assert.equal(gabriel?.affiliateId, 'AFF-KE');
  assert.ok((gabriel?.affectedRows ?? 0) > 0);

  const usersBefore = await c.execute('SELECT COUNT(*) AS n FROM users');
  const mapping = await mapUnresolvedActor(
    asClient(c),
    { unresolvedActorId: gabriel?.unresolvedActorId ?? '', userId: 'USR-GAB', revalidate: true },
    CTX,
  );
  assert.equal(mapping.ok, true);
  const usersAfter = await c.execute('SELECT COUNT(*) AS n FROM users');
  assert.equal(
    Number(usersAfter.rows[0]?.n),
    Number(usersBefore.rows[0]?.n),
    'mapping a name never creates a user',
  );
  assert.ok((mapping.ok && mapping.revalidated?.rowsExamined) ?? 0 > 0);

  // The revalidation reached the stages the first commit left unassigned,
  // without the file being sent again.
  const assigned = await c.execute(`
    SELECT COUNT(*) AS n FROM workflow_stage_instances
    WHERE assigned_user_id = 'USR-GAB' AND action_notes LIKE '%approval level 2'`);
  assert.equal(Number(assigned.rows[0]?.n), 40);

  const closed = await c.execute({
    sql: `SELECT status, mapped_user_id, resolved_by_user_id FROM unresolved_actors
          WHERE unresolved_actor_id = ?`,
    args: [gabriel?.unresolvedActorId],
  });
  assert.equal(String(closed.rows[0]?.status), 'MAPPED');
  assert.equal(String(closed.rows[0]?.mapped_user_id), 'USR-GAB');

  const audited = await c.execute(
    `SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'UNRESOLVED_ACTOR_MAPPED'`,
  );
  assert.equal(Number(audited.rows[0]?.n), 1);

  // A second, later file carrying the same name resolves it with nobody
  // touching the mapping again.
  const later = await c.execute({
    sql: `SELECT COUNT(*) AS n FROM source_identities WHERE external_username = ?`,
    args: ['Mr. Musembi Gabriel Musyoka'],
  });
  assert.equal(Number(later.rows[0]?.n), 1);
});

test('revalidation reprocesses only eligible rows and keeps the batch provenance', async () => {
  const c = await db();
  const outcome = await receiveUpload(asClient(c), soUpload(new Uint8Array(SO_FILE)), CTX);
  const batchId = outcome.batchId ?? '';
  const before = await c.execute({
    sql: `SELECT row_status, COUNT(*) AS n FROM import_rows WHERE import_batch_id = ? GROUP BY row_status`,
    args: [batchId],
  });
  const unresolvedBefore = Number(
    before.rows.find((r) => String(r.row_status) === 'UNRESOLVED')?.n ?? 0,
  );
  assert.ok(unresolvedBefore > 0);

  // The administrator maps one customer, and nothing else changes.
  const anyCode = await c.execute({
    sql: `SELECT source_record_key, raw_json FROM import_rows
          WHERE import_batch_id = ? AND row_status = 'UNRESOLVED' LIMIT 1`,
    args: [batchId],
  });
  const raw = JSON.parse(String(anyCode.rows[0]?.raw_json)) as Record<string, unknown>;
  await c.execute({
    sql: `INSERT INTO accounts (account_id, account_name, account_type, oracle_customer_code,
            country_id, affiliate_id, status, created_at, updated_at)
          VALUES ('ACC-LATE', 'Late Mapped Customer', 'CUSTOMER', ?, 'CTR-KE', 'AFF-KE',
                  'ACTIVE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    args: [String(raw.CUSTOMER_CODE)],
  });
  await c.execute({
    sql: `INSERT INTO products (product_id, product_code, product_name, product_category_id,
            unit_of_measure, active, created_at)
          VALUES ('PROD-LATE', ?, 'Late mapped item', 'PC-LUBE', 'UNIT', 1, CURRENT_TIMESTAMP)`,
    args: [String(raw.ORDERED_ITEM)],
  });

  const result = await revalidateBatch(asClient(c), batchId, CTX);
  assert.equal(result.rowsExamined, unresolvedBefore, 'only the unresolved rows are examined');
  assert.ok(result.rowsResolved > 0);
  assert.ok(result.rowsStillUnresolved > 0, 'rows without a mapping keep waiting');

  const after = await c.execute({
    sql: `SELECT COUNT(*) AS n FROM import_rows WHERE import_batch_id = ?`,
    args: [batchId],
  });
  assert.equal(Number(after.rows[0]?.n), 1386, 'the batch keeps every one of its rows');
  const stillMine = await c.execute({
    sql: `SELECT COUNT(*) AS n FROM import_rows WHERE import_batch_id = ? AND source_row_number = 1`,
    args: [batchId],
  });
  assert.equal(Number(stillMine.rows[0]?.n), 1, 'provenance is untouched');

  const reprocessed = await c.execute(
    `SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'IMPORT_ROW_REPROCESSED'`,
  );
  assert.equal(Number(reprocessed.rows[0]?.n), 1);
});

test('the row inspector hides source values from a reader without the module', async () => {
  const c = await db();
  const outcome = await receiveUpload(asClient(c), poUpload(new Uint8Array(PO_FILE)), CTX);
  const row = await c.execute({
    sql: `SELECT import_row_id FROM import_rows WHERE import_batch_id = ? LIMIT 1`,
    args: [outcome.batchId],
  });
  const rowId = String(row.rows[0]?.import_row_id);

  const withModule = await inspectRow(asClient(c), rowId, [
    'DATA.IMPORTS.VIEW',
    'ORDERS.PURCHASE_ORDER.VIEW',
  ]);
  assert.notEqual(withModule?.rawSource, null);
  assert.equal(withModule?.withheld, null);
  assert.ok(Object.keys(withModule?.rawSource ?? {}).includes('NATURE'));

  const withoutModule = await inspectRow(asClient(c), rowId, ['DATA.IMPORTS.VIEW']);
  assert.notEqual(withoutModule, null, 'the row itself is still visible');
  assert.equal(withoutModule?.rawSource, null);
  assert.ok(withoutModule?.withheld?.includes('view permission'));
  assert.equal(withoutModule?.rowStatus, 'NEW');

  // A sales order view grant does not open purchase order rows.
  const wrongModule = await inspectRow(asClient(c), rowId, [
    'DATA.IMPORTS.VIEW',
    'ORDERS.SALES_ORDER.VIEW',
  ]);
  assert.equal(wrongModule?.rawSource, null);

  // And no import permission at all sees nothing.
  assert.equal(await inspectRow(asClient(c), rowId, ['ORDERS.PURCHASE_ORDER.VIEW']), null);
});

test('no file is deleted, and the quality panel counts what is waiting', async () => {
  const c = await db();
  const outcome = await receiveUpload(asClient(c), soUpload(new Uint8Array(SO_FILE)), CTX);
  await commitBatch(asClient(c), outcome.batchId ?? '', CTX);

  const file = await c.execute({
    sql: `SELECT original_filename, sha256, storage_key, size_bytes FROM file_objects
          WHERE storage_key LIKE ?`,
    args: [`imports/${outcome.batchId}/%`],
  });
  assert.equal(file.rows.length, 1);
  assert.equal(String(file.rows[0]?.original_filename), 'SO-Ver1.xls');
  assert.equal(String(file.rows[0]?.sha256), outcome.fileSha256);
  assert.equal(Number(file.rows[0]?.size_bytes), SO_FILE.byteLength);

  const quality = await dataQuality(asClient(c));
  assert.ok(quality.unresolvedCustomerRows > 0);
  assert.equal(quality.recentPartialImports.length, 1);
  assert.equal(quality.recentPartialImports[0]?.batchId, outcome.batchId);
});

test('a rejected upload writes nothing at all', async () => {
  const c = await db();
  const notAWorkbook = new Uint8Array([0x4d, 0x5a, 0x90, 0x00]);
  const refused = await receiveUpload(asClient(c), soUpload(notAWorkbook, 'payload.xls'), CTX);
  assert.equal(refused.stage, 'REJECTED');
  assert.equal(refused.batchId, null);

  // A purchase order upload with no affiliate is NOT a rejection any more: the
  // extract carries no affiliate column, so the batch is Group scope. That
  // case is proved in poImport.test.ts; what belongs here is only what a
  // genuine rejection must not leave behind.

  const unknownSource = await receiveUpload(
    asClient(c),
    { ...soUpload(new Uint8Array(SO_FILE)), sourceSystemId: 'SRC-NOWHERE' },
    CTX,
  );
  assert.equal(unknownSource.stage, 'REJECTED');

  const batches = await listBatches(asClient(c), 20);
  assert.equal(batches.filter((b) => b.uploadedAt >= '2026-08-27').length, 0);
  const files = await c.execute(
    `SELECT COUNT(*) AS n FROM file_objects WHERE uploaded_at >= '2026-08-27'`,
  );
  assert.equal(Number(files.rows[0]?.n), 0);
});

test('a broken row leaves no half-written document, and the rest of the batch still lands', async () => {
  const c = await db();
  // Two documents in the real file's shape. The second carries line number 0,
  // which the sales_order_lines CHECK refuses, so its document cannot be
  // written at all.
  const headers = parseWorkbook(SO_FILE).headers;
  const template = parseWorkbook(SO_FILE).rows[0] ?? {};
  const row = (documentNumber: string, lineNumber: number) => {
    const record: Record<string, unknown> = { ...template };
    record.DOCUMENT_NUMBER = documentNumber;
    record.LINE_NUMBER = lineNumber;
    return headers.map((header) => record[header] ?? null);
  };
  const sheet = XLSX.utils.aoa_to_sheet([headers, row('SYN-GOOD', 1), row('SYN-BROKEN', 0)]);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, 'Sheet 1');
  const file = XLSX.write(book, { bookType: 'biff8', type: 'buffer' }) as Buffer;

  // Both documents share the template's customer and item, so both resolve.
  await c.execute({
    sql: `INSERT INTO accounts (account_id, account_name, account_type, oracle_customer_code,
            country_id, affiliate_id, status, created_at, updated_at)
          VALUES ('ACC-SYN', 'Synthetic Customer', 'CUSTOMER', ?, 'CTR-KE', 'AFF-KE',
                  'ACTIVE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    args: [String(template.CUSTOMER_CODE)],
  });
  await c.execute({
    sql: `INSERT INTO products (product_id, product_code, product_name, product_category_id,
            unit_of_measure, active, created_at)
          VALUES ('PROD-SYN', ?, 'Synthetic item', 'PC-LUBE', 'UNIT', 1, CURRENT_TIMESTAMP)`,
    args: [String(template.ORDERED_ITEM)],
  });

  const outcome = await receiveUpload(
    asClient(c),
    soUpload(new Uint8Array(file), 'two-documents.xls'),
    CTX,
  );
  assert.equal(outcome.summary?.uniqueDocuments, 2);

  const committed = await commitBatch(asClient(c), outcome.batchId ?? '', CTX);
  assert.equal(committed.status, 'PARTIAL');
  assert.equal(committed.documentsCreated, 1, 'the sound document still lands');
  assert.equal(committed.documentsSkipped, 1);
  assert.ok(
    committed.skippedReasons.some((entry) => entry.reason.includes('could not be written')),
  );

  const good = await c.execute(
    `SELECT sales_order_id FROM sales_orders WHERE document_number = 'SYN-GOOD'`,
  );
  assert.equal(good.rows.length, 1);
  const broken = await c.execute(
    `SELECT sales_order_id FROM sales_orders WHERE document_number = 'SYN-BROKEN'`,
  );
  assert.equal(broken.rows.length, 0, 'nothing of the broken document was written');
  const brokenLines = await c.execute(`
    SELECT COUNT(*) AS n FROM sales_order_lines WHERE line_number = 0`);
  assert.equal(Number(brokenLines.rows[0]?.n), 0);
  const brokenSnapshot = await c.execute(`
    SELECT COUNT(*) AS n FROM record_snapshots WHERE source_record_key LIKE '%SYN-BROKEN%'`);
  assert.equal(Number(brokenSnapshot.rows[0]?.n), 0, 'and no snapshot claims it exists');

  // The failure is on the rows it belongs to, in words.
  const rows = await c.execute({
    sql: `SELECT row_status, error_message FROM import_rows
          WHERE import_batch_id = ? AND source_record_key LIKE '%SYN-BROKEN%'`,
    args: [outcome.batchId],
  });
  assert.equal(String(rows.rows[0]?.row_status), 'REJECTED');
  assert.ok(String(rows.rows[0]?.error_message).includes('could not be written'));
});

test('version_no is guarded by the database, not by the read that chose it', async () => {
  const c = await db();
  const mapped = await mapSoMasterData(c);
  const first = await receiveUpload(asClient(c), soUpload(new Uint8Array(SO_FILE)), CTX);
  await commitBatch(asClient(c), first.batchId ?? '', CTX);
  const orderId = String(
    (
      await c.execute({
        sql: `SELECT sales_order_id FROM sales_orders WHERE document_number = ?`,
        args: [mapped.documentNumber],
      })
    ).rows[0]?.sales_order_id,
  );

  // The guarantee, shown directly: a second row claiming version 1 is refused
  // by UNIQUE(entity_type, entity_id, version_no). That constraint, not the
  // MAX() read, is what makes the number safe.
  await assert.rejects(
    () =>
      c.execute({
        sql: `INSERT INTO record_snapshots
                (snapshot_id, entity_type, entity_id, import_batch_id, source_record_key,
                 version_no, row_hash, snapshot_json, captured_at, is_current)
              VALUES ('SNAP-CLASH', 'SALES_ORDER', ?, ?, 'x', 1, 'h', '{}', '2026-08-27 10:00:00', 0)`,
        args: [orderId, first.batchId],
      }),
    /UNIQUE/i,
  );

  // And the retry, exercised: a competitor takes the next version between
  // this writer's MAX() read and its insert. The first attempt fails on the
  // constraint, the loop reads again and lands on the version after it, so
  // two writers never share a number and neither is lost.
  let stolen = false;
  const racing = {
    execute: async (statement: unknown) => {
      const result = await c.execute(statement as never);
      const sql = String((statement as { sql?: string }).sql ?? '');
      if (!stolen && sql.includes('MAX(version_no)')) {
        stolen = true;
        await c.execute({
          sql: `INSERT INTO record_snapshots
                  (snapshot_id, entity_type, entity_id, import_batch_id, source_record_key,
                   version_no, row_hash, snapshot_json, captured_at, is_current)
                VALUES ('SNAP-RACE', 'SALES_ORDER', ?, ?, 'race', 2, 'h', '{}', '2026-08-27 10:00:00', 0)`,
          args: [orderId, first.batchId],
        });
      }
      return result;
    },
    batch: (statements: unknown, mode: unknown) => c.batch(statements as never, mode as never),
  };

  const snapshotId = await insertSnapshot(
    racing as never,
    SALES_ORDER_SNAPSHOT,
    orderId,
    'AFF-KE|race',
    'hash',
    '{}',
    first.batchId ?? '',
    '2026-08-27 10:00:00',
  );
  assert.equal(stolen, true, 'the competitor did insert between the read and the write');

  const versions = await c.execute({
    sql: `SELECT version_no, snapshot_id, is_current FROM record_snapshots
          WHERE entity_type = 'SALES_ORDER' AND entity_id = ? ORDER BY version_no`,
    args: [orderId],
  });
  assert.deepEqual(
    versions.rows.map((r) => Number(r.version_no)),
    [1, 2, 3],
    'the retry landed on the version after the competitor, and nothing was overwritten',
  );
  const mine = versions.rows.find((r) => String(r.snapshot_id) === snapshotId);
  assert.equal(Number(mine?.version_no), 3);
  assert.equal(
    versions.rows.filter((r) => Number(r.is_current) === 1).length,
    1,
    'exactly one snapshot is current',
  );
});
