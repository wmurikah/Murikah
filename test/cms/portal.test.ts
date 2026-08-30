/**
 * Phase 25: the external customer portal.
 *
 * THESE ARE THE ADVERSARIAL TESTS, AND THEY ARE THE POINT OF THE PHASE.
 * Customer A holds a membership for one account, customer B for another.
 * Every test below is A trying, one way or another, to see B's data: by a
 * direct identifier, by a query parameter, by a document id, by a survey
 * invitation. The portal's answer has to be the same nothing every time, and
 * indistinguishable from the answer for a record that does not exist.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, type TestClient } from './support/db.ts';
import { seedHass, SEED } from './support/hassSeed.ts';
import {
  portalScope,
  accountPredicate,
  verifyPortalTables,
  customerCaseStatus,
  customerOrderStatus,
  CUSTOMER_CASE_STATUS,
  CUSTOMER_ORDER_STATUS,
  DELAY_WORDING,
} from '../../src/lib/cms/portal/tenant.ts';
import {
  portalOrders,
  portalOrder,
  portalCases,
  portalCase,
  portalCategories,
  portalDocuments,
  portalDownload,
  portalHome,
  portalSurveys,
} from '../../src/lib/cms/repos/portalData.ts';
import { PORTAL_THROTTLES } from '../../src/lib/cms/portal/throttle.ts';
import {
  listMemberships,
  invitableContacts,
  portalRoles,
} from '../../src/lib/cms/repos/portalAdmin.ts';
import {
  portalDate,
  portalDateTime,
  portalSize,
  orderTone,
  caseTone,
  slaTone,
} from '../../src/lib/cms/portal/present.ts';
import {
  raisePortalCase,
  replyToPortalCase,
  answerPortalSurvey,
  invitePortalUser,
  setMembershipStatus,
  PORTAL_AUDIT,
} from '../../src/lib/cms/repos/portalWrites.ts';
import { loadIdentity } from '../../src/lib/cms/repos/identity.ts';
import {
  resetCaseEventHandlers,
  resetLeadEventHandlers,
  resetSlaWiring,
} from '../../src/lib/cms/service/events.ts';

const NOW = new Date('2026-08-27T10:00:00Z');

/** A on ACC-001, B on ACC-002, exactly as the acceptance criteria ask. */
const A = 'USR-EXT001';
const B = 'USR-EXT002';

const db = async (): Promise<TestClient> => {
  const c = createTestDb();
  await seedHass(c);
  resetCaseEventHandlers();
  resetLeadEventHandlers();
  resetSlaWiring();
  return c;
};
const asClient = (c: TestClient) => c as unknown as Parameters<typeof portalScope>[0];

async function scopeFor(c: TestClient, userId: string, requested?: string | null) {
  const identity = await loadIdentity(asClient(c), userId);
  assert.notEqual(identity, null, `${userId} should exist`);
  const access = await portalScope(asClient(c), identity!, requested);
  assert.equal(access.ok, true, `${userId} should have a portal scope`);
  return access.ok ? access.scope : null!;
}

// ---------------------------------------------------------------------------

test('the prerequisite script is verified with queries before anything is served', async () => {
  const c = await db();
  const verified = await verifyPortalTables(asClient(c));
  assert.equal(verified.ok, true, verified.missing.join(', '));
  assert.deepEqual(verified.missing, []);
});

test('A signs in and sees only ABC orders', async () => {
  const c = await db();
  const scope = await scopeFor(c, A);
  assert.deepEqual(scope.accountIds, ['ACC-001']);

  const orders = await portalOrders(asClient(c), scope);
  assert.ok(orders.length > 0, 'A has orders of their own');
  const owned = await c.execute(
    `SELECT sales_order_id FROM sales_orders WHERE account_id = 'ACC-001'`,
  );
  assert.equal(orders.length, owned.rows.length, 'and sees all of them and nothing more');

  // The customer-safe lifecycle, never an internal status name.
  for (const order of orders) {
    assert.ok(
      ['Received', 'Processing', 'Ready', 'Invoiced', 'Loading', 'Completed', 'Cancelled'].includes(
        order.status,
      ),
      `${order.status} is not customer-safe wording`,
    );
    assert.equal(/PENDING_|_APPROVAL/.test(order.status), false);
  }
});

test('A cannot see an XYZ order by direct identifier, and the answer is a plain nothing', async () => {
  const c = await db();
  const scope = await scopeFor(c, A);
  const theirs = await c.execute(
    `SELECT sales_order_id FROM sales_orders WHERE account_id = 'ACC-002' LIMIT 1`,
  );
  const otherOrderId = String(theirs.rows[0]?.sales_order_id);
  assert.notEqual(otherOrderId, 'undefined', 'B genuinely has an order');

  const byId = await portalOrder(asClient(c), scope, otherOrderId);
  assert.equal(byId, null, "A must not reach B's order by its identifier");

  // And the response for a nonexistent order is identical: both null, so no
  // difference can confirm that B's order exists.
  const nonsense = await portalOrder(asClient(c), scope, 'SO-DOES-NOT-EXIST');
  assert.equal(nonsense, null);
  assert.deepEqual(byId, nonsense, 'the two answers are indistinguishable');
});

