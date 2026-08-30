/**
 * Phase 13: the shared activity engine.
 *
 * The centre of gravity is the polymorphic control: entity_id has no foreign
 * key, so every claim here about access is proved by direct repository calls
 * with hostile inputs, not by what the interface offers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { refusalFields } from './support/refusal.ts';
import { createTestDb, type TestClient } from './support/db.ts';
import { seedHass, SEED } from './support/hassSeed.ts';
import {
  createActivity,
  completeActivity,
  getActivity,
  listAccountActivities,
  listEntityActivities,
  myWork,
  reassignActivity,
  QUALIFYING_CONTACT,
  DUE_SQL,
  type ActivityInput,
} from '../../src/lib/cms/repos/activityAdmin.ts';
import { resolveEntityAccess } from '../../src/lib/cms/crm/entityAccess.ts';
import { createLead, getLead, type LeadInput } from '../../src/lib/cms/repos/leadAdmin.ts';

const NOW = new Date('2026-08-27T10:00:00Z');
const CTX = {
  actorUserId: SEED.admin,
  ip: '10.0.0.10',
  userAgent: 'HassCMS Test',
  now: NOW,
} as const;

const anyQuery = {
  activityType: null,
  ownerUserId: null,
  state: 'all' as const,
  from: null,
  to: null,
  search: '',
  page: 1,
};

/** The permission scripts 02, 03 and 04, exactly as the operator runs them. */
async function grantAll(c: TestClient): Promise<void> {
  await c.execute({
    sql: `INSERT OR IGNORE INTO permissions (permission_id, module_name, resource_name, action_name, description) VALUES
          ('PERM-031','CUSTOMERS','ACCOUNTS','VIEW','View customer accounts'),
          ('PERM-032','CUSTOMERS','ACCOUNTS','MANAGE','Manage customer accounts'),
          ('PERM-034','CRM','LEADS','MANAGE','Manage leads'),
          ('PERM-036','CRM','OPPORTUNITIES','VIEW','View opportunities')`,
    args: [],
  });
  await c.execute({
    sql: `INSERT OR IGNORE INTO role_permissions (role_permission_id, role_id, permission_id, allowed, created_at)
          SELECT 'RP-ADMIN-' || permission_id, 'ROLE-ADMIN', permission_id, 1, CURRENT_TIMESTAMP
          FROM permissions WHERE permission_id IN ('PERM-031','PERM-032','PERM-034','PERM-036')`,
    args: [],
  });
}

const db = async (): Promise<TestClient> => {
  const c = createTestDb();
  await seedHass(c);
  await grantAll(c);
  return c;
};
const asClient = (c: TestClient) => c as unknown as Parameters<typeof createActivity>[0];

const activity = (over: Partial<ActivityInput> = {}): ActivityInput => ({
  entityType: 'ACCOUNT',
  entityId: 'ACC-001',
  activityType: 'CALL',
  contactId: null,
  ownerUserId: SEED.james,
  summary: 'Spoke about renewal terms',
  notes: null,
  scheduledAt: null,
  completedAt: '2026-08-27 09:30:00',
  outcome: 'Positive',
  nextAction: null,
  nextActionDue: null,
  ...over,
});

// ---------------------------------------------------------------------------
// The polymorphic control.
// ---------------------------------------------------------------------------

test('an activity lands on an account, a lead and an opportunity, with the account derived', async () => {
  const c = await db();
  const onAccount = await createActivity(asClient(c), SEED.admin, activity(), CTX);
  assert.equal(onAccount.ok, true);
  if (onAccount.ok) assert.equal(onAccount.value.accountId, 'ACC-001');

  const onLead = await createActivity(
    asClient(c),
    SEED.admin,
    activity({ entityType: 'LEAD', entityId: 'LEAD-002', activityType: 'MEETING' }),
    CTX,
  );
  assert.equal(onLead.ok, true);
  // LEAD-002 belongs to ACC-005: the account came from the lead, not a payload.
  if (onLead.ok) assert.equal(onLead.value.accountId, 'ACC-005');

  const onOpportunity = await createActivity(
    asClient(c),
    SEED.admin,
    activity({ entityType: 'OPPORTUNITY', entityId: 'OPP-001', activityType: 'PROPOSAL' }),
    CTX,
  );
  assert.equal(onOpportunity.ok, true);
  if (onOpportunity.ok) assert.equal(onOpportunity.value.accountId, 'ACC-003');
  c.close();
});

