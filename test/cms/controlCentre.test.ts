/**
 * Phase 26: the control centre, the audit trail and the configuration review.
 *
 * THE FIRST TWO TESTS ARE THE ONES THAT MATTER MOST. Every audit control up
 * to this phase was a promise the application makes, and a promise is only
 * as good as the next endpoint somebody writes. The triggers make
 * immutability a property of the database, and the only evidence worth
 * anything for that is a real UPDATE and a real DELETE, attempted against
 * the real trigger, both refused.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, type TestClient } from './support/db.ts';
import { seedHass } from './support/hassSeed.ts';
import {
  AUDIT_CATALOGUE,
  describe as describeEvent,
  classify,
  isHighRisk,
  SECURITY_EVENT_TYPES,
  HIGH_RISK_EVENT_TYPES,
} from '../../src/lib/cms/audit/catalogue.ts';
import {
  isSensitiveKey,
  maskPayload,
  maskedJson,
  MASKED_PLACEHOLDER,
} from '../../src/lib/cms/audit/mask.ts';
import { diffPayloads, humanLabel, renderValue } from '../../src/lib/cms/audit/diff.ts';
import {
  auditScope,
  listAuditEvents,
  auditEvent,
  entityHistory,
  userActivity,
  securityEvents,
  maySeeSecurityEvents,
  parseAuditFilter,
  exportAuditCsv,
  auditExportStmt,
  describeFilter,
  DEFAULT_WINDOW_DAYS,
  PAGE_SIZE,
} from '../../src/lib/cms/repos/auditTrail.ts';
import {
  systemHealth,
  accessReview,
  authorityReview,
  roleImpact,
  expiringAuthority,
} from '../../src/lib/cms/repos/controlCentre.ts';

const NOW = new Date('2026-08-27T10:00:00Z');
const TODAY = '2026-08-27';

const asClient = (c: TestClient) => c as unknown as Parameters<typeof auditScope>[0];

const db = async (): Promise<TestClient> => {
  const c = createTestDb();
  await seedHass(c);
  return c;
};

/**
 * The two audit permissions do not exist in the seed; the operator's script
 * adds them. Tests that need them mirror
 * docs/cms/audit/09_add_audit_permissions.sql exactly, the same way the CRM
 * suites mirror the opportunity permission script.
 */
async function grantAuditPermissions(c: TestClient): Promise<void> {
  await c.execute(`INSERT OR IGNORE INTO permissions
      (permission_id, module_name, resource_name, action_name, description) VALUES
    ('PERM-041','AUDIT','EVENTS','SECURITY_VIEW','View authentication and access security events'),
    ('PERM-042','AUDIT','EVENTS','EXPORT','Export filtered audit evidence')`);
  await c.execute(`INSERT OR IGNORE INTO role_permissions
      (role_permission_id, role_id, permission_id, allowed, created_at) VALUES
    ('RP-ADM-041','ROLE-ADMIN','PERM-041',1,CURRENT_TIMESTAMP),
    ('RP-ADM-042','ROLE-ADMIN','PERM-042',1,CURRENT_TIMESTAMP),
    ('RP-GF-041','ROLE-GRP-FIN','PERM-041',1,CURRENT_TIMESTAMP),
    ('RP-GF-042','ROLE-GRP-FIN','PERM-042',1,CURRENT_TIMESTAMP)`);
}

let counter = 0;
async function writeAudit(
  c: TestClient,
  input: {
    actor?: string | null;
    eventType: string;
    entityType: string;
    entityId: string;
    action?: string;
    before?: unknown;
    after?: unknown;
    at?: string;
  },
): Promise<string> {
  counter += 1;
  const id = `AEV-T${String(counter).padStart(4, '0')}`;
  await c.execute({
    sql: `INSERT INTO audit_events
            (audit_event_id, actor_user_id, event_type, entity_type, entity_id, action,
             before_json, after_json, ip_address, user_agent, event_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, '196.201.0.1', 'test', ?)`,
    args: [
      id,
      input.actor === undefined ? 'USR-CATH' : input.actor,
      input.eventType,
      input.entityType,
      input.entityId,
      input.action ?? 'UPDATE',
      input.before === undefined ? null : JSON.stringify(input.before),
      input.after === undefined ? null : JSON.stringify(input.after),
      input.at ?? '2026-08-26 09:00:00',
    ] as never[],
  });
  return id;
}

// ---------------------------------------------------------------------------
// 1. Immutability, proved against the database
// ---------------------------------------------------------------------------

test('both immutability triggers exist before anything else runs', async () => {
  const c = await db();
  const result = await c.execute(
    `SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'trg_audit_events%' ORDER BY name`,
  );
  const names = result.rows.map((raw) => String((raw as unknown as Record<string, unknown>).name));
  assert.deepEqual(names, ['trg_audit_events_no_delete', 'trg_audit_events_no_update']);
});

test('an UPDATE and a DELETE against audit_events are refused by the database', async () => {
  const c = await db();
  const id = await writeAudit(c, {
    eventType: 'ACCOUNT_UPDATED',
    entityType: 'ACCOUNT',
    entityId: 'ACC-001',
    after: { accountName: 'Original' },
  });

  let updateError = '';
  await assert.rejects(
    async () => {
      await c.execute({
        sql: `UPDATE audit_events SET after_json = ? WHERE audit_event_id = ?`,
        args: [JSON.stringify({ accountName: 'Rewritten' }), id],
      });
    },
    (error: Error) => {
      updateError = error.message;
      return /append-only/i.test(error.message);
    },
  );

  let deleteError = '';
  await assert.rejects(
    async () => {
      await c.execute({ sql: `DELETE FROM audit_events WHERE audit_event_id = ?`, args: [id] });
    },
    (error: Error) => {
      deleteError = error.message;
      return /append-only/i.test(error.message);
    },
  );

  // Both errors are recorded in the phase report as evidence.
  assert.match(updateError, /UPDATE is refused/);
  assert.match(deleteError, /DELETE is refused/);

  // And the row is exactly as it was written.
  const after = await c.execute({
    sql: `SELECT after_json FROM audit_events WHERE audit_event_id = ?`,
    args: [id],
  });
  assert.equal(
    String((after.rows[0] as unknown as Record<string, unknown>).after_json),
    JSON.stringify({ accountName: 'Original' }),
  );
});