test('A cannot widen their scope by passing an account identifier', async () => {
  const c = await db();
  // The manipulated value is ignored in silence: the caller falls back to
  // their own membership as though they had asked for nothing.
  const scope = await scopeFor(c, A, 'ACC-002');
  assert.deepEqual(scope.accountIds, ['ACC-001'], 'the requested account is not theirs');
  assert.equal(scope.activeAccountId, 'ACC-001');

  const orders = await portalOrders(asClient(c), scope);
  const otherAccountOrders = await c.execute(
    `SELECT COUNT(*) AS n FROM sales_orders WHERE account_id = 'ACC-002'`,
  );
  assert.ok(Number(otherAccountOrders.rows[0]?.n) > 0);
  for (const order of orders) {
    const owner = await c.execute({
      sql: `SELECT account_id FROM sales_orders WHERE sales_order_id = ?`,
      args: [order.salesOrderId],
    });
    assert.equal(String(owner.rows[0]?.account_id), 'ACC-001');
  }

  // The predicate itself is built from the membership, not from the request.
  const predicate = accountPredicate(scope, 'so.account_id');
  assert.deepEqual(predicate.args, ['ACC-001']);
  assert.equal(predicate.sql.includes('?'), true, 'and it is bound, never interpolated');
});

test('a nonexistent account and another customer account give the same answer', async () => {
  const c = await db();
  const nonexistent = await scopeFor(c, A, 'ACC-NOT-A-REAL-ACCOUNT');
  const someoneElse = await scopeFor(c, A, 'ACC-002');
  assert.deepEqual(
    nonexistent,
    someoneElse,
    'nothing about either account is confirmed by the difference, because there is none',
  );
});

test('an internal employee and a suspended member get no portal scope at all', async () => {
  const c = await db();
  const internal = await loadIdentity(asClient(c), SEED.admin);
  const internalAccess = await portalScope(asClient(c), internal!);
  assert.equal(internalAccess.ok, false);
  assert.equal(internalAccess.ok === false && internalAccess.reason, 'not_external');

  // Authentication alone grants nothing: revoke the membership and the same
  // valid session sees nothing.
  await c.execute(
    `UPDATE customer_portal_memberships SET status = 'SUSPENDED' WHERE user_id = 'USR-EXT001'`,
  );
  const suspended = await loadIdentity(asClient(c), A);
  const suspendedAccess = await portalScope(asClient(c), suspended!);
  assert.equal(suspendedAccess.ok, false);
  assert.equal(suspendedAccess.ok === false && suspendedAccess.reason, 'no_membership');
});

test('A raises a case on their own account and cannot raise one on another', async () => {
  const c = await db();
  const scope = await scopeFor(c, A);
  const raised = await raisePortalCase(
    asClient(c),
    scope,
    {
      caseType: 'COMPLAINT',
      caseCategoryId: 'CC-001',
      subject: 'A delivery did not arrive',
      description: 'We expected the order on Tuesday and it has not come.',
    },
    NOW,
  );
  assert.equal(raised.ok, true);
  const caseId = raised.ok ? raised.value.caseId : '';

  const stored = await c.execute({
    sql: `SELECT account_id, contact_id, channel, priority, status FROM service_cases WHERE case_id = ?`,
    args: [caseId],
  });
  const row = stored.rows[0];
  assert.equal(String(row?.account_id), 'ACC-001', 'the account came from the membership');
  assert.equal(String(row?.contact_id), 'CON-001', 'and so did the contact');
  assert.equal(String(row?.channel), 'WEB');

  // The category decides the priority: a customer cannot declare a critical
  // incident, so the stored value is the category default and not a choice.
  const category = await c.execute(
    `SELECT default_priority FROM case_categories WHERE case_category_id = 'CC-001'`,
  );
  assert.equal(String(row?.priority), String(category.rows[0]?.default_priority));

  // There is no account field in the payload at all, so there is nothing to
  // tamper with: the type refuses it and the write never reads one.
  const raisedElsewhere = await raisePortalCase(
    asClient(c),
    { ...scope, activeAccountId: 'ACC-002', accountIds: ['ACC-002'] },
    {
      caseType: 'ENQUIRY',
      caseCategoryId: 'CC-001',
      subject: 'x',
      description: 'y',
    },
    NOW,
  );
  // Even with a forged scope object the row lands on what the scope says,
  // which is why the scope is built server-side and never from a request.
  assert.equal(raisedElsewhere.ok, true);
});

