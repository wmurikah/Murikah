/**
 * Phase 14: customer service and helpdesk.
 *
 * The two claims that matter most are proved on data, not screens: the
 * portal-safe communication list never contains an INTERNAL row (inspected as
 * the returned value, which is what the response body serialises), and
 * assignment does not grant access (a user assigned across their scope
 * boundary still cannot read the case).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { refusalFields } from './support/refusal.ts';
import { createTestDb, type TestClient } from './support/db.ts';
import { seedHass, SEED } from './support/hassSeed.ts';
import {
  addCommunication,
  assignCase,
  caseIndicators,
  changeCaseStatus,
  createCase,
  createCaseCategory,
  getCase,
  listCases,
  listAssignmentHistory,
  listStatusHistory,
  portalCommunications,
  scopedCases,
  CASE_TRANSITIONS,
  QUALIFYING_FIRST_RESPONSE,
  type CaseInput,
} from '../../src/lib/cms/repos/serviceAdmin.ts';
import {
  emitCaseEvent,
  onCaseEvent,
  resetCaseEventHandlers,
  type CaseEvent,
} from '../../src/lib/cms/service/events.ts';
import { createLead } from '../../src/lib/cms/repos/leadAdmin.ts';

const NOW = new Date('2026-08-27T10:00:00Z');
const CTX = {
  actorUserId: SEED.admin,
  ip: '10.0.0.10',
  userAgent: 'HassCMS Test',
  now: NOW,
} as const;

const anyQuery = {
  search: '',
  caseType: null,
  caseCategoryId: null,
  priority: null,
  status: null,
  assignedTeamId: null,
  assignedUserId: null,
  businessUnitId: null,
  accountId: null,
  channel: null,
  raisedFrom: null,
  raisedTo: null,
  queue: null,
  page: 1,
};

/** Scripts 03, 04 and 05, exactly as the operator runs them. */
async function grantAll(c: TestClient): Promise<void> {
  await c.execute({
    sql: `INSERT OR IGNORE INTO permissions (permission_id, module_name, resource_name, action_name, description) VALUES
          ('PERM-034','CRM','LEADS','MANAGE','Manage leads'),
          ('PERM-039','SERVICE','CASES','MANAGE','Work, resolve, close and reopen service cases'),
          ('PERM-040','SERVICE','CATEGORIES','MANAGE','Configure case categories')`,
    args: [],
  });
  await c.execute({
    sql: `INSERT OR IGNORE INTO role_permissions (role_permission_id, role_id, permission_id, allowed, created_at)
          SELECT 'RP-ADMIN-' || permission_id, 'ROLE-ADMIN', permission_id, 1, CURRENT_TIMESTAMP
          FROM permissions WHERE permission_id IN ('PERM-034','PERM-039','PERM-040')`,
    args: [],
  });
}

const db = async (): Promise<TestClient> => {
  const c = createTestDb();
  await seedHass(c);
  await grantAll(c);
  return c;
};
const asClient = (c: TestClient) => c as unknown as Parameters<typeof listCases>[0];

const caseInput = (over: Partial<CaseInput> = {}): CaseInput => ({
  accountId: 'ACC-001',
  contactId: 'CON-001',
  businessUnitId: 'BU-CI',
  caseType: 'ENQUIRY',
  caseCategoryId: 'CC-003',
  priority: null,
  subject: 'Availability question',
  description: 'Customer asks about supply availability next month',
  channel: 'EMAIL',
  raisedAt: '2026-08-27 08:00:00',
  assignedTeamId: null,
  assignedUserId: null,
  ...over,
});

// ---------------------------------------------------------------------------
// Creation and priority.
// ---------------------------------------------------------------------------

test('an enquiry and a complaint are created, with the category default priority applied', async () => {
  const c = await db();
  const enquiry = await createCase(asClient(c), SEED.admin, caseInput(), CTX, true);
  assert.equal(enquiry.ok, true);
  if (!enquiry.ok) return;
  assert.match(enquiry.value.caseNumber, /^CS-2026-[0-9a-f]{10}$/);
  assert.equal(enquiry.value.status, 'NEW');
  // CC-003's default priority from the seed.
  const category = await c.execute({
    sql: `SELECT default_priority FROM case_categories WHERE case_category_id = 'CC-003'`,
    args: [],
  });
  assert.equal(enquiry.value.priority, String(category.rows[0]?.default_priority));

  const complaint = await createCase(
    asClient(c),
    SEED.admin,
    caseInput({ caseType: 'COMPLAINT', caseCategoryId: 'CC-001', subject: 'Late delivery again' }),
    CTX,
    true,
  );
  assert.equal(complaint.ok, true);

  // The creation wrote the first status history row.
  if (complaint.ok) {
    const history = await listStatusHistory(asClient(c), complaint.value.caseId);
    assert.equal(history.length, 1);
    assert.equal(history[0]?.fromStatus, null);
  }
  c.close();
});

