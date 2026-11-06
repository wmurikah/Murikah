import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';
import { runMigrations } from '../db/migrate.ts';
import {
  approveLpo,
  createLpo,
  createWorkOrderInLpo,
  issueLpo,
  submitLpo,
} from '../src/lib/engr/repos/lpos.ts';
import {
  createRfqWithInvitations,
  releaseRfq,
  submitRfq,
  updateRfqDraft,
} from '../src/lib/engr/repos/rfqs.ts';

test('engineers make drafts, managers check them, and option ids stay inside the organisation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'engr-workflow-roles-'));
  const db = createClient({ url: `file:${join(directory, 'test.db')}` });
  try {
    await runMigrations(db);
    await db.batch(
      [
        { sql: `INSERT INTO organisations (id,name,slug) VALUES ('o1','One','one')`, args: [] },
        { sql: `INSERT INTO organisations (id,name,slug) VALUES ('o2','Two','two')`, args: [] },
        {
          sql: `INSERT INTO users (id,org_id,full_name,email) VALUES ('maker','o1','Maker','maker@example.test')`,
          args: [],
        },
        {
          sql: `INSERT INTO users (id,org_id,full_name,email) VALUES ('checker','o1','Checker','checker@example.test')`,
          args: [],
        },
        {
          sql: `INSERT INTO stations (id,org_id,code,name) VALUES ('s1','o1','S1','Station One')`,
          args: [],
        },
        {
          sql: `INSERT INTO stations (id,org_id,code,name) VALUES ('foreign-station','o2','F1','Foreign')`,
          args: [],
        },
        {
          sql: `INSERT INTO asset_categories (id,org_id,code,name) VALUES ('cat1','o1','C1','Category')`,
          args: [],
        },
        {
          sql: `INSERT INTO asset_categories (id,org_id,code,name) VALUES ('foreign-category','o2','FC','Foreign category')`,
          args: [],
        },
        {
          sql: `INSERT INTO slas (id,org_id,name) VALUES ('sla1','o1','Standard')`,
          args: [],
        },
        {
          sql: `INSERT INTO contractors (id,org_id,name,is_prequalified) VALUES ('c1','o1','Vendor',1)`,
          args: [],
        },
        {
          sql: `INSERT INTO contractor_stations (org_id,contractor_id,station_id) VALUES ('o1','c1','s1')`,
          args: [],
        },
        {
          sql: `INSERT INTO service_requests
                  (id,org_id,request_no,station_id,category_id,raised_by,issue,status)
                VALUES ('request-rfq','o1','REQ-1','s1','cat1','checker','Issue','ACCEPTED')`,
          args: [],
        },
      ],
      'write',
    );

    const maker = { orgId: 'o1', userId: 'maker' };
    const checker = { orgId: 'o1', userId: 'checker' };

    const crossOrgLpo = await createLpo(db, maker, {
      contractorId: 'c1',
      baseStationId: 'foreign-station',
    });
    assert.equal(crossOrgLpo.ok, false);

    const lpo = await createLpo(db, maker, { contractorId: 'c1', baseStationId: 's1' });
    assert.equal(lpo.ok, true);
    if (!lpo.ok) return;

    const crossOrgWorkOrder = await createWorkOrderInLpo(db, maker, {
      lpoId: lpo.lpoId,
      stationId: 's1',
      categoryId: 'foreign-category',
      slaId: 'sla1',
      mileageReferenceStationId: 's1',
    });
    assert.equal(crossOrgWorkOrder.ok, false);

    const workOrder = await createWorkOrderInLpo(db, maker, {
      lpoId: lpo.lpoId,
      stationId: 's1',
      categoryId: 'cat1',
      slaId: 'sla1',
      mileageReferenceStationId: 's1',
    });
    assert.equal(workOrder.ok, true);
    assert.equal((await submitLpo(db, checker, lpo.lpoId)).ok, false);
    assert.equal((await submitLpo(db, maker, lpo.lpoId)).ok, true);
    assert.equal((await approveLpo(db, maker, lpo.lpoId)).ok, false);
    assert.equal((await approveLpo(db, checker, lpo.lpoId)).ok, true);
    assert.equal((await issueLpo(db, checker, lpo.lpoId)).ok, true);
    if (workOrder.ok) {
      const status = await db.execute({
        sql: `SELECT status FROM work_orders WHERE id = ?`,
        args: [workOrder.workOrderId],
      });
      assert.equal(status.rows[0]?.status, 'CONTRACTOR_NOTIFIED');
    }

    const rfq = await createRfqWithInvitations(db, maker, {
      requestId: 'request-rfq',
      dueDate: '2026-12-01',
      thresholdMinor: 100_000,
      contractorIds: ['c1'],
    });
    assert.equal(rfq.ok, true);
    if (!rfq.ok) return;

    assert.equal(
      (await updateRfqDraft(db, checker, rfq.rfqId, { dueDate: null, thresholdMinor: null })).ok,
      false,
    );
    assert.equal((await submitRfq(db, checker, rfq.rfqId)).ok, false);
    assert.equal((await submitRfq(db, maker, rfq.rfqId)).ok, true);
    assert.equal((await releaseRfq(db, maker, rfq.rfqId)).ok, false);
    assert.equal((await releaseRfq(db, checker, rfq.rfqId)).ok, true);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