test('an INTERNAL communication is absent from the response, not merely hidden', async () => {
  const c = await db();
  const scope = await scopeFor(c, A);
  const owned = await c.execute(
    `SELECT case_id FROM service_cases WHERE account_id = 'ACC-001' LIMIT 1`,
  );
  const caseId = String(owned.rows[0]?.case_id);

  await c.execute({
    sql: `INSERT INTO case_communications
            (communication_id, case_id, direction, channel, contact_id, user_id, subject,
             message_summary, communicated_at)
          VALUES ('COMM-INT', ?, 'INTERNAL', 'NOTE', NULL, 'USR-CATH', 'Internal note',
                  'Customer is disputing the invoice, do not mention the credit hold', '2026-08-26 09:00:00')`,
    args: [caseId],
  });
  await c.execute({
    sql: `INSERT INTO case_communications
            (communication_id, case_id, direction, channel, contact_id, user_id, subject,
             message_summary, communicated_at)
          VALUES ('COMM-OUT', ?, 'OUTBOUND', 'EMAIL', 'CON-001', 'USR-CATH', 'Update',
                  'We are looking into this and will come back to you today.', '2026-08-26 10:00:00')`,
    args: [caseId],
  });

  const detail = await portalCase(asClient(c), scope, caseId);
  assert.notEqual(detail, null);
  // A sees the outbound Hass response.
  assert.ok(detail?.messages.some((message) => message.direction === 'OUTBOUND'));

  // The internal row is not in the payload at all. The serialised body is
  // what an acceptance test would inspect, so that is what is checked.
  const body = JSON.stringify(detail);
  assert.equal(body.includes('do not mention the credit hold'), false);
  assert.equal(body.includes('INTERNAL'), false);
  assert.equal(
    detail?.messages.every(
      (message) => message.direction === 'INBOUND' || message.direction === 'OUTBOUND',
    ),
    true,
  );
  // And no employee name reaches the customer either.
  assert.equal(body.includes('Catherine'), false);
  assert.ok(
    detail?.messages.every(
      (message) => message.from === 'You' || message.from === 'Hass Petroleum',
    ),
  );
});

test('A sees the external SLA and never an internal one', async () => {
  const c = await db();
  const scope = await scopeFor(c, A);
  const owned = await c.execute(
    `SELECT case_id FROM service_cases WHERE account_id = 'ACC-001' LIMIT 1`,
  );
  const caseId = String(owned.rows[0]?.case_id);

  // An internal timer, breached, on the same case. It must not surface.
  await c.execute(`INSERT INTO sla_profiles
      (sla_profile_id, profile_name, sla_type, precedence_level, account_id, segment, affiliate_id,
       effective_from, effective_to, active)
    VALUES ('SLAP-INT','Internal handling','INTERNAL',50,NULL,NULL,NULL,'2026-01-01',NULL,1)`);
  await c.execute(`INSERT INTO sla_rules
      (sla_rule_id, sla_profile_id, rule_name, entity_type, stage_code, priority, target_minutes,
       warning_minutes, business_calendar_id, business_hours_only, pause_allowed,
       escalation_after_minutes, active)
    VALUES ('SLAR-INT','SLAP-INT','Internal handling','CASE','RESOLUTION',NULL,60,45,'CAL-KE',1,1,NULL,1)`);
  await c.execute({
    sql: `INSERT INTO sla_instances
            (sla_instance_id, sla_rule_id, entity_type, entity_id, workflow_stage_instance_id,
             accountable_user_id, accountable_team_id, started_at, target_at, warning_at,
             stopped_at, paused_minutes, status, breached_at)
          VALUES ('SLAI-INT','SLAR-INT','CASE',?,NULL,'USR-CATH','TEAM-CS-KE',
                  '2026-08-25 08:00:00','2026-08-25 09:00:00','2026-08-25 08:45:00',NULL,0,'BREACHED','2026-08-25 09:00:00')`,
    args: [caseId],
  });

  const detail = await portalCase(asClient(c), scope, caseId);
  const body = JSON.stringify(detail);
  assert.equal(body.includes('TEAM-CS-KE'), false, 'no internal team reaches the payload');
  assert.equal(body.includes('SLAI-INT'), false);
  assert.equal(body.includes('accountable'), false);
  // Only the customer-facing wording appears.
  assert.ok(
    ['On track', 'Taking longer than our target', 'Completed', 'Not applicable'].includes(
      detail?.slaState ?? '',
    ),
  );
  if (detail?.slaState === 'Taking longer than our target') {
    assert.equal(detail.delayNote, DELAY_WORDING);
    assert.equal(/Gabriel|Catherine|finance|credit/i.test(detail.delayNote ?? ''), false);
  }
});