// ---------------------------------------------------------------------------
// 2. Masking
// ---------------------------------------------------------------------------

test('a synthetic row carrying every secret renders none of them', async () => {
  const c = await db();
  // Exactly the five the acceptance criterion names, plus the nesting and the
  // array that a real payload would put them in.
  const poisoned = {
    email: 'grace@example.com',
    password_hash: 'pbkdf2$210000$abcdef$0123456789abcdef',
    sessionToken: 'sess_live_9f3a2b1c8d7e6f5a',
    mfa_secret: 'JBSWY3DPEHPK3PXP',
    resetToken: 'rst_7f2e9d1c',
    verification_token: 'vrf_a1b2c3d4',
    credentials: { passwordHash: 'nested-secret', backupCodes: ['abc-123', 'def-456'] },
    displayName: 'Grace Wanjiru',
  };
  const id = await writeAudit(c, {
    eventType: 'USER_UPDATED',
    entityType: 'USER',
    entityId: 'USR-GAB',
    before: { email: 'g.old@example.com', password_hash: 'previous-secret' },
    after: poisoned,
  });

  const detail = await auditEvent(asClient(c), 'USR-CATH', id);
  assert.notEqual(detail, null);
  const rendered = JSON.stringify(detail);

  // Not one of the secret values appears anywhere in the rendered object,
  // diff rows, technical JSON and all.
  for (const secret of [
    'pbkdf2$210000$abcdef$0123456789abcdef',
    'sess_live_9f3a2b1c8d7e6f5a',
    'JBSWY3DPEHPK3PXP',
    'rst_7f2e9d1c',
    'vrf_a1b2c3d4',
    'nested-secret',
    'abc-123',
    'previous-secret',
  ]) {
    assert.equal(rendered.includes(secret), false, `${secret} must never be rendered`);
  }

  // The non-secret fields are still there, so the row is still evidence.
  assert.equal(rendered.includes('Grace Wanjiru'), true);
  assert.equal(rendered.includes('grace@example.com'), true);

  // The password hash change is still REPORTED, just not shown. Knowing the
  // field changed is the audit fact; the value is only useful to an attacker.
  const hashRow = detail!.diff.rows.find((row) => row.path === 'password_hash');
  assert.notEqual(hashRow, undefined);
  assert.equal(hashRow!.kind, 'changed');
  assert.equal(hashRow!.before, MASKED_PLACEHOLDER);
  assert.equal(hashRow!.after, MASKED_PLACEHOLDER);
  assert.equal(hashRow!.masked, true);
});

test('the masked-key list recognises the spellings a payload actually uses', () => {
  for (const key of [
    'password',
    'password_hash',
    'passwordHash',
    'pwdHash',
    'sessionToken',
    'session_token',
    'mfa_secret',
    'totpSecret',
    'resetToken',
    'verification_token',
    'refresh_token',
    'apiKey',
    'salt',
    'credentials.passwordHash',
  ]) {
    assert.equal(isSensitiveKey(key), true, `${key} must be masked`);
  }
  // And the exemptions, which are real fields a reader needs.
  for (const key of ['fileHash', 'file_hash', 'session_id', 'sessionId']) {
    assert.equal(isSensitiveKey(key), false, `${key} must not be masked`);
  }
  // Ordinary fields are untouched.
  for (const key of ['accountName', 'status', 'effective_to', 'target_minutes']) {
    assert.equal(isSensitiveKey(key), false);
  }
});

test('the technical JSON disclosure is masked too, so it is not the one hole', () => {
  const raw = JSON.stringify({ password_hash: 'secret', accountName: 'ABC Ltd' });
  const masked = maskedJson(raw);
  assert.notEqual(masked, null);
  assert.equal(masked!.includes('secret'), false);
  assert.equal(masked!.includes('ABC Ltd'), true);
  assert.equal(masked!.includes(MASKED_PLACEHOLDER), true);

  // A stored value that is not JSON is not rendered raw either: it could be
  // anything, including a bare token somebody stored as a string.
  assert.equal(maskedJson('not json at all')!.includes('not json at all'), false);
  // Nested and arrayed secrets are reached by the recursion.
  const nested = maskPayload({ a: { b: { token: 'x' } }, list: [{ secret: 'y' }] }) as Record<
    string,
    unknown
  >;
  assert.equal(JSON.stringify(nested).includes('"x"'), false);
  assert.equal(JSON.stringify(nested).includes('"y"'), false);
});

// ---------------------------------------------------------------------------
// 3. The diff, in business language
// ---------------------------------------------------------------------------