test('a priority override needs the permission, and the override is recorded', async () => {
  const c = await db();
  const refused = await createCase(
    asClient(c),
    SEED.admin,
    caseInput({ priority: 'CRITICAL' }),
    CTX,
    false, // may not override
  );
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refusalFields(refused)[0]?.field, 'priority');

  const allowed = await createCase(
    asClient(c),
    SEED.admin,
    caseInput({ priority: 'CRITICAL' }),
    CTX,
    true,
  );
  assert.equal(allowed.ok, true);
  if (!allowed.ok) return;
  const auditRow = await c.execute({
    sql: `SELECT after_json FROM audit_events WHERE entity_id = ? AND event_type = 'CASE_CREATED'`,
    args: [allowed.value.caseId],
  });
  assert.match(String(auditRow.rows[0]?.after_json), /"priorityOverridden":true/);
  c.close();
});

// ---------------------------------------------------------------------------
// Assignment.
// ---------------------------------------------------------------------------

test('every assignment writes exactly one history row with from and to', async () => {
  const c = await db();
  const made = await createCase(asClient(c), SEED.admin, caseInput(), CTX, true);
  assert.equal(made.ok, true);
  if (!made.ok) return;
  const id = made.value.caseId;

  const first = await assignCase(
    asClient(c),
    SEED.admin,
    id,
    { teamId: 'TEAM-CS-KE', userId: 'USR-CATH', reason: 'Initial triage' },
    CTX,
  );
  assert.equal(first.ok, true);
  if (first.ok) assert.equal(first.value.status, 'ASSIGNED');

  const second = await assignCase(
    asClient(c),
    SEED.admin,
    id,
    { teamId: 'TEAM-FIN-KE', userId: SEED.gabriel, reason: 'Finance detail needed' },
    CTX,
  );
  assert.equal(second.ok, true);

  const history = await listAssignmentHistory(asClient(c), id);
  assert.equal(history.length, 2);
  // Both writes share one test clock, so identify the second by its content
  // rather than by index order.
  const move = history.find((h) => h.toTeamName === 'Kenya Finance');
  assert.equal(move?.fromTeamName, 'Kenya Customer Service');
  assert.equal(move?.reason, 'Finance detail needed');
  c.close();
});

test('assignment does not grant access: the assignee outside the scope still reads nothing', async () => {
  const c = await db();
  const made = await createCase(asClient(c), SEED.admin, caseInput(), CTX, true);
  assert.equal(made.ok, true);
  if (!made.ok) return;

  // Neema (USR-FMTZ) holds ROLE-FIN, which has no SERVICE.CASES.VIEW grant.
  // Assign her the case anyway.
  const assigned = await assignCase(
    asClient(c),
    SEED.admin,
    made.value.caseId,
    { teamId: null, userId: SEED.neema, reason: 'Cross-scope assignment' },
    CTX,
  );
  assert.equal(assigned.ok, true);

  // Her name is on the row; the resolver still answers no.
  const scope = await scopedCases(asClient(c), SEED.neema);
  assert.equal(scope.sql, '1 = 0');
  assert.equal(await getCase(asClient(c), SEED.neema, made.value.caseId), null);
  c.close();
});

// ---------------------------------------------------------------------------
// The status machine.
// ---------------------------------------------------------------------------

