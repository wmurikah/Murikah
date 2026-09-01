/**
 * Build Prompt 42, the resolution: three sources in order of authority — the
 * file's own column, the filename token against affiliates.extract_code, the
 * operator — with the period as a cross-check and never a source.
 *
 * The purchase order tests run synthetic workbooks in the real extract's
 * shape (its own 29 headers), because the case this phase exists for is a
 * file with NO affiliate column whose country lives only in its name. The
 * sales tests run the real SO-Ver1.xls, whose AFFILIATE column is the word
 * that outranks any name it is given.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as XLSX from 'xlsx';
import { createTestDb, type TestClient } from './support/db.ts';
import { seedHass, SEED } from './support/hassSeed.ts';
import { parseWorkbook } from '../../src/lib/cms/import/workbook.ts';
import {
  receiveUpload,
  commitBatch,
  listUploadAffiliates,
} from '../../src/lib/cms/import/uploadCentre.ts';
import {
  resetCaseEventHandlers,
  resetLeadEventHandlers,
  resetSlaWiring,
} from '../../src/lib/cms/service/events.ts';

const here = dirname(fileURLToPath(import.meta.url));
const PO_FILE = readFileSync(join(here, 'support', 'PO-Ver1.xls'));
const SO_FILE = readFileSync(join(here, 'support', 'SO-Ver1.xls'));
const PO_HEADERS = parseWorkbook(PO_FILE).headers;

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

/** An Excel day serial for a UTC moment. */
const serial = (iso: string): number => new Date(iso).getTime() / 86400000 + 25569;

/** A purchase workbook in the real extract's shape: no affiliate column. */
function poWorkbook(orders: { purchaseNumber: string; createdAt: string }[]): Uint8Array {
  const rows: unknown[][] = [PO_HEADERS];
  for (const order of orders) {
    const record: Record<string, unknown> = {
      'purchase Number': order.purchaseNumber,
      'Req Description': `Synthetic order ${order.purchaseNumber}`,
      NATURE: 'PRODUCT',
      ORIGINAL_CREATION_DATE: serial(order.createdAt),
      SUBMISSION_FOR_APPROVAL_DATE: serial(order.createdAt) + 10 / 1440,
      TIME_DIFF_RAISEPO_TOAPROVALSUBMIT: 10,
      PURCHASE_ORDER_CREATED_BY: 'HAPPINESS.MUNUHE',
      AUTHORIZATION_STATUS: 'APPROVED',
      FIRST_APPROVAL_DATE: serial(order.createdAt) + 40 / 1440,
      FIRST_APPROVER: 'Mr. Synthetic Approver 1',
      FIRST_APPROVALS_VARIANCE: 30,
    };
    rows.push(PO_HEADERS.map((h) => record[h] ?? null));
  }
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, 'Sheet 1');
  return new Uint8Array(XLSX.write(book, { bookType: 'biff8', type: 'buffer' }) as Buffer);
}

const upload = (
  importType: 'SALES_ORDER' | 'PURCHASE_ORDER',
  filename: string,
  bytes: Uint8Array,
  overrides: Partial<Parameters<typeof receiveUpload>[1]> = {},
) => ({
  importType,
  sourceSystemId: 'SRC-ORACLE',
  affiliateId: null,
  filename,
  reportingPeriodFrom: null,
  reportingPeriodTo: null,
  bytes,
  ...overrides,
});

// ---- Prerequisite ------------------------------------------------------------

test('the eight affiliates carry their extract codes, none null', async () => {
  const c = await db();
  const result = await c.execute(
    `SELECT affiliate_code, affiliate_name, extract_code FROM affiliates ORDER BY extract_code`,
  );
  assert.equal(result.rows.length, 8);
  assert.equal(
    result.rows.filter((row) => row.extract_code === null).length,
    0,
    'no affiliate may lack its extract code',
  );
  const byCode = new Map(result.rows.map((row) => [String(row.extract_code), row]));
  assert.equal(String(byCode.get('DRC')?.affiliate_code), 'HPD');
  assert.equal(String(byCode.get('SSD')?.affiliate_code), 'HPS');
  assert.equal(String(byCode.get('TERMINAL')?.affiliate_code), 'HTW');
  assert.equal(String(byCode.get('TERMINAL')?.affiliate_name), 'Hass Terminal');
});