test('a role permission change renders as a field-level diff in business language', async () => {
  const c = await db();
  const id = await writeAudit(c, {
    eventType: 'PERMISSION_GRANTED',
    entityType: 'ACCESS_ROLE',
    entityId: 'ROLE-FIN',
    action: 'UPDATE',
    before: {
      role_name: 'Finance Manager',
      permissions: ['ORDERS.SALES_ORDER.VIEW', 'AUDIT.EVENTS.VIEW'],
      sla_target_minutes: 240,
      effective_to: null,
    },
    after: {
      role_name: 'Finance Manager',
      permissions: ['ORDERS.SALES_ORDER.VIEW', 'AUDIT.EVENTS.VIEW', 'AUDIT.EVENTS.EXPORT'],
      sla_target_minutes: 120,
      effective_to: '2026-12-31',
    },
  });
  await grantAuditPermissions(c);
  const detail = await auditEvent(asClient(c), 'USR-CATH', id);
  assert.notEqual(detail, null);

  const byPath = new Map(detail!.diff.rows.map((row) => [row.path, row]));

  // An added array element is reported as added, not as "the whole list changed".
  const added = byPath.get('permissions.2');
  assert.notEqual(added, undefined);
  assert.equal(added!.kind, 'added');
  assert.equal(added!.after, 'AUDIT.EVENTS.EXPORT');
  assert.equal(added!.before, 'Not set');
  assert.equal(added!.label, 'Permissions, item 3');

  // A changed number, labelled in business language with the initialism kept.
  const target = byPath.get('sla_target_minutes');
  assert.equal(target!.kind, 'changed');
  assert.equal(target!.label, 'SLA target minutes');
  assert.equal(target!.before, '240');
  assert.equal(target!.after, '120');

  // Null to a value is "added", and null renders as "Not set", never "null".
  const effective = byPath.get('effective_to');
  assert.equal(effective!.kind, 'added');
  assert.equal(effective!.before, 'Not set');
  assert.equal(effective!.label, 'Effective to');

  // An unchanged field is not in the diff at all by default.
  assert.equal(byPath.has('role_name'), false);

  // Raw JSON exists but is separate: it is the Technical Details disclosure,
  // not the primary experience.
  assert.notEqual(detail!.afterJson, null);
  assert.equal(detail!.diff.rows.length > 0, true);
});

test('null, empty and zero are three different readings', () => {
  assert.equal(renderValue(null), 'Not set');
  assert.equal(renderValue(undefined), 'Not set');
  assert.equal(renderValue(''), 'Empty');
  assert.equal(renderValue(0), '0');
  assert.equal(renderValue(false), 'No');
  assert.equal(renderValue(true), 'Yes');
  assert.equal(renderValue([]), 'Empty list');
  // The three that a careless renderer collapses into one.
  assert.notEqual(renderValue(null), renderValue(0));
  assert.notEqual(renderValue(null), renderValue(''));
  assert.notEqual(renderValue(''), renderValue(0));
});

test('the diff handles a creation, a deletion, nesting and an unreadable payload', () => {
  // A creation has no before and reads as a list of added fields.
  const created = diffPayloads(null, JSON.stringify({ name: 'New', active: true }));
  assert.equal(
    created.rows.every((row) => row.kind === 'added'),
    true,
  );
  assert.equal(created.rows.length, 2);

  // A deletion has no after and reads as removed.
  const removed = diffPayloads(JSON.stringify({ name: 'Old' }), null);
  assert.equal(removed.rows[0]!.kind, 'removed');

  // Nesting produces a dotted path and a readable label.
  const nested = diffPayloads(
    JSON.stringify({ scope: { country_id: 'CTR-KE' } }),
    JSON.stringify({ scope: { country_id: 'CTR-UG' } }),
  );
  assert.equal(nested.rows[0]!.path, 'scope.country_id');
  assert.equal(nested.rows[0]!.label, 'Scope, country id');

  // Both sides absent is empty rather than an error.
  assert.equal(diffPayloads(null, null).empty, true);

  // An unreadable payload SAYS SO. An empty diff and an unreadable one are
  // different facts and a reader must not be shown the first for the second.
  const broken = diffPayloads('{not json', null);
  assert.notEqual(broken.parseError, null);
  assert.equal(broken.rows.length, 0);
});

test('humanLabel never shows a database column name to a reader', () => {
  assert.equal(humanLabel('effective_from'), 'Effective from');
  assert.equal(humanLabel('businessUnitId'), 'Business unit id');
  assert.equal(humanLabel('mfa_method_id'), 'MFA method id');
  assert.equal(humanLabel('rules.0.max_amount'), 'Rules, item 1, max amount');
});

// ---------------------------------------------------------------------------
// 4. Classification and high risk
// ---------------------------------------------------------------------------

test('high-risk events carry a label and a reason, not a colour', () => {
  // Every high-risk entry explains itself, because section 6 forbids
  // distinguishing them by colour alone and a colour with no words is
  // exactly that.
  for (const code of HIGH_RISK_EVENT_TYPES) {
    const meta = describeEvent(code);
    assert.equal(meta.highRisk, true);
    assert.notEqual(meta.label, '', `${code} needs a label`);
    assert.equal(typeof meta.why, 'string', `${code} needs a reason`);
    assert.equal((meta.why ?? '').length > 20, true, `${code}'s reason must be a sentence`);
  }
  // The events section 6 names explicitly are all classified high-risk.
  for (const code of [
    'USER_ROLE_ASSIGNED',
    'ROLE_SCOPE_ASSIGNED',
    'AUTHORITY_RULE_CHANGED',
    'WORKFLOW_STAGE_CHANGED',
    'SLA_RULE_UPDATED',
    'PORTAL_USER_INVITED',
    'USER_EMAIL_CHANGED',
    'USER_SUSPENDED',
    'USER_REACTIVATED',
  ]) {
    assert.equal(isHighRisk(code), true, `${code} must be high risk`);
  }
});

test('an uncatalogued event type is rendered, not dropped', () => {
  const meta = describeEvent('SOME_FUTURE_EVENT');
  assert.equal(meta.label, 'Some future event');
  // Business and not high-risk: guessing security would hide it behind a
  // permission, guessing high-risk would fill that view with noise.
  assert.equal(meta.classification, 'BUSINESS');
  assert.equal(meta.highRisk, false);
});

test('the three classifications partition the catalogue with nothing left over', () => {
  const classes = new Set(Object.keys(AUDIT_CATALOGUE).map((code) => classify(code)));
  for (const value of classes) {
    assert.equal(['SECURITY', 'CONFIGURATION', 'BUSINESS'].includes(value), true);
  }
  // Authentication is security, approvals are business, workflows are config.
  assert.equal(classify('LOGIN_FAILED'), 'SECURITY');
  assert.equal(classify('APPROVAL_COMPLETED'), 'BUSINESS');
  assert.equal(classify('WORKFLOW_VERSION_CREATED'), 'CONFIGURATION');
  assert.equal(SECURITY_EVENT_TYPES.includes('LOGIN_FAILED'), true);
  assert.equal(SECURITY_EVENT_TYPES.includes('ACCOUNT_UPDATED'), false);
});