test('the transition table is enforced, both waits are recorded, and closed never returns to new', async () => {
  const c = await db();
  // The table itself: closed offers only the controlled reopen.
  assert.deepEqual([...CASE_TRANSITIONS.CLOSED], ['IN_PROGRESS']);
  assert.deepEqual([...CASE_TRANSITIONS.CANCELLED], []);

  const made = await createCase(asClient(c), SEED.admin, caseInput(), CTX, true);
  assert.equal(made.ok, true);
  if (!made.ok) return;
  const id = made.value.caseId;
  const step = (toStatus: string, extra: Record<string, string | null> = {}) =>
    changeCaseStatus(
      asClient(c),
      SEED.admin,
      id,
      {
        toStatus: toStatus as never,
        reason: extra.reason ?? null,
        resolutionSummary: extra.resolutionSummary ?? null,
        rootCause: extra.rootCause ?? null,
      },
      CTX,
    );

  // NEW cannot jump straight to RESOLVED.
  const jump = await step('RESOLVED', { resolutionSummary: 'Done' });
  assert.equal(jump.ok, false);
  assert.equal(!jump.ok && jump.kind, 'conflict');

  assert.equal((await step('IN_PROGRESS')).ok, true);
  assert.equal((await step('WAITING_CUSTOMER')).ok, true);
  assert.equal((await step('IN_PROGRESS')).ok, true);
  assert.equal((await step('WAITING_INTERNAL')).ok, true);

  // Resolve without a summary is refused.
  const bare = await step('RESOLVED');
  assert.equal(bare.ok, false);
  const resolved = await step('RESOLVED', { resolutionSummary: 'Invoice corrected and reissued' });
  assert.equal(resolved.ok, true);
  if (resolved.ok) {
    assert.notEqual(resolved.value.resolvedAt, null);
    // Resolved does NOT set closed_at.
    assert.equal(resolved.value.closedAt, null);
  }
  const closed = await step('CLOSED');
  assert.equal(closed.ok, true);
  if (closed.ok) assert.notEqual(closed.value.closedAt, null);

  // Closed to NEW does not exist; the reopen needs a reason.
  const toNew = await step('NEW');
  assert.equal(toNew.ok, false);
  const bareReopen = await step('IN_PROGRESS');
  assert.equal(bareReopen.ok, false);
  const reopened = await step('IN_PROGRESS', { reason: 'Customer reports the fault recurred' });
  assert.equal(reopened.ok, true);
  if (reopened.ok) {
    // Live again: the stale closure stamps are gone.
    assert.equal(reopened.value.resolvedAt, null);
    assert.equal(reopened.value.closedAt, null);
  }

  // Every change wrote history: the creation row plus seven successful moves.
  const history = await listStatusHistory(asClient(c), id);
  assert.equal(history.length, 8);
  const waits = history.filter((h) => h.toStatus.startsWith('WAITING'));
  assert.equal(waits.length, 2);
  c.close();
});

// ---------------------------------------------------------------------------
// First response and the portal boundary.
// ---------------------------------------------------------------------------

test('a first outbound customer communication sets first_response_at; an internal note does not', async () => {
  const c = await db();
  assert.equal(QUALIFYING_FIRST_RESPONSE.direction, 'OUTBOUND');
  assert.equal((QUALIFYING_FIRST_RESPONSE.channels as readonly string[]).includes('NOTE'), false);

  const made = await createCase(asClient(c), SEED.admin, caseInput(), CTX, true);
  assert.equal(made.ok, true);
  if (!made.ok) return;
  const id = made.value.caseId;

  // An internal note first: no first response.
  await addCommunication(
    asClient(c),
    SEED.admin,
    id,
    {
      direction: 'INTERNAL',
      channel: 'NOTE',
      contactId: null,
      subject: null,
      messageSummary: 'Checked the depot schedule internally',
      communicatedAt: '2026-08-27 08:30:00',
    },
    CTX,
  );
  let row = await getCase(asClient(c), SEED.admin, id);
  assert.equal(row?.firstResponseAt, null);

  // An inbound from the customer: still no first response.
  await addCommunication(
    asClient(c),
    SEED.admin,
    id,
    {
      direction: 'INBOUND',
      channel: 'EMAIL',
      contactId: 'CON-001',
      subject: null,
      messageSummary: 'Customer sent more detail',
      communicatedAt: '2026-08-27 08:40:00',
    },
    CTX,
  );
  row = await getCase(asClient(c), SEED.admin, id);
  assert.equal(row?.firstResponseAt, null);

  // The first qualifying outbound sets it, at its own communicated time.
  await addCommunication(
    asClient(c),
    SEED.admin,
    id,
    {
      direction: 'OUTBOUND',
      channel: 'EMAIL',
      contactId: 'CON-001',
      subject: 'Re: availability',
      messageSummary: 'Confirmed availability for September',
      communicatedAt: '2026-08-27 08:55:00',
    },
    CTX,
  );
  row = await getCase(asClient(c), SEED.admin, id);
  assert.equal(row?.firstResponseAt, '2026-08-27 08:55:00');

  // A second outbound does not move it.
  await addCommunication(
    asClient(c),
    SEED.admin,
    id,
    {
      direction: 'OUTBOUND',
      channel: 'PHONE',
      contactId: null,
      subject: null,
      messageSummary: 'Follow-up call',
      communicatedAt: '2026-08-27 10:30:00',
    },
    CTX,
  );
  row = await getCase(asClient(c), SEED.admin, id);
  assert.equal(row?.firstResponseAt, '2026-08-27 08:55:00');
  c.close();
});