// ---- The purchase order path: the whole point of this phase -------------------

test('PURCHASE-UG resolves from the filename and the orders carry AFF-UG', async () => {
  const c = await db();
  const bytes = poWorkbook([
    { purchaseNumber: '9001', createdAt: '2026-08-04T09:00:00Z' },
    { purchaseNumber: '9002', createdAt: '2026-08-19T11:30:00Z' },
  ]);
  const outcome = await receiveUpload(
    asClient(c),
    upload('PURCHASE_ORDER', 'PURCHASE-UG-01AUG2026-24AUG2026.xls', bytes),
    CTX,
  );
  assert.equal(outcome.stage, 'READY');
  assert.equal(outcome.entity?.source, 'filename');
  assert.equal(outcome.entity?.affiliateId, 'AFF-UG');
  assert.equal(outcome.entity?.affiliateName, 'Hass Petroleum Uganda');
  // Plain words, for a person: what was resolved and where it came from.
  assert.match(outcome.entity?.statement ?? '', /from the filename: UG, Hass Petroleum Uganda/);
  // The name and the data agree on the period, and the preview says so.
  assert.equal(outcome.periodCheck?.status, 'agrees');

  await commitBatch(asClient(c), outcome.batchId ?? '', CTX);
  const orders = await c.execute(
    `SELECT document_number, affiliate_id FROM purchase_orders
      WHERE document_number IN ('9001','9002') ORDER BY document_number`,
  );
  assert.equal(orders.rows.length, 2);
  for (const row of orders.rows) {
    assert.equal(String(row.affiliate_id), 'AFF-UG', 'no purchase order may stay Group-wide');
  }
});

test('SALES-TERMINAL token resolves to Hass Terminal, HTW', async () => {
  const c = await db();
  // The token lookup itself, from the one affiliates read the upload makes.
  const affiliates = await listUploadAffiliates(asClient(c));
  const terminal = affiliates.find((a) => a.extractCode === 'TERMINAL');
  assert.equal(terminal?.affiliateName, 'Hass Terminal');
  const code = await c.execute({
    sql: `SELECT affiliate_code FROM affiliates WHERE affiliate_id = ?`,
    args: [terminal?.affiliateId ?? ''],
  });
  assert.equal(String(code.rows[0]?.affiliate_code), 'HTW');
  // And through an upload: a purchase file named for the terminal lands on it.
  const outcome = await receiveUpload(
    asClient(c),
    upload(
      'PURCHASE_ORDER',
      'PURCHASE-TERMINAL-01AUG2026-24AUG2026.xls',
      poWorkbook([{ purchaseNumber: '9100', createdAt: '2026-08-10T08:00:00Z' }]),
    ),
    CTX,
  );
  assert.equal(outcome.entity?.affiliateName, 'Hass Terminal');
  assert.equal(outcome.entity?.source, 'filename');
});