// ---------------------------------------------------------------------------
// 5. Scope
// ---------------------------------------------------------------------------

test('a country administrator cannot see a Group security configuration event', async () => {
  const c = await db();
  await grantAuditPermissions(c);

  // A Group role change: an ACCESS_ROLE entity, which resolves to no country
  // and no affiliate, so it is Group configuration by construction.
  const groupEvent = await writeAudit(c, {
    actor: 'USR-CATH',
    eventType: 'PERMISSION_GRANTED',
    entityType: 'ACCESS_ROLE',
    entityId: 'ROLE-GRP-FIN',
    after: { permissions: ['AUDIT.EVENTS.EXPORT'] },
  });

  // USR-FMUG is the Uganda finance manager: PERM-020 through ROLE-FIN, scoped
  // to their own affiliate.
  const local = await auditScope(asClient(c), 'USR-FMUG');
  assert.equal(local.granted, true, 'the Uganda finance manager holds AUDIT.EVENTS.VIEW');
  assert.equal(local.group, false, 'and is not Group-scoped');

  // The direct call, which is the only test that means anything: hiding it in
  // the interface would prove nothing.
  const direct = await auditEvent(asClient(c), 'USR-FMUG', groupEvent);
  assert.equal(direct, null, 'a Group role change is not visible to a local administrator');

  const list = await listAuditEvents(
    asClient(c),
    'USR-FMUG',
    parseAuditFilter(new URLSearchParams(), NOW),
  );
  assert.equal(
    list.items.some((row) => row.auditEventId === groupEvent),
    false,
  );

  // The system administrator, who is Group-scoped, does see it.
  const admin = await auditEvent(asClient(c), 'USR-CATH', groupEvent);
  assert.notEqual(admin, null);
});

test('an audit row is visible to exactly the people who can see its entity', async () => {
  const c = await db();
  // ACC-001 is a Kenya account in the seed. The Uganda finance manager cannot
  // see it, so they cannot see its audit row either.
  const kenyaEvent = await writeAudit(c, {
    eventType: 'ACCOUNT_UPDATED',
    entityType: 'ACCOUNT',
    entityId: 'ACC-001',
    before: { status: 'ACTIVE' },
    after: { status: 'ON_HOLD' },
  });

  const uganda = await auditEvent(asClient(c), 'USR-FMUG', kenyaEvent);
  assert.equal(uganda, null);

  const group = await auditEvent(asClient(c), 'USR-GCFO', kenyaEvent);
  assert.notEqual(group, null, 'Group finance sees it');
});

test('an event whose entity no longer exists is withheld from a local administrator', async () => {
  const c = await db();
  // An account id that does not resolve. The scope cannot be derived, and the
  // safe reading of "I cannot tell whose this was" is to withhold it. Failing
  // open here would mean an attacker who could delete a record would gain the
  // audit rows about it.
  const orphan = await writeAudit(c, {
    eventType: 'ACCOUNT_UPDATED',
    entityType: 'ACCOUNT',
    entityId: 'ACC-DELETED-999',
    after: { status: 'ARCHIVED' },
  });
  assert.equal(await auditEvent(asClient(c), 'USR-FMUG', orphan), null);
  // A Group principal still sees it, so the evidence is not lost.
  assert.notEqual(await auditEvent(asClient(c), 'USR-CATH', orphan), null);
});

test('a principal always sees their own actions whatever their scope', async () => {
  const c = await db();
  // The Uganda finance manager acting on a Group configuration entity they
  // could not otherwise read. A person may always read what they themselves
  // did, which is the one exception and it is deliberate.
  const own = await writeAudit(c, {
    actor: 'USR-FMUG',
    eventType: 'ORGANISATION_CHANGE',
    entityType: 'BUSINESS_UNIT',
    entityId: 'BU-RET',
    after: { name: 'Retail' },
  });
  assert.notEqual(await auditEvent(asClient(c), 'USR-FMUG', own), null);
});

test('a principal without the audit permission sees nothing at all', async () => {
  const c = await db();
  await writeAudit(c, {
    eventType: 'ACCOUNT_UPDATED',
    entityType: 'ACCOUNT',
    entityId: 'ACC-001',
    after: { status: 'ACTIVE' },
  });
  // USR-VIC is the credit manager: no PERM-020 in the seed.
  const scope = await auditScope(asClient(c), 'USR-VIC');
  assert.equal(scope.granted, false);
  assert.equal(scope.sql, '1 = 0');
  const page = await listAuditEvents(
    asClient(c),
    'USR-VIC',
    parseAuditFilter(new URLSearchParams(), NOW),
  );
  assert.equal(page.total, 0);
  assert.deepEqual(page.items, []);
});

// ---------------------------------------------------------------------------
// 6. The security view
// ---------------------------------------------------------------------------

test('the security view refuses everybody until the operator runs the script', async () => {
  const c = await db();
  await writeAudit(c, {
    eventType: 'LOGIN_FAILED',
    entityType: 'USER',
    entityId: 'USR-GAB',
    action: 'LOGIN',
    after: { reason: 'BAD_PASSWORD', attempts: 3 },
  });

  // PERM-041 does not exist yet, so nobody holds it, the system administrator
  // included. That is the correct behaviour and the interface says so.
  assert.equal(await maySeeSecurityEvents(asClient(c), 'USR-CATH'), false);
  const before = await securityEvents(
    asClient(c),
    'USR-CATH',
    parseAuditFilter(new URLSearchParams(), NOW),
  );
  assert.equal(before.total, 0);
  assert.equal(before.securityIncluded, false);

  await grantAuditPermissions(c);
  assert.equal(await maySeeSecurityEvents(asClient(c), 'USR-CATH'), true);
  const after = await securityEvents(
    asClient(c),
    'USR-CATH',
    parseAuditFilter(new URLSearchParams(), NOW),
  );
  assert.equal(after.total, 1);
});