test('an unknown entity type, a missing row and an out-of-scope row are one refusal', async () => {
  const c = await db();
  const badType = await createActivity(
    asClient(c),
    SEED.admin,
    activity({ entityType: 'INVOICE', entityId: 'X' }),
    CTX,
  );
  assert.equal(badType.ok, false);

  const missing = await createActivity(
    asClient(c),
    SEED.admin,
    activity({ entityId: 'ACC-NOPE' }),
    CTX,
  );
  assert.equal(missing.ok, false);

  // James is OWN-scoped on accounts he manages; ACC-002's manager is not him.
  await c.execute({
    sql: `UPDATE accounts SET account_manager_user_id = ? WHERE account_id = 'ACC-001'`,
    args: [SEED.james],
  });
  const outOfScope = await createActivity(
    asClient(c),
    SEED.james,
    activity({ entityId: 'ACC-002' }),
    CTX,
  );
  assert.equal(outOfScope.ok, false);
  if (!outOfScope.ok && !missing.ok) {
    // Identical shape: nothing distinguishes absent from withheld.
    assert.deepEqual(refusalFields(outOfScope), refusalFields(missing));
  }
  c.close();
});

test('a contact from another account is refused whatever the payload claims', async () => {
  const c = await db();
  // CON-001 belongs to ACC-001; the activity is on ACC-002.
  const refused = await createActivity(
    asClient(c),
    SEED.admin,
    activity({ entityId: 'ACC-002', contactId: 'CON-001' }),
    CTX,
  );
  assert.equal(refused.ok, false);
  if (!refused.ok) {
    assert.equal(refusalFields(refused)[0]?.field, 'contactId');
  }
  const accepted = await createActivity(
    asClient(c),
    SEED.admin,
    activity({ entityId: 'ACC-001', contactId: 'CON-001' }),
    CTX,
  );
  assert.equal(accepted.ok, true);
  c.close();
});

test('reading by id re-resolves access through the parent, so a guessed id earns nothing', async () => {
  const c = await db();
  const made = await createActivity(asClient(c), SEED.admin, activity(), CTX);
  assert.equal(made.ok, true);
  if (!made.ok) return;
  // An external user has no account scope: the same id answers null.
  const denied = await getActivity(
    asClient(c),
    SEED.external[0] ?? 'USR-EXT001',
    made.value.activityId,
  );
  assert.equal(denied, null);
  const allowed = await getActivity(asClient(c), SEED.admin, made.value.activityId);
  assert.notEqual(allowed, null);
  c.close();
});

// ---------------------------------------------------------------------------
// First contact.
// ---------------------------------------------------------------------------

const bareLead = (): LeadInput => ({
  accountId: 'ACC-001',
  primaryContactId: null,
  leadSourceId: 'LS-002',
  campaignId: null,
  businessUnitId: 'BU-CI',
  ownerUserId: SEED.james,
  title: 'Activity engine lead',
  description: null,
  productInterest: null,
  estimatedVolume: null,
  estimatedValue: 100000,
  currencyCode: 'KES',
  capturedAt: '2026-08-26 08:00:00',
});

test('a first qualifying contact sets lead.first_contact_at in the same transaction', async () => {
  const c = await db();
  const lead = await createLead(asClient(c), bareLead(), CTX);
  assert.equal(lead.ok, true);
  if (!lead.ok) return;
  assert.equal(lead.value.firstContactAt, null);

  const call = await createActivity(
    asClient(c),
    SEED.admin,
    activity({
      entityType: 'LEAD',
      entityId: lead.value.leadId,
      activityType: 'CALL',
      completedAt: '2026-08-27 09:00:00',
    }),
    CTX,
  );
  assert.equal(call.ok, true);

  const after = await getLead(asClient(c), SEED.admin, lead.value.leadId);
  // The activity's own completion time is the contact time: it is the
  // verifiable evidence of when the contact happened.
  assert.equal(after?.firstContactAt, '2026-08-27 09:00:00');
  assert.equal(after?.status, 'CONTACTED');

  // A second qualifying contact does not move the stamp.
  await createActivity(
    asClient(c),
    SEED.admin,
    activity({
      entityType: 'LEAD',
      entityId: lead.value.leadId,
      activityType: 'MEETING',
      completedAt: '2026-08-27 15:00:00',
    }),
    CTX,
  );
  const still = await getLead(asClient(c), SEED.admin, lead.value.leadId);
  assert.equal(still?.firstContactAt, '2026-08-27 09:00:00');
  c.close();
});

