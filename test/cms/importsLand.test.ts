/**
 * Build Prompt 35: both extracts land, against the real files.
 *
 * WHAT THESE COVER, AND WHY THEY ARE SEPARATE FROM THE TWO IMPORTER SUITES.
 * poImport.test.ts and soImport.test.ts prove the importers' own rules —
 * approval levels, change detection, the mapping report. These prove the two
 * faults that stopped both files reaching the database at all, and the policy
 * that replaced the refusal:
 *
 *   the purchase order foreign key   Every one of 45 rows failed with
 *                                    "FOREIGN KEY constraint failed" and
 *                                    nothing else. The importer was writing
 *                                    the document number into affiliate_id,
 *                                    because a Group-scope source key carried
 *                                    no affiliate slot and commit recovered
 *                                    the affiliate by splitting the key. Every
 *                                    existing test passed an affiliate, which
 *                                    took the other branch, which is why the
 *                                    suite stayed green through three failed
 *                                    batches.
 *   the sales order refusal          1,386 rows reached the unresolved queue
 *                                    behind 228 customers and 111 products
 *                                    that did not exist yet.
 *
 * Criteria 3, 5, 6, 7 and 9 of the phase are each a test below, named.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createTestDb, type TestClient } from './support/db.ts';
import { seedHass, SEED } from './support/hassSeed.ts';
import {
  validatePoWorkbook,
  commitPoBatch,
  buildPoSourceKey,
  parsePoSourceKey,
} from '../../src/lib/cms/import/poImport.ts';
import { validateSoWorkbook, commitSoBatch } from '../../src/lib/cms/import/soImport.ts';
import {
  listCreatedFromImport,
  UNCLASSIFIED_CATEGORY_CODE,
} from '../../src/lib/cms/import/masterData.ts';
import {
  describeWriteFailure,
  preflightForeignKeys,
} from '../../src/lib/cms/import/foreignKeys.ts';
import {
  resetCaseEventHandlers,
  resetLeadEventHandlers,
  resetSlaWiring,
} from '../../src/lib/cms/service/events.ts';

const here = dirname(fileURLToPath(import.meta.url));
const PO_FILE = readFileSync(join(here, 'support', 'PO-Ver1.xls'));
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
const asClient = (c: TestClient) => c as unknown as Parameters<typeof validatePoWorkbook>[0];

const count = async (c: TestClient, sql: string, args: unknown[] = []): Promise<number> =>
  Number(((await c.execute({ sql, args })).rows[0] as Record<string, unknown>)?.n ?? 0);

// ---------------------------------------------------------------------------
// Criterion 3: the real PO-Ver1.xls imports.
// ---------------------------------------------------------------------------

test('criterion 3: 45 purchase orders import with a NULL affiliate, no lines and no exception', async () => {
  const c = await db();
  const ordersBefore = await count(c, 'SELECT COUNT(*) AS n FROM purchase_orders');
  const linesBefore = await count(c, 'SELECT COUNT(*) AS n FROM purchase_order_lines');

  // affiliateId null: the extract has no affiliate column, so a Group-scope
  // batch is exactly what the three failed production batches were.
  const validation = await validatePoWorkbook(
    asClient(c),
    PO_FILE,
    {
      filename: 'PO-Ver1.xls',
      uploadedBy: SEED.admin,
      sourceSystemId: 'SRC-EXCEL',
      affiliateId: null,
    },
    CTX,
  );
  assert.equal(validation.rejectedReason, null);
  assert.equal(validation.rowsReceived, 45);
  assert.equal(validation.uniqueOrders, 45);

  const result = await commitPoBatch(asClient(c), validation.batchId ?? '', CTX);
  assert.equal(result.ordersCreated, 45);
  assert.equal(result.ordersSkipped, 0, 'not one row may be rejected');
  assert.equal(result.linesWritten, 0, 'the extract has no line grain, so no line is invented');

  assert.equal(await count(c, 'SELECT COUNT(*) AS n FROM purchase_orders'), ordersBefore + 45);
  assert.equal(
    await count(c, `SELECT COUNT(*) AS n FROM purchase_orders WHERE affiliate_id IS NULL`),
    45,
    'every imported order carries a NULL affiliate, never a document number',
  );
  assert.equal(
    await count(c, 'SELECT COUNT(*) AS n FROM purchase_order_lines'),
    linesBefore,
    'no purchase order line is written, so nothing reaches the product catalogue',
  );
  assert.equal(
    await count(
      c,
      `SELECT COUNT(*) AS n FROM import_rows
       WHERE import_batch_id = ? AND row_status = 'REJECTED'`,
      [validation.batchId],
    ),
    0,
    'no exception',
  );

  // The specific value that used to be written. If a document number ever
  // reaches affiliate_id again, this is the assertion that names it.
  assert.equal(
    await count(
      c,
      `SELECT COUNT(*) AS n FROM purchase_orders
       WHERE affiliate_id IS NOT NULL AND affiliate_id = document_number`,
    ),
    0,
  );
  c.close();
});

test('criterion 3: a second upload of the same purchase order file creates no duplicate order', async () => {
  const c = await db();
  const upload = {
    filename: 'PO-Ver1.xls',
    uploadedBy: SEED.admin,
    sourceSystemId: 'SRC-EXCEL',
    affiliateId: null,
  };
  const first = await validatePoWorkbook(asClient(c), PO_FILE, upload, CTX);
  await commitPoBatch(asClient(c), first.batchId ?? '', CTX);
  const after = await count(c, 'SELECT COUNT(*) AS n FROM purchase_orders');

  // A reprocess rather than a re-upload: the same bytes are refused as a
  // duplicate file, which is a different rule. This runs the batch again.
  const again = await validatePoWorkbook(
    asClient(c),
    PO_FILE,
    { ...upload, reprocessBatchId: first.batchId },
    CTX,
  );
  const second = await commitPoBatch(asClient(c), again.batchId ?? '', CTX);
  assert.equal(second.ordersCreated, 0, 'the Group-scope lookup must recognise its own orders');
  assert.equal(
    await count(c, 'SELECT COUNT(*) AS n FROM purchase_orders'),
    after,
    'a NULL affiliate must not make every order look new',
  );
  c.close();
});

test('the source key round trip is total, including the keys the failed batches wrote', () => {
  // The fault in one assertion. A Group-scope key used to be written with no
  // affiliate slot at all, and commit recovered the affiliate by splitting on
  // '|', which handed back the document number.
  assert.equal(buildPoSourceKey(null, '9296'), '|9296');
  assert.deepEqual(parsePoSourceKey(buildPoSourceKey(null, '9296')), {
    affiliateId: null,
    documentNumber: '9296',
  });
  assert.equal(buildPoSourceKey('AFF-KE', '9296'), 'AFF-KE|9296');
  assert.deepEqual(parsePoSourceKey(buildPoSourceKey('AFF-KE', '9296')), {
    affiliateId: 'AFF-KE',
    documentNumber: '9296',
  });

  // AND THE KEYS ALREADY IN THE DATABASE. The three failed production batches
  // are evidence and are not being cleared, so their rows still carry the old
  // separator-less key. Read as a Group-scope document, which is what it
  // always meant, a reprocess of one of those batches now succeeds.
  assert.deepEqual(parsePoSourceKey('9296'), {
    affiliateId: null,
    documentNumber: '9296',
  });
});

// ---------------------------------------------------------------------------
// Criterion 4: a foreign key failure names the table, the column and the value.
// ---------------------------------------------------------------------------

test('criterion 4: a foreign key failure names the table, the column and the value', async () => {
  const c = await db();
  const statements = [
    {
      sql: `INSERT INTO purchase_orders
              (purchase_order_id, document_number, affiliate_id, business_unit_id, supplier_name,
               po_created_at, submitted_for_approval_at, currency_code, po_value,
               physical_received_at, oracle_stock_posted_at, status, created_at)
            VALUES (?, ?, ?, NULL, NULL, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
      args: [
        'PO-DELIBERATE',
        '9296',
        // Exactly the value the fault was writing: the document number.
        '9296',
        '2026-05-19 09:50:23',
        'APPROVED',
        '2026-08-27 10:00:00',
      ],
    },
  ];

  // The preflight refuses it before SQLite is asked.
  const preflight = await preflightForeignKeys(asClient(c), statements);
  assert.equal(preflight, "purchase_orders.affiliate_id = '9296' is not a affiliates.affiliate_id");

  // And the same sentence is appended to a real failure, so a message that
  // escapes the preflight still names what was rejected.
  let raised: unknown = null;
  try {
    await c.batch(statements, 'write');
  } catch (error) {
    raised = error;
  }
  assert.notEqual(raised, null, 'the write must genuinely fail');
  const described = await describeWriteFailure(asClient(c), statements, raised);
  assert.match(described, /FOREIGN KEY constraint failed/);
  assert.match(described, /purchase_orders\.affiliate_id = '9296'/);
  assert.match(described, /is not a affiliates\.affiliate_id/);

  // A failure that is not a foreign key is passed through unchanged rather
  // than dressed up as one.
  const other = await describeWriteFailure(asClient(c), statements, new Error('NOT NULL failed'));
  assert.equal(other, 'Error: NOT NULL failed');
  c.close();
});

// ---------------------------------------------------------------------------
// Criteria 5, 6, 7: the real SO-Ver1.xls imports and creates its master data.
// ---------------------------------------------------------------------------

const soUpload = {
  filename: 'SO-Ver1.xls',
  uploadedBy: SEED.admin,
  sourceSystemId: 'SRC-EXCEL',
};

test('criteria 5, 6 and 7: 1,386 rows, 662 orders, 228 accounts and 108 products, none guessed', async () => {
  const c = await db();
  const accountsBefore = await count(c, 'SELECT COUNT(*) AS n FROM accounts');
  const productsBefore = await count(c, 'SELECT COUNT(*) AS n FROM products');

  const validation = await validateSoWorkbook(asClient(c), SO_FILE, soUpload, CTX);

  // ---- Criterion 8: the preview shows both counts and both lists ----------
  assert.equal(validation.accountsToCreate.length, 228);
  assert.equal(
    validation.productsToCreate.length,
    108,
    '111 distinct items in the file; AGO, PMS and JET-A1 already exist',
  );
  assert.ok(
    validation.accountsToCreate.every((a) => a.code !== '' && a.rows > 0),
    'the list carries each code and how many rows named it',
  );
  assert.ok(validation.productsToCreate.every((p) => p.code !== ''));
  // Nothing was written to say it: the preview is a preview.
  assert.equal(await count(c, 'SELECT COUNT(*) AS n FROM accounts'), accountsBefore);
  assert.equal(await count(c, 'SELECT COUNT(*) AS n FROM products'), productsBefore);

  // ---- Criterion 5: the rows and the documents ----------------------------
  assert.equal(validation.rowsReceived, 1386);
  assert.equal(validation.uniqueDocuments, 662);
  assert.equal(validation.unresolvedCustomers.length, 0, 'no unresolved customer');
  assert.equal(validation.unresolvedProducts.length, 0, 'no unmapped product');
  assert.equal(validation.rowsUnresolved, 0);

  const result = await commitSoBatch(asClient(c), validation.batchId ?? '', CTX);
  assert.equal(result.documentsCreated, 662);
  assert.equal(result.documentsSkipped, 0);
  assert.equal(result.accountsCreated, 228);
  assert.equal(result.productsCreated, 108);

  // ---- Criterion 6: what a created account carries, and what it does not --
  assert.equal(await count(c, 'SELECT COUNT(*) AS n FROM accounts'), accountsBefore + 228);
  const sample = await c.execute({
    sql: `SELECT account_name, account_type, country_id, affiliate_id,
                 credit_limit, credit_days, account_manager_user_id
          FROM accounts WHERE oracle_customer_code = ?`,
    args: ['131964'],
  });
  const account = sample.rows[0] as Record<string, unknown>;
  assert.equal(account?.account_name, 'STABEX INTERNATIONAL LIMITED', 'the name from the file');
  assert.equal(account?.account_type, 'CUSTOMER');
  assert.equal(account?.country_id, 'CTR-KE', "the country of the row's affiliate");
  // NEVER A VALUE THE FILE DOES NOT CARRY. A zero credit limit invented here
  // would read downstream as a customer who may not trade.
  assert.equal(account?.credit_limit, null);
  assert.equal(account?.credit_days, null);
  assert.equal(account?.account_manager_user_id, null);
  // Scoped to the accounts THIS IMPORT created, found through the audit trail
  // that marks them. The seeded demo customers legitimately carry credit terms
  // somebody entered, and sweeping them into this assertion would make it pass
  // or fail for reasons that have nothing to do with the importer.
  assert.equal(
    await count(
      c,
      `SELECT COUNT(*) AS n FROM accounts a
       JOIN audit_events e ON e.entity_id = a.account_id AND e.event_type = 'ACCOUNT_CREATED'
       WHERE a.credit_limit IS NOT NULL OR a.credit_days IS NOT NULL
          OR a.account_manager_user_id IS NOT NULL`,
    ),
    0,
    'not one created account carries an invented commercial value',
  );

  // ---- Criterion 7: every created product is unclassified ----------------
  assert.equal(await count(c, 'SELECT COUNT(*) AS n FROM products'), productsBefore + 108);
  assert.equal(
    await count(
      c,
      `SELECT COUNT(*) AS n FROM products p
       JOIN product_categories pc ON pc.product_category_id = p.product_category_id
       WHERE pc.category_code = ?`,
      [UNCLASSIFIED_CATEGORY_CODE],
    ),
    108,
    'all 108 created products sit in Unclassified',
  );
  // And the Unclassified category hangs under Other Products, not under fuel.
  const category = await c.execute({
    sql: `SELECT pg.group_code FROM product_categories pc
          JOIN product_groups pg ON pg.product_group_id = pc.product_group_id
          WHERE pc.category_code = ?`,
    args: [UNCLASSIFIED_CATEGORY_CODE],
  });
  assert.equal((category.rows[0] as Record<string, unknown>)?.group_code, 'OTHER');
  // Nothing recognisable-looking was guessed into the petroleum catalogue.
  for (const code of ['GHOS50PG', 'GHOS13EC', 'HS-03-208', 'OM-01-208']) {
    assert.equal(
      await count(
        c,
        `SELECT COUNT(*) AS n FROM products p
         JOIN product_categories pc ON pc.product_category_id = p.product_category_id
         WHERE p.product_code = ? AND pc.category_code != ?`,
        [code, UNCLASSIFIED_CATEGORY_CODE],
      ),
      0,
      `${code} must never be filed anywhere but Unclassified`,
    );
  }

  // ---- Criteria 16 and 17: a person is still never created ---------------
  assert.equal(
    (await count(c, `SELECT COUNT(*) AS n FROM unresolved_actors WHERE status = 'OPEN'`)) > 0,
    true,
    'an unmapped person still produces an unresolved actor',
  );

  // ---- Criterion 11: everything created is listed for review -------------
  const listed = await listCreatedFromImport(asClient(c), 1000);
  assert.equal(listed.accounts.length, 228);
  assert.equal(listed.products.length, 108);
  assert.ok(
    listed.accounts.every((row) => row.importBatchId === validation.batchId),
    'each created record names the batch that created it',
  );
  c.close();
});

// ---------------------------------------------------------------------------
// Criterion 9: a second upload creates nothing twice.
// ---------------------------------------------------------------------------

test('criterion 9: a second upload of the same file creates no duplicate account or product', async () => {
  const c = await db();
  const first = await validateSoWorkbook(asClient(c), SO_FILE, soUpload, CTX);
  await commitSoBatch(asClient(c), first.batchId ?? '', CTX);

  const accountsAfterFirst = await count(c, 'SELECT COUNT(*) AS n FROM accounts');
  const productsAfterFirst = await count(c, 'SELECT COUNT(*) AS n FROM products');
  assert.equal(accountsAfterFirst > 228, true);
  assert.equal(productsAfterFirst > 108, true);

  // The same bytes again, as a reprocess so the file-hash duplicate rule does
  // not answer for us: this has to be the creation logic recognising its own
  // records, not the upload being refused.
  const second = await validateSoWorkbook(
    asClient(c),
    SO_FILE,
    { ...soUpload, reprocessBatchId: first.batchId },
    CTX,
  );
  assert.equal(
    second.accountsToCreate.length,
    0,
    'the preview offers nothing to create the second time',
  );
  assert.equal(second.productsToCreate.length, 0);

  const result = await commitSoBatch(asClient(c), second.batchId ?? '', CTX);
  assert.equal(result.accountsCreated, 0);
  assert.equal(result.productsCreated, 0);

  assert.equal(
    await count(c, 'SELECT COUNT(*) AS n FROM accounts'),
    accountsAfterFirst,
    'no duplicate account',
  );
  assert.equal(
    await count(c, 'SELECT COUNT(*) AS n FROM products'),
    productsAfterFirst,
    'no duplicate product',
  );
  c.close();
});

// ---------------------------------------------------------------------------
// Criterion 10: a matched code with a different name is flagged, not overwritten.
// ---------------------------------------------------------------------------

test('criterion 10: a code that matches with a different name is flagged, never overwritten', async () => {
  const c = await db();
  // The account exists under the code 131964, with a name nobody is going to
  // change on the strength of a spreadsheet column.
  await c.execute({
    sql: `INSERT INTO accounts (account_id, account_name, account_type, oracle_customer_code,
            country_id, affiliate_id, status, created_at, updated_at)
          VALUES ('ACC-RENAMED', 'Stabex International (renamed in the CMS)', 'CUSTOMER',
                  '131964', 'CTR-KE', 'AFF-KE', 'ACTIVE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    args: [],
  });

  const validation = await validateSoWorkbook(asClient(c), SO_FILE, soUpload, CTX);
  const mismatch = validation.nameMismatches.find((m) => m.code === '131964');
  assert.notEqual(mismatch, undefined, 'the difference is raised in the preview');
  assert.equal(mismatch?.storedName, 'Stabex International (renamed in the CMS)');
  assert.equal(mismatch?.fileName, 'STABEX INTERNATIONAL LIMITED');

  const result = await commitSoBatch(asClient(c), validation.batchId ?? '', CTX);
  assert.equal(result.nameMismatches >= 1, true);

  const after = await c.execute({
    sql: `SELECT account_name FROM accounts WHERE account_id = 'ACC-RENAMED'`,
    args: [],
  });
  assert.equal(
    (after.rows[0] as Record<string, unknown>)?.account_name,
    'Stabex International (renamed in the CMS)',
    'a customer renamed in Oracle and a code reused are different events; only a person decides',
  );
  assert.equal(
    await count(c, `SELECT COUNT(*) AS n FROM accounts WHERE oracle_customer_code = '131964'`),
    1,
    'and no second account is created for a code that already exists',
  );

  const listed = await listCreatedFromImport(asClient(c), 1000);
  assert.ok(
    listed.mismatches.some((row) => row.code === '131964'),
    'the mismatch is on the review queue',
  );
  c.close();
});

// ---------------------------------------------------------------------------
// Criteria 12 to 15: the type conversion, on the real data.
// ---------------------------------------------------------------------------

test('criteria 12 to 15: identifiers, timestamps, NULLs and the absence of invented zeros', async () => {
  const c = await db();
  const validation = await validateSoWorkbook(asClient(c), SO_FILE, soUpload, CTX);
  await commitSoBatch(asClient(c), validation.batchId ?? '', CTX);

  // 12: DOCUMENT_NUMBER arrives as the float 3988 and is stored as "3988".
  const doc = await c.execute({
    sql: `SELECT document_number, typeof(document_number) AS kind FROM sales_orders
          WHERE document_number = '3988'`,
    args: [],
  });
  assert.equal(doc.rows.length, 1);
  assert.equal((doc.rows[0] as Record<string, unknown>).kind, 'text');
  assert.equal(
    await count(c, `SELECT COUNT(*) AS n FROM sales_orders WHERE document_number LIKE '%.%'`),
    0,
    'no document number keeps a decimal tail',
  );

  // 13: every timestamp is the database's own ISO 8601 text.
  assert.equal(
    await count(
      c,
      `SELECT COUNT(*) AS n FROM sales_orders
       WHERE order_created_at IS NOT NULL
         AND order_created_at NOT GLOB
             '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9]'`,
    ),
    0,
  );

  // 14: an empty cell is NULL, not ''. The two are different questions, and
  // every report asks the first.
  assert.equal(
    await count(
      c,
      `SELECT COUNT(*) AS n FROM sales_orders
       WHERE currency_code = '' OR document_number = '' OR order_created_at = ''`,
    ),
    0,
    'not one empty string was written',
  );
  assert.equal(
    (await count(c, `SELECT COUNT(*) AS n FROM sales_orders WHERE currency_code IS NULL`)) >= 662,
    true,
    'the absent currency is NULL, which is what WHERE x IS NULL can find',
  );

  // 15: unknown is not zero, on both extracts.
  assert.equal(
    await count(
      c,
      `SELECT COUNT(*) AS n FROM sales_orders so
       JOIN import_rows ir ON ir.entity_id = so.sales_order_id
       WHERE ir.import_batch_id = ? AND (so.currency_code IS NOT NULL OR so.order_value IS NOT NULL)`,
      [validation.batchId],
    ),
    0,
    'the sales order extract carries no currency and no value, so neither was written',
  );
  // Scoped to this batch's own orders: the seeded demo lines carry real
  // quantities somebody entered, which is not what this is asking about.
  assert.equal(
    await count(
      c,
      `SELECT COUNT(*) AS n FROM sales_order_lines sol
       JOIN import_rows ir ON ir.entity_id = sol.sales_order_id
       WHERE ir.import_batch_id = ?
         AND (sol.quantity IS NOT NULL OR sol.unit_price IS NOT NULL)`,
      [validation.batchId],
    ),
    0,
    'and no quantity or unit price either, and certainly not zero',
  );

  const po = await validatePoWorkbook(
    asClient(c),
    PO_FILE,
    {
      filename: 'PO-Ver1.xls',
      uploadedBy: SEED.admin,
      sourceSystemId: 'SRC-EXCEL',
      affiliateId: null,
    },
    CTX,
  );
  await commitPoBatch(asClient(c), po.batchId ?? '', CTX);
  assert.equal(
    await count(
      c,
      `SELECT COUNT(*) AS n FROM purchase_orders
       WHERE affiliate_id IS NULL
         AND (supplier_name IS NOT NULL OR currency_code IS NOT NULL OR po_value IS NOT NULL)`,
    ),
    0,
    'supplier, currency and value are absent from the purchase order extract, so all three are NULL',
  );
  c.close();
});

// ---------------------------------------------------------------------------
// Criterion 16: neither import creates a user.
// ---------------------------------------------------------------------------

test('criterion 16: neither import creates a user', async () => {
  const c = await db();
  const before = await count(c, 'SELECT COUNT(*) AS n FROM users');

  const so = await validateSoWorkbook(asClient(c), SO_FILE, soUpload, CTX);
  await commitSoBatch(asClient(c), so.batchId ?? '', CTX);
  const po = await validatePoWorkbook(
    asClient(c),
    PO_FILE,
    {
      filename: 'PO-Ver1.xls',
      uploadedBy: SEED.admin,
      sourceSystemId: 'SRC-EXCEL',
      affiliateId: null,
    },
    CTX,
  );
  await commitPoBatch(asClient(c), po.batchId ?? '', CTX);

  assert.equal(
    await count(c, 'SELECT COUNT(*) AS n FROM users'),
    before,
    'a user is an identity with an email, a credential and a permission set; a file never mints one',
  );
  // Criterion 17: the unmapped person is still raised for an administrator.
  assert.equal(
    (await count(c, `SELECT COUNT(*) AS n FROM unresolved_actors WHERE status = 'OPEN'`)) > 0,
    true,
  );
  c.close();
});