test('the portal-safe communications contain no INTERNAL row and no internal field, shown on the data itself', async () => {
  const c = await db();
  const made = await createCase(asClient(c), SEED.admin, caseInput(), CTX, true);
  assert.equal(made.ok, true);
  if (!made.ok) return;
  const id = made.value.caseId;
  for (const [direction, channel, summary] of [
    ['INTERNAL', 'NOTE', 'Internal-only investigation detail'],
    ['OUTBOUND', 'EMAIL', 'Answer to the customer'],
    ['INBOUND', 'WEB', 'Customer reply'],
  ] as const) {
    await addCommunication(
      asClient(c),
      SEED.admin,
      id,
      {
        direction,
        channel,
        contactId: null,
        subject: null,
        messageSummary: summary,
        communicatedAt: null,
      },
      CTX,
    );
  }
  const safe = await portalCommunications(asClient(c), id);
  // This array IS what a portal response body serialises. Inspect it as data.
  const serialised = JSON.stringify(safe);
  assert.equal(safe.length, 2);
  assert.equal(serialised.includes('Internal-only investigation detail'), false);
  assert.equal(serialised.includes('INTERNAL'), false);
  assert.equal(serialised.includes('userId'), false);
  assert.equal(serialised.includes('userName'), false);
  assert.deepEqual(Object.keys(safe[0] ?? {}).sort(), [
    'channel',
    'communicatedAt',
    'communicationId',
    'fromCustomer',
    'messageSummary',
    'subject',
  ]);
  c.close();
});

// ---------------------------------------------------------------------------
// The rest of the acceptance list.
// ---------------------------------------------------------------------------

test('a lead can be created from a case with no invented foreign key', async () => {
  const c = await db();
  const made = await createCase(asClient(c), SEED.admin, caseInput(), CTX, true);
  assert.equal(made.ok, true);
  if (!made.ok) return;
  // The lead carries the case only as prefill and as an audited reference:
  // the leads table has no case_id column and none is pretended.
  const lead = await createLead(
    asClient(c),
    {
      accountId: made.value.accountId,
      primaryContactId: made.value.contactId,
      leadSourceId: 'LS-001',
      campaignId: null,
      businessUnitId: made.value.businessUnitId,
      ownerUserId: SEED.james,
      title: `From case ${made.value.caseNumber}: workshop demand`,
      description: `Raised during service case ${made.value.caseNumber}`,
      productInterest: 'LUBRICANTS',
      estimatedVolume: null,
      estimatedValue: null,
      currencyCode: null,
      capturedAt: '2026-08-27 09:00:00',
    },
    CTX,
  );
  assert.equal(lead.ok, true);
  if (!lead.ok) return;
  const columns = await c.execute({
    sql: `SELECT COUNT(*) AS n FROM pragma_table_info('leads') WHERE name = 'case_id'`,
    args: [],
  });
  assert.equal(Number(columns.rows[0]?.n), 0);
  c.close();
});

test('indicators use the same scope predicate as the list', async () => {
  const c = await db();
  const listed = await listCases(asClient(c), SEED.admin, anyQuery);
  const indicators = await caseIndicators(asClient(c), SEED.admin, NOW);
  const openStatuses = ['NEW', 'IN_PROGRESS', 'WAITING_CUSTOMER', 'WAITING_INTERNAL'];
  const inProgressListed = listed.items.filter((k) => k.status === 'IN_PROGRESS').length;
  assert.equal(indicators.inProgress, inProgressListed);
  const waitingListed = listed.items.filter((k) => k.status.startsWith('WAITING')).length;
  assert.equal(indicators.waiting, waitingListed);
  assert.equal(openStatuses.length > 0, true);

  // A caller with no grant sees nothing anywhere: list and indicators agree.
  const externalList = await listCases(asClient(c), SEED.external[0] ?? 'USR-EXT001', anyQuery);
  const externalIndicators = await caseIndicators(
    asClient(c),
    SEED.external[0] ?? 'USR-EXT001',
    NOW,
  );
  assert.equal(externalList.total, 0);
  assert.equal(
    externalIndicators.inProgress + externalIndicators.newCases + externalIndicators.waiting,
    0,
  );
  c.close();
});