test('the detailed sign-in failure reason never reaches an unauthorised principal', async () => {
  const c = await db();
  await writeAudit(c, {
    eventType: 'LOGIN_FAILED',
    entityType: 'USER',
    entityId: 'USR-GAB',
    action: 'LOGIN',
    after: { reason: 'ACCOUNT_SUSPENDED', attempts: 5 },
  });

  // The finance manager holds PERM-020 but not PERM-041 even after the script,
  // because the script deliberately does not grant ROLE-FIN either code.
  await grantAuditPermissions(c);
  assert.equal(await maySeeSecurityEvents(asClient(c), 'USR-GAB'), false);

  const list = await listAuditEvents(
    asClient(c),
    'USR-GAB',
    parseAuditFilter(new URLSearchParams(), NOW),
  );
  // NO ROW, rather than a row with the reason blanked. A blanked field is one
  // refactor away from being un-blanked; an absent row is not.
  assert.equal(
    list.items.some((row) => row.eventType === 'LOGIN_FAILED'),
    false,
  );
  assert.equal(JSON.stringify(list).includes('ACCOUNT_SUSPENDED'), false);

  const security = await securityEvents(
    asClient(c),
    'USR-GAB',
    parseAuditFilter(new URLSearchParams(), NOW),
  );
  assert.equal(security.total, 0);
  assert.equal(JSON.stringify(security).includes('ACCOUNT_SUSPENDED'), false);
});

// ---------------------------------------------------------------------------
// 7. Entity history and the user audit tab
// ---------------------------------------------------------------------------

test('entity history on a customer shows only that customer', async () => {
  const c = await db();
  const mine = await writeAudit(c, {
    eventType: 'ACCOUNT_UPDATED',
    entityType: 'ACCOUNT',
    entityId: 'ACC-001',
    after: { status: 'ACTIVE' },
  });
  await writeAudit(c, {
    eventType: 'ACCOUNT_UPDATED',
    entityType: 'ACCOUNT',
    entityId: 'ACC-002',
    after: { status: 'ACTIVE' },
  });
  await writeAudit(c, {
    eventType: 'LEAD_CREATED',
    entityType: 'LEAD',
    entityId: 'LEAD-001',
    after: { title: 'A lead' },
  });

  const history = await entityHistory(asClient(c), 'USR-CATH', 'ACCOUNT', 'ACC-001');
  assert.equal(history.length, 1);
  assert.equal(history[0]!.auditEventId, mine);
  assert.equal(history[0]!.entityId, 'ACC-001');
});

test('the user audit tab shows configuration changes and not sign-in history', async () => {
  const c = await db();
  await grantAuditPermissions(c);
  // The same person: one thing they configured, one time they signed in.
  await writeAudit(c, {
    actor: 'USR-GAB',
    eventType: 'ACCOUNT_UPDATED',
    entityType: 'ACCOUNT',
    entityId: 'ACC-001',
    after: { status: 'ACTIVE' },
  });
  await writeAudit(c, {
    actor: 'USR-GAB',
    eventType: 'LOGIN_SUCCESS',
    entityType: 'USER',
    entityId: 'USR-GAB',
    action: 'LOGIN',
    after: { ok: true },
  });
  await writeAudit(c, {
    actor: 'USR-GAB',
    eventType: 'LOGIN_FAILED',
    entityType: 'USER',
    entityId: 'USR-GAB',
    action: 'LOGIN',
    after: { reason: 'BAD_PASSWORD' },
  });

  const activity = await userActivity(asClient(c), 'USR-CATH', 'USR-GAB');
  const types = activity.map((row) => row.eventType);
  assert.equal(types.includes('ACCOUNT_UPDATED'), true);
  // Not login history, even for a caller who holds the security permission.
  // A list of somebody's sign-in times on their profile page is surveillance
  // wearing an audit badge, and it is the wrong place to investigate anyway.
  assert.equal(types.includes('LOGIN_SUCCESS'), false);
  assert.equal(types.includes('LOGIN_FAILED'), false);
});

// ---------------------------------------------------------------------------
// 8. The list, the window and the page size
// ---------------------------------------------------------------------------

test('the list is server-paginated with a stated default date window', async () => {
  const c = await db();
  // Two rows inside the window and one well outside it.
  await writeAudit(c, {
    eventType: 'ACCOUNT_UPDATED',
    entityType: 'ACCOUNT',
    entityId: 'ACC-001',
    at: '2026-08-26 09:00:00',
    after: { status: 'ACTIVE' },
  });
  await writeAudit(c, {
    eventType: 'ACCOUNT_UPDATED',
    entityType: 'ACCOUNT',
    entityId: 'ACC-001',
    at: '2026-08-20 09:00:00',
    after: { status: 'ACTIVE' },
  });
  await writeAudit(c, {
    eventType: 'ACCOUNT_UPDATED',
    entityType: 'ACCOUNT',
    entityId: 'ACC-001',
    at: '2026-01-05 09:00:00',
    after: { status: 'ACTIVE' },
  });

  assert.equal(DEFAULT_WINDOW_DAYS, 30);
  assert.equal(PAGE_SIZE, 50);

  const filter = parseAuditFilter(new URLSearchParams(), NOW);
  assert.equal(filter.from, '2026-07-28');
  assert.equal(filter.to, '2026-08-27');

  const page = await listAuditEvents(asClient(c), 'USR-CATH', filter);
  assert.equal(page.total, 2, 'the January row is outside the default window');
  assert.equal(page.pageSize, 50);
  assert.deepEqual(page.window, { from: '2026-07-28', to: '2026-08-27' });

  // The window is a default, not a ceiling: asking for January returns it.
  const january = await listAuditEvents(
    asClient(c),
    'USR-CATH',
    parseAuditFilter(new URLSearchParams('from=2026-01-01&to=2026-01-31'), NOW),
  );
  assert.equal(january.total, 1);
});

