import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = (relative: string): string =>
  readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');

test('six collapsible groups contain exactly the approved 25 destinations', () => {
  const layout = source('src/layouts/EngrLayout.astro');
  const start = layout.indexOf('const rawGroups: NavGroup[] = [');
  const end = layout.indexOf('const groups = rawGroups.filter', start);
  assert.ok(start > 0 && end > start);
  const menu = layout.slice(start, end);
  const groups = [...menu.matchAll(/^    label: '([^']+)',/gm)].map((x) => x[1]);
  assert.deepEqual(groups, [
    'Overview', 'Operations', 'Procurement', 'Finance', 'Service Setup', 'Administration',
  ]);
  const allLabels = [...menu.matchAll(/label: '([^']+)'/g)].map((x) => x[1]);
  const items = allLabels.filter((label) => !groups.includes(label));
  const expected = [
    'Dashboard', 'Report centre',
    'Requests', 'Work orders', 'Maintenance', 'Assets',
    'RFQs', 'LPOs', 'Contractors', 'Rate cards',
    'Costs', 'Bills', 'Invoices', 'Payments',
    'Locations', 'Regions', 'Technicians', 'Engineers in charge', 'SLAs',
    'Affiliates', 'Users', 'Roles', 'Notification settings', 'Security settings', 'Audit history',
  ];
  assert.equal(items.length, 25);
  assert.deepEqual(items, expected);
  assert.equal(new Set(items).size, 25, 'no destination may be repeated');
  for (const removed of [
    'Location confirmations', 'Procurement approvals', 'Mileage approvals',
    'Cost approvals', 'Bill approvals', 'Asset transfers', 'Delivery monitor',
  ]) {
    assert.equal(items.includes(removed), false, removed + ' belongs inside a parent page');
  }
});

test('existing queues remain linked under the correct parent and contribute to its sidebar badge', () => {
  const layout = source('src/layouts/EngrLayout.astro');
  assert.match(layout, /extraBadgeKeys: \['stationConfirmations'\]/);
  assert.match(layout, /extraBadgeKeys: \['procurementApprovals'\]/);
  assert.match(layout, /extraBadgeKeys: \['mileageApprovals', 'costApprovals'\]/);
  assert.match(layout, /extraBadgeKeys: \['billApprovals'\]/);
  assert.match(layout, /badgeKey: 'assetTransfers'/);
  assert.match(layout, /data-nav-extra-keys/);
  assert.match(layout, /badge\.dataset\.navExtraKeys/);
  assert.match(layout, /keys\.reduce\(/);
  for (const route of [
    '/station/confirmations', '/procurement/approvals',
    '/mileage/approvals', '/costs/approvals', '/bills/approvals',
  ]) assert.ok(layout.includes(`'${route}'`), route + ' should keep its parent highlighted');

  const queues: Array<[string, string, string]> = [
    ['src/pages/engr/workorders/index.astro', '/station/confirmations', 'stationConfirmations'],
    ['src/pages/engr/rfqs/index.astro', '/procurement/approvals', 'procurementApprovals'],
    ['src/pages/engr/costs/index.astro', '/mileage/approvals', 'mileageApprovals'],
    ['src/pages/engr/costs/index.astro', '/costs/approvals', 'costApprovals'],
    ['src/pages/engr/bills/index.astro', '/bills/approvals', 'billApprovals'],
    ['src/pages/engr/admin/assets/index.astro', '/admin/assets/transfers', 'assetTransfers'],
  ];
  for (const [file, route, key] of queues) {
    const page = source(file);
    assert.ok(page.includes(`href="${route}"`), file + ' must link to ' + route);
    assert.ok(page.includes(`countKeys={['${key}']}`), file + ' must show only its matching count');
    assert.match(page, /ActionQueueLink/);
  }
  const actions = source('src/components/engr/ActionQueueLink.astro');
  assert.match(actions, /engr:pending-counts/);
  assert.match(actions, /data-pending-action-count/);
  assert.doesNotMatch(actions, /fetch\(/, 'contextual badges reuse a single existing sidebar request');
});

test('approval-only roles have a parent landing page without granting visibility of the full register', () => {
  const layout = source('src/layouts/EngrLayout.astro');
  assert.match(layout, /has\('rfq\.award'\)/);
  assert.match(layout, /has\('cost\.approve'\)/);
  assert.match(layout, /has\('bill\.approve\.finance'\)/);
  const rfq = source('src/pages/engr/rfqs/index.astro');
  const costs = source('src/pages/engr/costs/index.astro');
  const bills = source('src/pages/engr/bills/index.astro');
  for (const page of [rfq, costs, bills]) {
    assert.match(page, /if \(allowed\)/, 'list query must remain gated on register view permission');
    assert.match(page, /!allowed \?/, 'a limited role must not be shown register rows');
  }
  assert.match(rfq, /canProcure/);
  assert.match(costs, /canApprove/);
  assert.match(bills, /canApprove/);
  assert.match(layout, /open=\{\['Overview', 'Operations', 'Procurement'\]\.includes\(group.label\)\}/);
  assert.doesNotMatch(layout, /name="engr-nav"/, 'multiple default-expanded sections must be possible');
  const wo = source('src/pages/engr/workorders/index.astro');
  assert.match(wo, /const canConfirm = allowed &&/, 'station confirmations retain the existing workorder.view gate');
  const contractors = source('src/pages/engr/admin/contractors/index.astro');
  assert.match(contractors, /can\(Astro\.locals, 'technicians\.view'\)/);
  assert.match(contractors, /href="\/admin\/technicians"/);
});
