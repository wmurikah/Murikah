/**
 * Phase 16: notifications and escalation.
 *
 * Idempotency is the whole difficulty, so every creation path here is run
 * twice and counted once. The escalation tests prove local-before-Group on
 * the seeded hierarchy: the Kenya supervisor hears about a Kenya delay and
 * the Group CFO hears nothing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, type TestClient } from './support/db.ts';
import { seedHass, SEED } from './support/hassSeed.ts';
import {
  notify,
  notifyImportException,
  sweepNotifications,
  listNotifications,
  markAllRead,
  markRead,
  unreadCount,
  resolveNotificationTarget,
} from '../../src/lib/cms/notify/notifications.ts';
import { sweepDueSlas } from '../../src/lib/cms/sla/engine.ts';
import { registerSlaHandlers, resetSlaRegistration } from '../../src/lib/cms/sla/wiring.ts';
import {
  resetCaseEventHandlers,
  resetLeadEventHandlers,
  resetSlaWiring,
} from '../../src/lib/cms/service/events.ts';
import { createCase } from '../../src/lib/cms/repos/serviceAdmin.ts';
import { createActivity } from '../../src/lib/cms/repos/activityAdmin.ts';

const NOW = new Date('2026-08-27T07:00:00Z');
const CTX = {
  actorUserId: SEED.admin,
  ip: '10.0.0.10',
  userAgent: 'HassCMS Test',
  now: NOW,
} as const;

async function grantAll(c: TestClient): Promise<void> {
  await c.execute({
    sql: `INSERT OR IGNORE INTO permissions (permission_id, module_name, resource_name, action_name, description) VALUES
          ('PERM-031','CUSTOMERS','ACCOUNTS','VIEW','View accounts'),
          ('PERM-039','SERVICE','CASES','MANAGE','Manage cases')`,
    args: [],
  });
  await c.execute({
    sql: `INSERT OR IGNORE INTO role_permissions (role_permission_id, role_id, permission_id, allowed, created_at)
          SELECT 'RP-ADMIN-' || permission_id, 'ROLE-ADMIN', permission_id, 1, CURRENT_TIMESTAMP
          FROM permissions WHERE permission_id IN ('PERM-031','PERM-039')`,
    args: [],
  });
}

const db = async (): Promise<TestClient> => {
  const c = createTestDb();
  await seedHass(c);
  await grantAll(c);
  resetCaseEventHandlers();
  resetLeadEventHandlers();
  resetSlaWiring();
  resetSlaRegistration();
  registerSlaHandlers();
  return c;
};
const asClient = (c: TestClient) => c as unknown as Parameters<typeof notify>[0];

const caseInput = (over: Record<string, unknown> = {}) =>
  ({
    accountId: 'ACC-004',
    contactId: 'CON-004',
    businessUnitId: 'BU-CI',
    caseType: 'COMPLAINT',
    caseCategoryId: 'CC-001',
    priority: 'HIGH',
    subject: 'Notification case',
    description: 'Drives the notification tests',
    channel: 'EMAIL',
    raisedAt: '2026-08-27 07:00:00',
    assignedTeamId: 'TEAM-CS-KE',
    assignedUserId: 'USR-CATH',
    ...over,
  }) as never;

// ---------------------------------------------------------------------------
// Idempotency, the whole difficulty.
// ---------------------------------------------------------------------------

test('the same event processed twice creates exactly one notification, and no boolean exists', async () => {
  const c = await db();
  const input = {
    userId: SEED.james,
    type: 'SYSTEM' as const,
    title: 'One thing happened',
    message: 'And it is reported once.',
    entityType: 'CASE',
    entityId: 'CASE-001',
    at: NOW,
  };
  assert.equal(await notify(asClient(c), input), true);
  assert.equal(await notify(asClient(c), input), false);
  const counted = await c.execute({
    sql: `SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND entity_id = 'CASE-001'`,
    args: [SEED.james],
  });
  assert.equal(Number(counted.rows[0]?.n), 1);

  // Unread is derived from read_at; the table has no boolean to add.
  const columns = await c.execute({
    sql: `SELECT COUNT(*) AS n FROM pragma_table_info('notifications')
          WHERE name IN ('is_read','read','unread')`,
    args: [],
  });
  assert.equal(Number(columns.rows[0]?.n), 0);
  c.close();
});

test('an assignment notification reaches the assignee once, with the case number and nothing commercial', async () => {
  const c = await db();
  const made = await createCase(asClient(c), SEED.admin, caseInput(), CTX, true);
  assert.equal(made.ok, true);
  if (!made.ok) return;

  const rows = await c.execute({
    sql: `SELECT title, message FROM notifications
          WHERE user_id = 'USR-CATH' AND notification_type = 'ASSIGNMENT' AND entity_id = ?`,
    args: [made.value.caseId],
  });
  assert.equal(rows.rows.length, 1);
  const body = `${rows.rows[0]?.title} ${rows.rows[0]?.message}`;
  assert.match(body, /CS-2026-/);
  // The policy: no customer name, no amount, in any stored field.
  assert.equal(body.includes('Lakeview'), false);

  // Re-emitting the assignment event changes nothing.
  const { emitCaseEvent } = await import('../../src/lib/cms/service/events.ts');
  await emitCaseEvent(asClient(c), {
    type: 'CASE_ASSIGNED',
    caseId: made.value.caseId,
    at: NOW,
    actorUserId: SEED.admin,
    detail: { toTeamId: 'TEAM-CS-KE', toUserId: 'USR-CATH' },
  });
  const again = await c.execute({
    sql: `SELECT COUNT(*) AS n FROM notifications
          WHERE user_id = 'USR-CATH' AND notification_type = 'ASSIGNMENT' AND entity_id = ?`,
    args: [made.value.caseId],
  });
  assert.equal(Number(again.rows[0]?.n), 1);
  c.close();
});

test('warning and breach notify the accountable person once each, under repeated sweeps', async () => {
  const c = await db();
  const made = await createCase(asClient(c), SEED.admin, caseInput(), CTX, true);
  assert.equal(made.ok, true);
  if (!made.ok) return;

  // Past the target: the SLA sweep records the breach facts, then the
  // notification sweep turns them into messages. Both run twice.
  const later = new Date('2026-08-27T09:30:00Z');
  await sweepDueSlas(asClient(c), later);
  await sweepNotifications(asClient(c), later);
  await sweepDueSlas(asClient(c), later);
  await sweepNotifications(asClient(c), later);

  const mine = await c.execute({
    sql: `SELECT notification_type, COUNT(*) AS n FROM notifications
          WHERE user_id = 'USR-CATH' AND notification_type IN ('SLA_WARNING','SLA_BREACH')
          GROUP BY notification_type`,
    args: [],
  });
  const byType = new Map(mine.rows.map((r) => [String(r.notification_type), Number(r.n)]));
  assert.equal(byType.get('SLA_WARNING'), 1);
  assert.equal(byType.get('SLA_BREACH'), 1);
  c.close();
});

test('local escalation reaches the local supervisor once, never the Group CFO, with its evidence recorded', async () => {
  const c = await db();
  // Give the Kenya service team a manager so the local policy has somewhere
  // local to land. Amina (USR-AMN) is the Kenya country manager in the seed.
  await c.execute({
    sql: `UPDATE teams SET manager_user_id = 'USR-AMN' WHERE team_id = 'TEAM-CS-KE'`,
    args: [],
  });
  const made = await createCase(asClient(c), SEED.admin, caseInput(), CTX, true);
  assert.equal(made.ok, true);
  if (!made.ok) return;

  // SLAR-001: 60 minute target, escalation 60 minutes after that. Go well past.
  const later = new Date('2026-08-27T11:00:00Z');
  await sweepDueSlas(asClient(c), later);
  await sweepNotifications(asClient(c), later);
  await sweepNotifications(asClient(c), later);

  // The seeded breached instances (SLAI-002, SLAI-003) escalate too, to the
  // same local policy; this test reads only the escalation for its own case.
  const escalations = await c.execute({
    sql: `SELECT e.recipient_user_id, e.details_json FROM sla_escalation_events e
          JOIN sla_instances i ON i.sla_instance_id = e.sla_instance_id
          WHERE i.entity_type = 'CASE' AND i.entity_id = ?`,
    args: [made.value.caseId],
  });
  assert.equal(escalations.rows.length, 1);
  assert.equal(String(escalations.rows[0]?.recipient_user_id), 'USR-AMN');
  const details = JSON.parse(String(escalations.rows[0]?.details_json)) as { why?: string };
  assert.match(details.why ?? '', /exceeded its target/);
  assert.match(details.why ?? '', /local/);

  // The Group CFO heard nothing: no configuration named Group.
  const groupCfo = await c.execute({
    sql: `SELECT COUNT(*) AS n FROM notifications WHERE user_id = 'USR-GCFO'`,
    args: [],
  });
  assert.equal(Number(groupCfo.rows[0]?.n), 0);

  // One escalation level fires once: the duplicate is refused by UNIQUE.
  await assert.rejects(
    c.execute({
      sql: `INSERT INTO sla_escalation_events
              (sla_escalation_event_id, sla_instance_id, escalation_level, escalated_at)
            SELECT 'ESC-DUP', sla_instance_id, 1, '2026-08-27 11:30:00' FROM sla_escalation_events LIMIT 1`,
      args: [],
    }),
    /UNIQUE constraint failed/,
  );
  c.close();
});

test('an overdue activity produces one follow-up, not one per sweep cycle', async () => {
  const c = await db();
  const made = await createActivity(
    asClient(c),
    SEED.admin,
    {
      entityType: 'ACCOUNT',
      entityId: 'ACC-001',
      activityType: 'TASK',
      contactId: null,
      ownerUserId: SEED.james,
      summary: 'Chase the renewal paperwork',
      notes: null,
      scheduledAt: '2026-08-26 09:00:00',
      completedAt: null,
      outcome: null,
      nextAction: null,
      nextActionDue: null,
    },
    CTX,
  );
  assert.equal(made.ok, true);
  await sweepNotifications(asClient(c), NOW);
  await sweepNotifications(asClient(c), NOW);
  await sweepNotifications(asClient(c), NOW);
  const rows = await c.execute({
    sql: `SELECT COUNT(*) AS n FROM notifications
          WHERE user_id = ? AND notification_type = 'FOLLOW_UP' AND entity_type = 'ACTIVITY'`,
    args: [SEED.james],
  });
  assert.equal(Number(rows.rows[0]?.n), 1);
  c.close();
});

test('import exceptions aggregate into one message naming the count', async () => {
  const c = await db();
  await notifyImportException(asClient(c), {
    userId: SEED.admin,
    batchId: 'BATCH-001',
    unresolvedCount: 4,
    at: NOW,
  });
  await notifyImportException(asClient(c), {
    userId: SEED.admin,
    batchId: 'BATCH-001',
    unresolvedCount: 4,
    at: NOW,
  });
  const rows = await c.execute({
    sql: `SELECT title FROM notifications
          WHERE notification_type = 'IMPORT_EXCEPTION' AND entity_id = 'BATCH-001'`,
    args: [],
  });
  assert.equal(rows.rows.length, 1);
  assert.match(String(rows.rows[0]?.title), /4 unresolved/);
  c.close();
});

// ---------------------------------------------------------------------------
// Read state and the access re-check.
// ---------------------------------------------------------------------------

test('read state is derived from read_at, marked one at a time or all at once', async () => {
  const c = await db();
  // Neema has no seeded notification rows, so the arithmetic is exact.
  for (let i = 0; i < 3; i++) {
    await notify(asClient(c), {
      userId: SEED.neema,
      type: 'SYSTEM',
      title: `Notice ${i}`,
      message: 'A thing',
      entityType: null,
      entityId: `N-${i}`,
      at: NOW,
    });
  }
  assert.equal(await unreadCount(asClient(c), SEED.neema), 3);
  const list = await listNotifications(asClient(c), SEED.neema, {
    unreadOnly: true,
    type: null,
    page: 1,
  });
  const first = list.items[0];
  assert.notEqual(first, undefined);
  if (first === undefined) return;
  await markRead(asClient(c), SEED.neema, first.notificationId, NOW);
  assert.equal(await unreadCount(asClient(c), SEED.neema), 2);
  await markAllRead(asClient(c), SEED.neema, NOW);
  assert.equal(await unreadCount(asClient(c), SEED.neema), 0);
  c.close();
});

test('a notification is not an access grant: the target re-runs access control now', async () => {
  const c = await db();
  const made = await createCase(asClient(c), SEED.admin, caseInput(), CTX, true);
  assert.equal(made.ok, true);
  if (!made.ok) return;

  // Notify somebody who has no service scope at all.
  await notify(asClient(c), {
    userId: SEED.neema,
    type: 'ASSIGNMENT',
    title: `Case ${made.value.caseNumber} assigned to you`,
    message: 'On your queue.',
    entityType: 'CASE',
    entityId: made.value.caseId,
    at: NOW,
  });
  const list = await listNotifications(asClient(c), SEED.neema, {
    unreadOnly: false,
    type: null,
    page: 1,
  });
  const notification = list.items[0];
  assert.notEqual(notification, undefined);
  if (notification === undefined) return;
  // The row exists; the destination does not, because access is decided now.
  const denied = await resolveNotificationTarget(asClient(c), SEED.neema, notification);
  assert.equal(denied, null);
  // The same notification for the admin resolves to the case.
  const allowed = await resolveNotificationTarget(asClient(c), SEED.admin, {
    ...notification,
  });
  assert.equal(allowed, `/app/helpdesk/${made.value.caseId}`);
  c.close();
});

test('no restricted field reaches a stored message', async () => {
  const c = await db();
  const made = await createCase(asClient(c), SEED.admin, caseInput(), CTX, true);
  assert.equal(made.ok, true);
  const later = new Date('2026-08-27T11:00:00Z');
  await sweepDueSlas(asClient(c), later);
  await sweepNotifications(asClient(c), later);
  // Only rows this system wrote: the seeded NOT-00x demo rows are the
  // operator's fixture text, not this module's output.
  const rows = await c.execute({
    sql: `SELECT title || ' ' || message AS body FROM notifications
          WHERE notification_id LIKE 'NOTIF-%'`,
    args: [],
  });
  for (const raw of rows.rows) {
    const body = String((raw as Record<string, unknown>).body);
    // No customer names, no currency amounts: numbers only appear inside
    // record identifiers such as CS-2026-... or counts of items.
    assert.equal(/Lakeview|BluePeak|Riftline|EastGate|Savannah/.test(body), false, body);
    assert.equal(/KES|USD|UGX/.test(body), false, body);
  }
  c.close();
});
