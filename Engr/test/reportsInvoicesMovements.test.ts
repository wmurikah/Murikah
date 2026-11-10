import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';
import { runMigrations } from '../db/migrate.ts';
import { createAsset, updateAsset, listAssetMovements } from '../src/lib/engr/repos/adminAssets.ts';
import {
  createSupplierInvoice,
  listSupplierInvoices,
} from '../src/lib/engr/repos/supplierInvoices.ts';
import { REPORTS, parseReportDates, runReport } from '../src/lib/engr/reports/catalog.ts';
import { renderReport } from '../src/lib/engr/reports/formats.ts';
import { visibleReports } from '../src/lib/engr/reports/catalog.ts';

test('asset transfers and supplier invoices stay tied to their organisation and bill', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'engr-report-test-'));
  const db = createClient({ url: `file:${join(dir, 'test.db')}` });
  try {
    await runMigrations(db);
    for (const report of REPORTS) {
      assert.deepEqual(
        await runReport(db, 'missing', report, parseReportDates(null, null)!, 1),
        [],
      );
    }
    await db.batch(
      [
        `INSERT INTO organisations (id, name, slug) VALUES ('o', 'Kenya', 'kenya')`,
        `INSERT INTO organisations (id, name, slug) VALUES ('x', 'Other', 'other')`,
        `INSERT INTO users (id, org_id, full_name, email) VALUES ('u', 'o', 'Manager', 'manager@example.com')`,
        `INSERT INTO regions (id, org_id, code, name) VALUES ('r1', 'o', 'N', 'North')`,
        `INSERT INTO regions (id, org_id, code, name) VALUES ('r2', 'o', 'S', 'South')`,
        `INSERT INTO stations (id, org_id, region_id, code, name) VALUES ('s1', 'o', 'r1', 'ST1', 'Station One')`,
        `INSERT INTO stations (id, org_id, region_id, code, name) VALUES ('s2', 'o', 'r2', 'ST2', 'Station Two')`,
        `INSERT INTO contractors (id, org_id, name, portal_user_id) VALUES ('c', 'o', 'Supplier', 'u')`,
        `INSERT INTO bills (id, org_id, contractor_id, bill_no, subtotal_minor, tax_minor, total_minor) VALUES ('b', 'o', 'c', 'B-1', 10000, 1600, 11600)`,
      ],
      'write',
    );
    const input = {
      tag: 'A-1',
      name: 'Pump',
      stationId: 's1',
      categoryId: null,
      manufacturer: null,
      model: null,
      serialNo: null,
      installDate: null,
      status: 'IN_SERVICE',
    };
    const created = await createAsset(db, { orgId: 'o', userId: 'u' }, input);
    assert.equal(created.ok, true);
    if (!created.ok || !created.id) return;
    const noReason = await updateAsset(db, { orgId: 'o', userId: 'u' }, created.id, {
      ...input,
      stationId: 's2',
    });
    assert.equal(noReason.ok, false);
    const moved = await updateAsset(db, { orgId: 'o', userId: 'u' }, created.id, {
      ...input,
      stationId: 's2',
      movementReason: 'Maintenance transfer',
    });
    assert.equal(moved.ok, true);
    const movements = await listAssetMovements(db, 'o', created.id);
    assert.equal(movements.length, 2);
    assert.equal(movements[0].fromRegion, 'North');
    assert.equal(movements[0].toRegion, 'South');
    assert.equal(movements[0].reason, 'Maintenance transfer');
    assert.deepEqual(await listAssetMovements(db, 'x', created.id), []);

    const pdf = new TextEncoder().encode('%PDF-1.4\ninvoice');
    const invoice = await createSupplierInvoice(
      db,
      { orgId: 'o', userId: 'u', contractorId: 'c' },
      {
        billId: 'b',
        invoiceNo: 'INV-1',
        issueDate: '2026-11-10',
        dueDate: '2026-12-10',
        taxReference: 'PIN123',
        notes: null,
        originalName: 'invoice.pdf',
        originalPdf: pdf,
      },
    );
    assert.equal(invoice.ok, true);
    assert.equal((await listSupplierInvoices(db, 'o', null)).length, 1);
    assert.deepEqual(await listSupplierInvoices(db, 'x', null), []);
    const repeat = await createSupplierInvoice(
      db,
      { orgId: 'o', userId: 'u', contractorId: 'c' },
      {
        billId: 'b',
        invoiceNo: 'INV-1',
        issueDate: '2026-11-10',
        dueDate: '2026-12-10',
        taxReference: null,
        notes: null,
        originalName: 'invoice.pdf',
        originalPdf: pdf,
      },
    );
    assert.equal(repeat.ok, false);
    const movementReport = REPORTS.find((r) => r.id === 'asset_movements')!;
    const rows = await runReport(db, 'o', movementReport, parseReportDates(null, null)!, 50);
    assert.equal(rows.length, 2);
    assert.equal(rows[0][2], 'North');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('all five report formats produce their expected document containers', () => {
  assert.deepEqual(
    visibleReports(['reports.view', 'assets.view']).map((r) => r.id),
    ['assets', 'asset_movements'],
  );
  assert.equal(parseReportDates('2026-02-31', null), null);
  const report = REPORTS.find((r) => r.id === 'assets')!;
  const rows = [['=SUM(1,2)', 'Pump', 'Station', 'North', 'IN_SERVICE', '2026-11-10']];
  const xlsx = renderReport(report, rows, 'xlsx');
  const docx = renderReport(report, rows, 'docx');
  const pdf = renderReport(report, rows, 'pdf');
  const svg = renderReport(report, rows, 'svg');
  const csv = renderReport(report, rows, 'csv');
  assert.equal(new DataView(xlsx.body.buffer).getUint32(0, true), 0x04034b50);
  assert.equal(new DataView(docx.body.buffer).getUint32(0, true), 0x04034b50);
  assert.match(new TextDecoder().decode(pdf.body), /^%PDF-1.4/);
  assert.match(new TextDecoder().decode(svg.body), /<svg /);
  assert.match(new TextDecoder().decode(csv.body), /'=SUM\(1,2\)/);
});
