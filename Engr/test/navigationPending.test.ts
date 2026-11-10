import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { Client } from '@libsql/client/web';
import {
  getPendingNavigationCounts,
  pendingNavigationPlan,
  type PendingNavActor,
} from '../src/lib/engr/repos/navigationPending.ts';

const today = '2026-11-10';
const actor = (perms: string[], roles = ['ENGINEERING_MANAGER']): PendingNavActor => ({
  orgId: 'org-ke',
  userId: 'user-ke',
  roles,
  perms,
});

test('maker-checker workflow counters filter by authenticated user and organisation', () => {
  const plan = pendingNavigationPlan(
    actor([
      'requests.view', 'requests.accept', 'rfq.view', 'rfq.release', 'lpo.view',
      'lpo.approve', 'workorder.view', 'workorder.assign',
    ]),
    today,
  );
  const keys = plan.map((q) => q.key);
  assert.deepEqual(keys, ['requests', 'workorders', 'rfqs', 'lpos']);
  for (const q of plan) {
    assert.equal(q.args[0], 'org-ke');
    assert.match(q.sql, /org_id/);
  }
  assert.match(plan[0].sql, /raised_by <> \?/);
  assert.match(plan[1].sql, /created_by <> \?/);
  assert.match(plan[2].sql, /submitted_by <> \?/);
  assert.match(plan[3].sql, /submitted_by,l.created_by\) <> \?/);
  assert.ok(plan.every((q) => q.args.includes('user-ke')));
});

test('portal roles have only their own actionable queues', () => {
  const station = pendingNavigationPlan(
    actor(['workorder.view', 'arrival.confirm', 'jobcard.confirm', 'cost.approve'], ['STATION_MANAGER']),
    today,
  );
  assert.deepEqual(station.map((q) => q.key), ['stationConfirmations']);
  assert.match(station[0].sql, /s.station_manager_id = \?/);
  assert.ok(station[0].args.includes('user-ke'));

  const contractor = pendingNavigationPlan(
    actor(['workorder.view', 'workorder.accept', 'workorder.assign_technician', 'quotes.view', 'quotes.submit', 'cost.view', 'cost.create', 'cost.submit', 'bill.view', 'bill.submit', 'cost.approve'], ['CONTRACTOR']),
    today,
  );
  assert.deepEqual(contractor.map((q) => q.key), ['workorders', 'rfqs', 'costs', 'costs', 'bills']);
  assert.ok(contractor.every((q) => q.sql.includes('portal_user_id = ?')));
  assert.ok(contractor.every((q) => q.args.includes('user-ke')));

  const technician = pendingNavigationPlan(
    actor(['workorder.view', 'workorder.execute', 'bill.approve.finance'], ['TECHNICIAN']),
    today,
  );
  assert.deepEqual(technician.map((q) => q.key), ['workorders']);
  assert.match(technician[0].sql, /t.portal_user_id = \?/);
});

test('permissions, not general visibility, determine who receives approval badges', () => {
  const engineer = pendingNavigationPlan(
    actor(['requests.view', 'workorder.create', 'rfq.view', 'rfq.create', 'rfq.submit', 'pm.view', 'pm.create', 'lpo.view', 'lpo.create', 'lpo.submit'], ['ENGINEER']),
    today,
  );
  assert.deepEqual(engineer.map((q) => q.key), ['requests', 'rfqs', 'lpos']);
  const finance = pendingNavigationPlan(
    actor(['bill.approve.finance', 'payment.record', 'payment.view']),
    today,
  );
  assert.deepEqual(finance.map((q) => q.key), ['billApprovals', 'payments']);
  assert.match(finance[1].sql, /NOT EXISTS/);
  const readonly = pendingNavigationPlan(actor(['reports.view', 'workorder.view'], ['VIEWER']), today);
  assert.deepEqual(readonly, []);
});

test('read batch combines maintenance items and omits completed or zero counts', async () => {
  const allowed = actor(['pm.view', 'pm.activate', 'pm.allocate', 'notifications.monitor']);
  const queries: string[] = [];
  const fakeDb = {
    batch: async (statements: Array<{ sql: string; args: Array<string | number> }>, mode: string) => {
      assert.equal(mode, 'read');
      queries.push(...statements.map((s) => s.sql));
      return [
        { rows: [{ n: 2 }] },
        { rows: [{ n: 3 }] },
      ];
    },
  } as unknown as Client;
  const counts = await getPendingNavigationCounts(fakeDb, allowed, today);
  assert.equal(queries.length, 2);
  assert.deepEqual(counts, { maintenance: 5 });
});

test('sidebar shows section totals when closed and item counters when opened', () => {
  const layout = readFileSync(new URL('../src/layouts/EngrLayout.astro', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/styles/engr.css', import.meta.url), 'utf8');
  assert.match(layout, /data-nav-group-count/);
  assert.match(layout, /data-nav-key/);
  assert.match(layout, /api\/navigation\/pending/);
  assert.doesNotMatch(layout, /data-bell/);
  assert.doesNotMatch(layout, /label: 'Action Centre'/);
  assert.match(layout, /label: 'Procurement approvals'/);
  assert.match(layout, /label: 'Bill approvals'/);
  assert.match(layout, /label: 'Assets'.*badgeKey: 'assetTransfers'/);
  assert.doesNotMatch(layout, /label: 'Asset transfers'/);
  assert.doesNotMatch(layout, /label: 'Delivery monitor'/);
  assert.match(css, /\.engr-navgroup\[open\].*\[data-nav-group-count\]/);
});
