import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';
import { runMigrations } from '../db/migrate.ts';
import { listCostsForOrganisation } from '../src/lib/engr/repos/workCosts.ts';

test('work cost register includes historical statuses, pages results, and never crosses organisations', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'engr-registers-'));
  const db = createClient({ url: `file:${join(dir, 'test.db')}` });
  try {
    await runMigrations(db);
    await db.batch(
      [
        `INSERT INTO organisations (id, name, slug) VALUES ('org-a', 'Kenya', 'kenya')`,
        `INSERT INTO organisations (id, name, slug) VALUES ('org-b', 'Uganda', 'uganda')`,
        `INSERT INTO users (id, org_id, full_name, email) VALUES ('user-a', 'org-a', 'Manager A', 'a@example.com')`,
        `INSERT INTO users (id, org_id, full_name, email) VALUES ('user-b', 'org-b', 'Manager B', 'b@example.com')`,
        `INSERT INTO regions (id, org_id, code, name) VALUES ('region-a', 'org-a', 'N', 'North')`,
        `INSERT INTO regions (id, org_id, code, name) VALUES ('region-b', 'org-b', 'S', 'South')`,
        `INSERT INTO stations (id, org_id, region_id, code, name) VALUES ('station-a', 'org-a', 'region-a', 'ST1', 'One')`,
        `INSERT INTO stations (id, org_id, region_id, code, name) VALUES ('station-b', 'org-b', 'region-b', 'ST2', 'Two')`,
        `INSERT INTO contractors (id, org_id, name) VALUES ('contractor-a', 'org-a', 'Supplier A')`,
        `INSERT INTO contractors (id, org_id, name) VALUES ('contractor-b', 'org-b', 'Supplier B')`,
        `INSERT INTO work_orders (id, org_id, wo_no, station_id, created_by) VALUES ('wo-a', 'org-a', 'WO-A', 'station-a', 'user-a')`,
        `INSERT INTO work_orders (id, org_id, wo_no, station_id, created_by) VALUES ('wo-b', 'org-b', 'WO-B', 'station-b', 'user-b')`,
        `INSERT INTO work_costs (id, org_id, work_order_id, contractor_id, status, created_at) VALUES ('cost-old', 'org-a', 'wo-a', 'contractor-a', 'APPROVED', '2026-01-01T00:00:00.000Z')`,
        `INSERT INTO work_costs (id, org_id, work_order_id, contractor_id, status, created_at) VALUES ('cost-new', 'org-a', 'wo-a', 'contractor-a', 'PENDING_L1', '2026-02-01T00:00:00.000Z')`,
        `INSERT INTO work_costs (id, org_id, work_order_id, contractor_id, status) VALUES ('cost-other', 'org-b', 'wo-b', 'contractor-b', 'APPROVED')`,
      ],
      'write',
    );

    assert.deepEqual(
      (await listCostsForOrganisation(db, 'org-a', 0, 1)).map((r) => r.id),
      ['cost-new', 'cost-old'],
    );
    assert.deepEqual(
      (await listCostsForOrganisation(db, 'org-a', 1, 1)).map((r) => r.id),
      ['cost-old'],
    );
    assert.deepEqual(
      (await listCostsForOrganisation(db, 'org-b', 0)).map((r) => r.id),
      ['cost-other'],
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
