import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';
import { runMigrations } from '../db/migrate.ts';
import { listNotificationAuditRows, listAuditRows } from '../src/lib/engr/repos/audit.ts';
import { recordNotificationEvent } from '../src/lib/engr/notify/deliveryAudit.ts';
import { applyDeliveryReceipt, retryFailed } from '../src/lib/engr/repos/notifications.ts';

test('delivery events are immutable, tenant-scoped and never contain authentication bodies', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'engr-notify-audit-'));
  const db = createClient({ url: `file:${join(dir, 'test.db')}` });
  try {
    await runMigrations(db);
    await db.batch([
      `INSERT INTO organisations (id,name,slug) VALUES ('org1','Hass','hass')`,
      `INSERT INTO organisations (id,name,slug) VALUES ('org2','Other','other')`,
      `INSERT INTO users (id,org_id,full_name,email) VALUES ('u1','org1','Delivery Operator','operator@example.test')`,
      `INSERT INTO notifications
          (id,org_id,channel,recipient_user_id,template_key,subject,body,status)
          VALUES ('n1','org1','EMAIL','u1','operations.notice','Work order notification','SECRET BODY', 'SENT')`,
      `INSERT INTO notifications
          (id,org_id,channel,recipient_user_id,template_key,subject,body,status,error)
          VALUES ('nold','org1','EMAIL','u1','auth.password.reset','Password reset','REDACTED','FAILED','Expired link')`,
      `INSERT INTO notifications
          (id,org_id,channel,template_key,subject,status,error)
          VALUES ('foreign','org2','EMAIL','operations.notice','Foreign','FAILED','Private failure')`,
    ], 'write');

    await recordNotificationEvent(db, {
      notificationId: 'n1', orgId: 'org1', event: 'sent', status: 'SENT',
      reason: 'Accepted: https://example.test/secret-token',
    });
    assert.equal(await applyDeliveryReceipt(db, 'n1', false, 'Mailbox unavailable'), true);
    assert.equal(await retryFailed(db, 'org1', 'n1', 'u1'), true);
    assert.equal(await retryFailed(db, 'org1', 'n1', 'u1'), false, 'a queued row cannot be retried again');

    const audit = await listNotificationAuditRows(db, 'org1', 20);
    assert.equal(audit.filter((r) => r.notificationId === 'n1').length, 3);
    assert.equal(audit.some((r) => r.notificationId === 'foreign'), false);
    assert.equal(audit.find((r) => r.notificationId === 'nold')?.status, 'FAILED', 'legacy failures remain visible');
    assert.equal(audit.find((r) => r.action === 'retry queued')?.actorName, 'Delivery Operator');
    assert.equal(audit.find((r) => r.action === 'provider failed')?.reason, 'Mailbox unavailable');
    assert.equal(audit.find((r) => r.action === 'sent')?.recipient, 'Delivery Operator');
    const events = await db.execute(`SELECT action, after_json FROM audit_logs WHERE entity_type='notification' AND entity_id='n1'`);
    assert.equal(events.rows.length, 3);
    for (const event of events.rows) {
      const raw = String(event.after_json);
      assert.doesNotMatch(raw, /SECRET BODY|secret-token/);
      assert.match(raw, /"recipientType":"user"/);
    }
    assert.deepEqual(await listAuditRows(db, 'org1'), [], 'delivery rows do not crowd operational history');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('one sidebar Assets entry and in-page bubble reuse the existing pending count event', () => {
  const layout = readFileSync(new URL('../src/layouts/EngrLayout.astro', import.meta.url), 'utf8');
  const assets = readFileSync(new URL('../src/pages/engr/admin/assets/index.astro', import.meta.url), 'utf8');
  const audit = readFileSync(new URL('../src/pages/engr/admin/audit/index.astro', import.meta.url), 'utf8');
  const action = readFileSync(new URL('../src/components/engr/ActionQueueLink.astro', import.meta.url), 'utf8');
  const requests = readFileSync(new URL('../src/lib/engr/repos/navigationPending.ts', import.meta.url), 'utf8');
  assert.match(layout, /label: 'Assets', icon: 'assets', badgeKey: 'assetTransfers'/);
  assert.doesNotMatch(layout, /label: 'Asset transfers'/);
  assert.doesNotMatch(layout, /label: 'Delivery monitor'/);
  assert.match(layout, /engr:pending-counts/);
  assert.match(assets, /<ActionQueueLink href="\/admin\/assets\/transfers"/);
  assert.match(assets, /countKeys=\{\['assetTransfers'\]\}/);
  assert.match(action, /data-pending-action-count/);
  assert.match(action, /addEventListener\('engr:pending-counts'/);
  assert.match(audit, /filter=delivery/);
  assert.match(audit, /notifications.monitor/);
  assert.doesNotMatch(requests, /deliveryMonitor/);
});