test('a reversed or malformed date range is corrected rather than returned empty', () => {
  const reversed = parseAuditFilter(new URLSearchParams('from=2026-08-27&to=2026-08-01'), NOW);
  assert.equal(reversed.from, '2026-08-01');
  assert.equal(reversed.to, '2026-08-27');
  // A malformed date falls back to the default rather than to today, because
  // silently narrowing to one day reads as "no audit rows exist".
  const malformed = parseAuditFilter(new URLSearchParams('from=yesterday'), NOW);
  assert.equal(malformed.from, '2026-07-28');
});

// ---------------------------------------------------------------------------
// 9. Export
// ---------------------------------------------------------------------------

test('the export applies the same scope, escapes formulas and writes its own audit row', async () => {
  const c = await db();
  await grantAuditPermissions(c);

  // A customer renamed to a formula, exactly as the phase 20 export test does.
  await c.execute({
    sql: `UPDATE accounts SET account_name = ? WHERE account_id = 'ACC-001'`,
    args: ['=cmd|calc'],
  });
  await writeAudit(c, {
    eventType: 'ACCOUNT_UPDATED',
    entityType: 'ACCOUNT',
    entityId: 'ACC-001',
    at: '2026-08-26 09:00:00',
    before: { status: 'ACTIVE' },
    after: { status: 'ON_HOLD' },
  });
  const ugandaRow = await writeAudit(c, {
    eventType: 'ACCOUNT_UPDATED',
    entityType: 'ACCOUNT',
    entityId: 'ACC-005',
    at: '2026-08-26 10:00:00',
    after: { status: 'ACTIVE' },
  });
  void ugandaRow;

  const filter = parseAuditFilter(new URLSearchParams(), NOW);
  const exported = await exportAuditCsv(
    asClient(c),
    'USR-CATH',
    filter,
    '2026-08-27 10:00:00',
    'Jamlick Njoroge',
  );

  // The formula is defused with a leading apostrophe, so a spreadsheet cannot
  // execute a customer name.
  assert.equal(exported.csv.includes(`"'=cmd|calc"`), true);
  assert.equal(exported.csv.includes(`"=cmd|calc"`), false);

  // The metadata section states what the file is a copy of.
  assert.equal(exported.csv.includes('# Generated at,"2026-08-27 10:00:00"'), true);
  assert.equal(exported.csv.includes('# Date range,"2026-07-28 to 2026-08-27"'), true);
  assert.equal(exported.csv.includes('# Rows,'), true);

  // Scope: the Uganda finance manager's export contains no Kenyan row and
  // matches what they can see on screen exactly.
  const local = await exportAuditCsv(
    asClient(c),
    'USR-FMUG',
    filter,
    '2026-08-27 10:00:00',
    'Uganda Finance',
  );
  const screen = await listAuditEvents(asClient(c), 'USR-FMUG', filter);
  assert.equal(local.rowCount, screen.total, 'the export matches the screen exactly');
  assert.equal(local.csv.includes('=cmd|calc'), false);

  // The export audits itself: filters and count, and NOT the data.
  const stmt = auditExportStmt({
    actorUserId: 'USR-CATH',
    filter,
    rowCount: exported.rowCount,
    totalMatching: exported.totalMatching,
    format: 'CSV',
    ip: '196.201.0.1',
    userAgent: 'test',
    now: NOW,
  });
  await c.execute(stmt);
  const written = await c.execute(
    `SELECT event_type, entity_type, action, after_json FROM audit_events
      WHERE event_type = 'AUDIT_EXPORTED'`,
  );
  assert.equal(written.rows.length, 1);
  const row = written.rows[0] as unknown as Record<string, unknown>;
  const payload = JSON.parse(String(row.after_json)) as Record<string, unknown>;
  assert.equal(payload.rowCount, exported.rowCount);
  assert.equal(String(payload.filters).includes('2026-07-28 to 2026-08-27'), true);
  // The exported content is NOT in the audit row.
  assert.equal(String(row.after_json).includes('cmd|calc'), false);
  assert.equal(String(row.after_json).includes('Timestamp (UTC)'), false);
  assert.equal(describeFilter(filter).includes('2026-07-28'), true);
});

test('an export never carries a security event the exporter may not read', async () => {
  const c = await db();
  await writeAudit(c, {
    eventType: 'LOGIN_FAILED',
    entityType: 'USER',
    entityId: 'USR-GAB',
    action: 'LOGIN',
    at: '2026-08-26 09:00:00',
    after: { reason: 'BAD_PASSWORD' },
  });
  await grantAuditPermissions(c);
  // ROLE-FIN gets neither code, deliberately.
  const filter = parseAuditFilter(new URLSearchParams(), NOW);
  const exported = await exportAuditCsv(
    asClient(c),
    'USR-GAB',
    filter,
    '2026-08-27 10:00:00',
    'Gabriel Musyoka',
  );
  assert.equal(exported.csv.includes('LOGIN_FAILED'), false);
  assert.equal(exported.csv.includes('BAD_PASSWORD'), false);
  assert.equal(exported.csv.includes('# Security events included,"No, not permitted"'), true);
});

// ---------------------------------------------------------------------------
// 10. No audit noise
// ---------------------------------------------------------------------------