test('an unknown token is an exception that names the eight, never a Group-wide guess', async () => {
  const c = await db();
  const outcome = await receiveUpload(
    asClient(c),
    upload(
      'PURCHASE_ORDER',
      'PURCHASE-XX-01AUG2026-24AUG2026.xls',
      poWorkbook([{ purchaseNumber: '9200', createdAt: '2026-08-05T08:00:00Z' }]),
    ),
    CTX,
  );
  assert.equal(outcome.stage, 'NEEDS_ENTITY');
  assert.equal(outcome.entity?.affiliateId, null, 'an unknown token must resolve nothing');
  assert.equal(outcome.batchId, null);
  // Nothing was written: no batch for this file, beyond what the seed holds.
  const batches = await c.execute(
    `SELECT COUNT(*) AS n FROM import_batches WHERE original_filename LIKE 'PURCHASE-XX%'`,
  );
  assert.equal(Number(batches.rows[0]?.n), 0);
  // The eight that exist are named, so the operator can map the file.
  assert.equal(outcome.entity?.knownExtracts?.length, 8);
  const warning = outcome.entity?.warnings[0] ?? '';
  assert.match(warning, /XX matches no affiliate/);
  for (const token of ['KE', 'UG', 'TZ', 'RW', 'ZM', 'DRC', 'SSD', 'TERMINAL']) {
    assert.ok(warning.includes(token), `the warning must name ${token}`);
  }
  assert.match(warning, /will not be imported Group-wide/);

  // The operator maps it: the same file, sent again with their choice.
  const mapped = await receiveUpload(
    asClient(c),
    upload(
      'PURCHASE_ORDER',
      'PURCHASE-XX-01AUG2026-24AUG2026.xls',
      poWorkbook([{ purchaseNumber: '9200', createdAt: '2026-08-05T08:00:00Z' }]),
      { affiliateId: 'AFF-CD' },
    ),
    CTX,
  );
  assert.equal(mapped.stage, 'READY');
  assert.equal(mapped.entity?.source, 'operator');
  assert.equal(mapped.entity?.affiliateName, 'Hass Petroleum DRC');
});

test('the operator can override a filename-resolved entity before committing', async () => {
  const c = await db();
  const bytes = poWorkbook([{ purchaseNumber: '9300', createdAt: '2026-08-06T08:00:00Z' }]);
  const first = await receiveUpload(
    asClient(c),
    upload('PURCHASE_ORDER', 'PURCHASE-UG-01AUG2026-24AUG2026.xls', bytes),
    CTX,
  );
  assert.equal(first.entity?.affiliateId, 'AFF-UG');
  const batchId = first.batchId ?? '';

  // The SAME file, re-read with the operator's choice: the batch keeps its
  // identity and its hash, and its rows now carry the chosen entity.
  const overridden = await receiveUpload(
    asClient(c),
    upload('PURCHASE_ORDER', 'PURCHASE-UG-01AUG2026-24AUG2026.xls', bytes, {
      affiliateId: 'AFF-KE',
      overrideBatchId: batchId,
    }),
    CTX,
  );
  assert.equal(overridden.stage, 'READY');
  assert.equal(overridden.batchId, batchId, 'an override is the same batch, not a second one');
  assert.equal(overridden.entity?.source, 'operator');
  // The override was a deliberate disagreement with the name, and says so.
  assert.match(overridden.entity?.warnings[0] ?? '', /filename names UG/);

  // A different file cannot ride an override past the duplicate rule.
  const smuggled = await receiveUpload(
    asClient(c),
    upload(
      'PURCHASE_ORDER',
      'PURCHASE-UG-01AUG2026-24AUG2026.xls',
      poWorkbook([{ purchaseNumber: '9999', createdAt: '2026-08-06T08:00:00Z' }]),
      { affiliateId: 'AFF-KE', overrideBatchId: batchId },
    ),
    CTX,
  );
  assert.equal(smuggled.stage, 'REJECTED');
  assert.match(smuggled.rejectedReason ?? '', /does not match the batch/);

  await commitBatch(asClient(c), batchId, CTX);
  const orders = await c.execute(
    `SELECT affiliate_id FROM purchase_orders WHERE document_number = '9300'`,
  );
  assert.equal(String(orders.rows[0]?.affiliate_id), 'AFF-KE');

  // And once imported, the entity is settled: an override is refused.
  const late = await receiveUpload(
    asClient(c),
    upload('PURCHASE_ORDER', 'PURCHASE-UG-01AUG2026-24AUG2026.xls', bytes, {
      affiliateId: 'AFF-TZ',
      overrideBatchId: batchId,
    }),
    CTX,
  );
  assert.equal(late.stage, 'REJECTED');
  assert.match(late.rejectedReason ?? '', /already been imported/);
});