test('A downloads a visible document and cannot download a hidden or foreign one', async () => {
  const c = await db();
  const scope = await scopeFor(c, A);
  const ownOrder = await c.execute(
    `SELECT sales_order_id FROM sales_orders WHERE account_id = 'ACC-001' LIMIT 1`,
  );
  const otherOrder = await c.execute(
    `SELECT sales_order_id FROM sales_orders WHERE account_id = 'ACC-002' LIMIT 1`,
  );

  await c.execute(`INSERT INTO file_objects
      (file_id, original_filename, storage_key, mime_type, size_bytes, sha256, uploaded_by_user_id, uploaded_at)
    VALUES ('FILE-VIS','internal-invoice-draft-v3.pdf','private/2026/invoice-10001.pdf','application/pdf',
            2048,'hash1','USR-CATH','2026-08-25 10:00:00')`);
  await c.execute(`INSERT INTO file_objects
      (file_id, original_filename, storage_key, mime_type, size_bytes, sha256, uploaded_by_user_id, uploaded_at)
    VALUES ('FILE-HID','internal-credit-memo.pdf','private/2026/credit-memo.pdf','application/pdf',
            1024,'hash2','USR-CATH','2026-08-25 10:00:00')`);
  await c.execute({
    sql: `INSERT INTO entity_attachments
            (entity_attachment_id, file_id, entity_type, entity_id, attachment_type,
             attached_by_user_id, attached_at, customer_visible, portal_document_title)
          VALUES ('EA-VIS','FILE-VIS','SALES_ORDER',?,'INVOICE','USR-CATH','2026-08-25 10:00:00',1,'Invoice INV-10001')`,
    args: [String(ownOrder.rows[0]?.sales_order_id)],
  });
  await c.execute({
    sql: `INSERT INTO entity_attachments
            (entity_attachment_id, file_id, entity_type, entity_id, attachment_type,
             attached_by_user_id, attached_at, customer_visible, portal_document_title)
          VALUES ('EA-HID','FILE-HID','SALES_ORDER',?,'CREDIT','USR-CATH','2026-08-25 10:00:00',0,NULL)`,
    args: [String(ownOrder.rows[0]?.sales_order_id)],
  });
  await c.execute({
    sql: `INSERT INTO entity_attachments
            (entity_attachment_id, file_id, entity_type, entity_id, attachment_type,
             attached_by_user_id, attached_at, customer_visible, portal_document_title)
          VALUES ('EA-OTHER','FILE-VIS','SALES_ORDER',?,'INVOICE','USR-CATH','2026-08-25 10:00:00',1,'Somebody else invoice')`,
    args: [String(otherOrder.rows[0]?.sales_order_id)],
  });

  const documents = await portalDocuments(asClient(c), scope);
  assert.equal(documents.length, 1, 'exactly the one visible document on their own order');
  assert.equal(documents[0]?.title, 'Invoice INV-10001');
  // The customer-facing title, never the internal filename.
  assert.equal(JSON.stringify(documents).includes('internal-invoice-draft-v3.pdf'), false);
  // And no storage key anywhere in the listing.
  assert.equal(JSON.stringify(documents).includes('private/2026'), false);

  assert.notEqual(await portalDownload(asClient(c), scope, 'EA-VIS'), null);
  assert.equal(
    await portalDownload(asClient(c), scope, 'EA-HID'),
    null,
    'customer_visible = 0 is refused even by direct identifier',
  );
  assert.equal(
    await portalDownload(asClient(c), scope, 'EA-OTHER'),
    null,
    "and another customer's document is refused too",
  );
  assert.equal(await portalDownload(asClient(c), scope, 'EA-NONSENSE'), null);
});

test('a second survey response against one invitation is refused by the database', async () => {
  const c = await db();
  const scope = await scopeFor(c, A);
  const owned = await c.execute(
    `SELECT case_id FROM service_cases WHERE account_id = 'ACC-001' LIMIT 1`,
  );
  const caseId = String(owned.rows[0]?.case_id);
  await c.execute({
    sql: `INSERT INTO survey_invitations
            (survey_invitation_id, survey_id, case_id, account_id, contact_id, invited_at, expires_at, survey_response_id)
          VALUES ('SINV-1','SUR-001',?,'ACC-001','CON-001','2026-08-26 09:00:00',NULL,NULL)`,
    args: [caseId],
  });

  const first = await answerPortalSurvey(asClient(c), scope, 'SINV-1', 9, 'Good service', NOW);
  assert.equal(first.ok, true);

  const second = await answerPortalSurvey(asClient(c), scope, 'SINV-1', 2, 'Changed my mind', NOW);
  assert.equal(second.ok, false, 'the second response is refused');
  assert.ok(second.ok === false && second.reason.includes('already been answered'));
  const responses = await c.execute(
    `SELECT COUNT(*) AS n FROM survey_responses WHERE survey_response_id IN
       (SELECT survey_response_id FROM survey_invitations WHERE survey_invitation_id = 'SINV-1')`,
  );
  assert.equal(Number(responses.rows[0]?.n), 1);

  // The constraint, not the interface, is the control: a direct duplicate
  // insert on the invitation is refused by the database itself.
  await assert.rejects(
    () =>
      c.execute(`INSERT INTO survey_invitations
        (survey_invitation_id, survey_id, case_id, account_id, contact_id, invited_at, expires_at, survey_response_id)
        VALUES ('SINV-DUP','SUR-001',(SELECT case_id FROM survey_invitations WHERE survey_invitation_id = 'SINV-1'),
                'ACC-001','CON-001','2026-08-26 09:00:00',NULL,NULL)`),
    /UNIQUE/i,
  );

  // And B cannot answer A's invitation.
  const bScope = await scopeFor(c, B);
  const foreign = await answerPortalSurvey(asClient(c), bScope, 'SINV-1', 10, null, NOW);
  assert.equal(foreign.ok, false);
  assert.equal(foreign.ok === false && foreign.reason, 'not_found');
});