test('reading the audit workspace produces no audit row of its own', async () => {
  const c = await db();
  await grantAuditPermissions(c);
  await writeAudit(c, {
    eventType: 'ACCOUNT_UPDATED',
    entityType: 'ACCOUNT',
    entityId: 'ACC-001',
    after: { status: 'ACTIVE' },
  });

  const countRows = async (): Promise<number> => {
    const result = await c.execute(`SELECT COUNT(*) AS n FROM audit_events`);
    return Number((result.rows[0] as unknown as Record<string, unknown>).n);
  };

  const before = await countRows();

  // Everything a reader does while investigating: list, page, filter, sort by
  // a different window, open a detail, read an entity history, read a user's
  // activity, read the security view, read the health screen.
  const filter = parseAuditFilter(new URLSearchParams(), NOW);
  const page = await listAuditEvents(asClient(c), 'USR-CATH', filter);
  await listAuditEvents(asClient(c), 'USR-CATH', { ...filter, page: 2 });
  await listAuditEvents(asClient(c), 'USR-CATH', { ...filter, classification: 'BUSINESS' });
  await listAuditEvents(asClient(c), 'USR-CATH', { ...filter, highRiskOnly: true });
  await auditEvent(asClient(c), 'USR-CATH', page.items[0]!.auditEventId);
  await entityHistory(asClient(c), 'USR-CATH', 'ACCOUNT', 'ACC-001');
  await userActivity(asClient(c), 'USR-CATH', 'USR-CATH');
  await securityEvents(asClient(c), 'USR-CATH', filter);
  await systemHealth(asClient(c), NOW);
  await accessReview(asClient(c), TODAY);
  await authorityReview(asClient(c), { effectiveOn: TODAY });

  const after = await countRows();
  assert.equal(after, before, 'not one navigation, filter, sort or page view was audited');
});

// ---------------------------------------------------------------------------
// 11. System health
// ---------------------------------------------------------------------------

test('system health reports a workflow role with no eligible approver', async () => {
  const c = await db();
  const clean = await systemHealth(asClient(c), NOW);
  const check = clean.checks.find((row) => row.key === 'workflow_roles_without_approver');
  assert.notEqual(check, undefined);
  assert.equal(check!.severity, 'BLOCKING');
  assert.equal(check!.rule.length > 40, true, 'every check states its rule');
  const before = check!.count;

  // THE EXACT SITUATION THE PHASE NAMES. The seed carries no Uganda workflow,
  // so build one: a Uganda sales order approval whose finance stage is
  // assigned to WROLE-SO-FIN. Uganda's holder of that role is WRA-003.
  await c.execute(`INSERT INTO workflow_definitions VALUES
    ('WFD-UG-SO','Uganda Sales Order Approval','SALES_ORDER','CTR-UG','AFF-UG',NULL,1,1,'2026-01-01',NULL)`);
  await c.execute(`INSERT INTO workflow_stages VALUES
    ('WST-UG-FIN','WFD-UG-SO','FINANCE_APPROVAL','Finance Approval',1,'WORKFLOW_ROLE',
     NULL,'WROLE-SO-FIN',NULL,'ANY_ONE',1,NULL,0)`);

  // While Uganda has a live holder, the stage is staffed and nothing is
  // reported. This half matters: a check that fires on a healthy system is a
  // check people learn to ignore.
  const staffed = await systemHealth(asClient(c), NOW);
  const staffedCheck = staffed.checks.find((row) => row.key === 'workflow_roles_without_approver');
  assert.equal(staffedCheck!.count, before, 'a staffed Uganda stage is not reported');

  // Now the authority ends, which is how this happens in real life: nobody
  // deletes anything, a date simply passes and the stage quietly has nobody.
  await c.execute(
    `UPDATE workflow_role_assignments SET effective_to = '2026-07-31'
      WHERE workflow_role_assignment_id = 'WRA-003'`,
  );

  const after = await systemHealth(asClient(c), NOW);
  const found = after.checks.find((row) => row.key === 'workflow_roles_without_approver');
  assert.notEqual(found, undefined);
  assert.equal(found!.count, before + 1, 'the unstaffed Uganda stage is reported');
  const example = found!.examples.find((row) => (row.detail ?? '').includes('Uganda'));
  assert.notEqual(example, undefined, 'with an example naming the workflow, so it is actionable');
  assert.equal(example!.detail, 'Uganda Sales Order Approval, stage Finance Approval');
});

test('a Kenya approver does not staff a Uganda stage', async () => {
  const c = await db();
  // The false reassurance this check exists to prevent: counting Gabriel, who
  // holds WROLE-SO-FIN for AFF-KE, as cover for a Uganda stage.
  await c.execute(`INSERT INTO workflow_definitions VALUES
    ('WFD-UG-SO','Uganda Sales Order Approval','SALES_ORDER','CTR-UG','AFF-UG',NULL,1,1,'2026-01-01',NULL)`);
  await c.execute(`INSERT INTO workflow_stages VALUES
    ('WST-UG-FIN','WFD-UG-SO','FINANCE_APPROVAL','Finance Approval',1,'WORKFLOW_ROLE',
     NULL,'WROLE-SO-FIN',NULL,'ANY_ONE',1,NULL,0)`);
  // Remove every Uganda and Group holder, leaving only the Kenya ones.
  await c.execute(`UPDATE workflow_role_assignments SET active = 0
      WHERE workflow_role_id = 'WROLE-SO-FIN'
        AND (affiliate_id <> 'AFF-KE' OR scope_type = 'GROUP')`);

  const health = await systemHealth(asClient(c), NOW);
  const found = health.checks.find((row) => row.key === 'workflow_roles_without_approver');
  assert.equal(
    found!.examples.some((row) => (row.detail ?? '').includes('Uganda')),
    true,
    'Gabriel holds the role but not in Uganda, so the stage has nobody',
  );
});

test('every health check states a rule and none of them invents a warning', async () => {
  const c = await db();
  const health = await systemHealth(asClient(c), NOW);
  assert.equal(health.checks.length >= 8, true);
  for (const check of health.checks) {
    assert.equal(check.rule.trim().length > 40, true, `${check.key} must state its rule`);
    assert.equal(
      ['BLOCKING', 'ATTENTION', 'INFORMATION'].includes(check.severity),
      true,
      `${check.key} must carry a severity`,
    );
    assert.equal(check.count >= 0, true);
    assert.equal(check.examples.length <= 10, true);
  }
  // There is no overall score anywhere in the shape.
  assert.equal(Object.keys(health).includes('score'), false);
  assert.equal(Object.keys(health).includes('percentage'), false);
});