test('a malformed purchase filename proceeds Group-wide as before, and says the operator can choose', async () => {
  const c = await db();
  const outcome = await receiveUpload(
    asClient(c),
    upload(
      'PURCHASE_ORDER',
      'PO-Ver1.xls',
      poWorkbook([{ purchaseNumber: '9400', createdAt: '2026-08-07T08:00:00Z' }]),
    ),
    CTX,
  );
  assert.equal(outcome.stage, 'READY');
  assert.equal(outcome.entity?.source, 'none');
  assert.equal(outcome.entity?.affiliateId, null);
  assert.match(outcome.entity?.statement ?? '', /Group-wide/);
  assert.equal(outcome.periodCheck?.status, 'unnamed');
});

// ---- The period is a cross-check, not a source --------------------------------

test('a file named August whose data is May warns and shows both; the data period wins', async () => {
  const c = await db();
  const outcome = await receiveUpload(
    asClient(c),
    upload(
      'PURCHASE_ORDER',
      'PURCHASE-KE-01AUG2026-24AUG2026.xls',
      poWorkbook([
        { purchaseNumber: '9500', createdAt: '2026-04-30T08:00:00Z' },
        { purchaseNumber: '9501', createdAt: '2026-05-30T16:00:00Z' },
      ]),
    ),
    CTX,
  );
  assert.equal(outcome.stage, 'READY');
  assert.equal(outcome.periodCheck?.status, 'differs');
  assert.match(outcome.periodCheck?.detail ?? '', /filename says 2026-08-01 to 2026-08-24/);
  assert.match(outcome.periodCheck?.detail ?? '', /data runs 2026-04-30 to 2026-05-30/);
  // NEVER an override: the batch's recorded period is the data's, not the name's.
  const batch = await c.execute({
    sql: `SELECT reporting_period_from, reporting_period_to FROM import_batches
          WHERE import_batch_id = ?`,
    args: [outcome.batchId ?? ''],
  });
  assert.match(String(batch.rows[0]?.reporting_period_from), /^2026-04-30/);
  assert.match(String(batch.rows[0]?.reporting_period_to), /^2026-05-30/);
});

// ---- The sales order path: the column wins ------------------------------------

test('SALES-KE resolves from its own AFFILIATE column, and the preview says so', async () => {
  const c = await db();
  const outcome = await receiveUpload(
    asClient(c),
    upload('SALES_ORDER', 'SALES-KE-01JAN2026-31DEC2026.xls', new Uint8Array(SO_FILE)),
    CTX,
  );
  assert.equal(outcome.stage, 'READY');
  assert.equal(outcome.entity?.source, 'column');
  assert.equal(outcome.entity?.affiliateId, 'AFF-KE');
  assert.match(outcome.entity?.statement ?? '', /file's own AFFILIATE column/);
  assert.match(outcome.entity?.statement ?? '', /filename was not needed/);
  // The name agrees, so there is nothing to warn about.
  assert.deepEqual(outcome.entity?.warnings, []);
});

test('a sales file named for one entity containing another warns, and the column wins', async () => {
  const c = await db();
  const outcome = await receiveUpload(
    asClient(c),
    upload('SALES_ORDER', 'SALES-UG-01JAN2026-31DEC2026.xls', new Uint8Array(SO_FILE)),
    CTX,
  );
  assert.equal(outcome.stage, 'READY');
  // The column decided, whatever the name claimed.
  assert.equal(outcome.entity?.source, 'column');
  assert.equal(outcome.entity?.affiliateId, 'AFF-KE');
  const warning = outcome.entity?.warnings[0] ?? '';
  assert.match(warning, /named for Hass Petroleum Uganda \(UG\)/);
  assert.match(warning, /AFFILIATE column names Hass Petroleum Kenya/);
  assert.match(warning, /The column is right/);
});