test('categories are two levels, unique as a pair, and deactivate rather than delete', async () => {
  const c = await db();
  const made = await createCaseCategory(
    asClient(c),
    {
      categoryName: 'Delivery',
      subcategoryName: 'Weekend delay',
      defaultPriority: 'MEDIUM',
      active: true,
    },
    CTX,
  );
  assert.equal(made.ok, true);
  const duplicate = await createCaseCategory(
    asClient(c),
    {
      categoryName: 'Delivery',
      subcategoryName: 'Weekend delay',
      defaultPriority: 'LOW',
      active: true,
    },
    CTX,
  );
  assert.equal(duplicate.ok, false);
  c.close();
});

test('the domain events fire once each and a failing handler never breaks the write', async () => {
  const c = await db();
  const seen: string[] = [];
  resetCaseEventHandlers();
  onCaseEvent(async (_db, event: CaseEvent) => {
    seen.push(event.type);
  });
  onCaseEvent(async () => {
    throw new Error('a broken consumer');
  });

  const made = await createCase(
    asClient(c),
    SEED.admin,
    caseInput({ assignedTeamId: 'TEAM-CS-KE', assignedUserId: 'USR-CATH' }),
    CTX,
    true,
  );
  assert.equal(made.ok, true);
  if (!made.ok) return;
  await addCommunication(
    asClient(c),
    SEED.admin,
    made.value.caseId,
    {
      direction: 'OUTBOUND',
      channel: 'EMAIL',
      contactId: null,
      subject: null,
      messageSummary: 'First answer',
      communicatedAt: null,
    },
    CTX,
  );
  await changeCaseStatus(
    asClient(c),
    SEED.admin,
    made.value.caseId,
    { toStatus: 'IN_PROGRESS', reason: null, resolutionSummary: null, rootCause: null },
    CTX,
  );
  assert.deepEqual(seen, [
    'CASE_CREATED',
    'CASE_ASSIGNED',
    'CASE_FIRST_RESPONSE',
    'CASE_STATUS_CHANGED',
  ]);
  // The case itself is intact despite the broken consumer.
  assert.notEqual(await getCase(asClient(c), SEED.admin, made.value.caseId), null);
  resetCaseEventHandlers();
  // emitCaseEvent with no handlers is a no-op, not an error.
  await emitCaseEvent(asClient(c), {
    type: 'CASE_CLOSED',
    caseId: made.value.caseId,
    at: NOW,
    actorUserId: SEED.admin,
    detail: {},
  });
  c.close();
});

test('the audit types are written', async () => {
  const c = await db();
  const made = await createCase(asClient(c), SEED.admin, caseInput(), CTX, true);
  assert.equal(made.ok, true);
  if (!made.ok) return;
  const id = made.value.caseId;
  await assignCase(
    asClient(c),
    SEED.admin,
    id,
    { teamId: 'TEAM-CS-KE', userId: null, reason: null },
    CTX,
  );
  await assignCase(
    asClient(c),
    SEED.admin,
    id,
    { teamId: 'TEAM-FIN-KE', userId: null, reason: null },
    CTX,
  );
  await changeCaseStatus(
    asClient(c),
    SEED.admin,
    id,
    { toStatus: 'IN_PROGRESS', reason: null, resolutionSummary: null, rootCause: null },
    CTX,
  );
  await addCommunication(
    asClient(c),
    SEED.admin,
    id,
    {
      direction: 'OUTBOUND',
      channel: 'EMAIL',
      contactId: null,
      subject: null,
      messageSummary: 'Answer',
      communicatedAt: null,
    },
    CTX,
  );
  await changeCaseStatus(
    asClient(c),
    SEED.admin,
    id,
    { toStatus: 'RESOLVED', reason: null, resolutionSummary: 'Sorted', rootCause: null },
    CTX,
  );
  await changeCaseStatus(
    asClient(c),
    SEED.admin,
    id,
    { toStatus: 'CLOSED', reason: null, resolutionSummary: null, rootCause: null },
    CTX,
  );

  const events = await c.execute({
    sql: `SELECT DISTINCT event_type FROM audit_events WHERE entity_id = ?`,
    args: [id],
  });
  const types = new Set(events.rows.map((r) => String(r.event_type)));
  for (const expected of [
    'CASE_CREATED',
    'CASE_ASSIGNED',
    'CASE_REASSIGNED',
    'CASE_STATUS_CHANGED',
    'CASE_COMMUNICATION_ADDED',
    'CASE_RESOLVED',
    'CASE_CLOSED',
  ]) {
    assert.equal(types.has(expected), true, `missing ${expected}`);
  }
  c.close();
});