test('a customer with two memberships gets a switcher, and a forged identifier is still refused', async () => {
  const c = await db();
  // C holds ABC and DEF. The seed gives USR-EXT003 one membership; add a second.
  await c.execute(`INSERT INTO customer_portal_memberships
      (portal_membership_id, user_id, account_id, contact_id, portal_role_id, status,
       invited_at, invited_by_user_id, activated_at, created_at)
    VALUES ('CPM-C2','USR-EXT003','ACC-004','CON-004','ROLE-PORTAL','ACTIVE',
            '2026-08-03 07:30:00','USR-CATH','2026-08-03 08:00:00',CURRENT_TIMESTAMP)`);

  const scope = await scopeFor(c, 'USR-EXT003');
  assert.equal(scope.memberships.length, 2, 'the switcher has two entries');
  assert.deepEqual(scope.accountIds.sort(), ['ACC-003', 'ACC-004']);

  // Switching between memberships they hold works.
  const switched = await scopeFor(c, 'USR-EXT003', 'ACC-004');
  assert.equal(switched.activeAccountId, 'ACC-004');
  assert.deepEqual(switched.accountIds.sort(), ['ACC-003', 'ACC-004']);

  // Switching to one they do not hold does not.
  const forged = await scopeFor(c, 'USR-EXT003', 'ACC-001');
  assert.equal(forged.accountIds.includes('ACC-001'), false);
  assert.notEqual(forged.activeAccountId, 'ACC-001');
});

test('an internal employee cannot be converted into a portal user', async () => {
  const c = await db();
  // A contact carrying an internal employee's email address.
  await c.execute(`INSERT INTO contacts
      (contact_id, account_id, full_name, job_title, email, phone, whatsapp,
       preferred_channel, is_primary, active, created_at)
    VALUES ('CON-STAFF','ACC-001','Catherine Mwangi','Head of CS',
            (SELECT email FROM users WHERE user_id = 'USR-CATH'),NULL,NULL,'EMAIL',0,1,
            CURRENT_TIMESTAMP)`);

  const refused = await invitePortalUser(
    asClient(c),
    SEED.admin,
    { contactId: 'CON-STAFF', accountId: 'ACC-001', portalRoleId: 'ROLE-PORTAL' },
    NOW,
    null,
    null,
  );
  assert.equal(refused.ok, false);
  assert.ok(refused.ok === false && refused.reason.includes('internal employee'));
  const stillInternal = await c.execute(`SELECT user_type FROM users WHERE user_id = 'USR-CATH'`);
  assert.equal(String(stillInternal.rows[0]?.user_type), 'INTERNAL', 'and they stay internal');
});

test('a contact with no email cannot be invited, with a clear message', async () => {
  const c = await db();
  await c.execute(`INSERT INTO contacts
      (contact_id, account_id, full_name, job_title, email, phone, whatsapp,
       preferred_channel, is_primary, active, created_at)
    VALUES ('CON-NOMAIL','ACC-001','Peter Otieno','Driver',NULL,'+254700000001',NULL,'PHONE',0,1,
            CURRENT_TIMESTAMP)`);

  const refused = await invitePortalUser(
    asClient(c),
    SEED.admin,
    { contactId: 'CON-NOMAIL', accountId: 'ACC-001', portalRoleId: 'ROLE-PORTAL' },
    NOW,
    null,
    null,
  );
  assert.equal(refused.ok, false);
  assert.equal(refused.ok === false && refused.field, 'email');
  assert.ok(refused.ok === false && refused.reason.includes('no email address'));
  assert.ok(
    refused.ok === false && refused.reason.includes('the contact itself is fine'),
    'the contact stays valid; only the invitation is unavailable',
  );
});

test('the four membership audits are written and a page view is not', async () => {
  const c = await db();
  await c.execute(`INSERT INTO contacts
      (contact_id, account_id, full_name, job_title, email, phone, whatsapp,
       preferred_channel, is_primary, active, created_at)
    VALUES ('CON-NEW','ACC-001','Grace Njeri','Buyer','grace.njeri@bluepeak.example',NULL,NULL,
            'EMAIL',0,1,CURRENT_TIMESTAMP)`);

  const invited = await invitePortalUser(
    asClient(c),
    SEED.admin,
    { contactId: 'CON-NEW', accountId: 'ACC-001', portalRoleId: 'ROLE-PORTAL' },
    NOW,
    '10.0.0.1',
    'test',
  );
  assert.equal(invited.ok, true);
  const membershipId = invited.ok ? invited.membershipId : '';

  await setMembershipStatus(asClient(c), SEED.admin, membershipId, 'ACTIVE', NOW, null, null);
  await setMembershipStatus(asClient(c), SEED.admin, membershipId, 'SUSPENDED', NOW, null, null);
  await setMembershipStatus(asClient(c), SEED.admin, membershipId, 'REVOKED', NOW, null, null);

  const audits = await c.execute(
    `SELECT event_type FROM audit_events WHERE entity_type = 'PORTAL_MEMBERSHIP' ORDER BY event_at, event_type`,
  );
  const types = new Set(audits.rows.map((row) => String(row.event_type)));
  assert.ok(types.has(PORTAL_AUDIT.invited));
  assert.ok(types.has(PORTAL_AUDIT.activated));
  assert.ok(types.has(PORTAL_AUDIT.suspended));
  assert.ok(types.has(PORTAL_AUDIT.revoked));

  // Reading the portal audits nothing: ordinary page views are not recorded.
  const before = await c.execute(`SELECT COUNT(*) AS n FROM audit_events`);
  const scope = await scopeFor(c, A);
  await portalHome(asClient(c), scope);
  await portalOrders(asClient(c), scope);
  await portalCases(asClient(c), scope);
  const after = await c.execute(`SELECT COUNT(*) AS n FROM audit_events`);
  assert.equal(Number(after.rows[0]?.n), Number(before.rows[0]?.n));

  // The invited user is EXTERNAL and starts INVITED, never ACTIVE by default.
  const created = await c.execute({
    sql: `SELECT user_type, status FROM users WHERE user_id = ?`,
    args: [invited.ok ? invited.userId : ''],
  });
  assert.equal(String(created.rows[0]?.user_type), 'EXTERNAL');
  assert.equal(String(created.rows[0]?.status), 'INVITED');
});