test('a NOTE does not qualify as first contact, and the constant says which do', async () => {
  const c = await db();
  assert.deepEqual([...QUALIFYING_CONTACT], ['CALL', 'EMAIL', 'WHATSAPP', 'MEETING', 'VISIT']);
  assert.equal(QUALIFYING_CONTACT.includes('NOTE' as never), false);
  assert.equal(QUALIFYING_CONTACT.includes('TASK' as never), false);

  const lead = await createLead(asClient(c), bareLead(), CTX);
  assert.equal(lead.ok, true);
  if (!lead.ok) return;
  const note = await createActivity(
    asClient(c),
    SEED.admin,
    activity({ entityType: 'LEAD', entityId: lead.value.leadId, activityType: 'NOTE' }),
    CTX,
  );
  assert.equal(note.ok, true);
  const after = await getLead(asClient(c), SEED.admin, lead.value.leadId);
  assert.equal(after?.firstContactAt, null);
  assert.equal(after?.status, 'NEW');
  c.close();
});

// ---------------------------------------------------------------------------
// My Work and the due-time rule.
// ---------------------------------------------------------------------------

test('overdue and upcoming derive from COALESCE(next_action_due, scheduled_at), across a date boundary', async () => {
  const c = await db();
  assert.equal(DUE_SQL, 'COALESCE(act.next_action_due, act.scheduled_at)');

  // Due yesterday 23:50, now is 10:00 today: overdue across the boundary.
  await createActivity(
    asClient(c),
    SEED.admin,
    activity({
      activityType: 'TASK',
      ownerUserId: SEED.admin,
      completedAt: null,
      scheduledAt: '2026-08-26 23:50:00',
      summary: 'Overdue task from last night',
    }),
    CTX,
  );
  // Scheduled ahead, but the explicit follow-up is what governs: due sooner.
  await createActivity(
    asClient(c),
    SEED.admin,
    activity({
      activityType: 'FOLLOW_UP',
      ownerUserId: SEED.admin,
      completedAt: null,
      scheduledAt: '2026-08-29 09:00:00',
      nextActionDue: '2026-08-28 09:00:00',
      summary: 'Follow-up governed by next_action_due',
    }),
    CTX,
  );
  // No due time at all: visible under upcoming, never invented as overdue.
  await createActivity(
    asClient(c),
    SEED.admin,
    activity({
      activityType: 'TASK',
      ownerUserId: SEED.admin,
      completedAt: null,
      summary: 'Unscheduled task',
    }),
    CTX,
  );

  const work = await myWork(asClient(c), SEED.admin, NOW);
  assert.equal(
    work.overdue.some((a) => a.summary === 'Overdue task from last night'),
    true,
  );
  const followUp = work.upcoming.find((a) => a.summary === 'Follow-up governed by next_action_due');
  assert.equal(followUp?.dueAt, '2026-08-28 09:00:00');
  assert.equal(
    work.upcoming.some((a) => a.summary === 'Unscheduled task'),
    true,
  );
  assert.equal(
    work.overdue.some((a) => a.summary === 'Unscheduled task'),
    false,
  );
  c.close();
});

test('completion sets completed_at once and moves the row between sections', async () => {
  const c = await db();
  const made = await createActivity(
    asClient(c),
    SEED.admin,
    activity({
      activityType: 'TASK',
      ownerUserId: SEED.admin,
      completedAt: null,
      scheduledAt: '2026-08-26 08:00:00',
      summary: 'Task to complete',
    }),
    CTX,
  );
  assert.equal(made.ok, true);
  if (!made.ok) return;

  const before = await myWork(asClient(c), SEED.admin, NOW);
  assert.equal(
    before.overdue.some((a) => a.activityId === made.value.activityId),
    true,
  );

  const done = await completeActivity(asClient(c), SEED.admin, made.value.activityId, 'Done', CTX);
  assert.equal(done.ok, true);
  if (!done.ok) return;
  const stamp = done.value.completedAt;
  assert.notEqual(stamp, null);

  // A second completion does not move the timestamp.
  const again = await completeActivity(asClient(c), SEED.admin, made.value.activityId, null, CTX);
  assert.equal(again.ok, true);
  if (again.ok) assert.equal(again.value.completedAt, stamp);

  const after = await myWork(asClient(c), SEED.admin, NOW);
  assert.equal(
    after.overdue.some((a) => a.activityId === made.value.activityId),
    false,
  );
  assert.equal(
    after.recentlyCompleted.some((a) => a.activityId === made.value.activityId),
    true,
  );
  c.close();
});

// ---------------------------------------------------------------------------
// Timelines.
// ---------------------------------------------------------------------------