test('a user with no organisational assignment is reported', async () => {
  const c = await db();
  await c.execute(`INSERT INTO users
      (user_id, user_type, employee_no, first_name, last_name, display_name, email,
       status, email_verified_at, created_at, updated_at)
    VALUES ('USR-ORPHAN','INTERNAL',NULL,'Unassigned','Person','Unassigned Person',
            'unassigned@hasspetroleum.example','ACTIVE','2026-08-01 08:00:00',
            CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`);
  const health = await systemHealth(asClient(c), NOW);
  const check = health.checks.find((row) => row.key === 'users_without_assignment');
  assert.notEqual(check, undefined);
  assert.equal(
    check!.examples.some((row) => row.id === 'USR-ORPHAN'),
    true,
  );
});

// ---------------------------------------------------------------------------
// 12. Access review and authority review
// ---------------------------------------------------------------------------

test('access review shows application access and approval authority as two blocks', async () => {
  const c = await db();
  // USR-GAB holds an access role AND approval authority in the seed, which is
  // exactly the person this screen exists for.
  const rows = await accessReview(asClient(c), TODAY, { userId: 'USR-GAB' });
  assert.equal(rows.length, 1);
  const gabriel = rows[0]!;

  assert.equal(gabriel.accessRoles.length >= 1, true, 'block one: what he can open');
  assert.equal(gabriel.approvalAuthority.length >= 1, true, 'block two: what he can approve');

  // THE TWO ARE NEVER MERGED. There is no combined list anywhere in the shape,
  // because the merge is the error this screen exists to prevent.
  const keys = Object.keys(gabriel);
  assert.equal(keys.includes('accessRoles'), true);
  assert.equal(keys.includes('approvalAuthority'), true);
  assert.equal(keys.includes('permissions'), false, 'no merged capability list');
  assert.equal(keys.includes('capabilities'), false);

  // The approval authority carries its scope and its rules, which is what
  // makes it authority rather than access.
  const authority = gabriel.approvalAuthority[0]!;
  assert.equal(authority.scopeType !== '', true);
  assert.equal(authority.scopeLabel !== '', true);
  assert.equal(authority.workflowRoleName !== '', true);
});

test('authority review answers who can approve Kenya sales order finance today in one query', async () => {
  const c = await db();
  const rows = await authorityReview(asClient(c), {
    processType: 'SALES_ORDER',
    countryId: 'CTR-KE',
    effectiveOn: TODAY,
  });

  const names = rows.map((row) => row.displayName);
  assert.equal(rows.length > 0, true, 'somebody can approve Kenya sales order finance');
  // Gabriel is the Kenya affiliate sales order finance approver in the seed.
  assert.equal(
    rows.some((row) => row.userId === 'USR-GAB'),
    true,
  );
  // The Uganda finance manager is NOT an answer to a Kenya question.
  assert.equal(
    rows.some((row) => row.userId === 'USR-FMUG'),
    false,
    `Uganda must not appear: got ${names.join(', ')}`,
  );
  // Every row states its scope and whether it is in force today.
  for (const row of rows) {
    assert.equal(row.effectiveToday, true);
    assert.equal(row.scopeLabel !== '', true);
  }
});

test('an expired assignment is not an answer to "who can approve today"', async () => {
  const c = await db();
  await c.execute(
    `UPDATE workflow_role_assignments SET effective_to = '2026-07-31'
      WHERE workflow_role_assignment_id = 'WRA-001'`,
  );
  const rows = await authorityReview(asClient(c), {
    processType: 'SALES_ORDER',
    countryId: 'CTR-KE',
    effectiveOn: TODAY,
  });
  assert.equal(
    rows.some((row) => row.assignmentId === 'WRA-001'),
    false,
  );
  // And asking without a date still finds it, so the history is not lost.
  const all = await authorityReview(asClient(c), { processType: 'SALES_ORDER' });
  assert.equal(
    all.some((row) => row.assignmentId === 'WRA-001'),
    true,
  );
});

test('role impact shows the permissions and everyone who holds the role', async () => {
  const c = await db();
  const impact = await roleImpact(asClient(c), 'ROLE-FIN');
  assert.notEqual(impact, null);
  assert.equal(impact!.roleName, 'Finance Manager');
  assert.equal(impact!.permissions.length > 0, true);
  assert.equal(
    impact!.permissions.some((row) => row.code === 'AUDIT.EVENTS.VIEW'),
    true,
  );
  assert.equal(impact!.holders.length > 0, true, 'nobody should search user by user');
  for (const holder of impact!.holders) {
    assert.equal(holder.displayName !== '', true);
    assert.equal(holder.status !== '', true);
  }
  assert.equal(await roleImpact(asClient(c), 'ROLE-DOES-NOT-EXIST'), null);
});

test('expiring authority reports days remaining and never extends anything', async () => {
  const c = await db();
  // Gabriel's Kenya sales order authority ends in twelve days.
  await c.execute(
    `UPDATE workflow_role_assignments SET effective_to = '2026-09-08'
      WHERE workflow_role_assignment_id = 'WRA-001'`,
  );
  const expiring = await expiringAuthority(asClient(c), NOW, 30);
  const found = expiring.find((row) => row.assignmentId === 'WRA-001');
  assert.notEqual(found, undefined);
  assert.equal(found!.daysRemaining, 12);
  assert.equal(found!.kind, 'APPROVAL_AUTHORITY');

  // Nothing was changed by reading it.
  const check = await c.execute(
    `SELECT effective_to FROM workflow_role_assignments WHERE workflow_role_assignment_id = 'WRA-001'`,
  );
  assert.equal(
    String((check.rows[0] as unknown as Record<string, unknown>).effective_to),
    '2026-09-08',
  );

  // Approval authority and access roles are labelled differently, because
  // losing a screen and losing the ability to approve are different problems.
  await c.execute(`UPDATE user_roles SET effective_to = '2026-09-01' WHERE user_id = 'USR-ZUL'`);
  const both = await expiringAuthority(asClient(c), NOW, 30);
  const kinds = new Set(both.map((row) => row.kind));
  assert.equal(kinds.has('APPROVAL_AUTHORITY'), true);
  assert.equal(kinds.has('ACCESS_ROLE'), true);
});