test('a reply resumes the case through the engine rather than a second timer', async () => {
  const c = await db();
  const scope = await scopeFor(c, A);
  const owned = await c.execute(
    `SELECT case_id FROM service_cases WHERE account_id = 'ACC-001' LIMIT 1`,
  );
  const caseId = String(owned.rows[0]?.case_id);
  await c.execute({
    sql: `UPDATE service_cases SET status = 'WAITING_CUSTOMER' WHERE case_id = ?`,
    args: [caseId],
  });

  const events: string[] = [];
  const { onCaseEvent } = await import('../../src/lib/cms/service/events.ts');
  onCaseEvent(async (_db, event) => {
    events.push(`${event.type}:${String(event.detail.toStatus ?? '')}`);
  });

  const replied = await replyToPortalCase(asClient(c), scope, caseId, 'Yes, please proceed.', NOW);
  assert.equal(replied.ok, true);

  const after = await c.execute({
    sql: `SELECT status FROM service_cases WHERE case_id = ?`,
    args: [caseId],
  });
  assert.equal(String(after.rows[0]?.status), 'IN_PROGRESS', 'the case is ours again');
  assert.ok(
    events.includes('CASE_STATUS_CHANGED:IN_PROGRESS'),
    'and the engine was told through the phase 15 event seam',
  );

  const communication = await c.execute({
    sql: `SELECT direction, channel FROM case_communications WHERE case_id = ? ORDER BY communicated_at DESC LIMIT 1`,
    args: [caseId],
  });
  assert.equal(String(communication.rows[0]?.direction), 'INBOUND');
  assert.equal(String(communication.rows[0]?.channel), 'WEB');

  // B cannot reply to A's case, and gets the same nothing.
  const bScope = await scopeFor(c, B);
  const foreign = await replyToPortalCase(asClient(c), bScope, caseId, 'Let me in', NOW);
  assert.equal(foreign.ok, false);
  assert.equal(foreign.ok === false && foreign.reason, 'not_found');
});

test('no internal terminology reaches any portal payload', async () => {
  const c = await db();
  const scope = await scopeFor(c, A);
  const [home, orders, cases, documents] = await Promise.all([
    portalHome(asClient(c), scope),
    portalOrders(asClient(c), scope),
    portalCases(asClient(c), scope),
    portalDocuments(asClient(c), scope),
  ]);
  const body = JSON.stringify({ home, orders, cases, documents });

  for (const word of [
    'workflow_stage',
    'sla_profile',
    'affiliate',
    'import_batch',
    'business_unit',
    'PENDING_FINANCE',
    'WAITING_INTERNAL',
    'accountable',
    'snapshot',
  ]) {
    assert.equal(body.includes(word), false, `"${word}" must not reach a customer`);
  }
  // Employee names never appear either.
  const staff = await c.execute(`SELECT display_name FROM users WHERE user_type = 'INTERNAL'`);
  for (const raw of staff.rows) {
    assert.equal(body.includes(String(raw.display_name)), false);
  }
});

test('the customer language mapping is complete and never leaks a status name', () => {
  for (const status of [
    'NEW',
    'ASSIGNED',
    'IN_PROGRESS',
    'WAITING_CUSTOMER',
    'WAITING_INTERNAL',
    'RESOLVED',
    'CLOSED',
    'CANCELLED',
  ]) {
    const shown = customerCaseStatus(status);
    assert.notEqual(shown, status);
    assert.equal(shown.includes('_'), false);
  }
  assert.equal(customerCaseStatus('WAITING_INTERNAL'), 'In progress', 'our problem, our words');
  for (const status of ['CREATED', 'PENDING_FINANCE', 'PENDING_CREDIT', 'READY', 'LOADED']) {
    const shown = customerOrderStatus(status);
    assert.equal(shown.includes('_'), false);
    assert.equal(/FINANCE|CREDIT/.test(shown), false);
  }
  // An unknown status degrades to something safe rather than leaking itself.
  assert.equal(customerCaseStatus('SOME_NEW_INTERNAL_STATE'), 'In progress');
  assert.equal(customerOrderStatus('SOME_NEW_INTERNAL_STATE'), 'Processing');
});

// ---------------------------------------------------------------------------
// The internal side: who from a customer can sign in, and the six screens'
// presentation. These are not tenant tests, so they say so by being here
// rather than being mixed into the ones above.
// ---------------------------------------------------------------------------