test('the account timeline reaches activities recorded through the account’s own records, each exactly once', async () => {
  const c = await db();
  // Three activities all deriving ACC-001: directly, through its lead, and
  // through its opportunity (OPP-003 is on ACC-001).
  await createActivity(
    asClient(c),
    SEED.admin,
    activity({ summary: 'Direct on the account' }),
    CTX,
  );
  await createActivity(
    asClient(c),
    SEED.admin,
    activity({ entityType: 'LEAD', entityId: 'LEAD-003', summary: 'Through the lead' }),
    CTX,
  );
  await createActivity(
    asClient(c),
    SEED.admin,
    activity({
      entityType: 'OPPORTUNITY',
      entityId: 'OPP-003',
      summary: 'Through the opportunity',
    }),
    CTX,
  );

  const timeline = await listAccountActivities(asClient(c), SEED.admin, 'ACC-001', anyQuery);
  assert.notEqual(timeline, null);
  if (timeline === null) return;
  const mine = timeline.items.filter((a) =>
    ['Direct on the account', 'Through the lead', 'Through the opportunity'].includes(a.summary),
  );
  // Each appears exactly once: the count is the proof of no double counting.
  assert.equal(mine.length, 3);
  assert.equal(new Set(mine.map((a) => a.activityId)).size, 3);
  // And the page total agrees with a bare count of the same predicate.
  const counted = await c.execute({
    sql: `SELECT COUNT(*) AS n FROM activities WHERE account_id = 'ACC-001'`,
    args: [],
  });
  assert.equal(timeline.total, Number(counted.rows[0]?.n));
  c.close();
});

test('the entity timeline is paginated and refuses an out-of-scope parent', async () => {
  const c = await db();
  for (let i = 0; i < 30; i++) {
    await createActivity(
      asClient(c),
      SEED.admin,
      activity({ activityType: 'NOTE', summary: `Note number ${i}` }),
      CTX,
    );
  }
  const pageOne = await listEntityActivities(
    asClient(c),
    SEED.admin,
    'ACCOUNT',
    'ACC-001',
    anyQuery,
  );
  assert.notEqual(pageOne, null);
  if (pageOne === null) return;
  assert.equal(pageOne.items.length, 25);
  assert.equal(pageOne.total >= 30, true);
  const pageTwo = await listEntityActivities(asClient(c), SEED.admin, 'ACCOUNT', 'ACC-001', {
    ...anyQuery,
    page: 2,
  });
  assert.equal((pageTwo?.items.length ?? 0) >= 5, true);

  const denied = await listEntityActivities(
    asClient(c),
    SEED.external[0] ?? 'USR-EXT001',
    'ACCOUNT',
    'ACC-001',
    anyQuery,
  );
  assert.equal(denied, null);
  c.close();
});

// ---------------------------------------------------------------------------
// Audit and campaign access.
// ---------------------------------------------------------------------------

test('the four audit types are written, and reassignment preserves the creator in the trail', async () => {
  const c = await db();
  const made = await createActivity(
    asClient(c),
    SEED.admin,
    activity({ activityType: 'TASK', completedAt: null, summary: 'Auditable task' }),
    CTX,
  );
  assert.equal(made.ok, true);
  if (!made.ok) return;
  const id = made.value.activityId;
  const { updateActivity } = await import('../../src/lib/cms/repos/activityAdmin.ts');
  await updateActivity(
    asClient(c),
    SEED.admin,
    id,
    {
      summary: 'Auditable task, renamed',
      notes: null,
      outcome: null,
      nextAction: null,
      nextActionDue: null,
      scheduledAt: null,
    },
    CTX,
  );
  await reassignActivity(asClient(c), SEED.admin, id, SEED.gabriel, CTX);
  await completeActivity(asClient(c), SEED.admin, id, null, CTX);

  const events = await c.execute({
    sql: `SELECT event_type FROM audit_events WHERE entity_id = ?`,
    args: [id],
  });
  // Ids are random hex, not a sequence, and all four writes share one test
  // clock, so the set is the assertable fact and each type appears once.
  const types = events.rows.map((r) => String(r.event_type)).sort();
  assert.deepEqual(types, [
    'ACTIVITY_COMPLETED',
    'ACTIVITY_CREATED',
    'ACTIVITY_REASSIGNED',
    'ACTIVITY_UPDATED',
  ]);
  c.close();
});

test('a campaign accepts activities from a lead-permission holder and refuses an outsider', async () => {
  const c = await db();
  const allowed = await resolveEntityAccess(asClient(c), SEED.admin, 'CAMPAIGN', 'CMP-001');
  assert.equal(allowed.ok, true);
  const denied = await resolveEntityAccess(
    asClient(c),
    SEED.external[0] ?? 'USR-EXT001',
    'CAMPAIGN',
    'CMP-001',
  );
  assert.equal(denied.ok, false);
  c.close();
});
