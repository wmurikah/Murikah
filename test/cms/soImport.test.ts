/**
 * Phase 17: the sales order importer, against the real SO-Ver1.xls.
 *
 * These tests read the actual extract shipped with the repository, so every
 * measured fact the build was designed around is re-verified on each run:
 * 1,386 rows, 662 documents, one approver, 593 blank credit rows, 6 missing
 * invoice timestamps. The commit tests map one real document's master data
 * and import it, which is exactly the first real month will look like:
 * mostly exceptions, a few resolvable documents, and nothing invented.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as XLSX from 'xlsx';
import { createTestDb, type TestClient } from './support/db.ts';
import { seedHass, SEED } from './support/hassSeed.ts';
import {
  parseWorkbook,
  cellToIdentifier,
  excelSerialToTimestamp,
  hashCanonicalRow,
} from '../../src/lib/cms/import/workbook.ts';
import {
  validateSoWorkbook,
  commitSoBatch,
  verifySourceCompleteness,
  deriveSoStatus,
  varianceComparison,
  SO_HEADER_CLASSIFICATION,
} from '../../src/lib/cms/import/soImport.ts';
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

const db = async (): Promise<TestClient> => {
  const c = createTestDb();
  await seedHass(c);
  resetCaseEventHandlers();
  resetLeadEventHandlers();
  resetSlaWiring();
  return c;
};
const asClient = (c: TestClient) => c as unknown as Parameters<typeof validateSoWorkbook>[0];

const uploadInput = {
  filename: 'SO-Ver1.xls',
  uploadedBy: 'USR-CATH',
  sourceSystemId: 'SRC-EXCEL',
};

/** The 18-line document and its master data, discovered from the file itself. */
function biggestDocument() {
  const sheet = parseWorkbook(SO_FILE);
  const byDoc = new Map<string, Record<string, unknown>[]>();
  for (const row of sheet.rows) {
    const doc = cellToIdentifier(row.DOCUMENT_NUMBER) ?? '';
    const list = byDoc.get(doc) ?? [];
    list.push(row);
    byDoc.set(doc, list);
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
  return {
    documentNumber: best,
    rowCount: max,
    // The extract repeats rows: the 18-row document carries 7 distinct line
    // numbers, each appearing up to three times with identical values. The
    // distinct count is what one order can honestly hold.
    distinctLines: new Set(rows.map((r) => String(r.LINE_NUMBER ?? ''))).size,
    customerCode: String(rows[0]?.CUSTOMER_CODE ?? ''),
    items: [...new Set(rows.map((r) => String(r.ORDERED_ITEM ?? '')))],
  };
}

/** Map one real document's master data, the way an administrator would. */
async function mapDocumentMasterData(c: TestClient, doc: ReturnType<typeof biggestDocument>) {
  await c.execute({
    sql: `INSERT INTO accounts (account_id, account_name, account_type, oracle_customer_code,
            country_id, affiliate_id, status, created_at, updated_at)
          VALUES ('ACC-IMP', 'Imported Test Customer', 'CUSTOMER', ?, 'CTR-KE', 'AFF-KE',
                  'ACTIVE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    args: [doc.customerCode],
  });
  for (const [index, item] of doc.items.entries()) {
    await c.execute({
      sql: `INSERT INTO products (product_id, product_code, product_name, product_category_id,
              unit_of_measure, active, created_at)
            VALUES (?, ?, ?, 'PC-LUBE', 'UNIT', 1, CURRENT_TIMESTAMP)`,
      args: [`PROD-IMP-${index}`, item, `Mapped item ${item}`],
    });
  }
  // SULEKHA becomes a known Oracle identity, mapped to Zuleika.
  await c.execute({
    sql: `INSERT INTO source_identities (source_identity_id, source_system_id, user_id,
            external_username, affiliate_id, active, created_at)
          VALUES ('SID-SUL', 'SRC-ORACLE', 'USR-ZUL', 'SULEKHA', 'AFF-KE', 1, CURRENT_TIMESTAMP)`,
    args: [],
  });
}

// ---------------------------------------------------------------------------
// The file, as it actually is.
// ---------------------------------------------------------------------------

test('the prerequisite is verified with queries before anything imports', async () => {
  const c = await db();
  const verified = await verifySourceCompleteness(asClient(c));
  assert.deepEqual(verified, { ok: true, problems: [] });
  c.close();
});

test('1,386 rows read as 662 orders, never 1,386 orders, and every header is classified', async () => {
  const c = await db();
  const validation = await validateSoWorkbook(asClient(c), SO_FILE, uploadInput, CTX);
  assert.equal(validation.rowsReceived, 1386);
  assert.equal(validation.uniqueDocuments, 662);
  assert.equal(validation.report.length, 31);
  assert.equal(
    validation.report.every((line) => line.treatment !== 'unknown'),
    true,
  );
  assert.equal(Object.keys(SO_HEADER_CLASSIFICATION).length, 31);
  // Rows and documents are different facts, reported separately, always.
  assert.notEqual(validation.rowsReceived, validation.uniqueDocuments);
  // One affiliate, as measured.
  assert.deepEqual(validation.affiliates, ['Hass Petroleum Kenya']);
  c.close();
});

test('numbers normalise: DOCUMENT_NUMBER 3988 stores as the string "3988"', async () => {
  assert.equal(cellToIdentifier(3988), '3988');
  assert.equal(cellToIdentifier('3988.0'), '3988');
  assert.equal(cellToIdentifier(' 3988 '), '3988');
  // And an Excel serial becomes a readable timestamp.
  assert.match(excelSerialToTimestamp(46144.45520833333), /^2026-05-02 10:55:30$/);
});

test('an unknown Oracle customer code creates an exception and no account; an unknown approver creates an unresolved actor and no user', async () => {
  const c = await db();
  const accountsBefore = await c.execute({ sql: 'SELECT COUNT(*) AS n FROM accounts', args: [] });
  const usersBefore = await c.execute({ sql: 'SELECT COUNT(*) AS n FROM users', args: [] });

  const validation = await validateSoWorkbook(asClient(c), SO_FILE, uploadInput, CTX);
  assert.equal(validation.unresolvedCustomers.length > 0, true);
  // SULEKHA is not among the seeded identities: an unresolved actor, once.
  assert.equal(validation.unresolvedUsers.includes('SULEKHA'), true);
  const actors = await c.execute({
    sql: `SELECT COUNT(*) AS n FROM unresolved_actors WHERE external_username = 'SULEKHA' AND status = 'OPEN'`,
    args: [],
  });
  assert.equal(Number(actors.rows[0]?.n), 1);

  const accountsAfter = await c.execute({ sql: 'SELECT COUNT(*) AS n FROM accounts', args: [] });
  const usersAfter = await c.execute({ sql: 'SELECT COUNT(*) AS n FROM users', args: [] });
  assert.equal(Number(accountsAfter.rows[0]?.n), Number(accountsBefore.rows[0]?.n));
  assert.equal(Number(usersAfter.rows[0]?.n), Number(usersBefore.rows[0]?.n));
  c.close();
});

test('an unresolved product is never fuzzy-matched: the row waits as an exception', async () => {
  const c = await db();
  const validation = await validateSoWorkbook(asClient(c), SO_FILE, uploadInput, CTX);
  // The extract's item codes (GHOS50PG and friends) match no product_code.
  assert.equal(validation.unresolvedProducts.length > 0, true);
  const rows = await c.execute({
    sql: `SELECT COUNT(*) AS n FROM import_rows WHERE import_batch_id = ? AND row_status = 'UNRESOLVED'`,
    args: [validation.batchId],
  });
  assert.equal(Number(rows.rows[0]?.n) > 0, true);
  c.close();
});

// ---------------------------------------------------------------------------
// Commit, against one real document with its master data mapped.
// ---------------------------------------------------------------------------

test('the 18-line document imports as one order with its lines, NULL commercial values, and a reconstructed workflow', async () => {
  const c = await db();
  const doc = biggestDocument();
  assert.equal(doc.rowCount, 18);
  assert.equal(doc.distinctLines, 7);
  await mapDocumentMasterData(c, doc);

  const validation = await validateSoWorkbook(asClient(c), SO_FILE, uploadInput, CTX);
  assert.notEqual(validation.batchId, null);
  const result = await commitSoBatch(asClient(c), validation.batchId ?? '', CTX);
  // The mapped customer legitimately owns several documents in the extract,
  // and mapping their items resolves those documents too: each imports.
  // What matters here: at least the 18-line one, and the rest stay skipped.
  assert.equal(result.documentsCreated >= 1, true);
  assert.equal(result.documentsSkipped > 0, true);

  const order = await c.execute({
    sql: `SELECT sales_order_id, document_number, currency_code, order_value, status,
                 credit_approval_required, loaded_at
          FROM sales_orders WHERE document_number = ?`,
    args: [doc.documentNumber],
  });
  assert.equal(order.rows.length, 1);
  const row = order.rows[0] as Record<string, unknown>;
  // NULL, not zero, and no invented currency; loaded_at NULL because the
  // extract has no load timestamp.
  assert.equal(row.currency_code, null);
  assert.equal(row.order_value, null);
  assert.equal(row.loaded_at, null);

  const lines = await c.execute({
    sql: `SELECT COUNT(*) AS n, COUNT(quantity) AS with_quantity FROM sales_order_lines WHERE sales_order_id = ?`,
    args: [String(row.sales_order_id)],
  });
  // 18 source rows, 7 distinct lines: the upsert on (order, line) is what
  // keeps the repeated rows from inflating the order.
  assert.equal(Number(lines.rows[0]?.n), doc.distinctLines);
  assert.equal(Number(lines.rows[0]?.with_quantity), 0);

  // The finance stage exists once, attributed to the mapped SULEKHA identity.
  const stagesResult = await c.execute({
    sql: `SELECT si.status, si.assigned_user_id, ws.stage_code
          FROM workflow_stage_instances si
          JOIN workflow_instances wi ON wi.workflow_instance_id = si.workflow_instance_id
          JOIN workflow_stages ws ON ws.workflow_stage_id = si.workflow_stage_id
          WHERE wi.entity_type = 'SALES_ORDER' AND wi.entity_id = ?`,
    args: [String(row.sales_order_id)],
  });
  const finance = stagesResult.rows.find(
    (s) => String((s as Record<string, unknown>).stage_code) === 'FINANCE_APPROVAL',
  );
  assert.notEqual(finance, undefined);
  assert.equal(String((finance as Record<string, unknown>).assigned_user_id), 'USR-ZUL');

  // Credit stages appear only for rows whose credit columns are populated.
  const creditFlag = Number(row.credit_approval_required);
  const hasCreditStage = stagesResult.rows.some(
    (s) => String((s as Record<string, unknown>).stage_code) === 'CREDIT_CHECK',
  );
  assert.equal(hasCreditStage, creditFlag === 1);
  c.close();
});

test('a harmless Excel reformat produces zero CHANGED rows, and a real change produces exactly one', async () => {
  const c = await db();
  const doc = biggestDocument();
  await mapDocumentMasterData(c, doc);
  const first = await validateSoWorkbook(asClient(c), SO_FILE, uploadInput, CTX);
  await commitSoBatch(asClient(c), first.batchId ?? '', CTX);

  // The identical bytes are refused outright by the file hash, with the
  // previous batch named: a repeated filename is not the rule, the hash is.
  const identical = await validateSoWorkbook(asClient(c), SO_FILE, uploadInput, CTX);
  assert.equal(identical.batchId, null);
  assert.equal(identical.duplicateOfBatchId, first.batchId);

  // A genuine reformat: SheetJS re-writes the workbook, changing the bytes
  // and none of the values. Zero CHANGED rows.
  const reread = XLSX.read(SO_FILE, { type: 'buffer' });
  const reformatted = XLSX.write(reread, { type: 'buffer', bookType: 'biff8' }) as Uint8Array;
  const revalidated = await validateSoWorkbook(
    asClient(c),
    reformatted,
    { ...uploadInput, filename: 'SO-Ver1-reformatted.xls' },
    CTX,
  );
  assert.notEqual(revalidated.batchId, null);
  assert.equal(revalidated.rowsChanged, 0);
  // The resolvable rows now read as exact duplicates; the 18-line document's
  // are among them.
  assert.equal(revalidated.rowsDuplicate >= 18, true);

  // A later extract adding an invoice timestamp: exactly the changed rows
  // change, a new snapshot appears, the old one survives, no second order.
  const grid = XLSX.utils.sheet_to_json<unknown[]>(
    reread.Sheets[reread.SheetNames[0] ?? ''] ?? {},
    {
      header: 1,
      raw: true,
    },
  );
  const headers = grid[0] as string[];
  const docIdx = headers.indexOf('DOCUMENT_NUMBER');
  const invoiceIdx = headers.indexOf('INVOICE_CREATION_DATE');
  let touched = 0;
  for (const line of grid.slice(1)) {
    if (String(line[docIdx]) === doc.documentNumber) {
      line[invoiceIdx] = 46200.5;
      touched += 1;
    }
  }
  const editedSheet = XLSX.utils.aoa_to_sheet(grid as unknown[][]);
  const editedBook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(editedBook, editedSheet, 'Sheet 1');
  const edited = XLSX.write(editedBook, { type: 'buffer', bookType: 'biff8' }) as Uint8Array;

  const editedValidation = await validateSoWorkbook(
    asClient(c),
    edited,
    { ...uploadInput, filename: 'SO-Ver1-later.xls' },
    CTX,
  );
  assert.equal(editedValidation.rowsChanged, touched);
  const commit = await commitSoBatch(asClient(c), editedValidation.batchId ?? '', CTX);
  assert.equal(commit.documentsCreated, 0);
  assert.equal(commit.documentsUpdated, 1);
  assert.equal(commit.documentsUnchanged >= 1, true);
  // No workflow events were re-appended for stages that already exist.
  assert.equal(commit.workflowEventsAppended, 0);

  const orders = await c.execute({
    sql: `SELECT COUNT(*) AS n FROM sales_orders WHERE document_number = ?`,
    args: [doc.documentNumber],
  });
  assert.equal(Number(orders.rows[0]?.n), 1);
  // Several documents earned version-1 snapshots in the first commit; the
  // versioning claim is about THIS order's chain.
  const orderRow = await c.execute({
    sql: `SELECT sales_order_id FROM sales_orders WHERE document_number = ?`,
    args: [doc.documentNumber],
  });
  const snapshots = await c.execute({
    sql: `SELECT version_no, is_current FROM record_snapshots
          WHERE entity_type = 'SALES_ORDER' AND entity_id = ? ORDER BY version_no`,
    args: [String(orderRow.rows[0]?.sales_order_id)],
  });
  assert.equal(snapshots.rows.length, 2);
  assert.equal(Number(snapshots.rows[0]?.version_no), 1);
  assert.equal(Number(snapshots.rows[0]?.is_current), 0);
  assert.equal(Number(snapshots.rows[1]?.version_no), 2);
  assert.equal(Number(snapshots.rows[1]?.is_current), 1);
  c.close();
});

// ---------------------------------------------------------------------------
// Semantics.
// ---------------------------------------------------------------------------

test('blank credit columns mean credit was not required, never that it completed', async () => {
  const sheet = parseWorkbook(SO_FILE);
  const blank = sheet.rows.filter(
    (r) =>
      (r.CREDIT_HOLD_DATE ?? null) === null &&
      (r.RELEASED_FLAG ?? null) === null &&
      (r.CREDIT_HOLD_NAME ?? null) === null,
  );
  assert.equal(blank.length, 593);
  const populated = sheet.rows.length - blank.length;
  assert.equal(populated, 793);
  const missingInvoice = sheet.rows.filter(
    (r) => (r.INVOICE_CREATION_DATE ?? null) === null,
  ).length;
  assert.equal(missingInvoice, 6);
});

test('status derives conservatively and never infers loaded from an invoice', () => {
  const base = {
    sourceRowNumber: 1,
    raw: {},
    affiliateText: 'Hass Petroleum Kenya',
    affiliateId: 'AFF-KE',
    documentNumber: 'X',
    lineNumber: 1,
    customerCode: 'C',
    customerName: null,
    createdBy: null,
    orderCreatedAt: '2026-05-02 10:00:00',
    approvalAt: null,
    approvalStatus: null,
    approver: null,
    creditHoldAt: null,
    creditReleaseAt: null,
    creditReleasedBy: null,
    creditReleaseReason: null,
    creditRequired: false,
    invoiceCreatedAt: null,
    loadingAuthorityAt: null,
    orderedItem: null,
    sourceKey: 'k',
    rowHash: 'h',
  };
  assert.equal(deriveSoStatus(base as never), 'PENDING_FINANCE');
  assert.equal(
    deriveSoStatus({
      ...base,
      approvalStatus: 'APPROVE',
      approvalAt: '2026-05-02 11:00:00',
    } as never),
    'READY',
  );
  assert.equal(
    deriveSoStatus({
      ...base,
      approvalStatus: 'APPROVE',
      approvalAt: '2026-05-02 11:00:00',
      creditRequired: true,
    } as never),
    'PENDING_CREDIT',
  );
  assert.equal(
    deriveSoStatus({
      ...base,
      approvalStatus: 'APPROVE',
      approvalAt: '2026-05-02 11:00:00',
      invoiceCreatedAt: '2026-05-03 09:00:00',
    } as never),
    'INVOICED',
  );
});

test('the source variance and the computed duration sit side by side and may differ, corrupting nothing', () => {
  const sheet = parseWorkbook(SO_FILE);
  const sample = sheet.rows.find(
    (r) => r.FINANCE_VARIANCE !== null && r.FINANCE_VARIANCE !== undefined,
  );
  assert.notEqual(sample, undefined);
  const pair = varianceComparison(sample ?? {});
  assert.notEqual(pair.sourceFinanceVariance, null);
  assert.notEqual(pair.computedFinanceMinutes, null);
  // Two figures, two provenances. Nothing forces them to agree, and the
  // computed one is the only one the application ever treats as a duration.
  assert.equal(typeof pair.computedFinanceMinutes, 'number');
});

test('the canonical hash is stable across representations', async () => {
  const a = await hashCanonicalRow({ doc: '3988', when: '2026-05-02 10:55:30', item: 'GHOS50PG' });
  const b = await hashCanonicalRow({ item: 'GHOS50PG', when: '2026-05-02 10:55:30', doc: '3988' });
  const c2 = await hashCanonicalRow({ doc: '3989', when: '2026-05-02 10:55:30', item: 'GHOS50PG' });
  assert.equal(a, b);
  assert.notEqual(a, c2);
});