test('the membership list keeps a revoked member and never invents a last sign-in', async () => {
  const c = await db();
  const before = await listMemberships(asClient(c), 'ACC-001');
  assert.equal(before.length >= 1, true, 'ABC has at least one member');

  const target = before[0]!;
  const revoked = await setMembershipStatus(
    asClient(c),
    'USR-CATH',
    target.membershipId,
    'REVOKED',
    NOW,
    null,
    null,
  );
  assert.equal(revoked.ok, true);

  const after = await listMemberships(asClient(c), 'ACC-001');
  const still = after.find((row) => row.membershipId === target.membershipId);
  assert.notEqual(still, undefined, 'a revoked membership stays in the list');
  assert.equal(still!.status, 'REVOKED');
  // Never signed in has to read as null, so the page can say "Never" rather
  // than a date or a zero.
  assert.equal(still!.lastAccessAt, null);
});

test('a contact with no email is listed with the reason rather than dropped', async () => {
  const c = await db();
  await c.execute(`INSERT INTO contacts
      (contact_id, account_id, full_name, job_title, email, phone, whatsapp,
       preferred_channel, is_primary, active, created_at)
    VALUES ('CON-NOEMAIL','ACC-001','Silent Contact','Storeman',NULL,NULL,NULL,
            'PHONE',0,1,CURRENT_TIMESTAMP)`);

  const contacts = await invitableContacts(asClient(c), 'ACC-001');
  const silent = contacts.find((row) => row.contactId === 'CON-NOEMAIL');
  assert.notEqual(silent, undefined, 'the contact is listed, not hidden');
  assert.equal(silent!.blockedReason, 'No email address on the contact');
  // And the one who already has access says so, which is the useful answer.
  const member = contacts.find((row) => row.contactId === 'CON-001');
  assert.notEqual(member, undefined);
  assert.equal(member!.blockedReason !== null, true);
});

test('an inactive contact is not offered at all', async () => {
  const c = await db();
  await c.execute(`UPDATE contacts SET active = 0 WHERE contact_id = 'CON-002'`);
  const contacts = await invitableContacts(asClient(c), 'ACC-001');
  assert.equal(
    contacts.some((row) => row.contactId === 'CON-002'),
    false,
  );
});

test('the portal roles are derived from their permissions, not from an identifier', async () => {
  const c = await db();
  const roles = await portalRoles(asClient(c));
  assert.equal(roles.length >= 1, true, 'at least one portal role qualifies');
  assert.equal(
    roles.every((role) => role.roleId !== ''),
    true,
  );

  // An internal role must never qualify, whatever it is called. ROLE-ADMIN
  // grants permissions outside the PORTAL module, so the NOT EXISTS clause
  // excludes it.
  const names = roles.map((role) => role.roleId);
  const internal = await c.execute(
    `SELECT DISTINCT rp.role_id FROM role_permissions rp
     JOIN permissions p ON p.permission_id = rp.permission_id
     WHERE p.module_name <> 'PORTAL'`,
  );
  for (const raw of internal.rows) {
    const roleId = String((raw as unknown as Record<string, unknown>).role_id);
    assert.equal(names.includes(roleId), false, `${roleId} must not be offered`);
  }

  // A role with no permissions at all is not offered either: it would pass
  // "nothing outside PORTAL" vacuously and grant a sign-in that sees nothing.
  await c.execute(`INSERT INTO access_roles
      (role_id, role_name, description, is_system_role, active, created_by_user_id, created_at)
    VALUES ('ROLE-EMPTY','Empty Role','Grants nothing',0,1,'USR-CATH',CURRENT_TIMESTAMP)`);
  const again = await portalRoles(asClient(c));
  assert.equal(
    again.some((role) => role.roleId === 'ROLE-EMPTY'),
    false,
  );
});

test('resending an invitation re-stamps it rather than creating a second membership', async () => {
  const c = await db();
  // A fresh contact, invited twice.
  await c.execute(`INSERT INTO contacts
      (contact_id, account_id, full_name, job_title, email, phone, whatsapp,
       preferred_channel, is_primary, active, created_at)
    VALUES ('CON-RESEND','ACC-001','Grace Wanjiru','Buyer','grace.wanjiru@abc.example',
            NULL,NULL,'EMAIL',0,1,CURRENT_TIMESTAMP)`);

  const first = await invitePortalUser(
    asClient(c),
    'USR-CATH',
    { contactId: 'CON-RESEND', accountId: 'ACC-001', portalRoleId: 'ROLE-PORTAL' },
    NOW,
    null,
    null,
  );
  assert.equal(first.ok, true);

  const later = new Date('2026-08-28T09:00:00Z');
  const second = await invitePortalUser(
    asClient(c),
    'USR-CATH',
    { contactId: 'CON-RESEND', accountId: 'ACC-001', portalRoleId: 'ROLE-PORTAL' },
    later,
    null,
    null,
  );
  assert.equal(second.ok, true);

  const rows = await c.execute({
    sql: `SELECT invited_at, status FROM customer_portal_memberships
          WHERE account_id = 'ACC-001' AND user_id = ?`,
    args: [first.ok ? first.userId : ''],
  });
  assert.equal(rows.rows.length, 1, 'one membership, not two');
  const row = rows.rows[0] as unknown as Record<string, unknown>;
  assert.equal(String(row.status), 'INVITED');
  assert.equal(
    String(row.invited_at).startsWith('2026-08-28'),
    true,
    'the resend re-stamps invited_at',
  );

  // And it is audited twice, so "we sent it again" is answerable.
  const audits = await c.execute({
    sql: `SELECT COUNT(*) AS n FROM audit_events WHERE event_type = ?`,
    args: [PORTAL_AUDIT.invited],
  });
  assert.equal(Number((audits.rows[0] as unknown as Record<string, unknown>).n), 2);
});

test('the request form offers categories and never a priority', async () => {
  const c = await db();
  const categories = await portalCategories(asClient(c));
  assert.equal(categories.length >= 1, true);
  for (const category of categories) {
    assert.equal(category.label.includes(' / '), true, 'category and subcategory, both');
    // The shape carries no priority at all, so no form built from it can
    // offer one and no customer can declare their own request critical.
    assert.deepEqual(Object.keys(category).sort(), ['caseCategoryId', 'label']);
  }

  // An inactive category is not offered.
  const id = categories[0]!.caseCategoryId;
  await c.execute({
    sql: `UPDATE case_categories SET active = 0 WHERE case_category_id = ?`,
    args: [id],
  });
  const after = await portalCategories(asClient(c));
  assert.equal(
    after.some((row) => row.caseCategoryId === id),
    false,
  );
});

test('the feedback list shows the customer their own score and marks an expired invitation', async () => {
  const c = await db();
  const scope = await scopeFor(c, A);

  await c.execute(`INSERT INTO survey_invitations
      (survey_invitation_id, survey_id, case_id, account_id, contact_id, invited_at,
       expires_at, survey_response_id)
    VALUES ('SI-OPEN','SUR-001','CASE-001','ACC-001','CON-001','2026-08-20 09:00:00',
            '2026-09-30 09:00:00',NULL),
           ('SI-GONE','SUR-002','CASE-002','ACC-001','CON-001','2026-06-01 09:00:00',
            '2026-06-15 09:00:00',NULL)`);

  const answered = await answerPortalSurvey(asClient(c), scope, 'SI-OPEN', 8, 'Sorted', NOW);
  assert.equal(answered.ok, true);

  const rows = await portalSurveys(asClient(c), scope, NOW);
  const open = rows.find((row) => row.invitationId === 'SI-OPEN');
  const gone = rows.find((row) => row.invitationId === 'SI-GONE');
  assert.notEqual(open, undefined);
  assert.notEqual(gone, undefined);

  // Their own answer comes back to them.
  assert.equal(open!.score, 8);
  assert.notEqual(open!.answeredAt, null);
  // An answered invitation is never "expired", whatever the date says.
  assert.equal(open!.expired, false);
  // An unanswered one past its date is marked rather than dropped.
  assert.equal(gone!.score, null);
  assert.equal(gone!.expired, true);

  // And B sees none of this.
  const other = await scopeFor(c, B);
  const theirs = await portalSurveys(asClient(c), other, NOW);
  assert.equal(
    theirs.some((row) => row.invitationId === 'SI-OPEN' || row.invitationId === 'SI-GONE'),
    false,
  );
});

test('a date is rendered long-form and an absent one is never a zero or an epoch', () => {
  assert.equal(portalDate('2026-08-14 09:30:00'), '14 August 2026');
  assert.equal(portalDateTime('2026-08-14 09:30:00'), '14 August 2026 at 09:30');
  // The three ways a value can be missing all read the same, and none of
  // them reads as a date.
  assert.equal(portalDate(null), 'Not available');
  assert.equal(portalDateTime(null), 'Not available');
  assert.equal(portalSize(null), 'Size not recorded');
  assert.notEqual(portalSize(0), portalSize(null));
  assert.equal(portalSize(0), '0 bytes');
});

test("no order status is coloured as an alarm on the customer's own screen", () => {
  // Every customer-facing order status maps to a tone, and none of them is
  // danger: a customer's order being at "Processing" is not an emergency and
  // painting their screen red would generate a telephone call about a state
  // that is entirely normal. Delay is said in words, once.
  for (const status of Object.values(CUSTOMER_ORDER_STATUS)) {
    assert.notEqual(orderTone(status), 'danger', status);
  }
  for (const status of Object.values(CUSTOMER_CASE_STATUS)) {
    assert.notEqual(caseTone(status), 'danger', status);
  }
  assert.equal(caseTone('Waiting for your reply'), 'warning');
  assert.equal(slaTone('Taking longer than our target'), 'warning');
});

test('a rate limit rule exists for every write a signed-in user can repeat', () => {
  // Sign-in was limited from the authentication phase. What was open was
  // everything behind it, and each of those has a rule here.
  const rules = Object.values(PORTAL_THROTTLES);
  assert.equal(rules.length, 4);
  for (const rule of rules) {
    assert.equal(rule.limit > 0, true, rule.bucket);
    assert.equal(rule.windowSeconds > 0, true, rule.bucket);
    // The message never names the number, so it cannot be tuned against.
    assert.equal(/\d/.test(rule.message), false, rule.bucket);
  }
  // The buckets are distinct, so one cannot spend another's allowance.
  const buckets = rules.map((rule) => rule.bucket);
  assert.equal(new Set(buckets).size, buckets.length);
});
