/**
 * The customer account: scope, duplicates, and the single-primary-contact rule.
 *
 * Against the operator's own seed, so the countries, affiliates and users are
 * the configuration this product will run against.
 *
 * The permission rows PERM-031 to PERM-033 do not exist in the seed. They are
 * added by docs/cms/customers/02_add_customer_permissions.sql, which the
 * operator runs by hand, so `grantCustomerPermissions` below inserts exactly
 * what that script inserts. A test that granted something wider than the script
 * would prove nothing about the product as it will actually be configured.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, query, type TestClient } from './support/db.ts';
import { seedHass, SEED } from './support/hassSeed.ts';
import {
  ACCOUNT_COLUMNS,
  accountCounts,
  createAccount,
  createContact,
  findDuplicates,
  getAccount,
  listAccounts,
  primaryContactCount,
  scopedAccounts,
  updateAccount,
  updateContact,
  type AccountInput,
  type ContactInput,
} from '../../src/lib/cms/repos/accountAdmin.ts';
import { resolveScope, scopePredicate } from '../../src/lib/cms/auth/rbac.ts';
import { validateAccount, validateContact } from '../../src/lib/cms/admin/accountInput.ts';

const CTX = {
  actorUserId: SEED.admin,
  ip: '10.0.0.10',
  userAgent: 'HassCMS Test',
  now: new Date('2026-08-27T09:00:00Z'),
} as const;

const anyQuery = {
  search: '',
  accountType: null,
  status: null,
  countryId: null,
  affiliateId: null,
  segment: null,
  accountManagerUserId: null,
  page: 1,
  sort: 'name' as const,
};

/**
 * Exactly what docs/cms/customers/02_add_customer_permissions.sql does.
 *
 * Kept in step with the script by hand, which is why the script's own
 * verification SELECTs are quoted in it: if the two ever disagree, the numbers
 * the operator sees in the console will not match the numbers here.
 */
async function grantCustomerPermissions(c: TestClient): Promise<void> {
  await c.execute({
    sql: `INSERT OR IGNORE INTO permissions (permission_id, module_name, resource_name, action_name, description) VALUES
          ('PERM-031','CUSTOMERS','ACCOUNTS','VIEW','View customer accounts and their contacts'),
          ('PERM-032','CUSTOMERS','ACCOUNTS','MANAGE','Create and edit customer accounts and contacts'),
          ('PERM-033','CUSTOMERS','PORTAL_ACCESS','VIEW','See whether a contact holds customer portal access')`,
    args: [],
  });
  await c.execute({
    sql: `INSERT OR IGNORE INTO role_permissions (role_permission_id, role_id, permission_id, allowed, created_at)
          SELECT 'RP-ADMIN-' || permission_id, 'ROLE-ADMIN', permission_id, 1, CURRENT_TIMESTAMP
          FROM permissions WHERE permission_id IN ('PERM-031','PERM-032','PERM-033')`,
    args: [],
  });
  await c.execute({
    sql: `INSERT OR IGNORE INTO role_permissions (role_permission_id, role_id, permission_id, allowed, created_at) VALUES
          ('RP-CS-008','ROLE-CSM','PERM-031',1,CURRENT_TIMESTAMP),
          ('RP-CS-009','ROLE-CSM','PERM-032',1,CURRENT_TIMESTAMP),
          ('RP-SAL-006','ROLE-SALES','PERM-031',1,CURRENT_TIMESTAMP),
          ('RP-SAL-007','ROLE-SALES','PERM-032',1,CURRENT_TIMESTAMP),
          ('RP-FIN-006','ROLE-FIN','PERM-031',1,CURRENT_TIMESTAMP),
          ('RP-CRD-006','ROLE-CRD','PERM-031',1,CURRENT_TIMESTAMP),
          ('RP-CM-007','ROLE-CM','PERM-031',1,CURRENT_TIMESTAMP)`,
    args: [],
  });
}

const db = async (): Promise<TestClient> => {
  const c = createTestDb();
  await seedHass(c);
  await grantCustomerPermissions(c);
  // A Uganda account and an account with no affiliate, so the two negative
  // scope tests have something real to be refused.
  await c.execute({
    sql: `INSERT INTO accounts (account_id, account_code, account_name, account_type, country_id,
            affiliate_id, account_manager_user_id, status, created_at, updated_at)
          VALUES ('ACC-UG-001','CUST-UG-001','Kampala Haulage Ltd','CUSTOMER','CTR-UG','AFF-UG',
                  'USR-FMUG','ACTIVE','2026-01-01 00:00:00','2026-01-01 00:00:00')`,
    args: [],
  });
  await c.execute({
    sql: `INSERT INTO accounts (account_id, account_code, account_name, account_type, country_id,
            affiliate_id, account_manager_user_id, status, created_at, updated_at)
          VALUES ('ACC-ORPHAN','CUST-ORPHAN','Unassigned Holdings Ltd','PROSPECT','CTR-KE',
                  NULL,NULL,'ACTIVE','2026-01-01 00:00:00','2026-01-01 00:00:00')`,
    args: [],
  });
  return c;
};
const asClient = (c: TestClient) => c as unknown as Parameters<typeof listAccounts>[0];

const account = (over: Partial<AccountInput> = {}): AccountInput => ({
  accountName: 'Nyali Transporters Ltd',
  accountType: 'PROSPECT',
  accountCode: null,
  oracleCustomerCode: null,
  industry: null,
  segment: null,
  countryId: 'CTR-KE',
  affiliateId: 'AFF-KE',
  address: null,
  phone: null,
  email: null,
  website: null,
  taxPin: null,
  creditLimit: null,
  creditDays: null,
  accountManagerUserId: null,
  customerSince: null,
  status: 'ACTIVE',
  ...over,
});

const contact = (over: Partial<ContactInput> = {}): ContactInput => ({
  fullName: 'Aisha Karim',
  jobTitle: 'Procurement Lead',
  email: 'aisha.karim@nyali.example',
  phone: '+254700000001',
  whatsapp: null,
  preferredChannel: 'EMAIL',
  isPrimary: false,
  active: true,
  ...over,
});

// ---------------------------------------------------------------------------
// Criterion 4: a prospect with no Oracle code.
// ---------------------------------------------------------------------------

test('a prospect is created with no Oracle customer code and no account code', async () => {
  const c = await db();
  const made = await createAccount(asClient(c), account(), CTX);
  assert.equal(made.ok, true);
  if (!made.ok) return;

  assert.equal(made.value.accountType, 'PROSPECT');
  assert.equal(made.value.oracleCustomerCode, null);
  assert.equal(made.value.accountCode, null);

  const row = query(
    c,
    `SELECT account_name, account_type, oracle_customer_code, account_code
     FROM accounts WHERE account_id = ?`,
    made.value.accountId,
  )[0];
  assert.equal(row?.oracle_customer_code, null);
  assert.equal(row?.account_code, null);

  // And the validator does not require one either, for either type.
  const asCustomer = validateAccount({
    accountName: 'Direct Customer Ltd',
    accountType: 'CUSTOMER',
    countryId: 'CTR-KE',
  });
  assert.equal(asCustomer.ok, true);
  c.close();
});

// ---------------------------------------------------------------------------
// Criterion 5: a duplicate Oracle code is a field message.
// ---------------------------------------------------------------------------

test('a duplicate Oracle customer code is a conflict with a field message, never a crash', async () => {
  const c = await db();
  const first = await createAccount(
    asClient(c),
    account({ oracleCustomerCode: 'ORA-KE-9001' }),
    CTX,
  );
  assert.equal(first.ok, true);

  const second = await createAccount(
    asClient(c),
    account({ accountName: 'A different company', oracleCustomerCode: 'ORA-KE-9001' }),
    CTX,
  );
  assert.equal(second.ok, false);
  if (!second.ok) {
    assert.equal(second.kind, 'conflict');
    assert.equal(second.fields[0]?.field, 'oracleCustomerCode');
    assert.match(String(second.fields[0]?.message), /Oracle customer code/);
  }

  // The same for account_code, reported against its own field.
  await createAccount(asClient(c), account({ accountCode: 'CUST-9002' }), CTX);
  const clash = await createAccount(
    asClient(c),
    account({ accountName: 'Third company', accountCode: 'CUST-9002' }),
    CTX,
  );
  assert.equal(clash.ok, false);
  if (!clash.ok) assert.equal(clash.fields[0]?.field, 'accountCode');
  c.close();
});

// ---------------------------------------------------------------------------
// Criterion 6: an affiliate from a different country is rejected.
// ---------------------------------------------------------------------------

test('an affiliate whose country differs from the account country is refused', async () => {
  const c = await db();

  // AFF-UG sits in CTR-UG. The database accepts this pairing without complaint:
  // both foreign keys are satisfied and nothing relates them.
  const wrong = await createAccount(
    asClient(c),
    account({ countryId: 'CTR-KE', affiliateId: 'AFF-UG' }),
    CTX,
  );
  assert.equal(wrong.ok, false);
  if (!wrong.ok) {
    assert.equal(wrong.kind, 'invalid_reference');
    assert.equal(wrong.fields[0]?.field, 'affiliateId');
    assert.match(String(wrong.fields[0]?.message), /different country/);
  }

  // Proof the rule is not decorative: the same pairing inserted straight into
  // the table is accepted.
  await c.execute({
    sql: `INSERT INTO accounts (account_id, account_name, account_type, country_id, affiliate_id,
            status, created_at, updated_at)
          VALUES ('ACC-MISMATCH','Mismatched Ltd','PROSPECT','CTR-KE','AFF-UG','ACTIVE',
                  '2026-01-01 00:00:00','2026-01-01 00:00:00')`,
    args: [],
  });
  assert.equal(
    query(c, `SELECT COUNT(*) AS n FROM accounts WHERE account_id = 'ACC-MISMATCH'`)[0]?.n,
    1,
  );

  // The matching pairing is accepted through the repository.
  const right = await createAccount(
    asClient(c),
    account({ countryId: 'CTR-KE', affiliateId: 'AFF-KE' }),
    CTX,
  );
  assert.equal(right.ok, true);

  // And an update is checked the same way.
  if (right.ok) {
    const moved = await updateAccount(
      asClient(c),
      SEED.admin,
      right.value.accountId,
      account({ countryId: 'CTR-KE', affiliateId: 'AFF-TZ' }),
      CTX,
    );
    assert.equal(moved.ok, false);
  }
  c.close();
});

// ---------------------------------------------------------------------------
// Criterion 7: the duplicate check surfaces a match and merges nothing.
// ---------------------------------------------------------------------------

test('the duplicate check names what matched and merges nothing', async () => {
  const c = await db();
  const original = await createAccount(
    asClient(c),
    account({
      accountName: 'BluePeak Haulage Ltd',
      oracleCustomerCode: 'ORA-KE-7001',
      taxPin: 'P051234567X',
      email: 'accounts@bluepeak-haulage.example',
    }),
    CTX,
  );
  assert.equal(original.ok, true);
  if (!original.ok) return;

  const before = query(c, `SELECT COUNT(*) AS n FROM accounts`)[0]?.n;

  const candidates = await findDuplicates(asClient(c), SEED.admin, {
    accountName: 'BluePeak Haulage',
    oracleCustomerCode: null,
    taxPin: 'P051234567X',
    email: null,
    phone: null,
  });

  assert.equal(candidates.length >= 1, true);
  const match = candidates.find((entry) => entry.accountId === original.value.accountId);
  assert.notEqual(match, undefined);
  assert.deepEqual([...(match?.matchedOn ?? [])].sort(), ['a similar name', 'the same tax PIN']);

  // Nothing was written. The check reads and reports; a human decides.
  assert.equal(query(c, `SELECT COUNT(*) AS n FROM accounts`)[0]?.n, before);

  // And continuing anyway is allowed, because two similarly named companies in
  // one country are ordinary. The UNIQUE constraint is the hard stop, not this.
  const proceeded = await createAccount(
    asClient(c),
    account({ accountName: 'BluePeak Haulage Kenya Ltd' }),
    CTX,
  );
  assert.equal(proceeded.ok, true);
  c.close();
});

// ---------------------------------------------------------------------------
// Criterion 8: two primary contacts cannot exist.
// ---------------------------------------------------------------------------

test('an account never holds two primary contacts, including under a concurrent set', async () => {
  const c = await db();
  const made = await createAccount(asClient(c), account(), CTX);
  assert.equal(made.ok, true);
  if (!made.ok) return;
  const accountId = made.value.accountId;

  const first = await createContact(
    asClient(c),
    SEED.admin,
    accountId,
    contact({ fullName: 'Aisha Karim', isPrimary: true }),
    CTX,
  );
  assert.equal(first.ok, true);
  assert.equal(await primaryContactCount(asClient(c), accountId), 1);

  const second = await createContact(
    asClient(c),
    SEED.admin,
    accountId,
    contact({ fullName: 'Peter Njoroge', email: 'peter@nyali.example', isPrimary: true }),
    CTX,
  );
  assert.equal(second.ok, true);
  if (!second.ok || !first.ok) return;

  // Still exactly one, and it is the newer contact.
  assert.equal(await primaryContactCount(asClient(c), accountId), 1);
  const primary = query(
    c,
    `SELECT contact_id FROM contacts WHERE account_id = ? AND is_primary = 1`,
    accountId,
  );
  assert.equal(primary.length, 1);
  assert.equal(primary[0]?.contact_id, second.value.contactId);

  // Both contacts promoted, in both orders. The clear-then-set pair is
  // order-independent, so whichever transaction commits second wins outright
  // and the count is one either way.
  //
  // NOT a true concurrency test, and the difference is worth stating: this
  // harness is one synchronous node:sqlite connection, so two overlapping
  // `batch` calls raise "cannot start a transaction within a transaction"
  // rather than serialising the way libSQL does over HTTP. What is proved here
  // is that the pair is one transaction and that its outcome does not depend on
  // ordering, which is the property the invariant rests on. The interleaving
  // itself is the database's to guarantee, and it does: neither statement of
  // the pair is visible to another transaction until both commit.
  const promoteFirst = () =>
    updateContact(
      asClient(c),
      SEED.admin,
      first.value.contactId,
      contact({ fullName: 'Aisha Karim', isPrimary: true }),
      CTX,
    );
  const promoteSecond = () =>
    updateContact(
      asClient(c),
      SEED.admin,
      second.value.contactId,
      contact({ fullName: 'Peter Njoroge', email: 'peter@nyali.example', isPrimary: true }),
      CTX,
    );

  await promoteFirst();
  await promoteSecond();
  assert.equal(await primaryContactCount(asClient(c), accountId), 1);
  assert.equal(
    query(
      c,
      `SELECT contact_id FROM contacts WHERE account_id = ? AND is_primary = 1`,
      accountId,
    )[0]?.contact_id,
    second.value.contactId,
  );

  await promoteSecond();
  await promoteFirst();
  assert.equal(await primaryContactCount(asClient(c), accountId), 1);
  assert.equal(
    query(
      c,
      `SELECT contact_id FROM contacts WHERE account_id = ? AND is_primary = 1`,
      accountId,
    )[0]?.contact_id,
    first.value.contactId,
  );

  // Proof the database would not have stopped it: two direct updates leave two.
  await c.execute({
    sql: `UPDATE contacts SET is_primary = 1 WHERE account_id = ?`,
    args: [accountId],
  });
  assert.equal(await primaryContactCount(asClient(c), accountId), 2);
  c.close();
});

test('deactivating the primary contact clears the flag rather than leaving an unreachable primary', async () => {
  const c = await db();
  const made = await createAccount(asClient(c), account(), CTX);
  assert.equal(made.ok, true);
  if (!made.ok) return;

  const only = await createContact(
    asClient(c),
    SEED.admin,
    made.value.accountId,
    contact({ isPrimary: true }),
    CTX,
  );
  assert.equal(only.ok, true);
  if (!only.ok) return;

  const retired = await updateContact(
    asClient(c),
    SEED.admin,
    only.value.contactId,
    contact({ isPrimary: true, active: false }),
    CTX,
  );
  assert.equal(retired.ok, true);
  if (retired.ok) {
    assert.equal(retired.value.active, false);
    assert.equal(retired.value.isPrimary, false);
  }
  assert.equal(await primaryContactCount(asClient(c), made.value.accountId), 0);

  const audit = query(
    c,
    `SELECT event_type FROM audit_events WHERE event_type = 'CONTACT_DEACTIVATED'`,
  );
  assert.equal(audit.length, 1);
  c.close();
});

// ---------------------------------------------------------------------------
// Criteria 9, 10 and 11: scope.
// ---------------------------------------------------------------------------

/** Scope a user to one affiliate for the customer read, as the RBAC screens do. */
async function scopeToAffiliate(
  c: TestClient,
  userId: string,
  roleId: string,
  affiliateId: string,
): Promise<void> {
  const userRoleId = `UR-TEST-${userId}`;
  await c.execute({
    sql: `INSERT OR IGNORE INTO user_roles (user_role_id, user_id, role_id, effective_from,
            effective_to, assigned_by_user_id, active)
          VALUES (?, ?, ?, '2026-01-01', NULL, ?, 1)`,
    args: [userRoleId, userId, roleId, SEED.admin],
  });
  await c.execute({
    sql: `INSERT OR IGNORE INTO user_role_scopes (scope_id, user_role_id, scope_type,
            country_id, affiliate_id, business_unit_id, team_id)
          VALUES (?, ?, 'AFFILIATE', NULL, ?, NULL, NULL)`,
    args: [`URS-TEST-${userId}`, userRoleId, affiliateId],
  });
}

test('a Kenya-scoped user cannot retrieve a Uganda account, by list or by direct id', async () => {
  const c = await db();
  // ROLE-SALES holds PERM-031 through the data script. Gabriel is scoped to the
  // Kenya affiliate and to nothing else.
  await scopeToAffiliate(c, SEED.gabriel, 'ROLE-SALES', 'AFF-KE');

  const listed = await listAccounts(asClient(c), SEED.gabriel, anyQuery);
  const ids = listed.items.map((a) => a.accountId);
  assert.equal(ids.includes('ACC-UG-001'), false);
  assert.equal(ids.length > 0, true, 'the Kenya accounts should still be visible');

  // The direct fetch, which is the call curl makes. Empty, not a redirect and
  // not a different error from "no such account".
  const direct = await getAccount(asClient(c), SEED.gabriel, 'ACC-UG-001');
  assert.equal(direct, null);

  // And the account's owner does see it.
  await scopeToAffiliate(c, SEED.grace, 'ROLE-SALES', 'AFF-UG');
  const owner = await getAccount(asClient(c), SEED.grace, 'ACC-UG-001');
  assert.equal(owner?.accountName, 'Kampala Haulage Ltd');
  c.close();
});

test('an account with a null affiliate reaches no affiliate-scoped user', async () => {
  const c = await db();
  await scopeToAffiliate(c, SEED.gabriel, 'ROLE-SALES', 'AFF-KE');

  const listed = await listAccounts(asClient(c), SEED.gabriel, anyQuery);
  assert.equal(
    listed.items.some((a) => a.accountId === 'ACC-ORPHAN'),
    false,
  );
  assert.equal(await getAccount(asClient(c), SEED.gabriel, 'ACC-ORPHAN'), null);

  // The predicate says why: an explicit IS NOT NULL before the membership test.
  const resolution = await resolveScope(asClient(c), SEED.gabriel, 'CUSTOMERS.ACCOUNTS.VIEW');
  const predicate = scopePredicate(resolution, ACCOUNT_COLUMNS);
  assert.match(predicate.sql, /a\.affiliate_id IS NOT NULL AND a\.affiliate_id IN/);
  c.close();
});

test('TEAM and BUSINESS_UNIT scopes reach no account, because the table has neither column', async () => {
  const c = await db();
  const userRoleId = 'UR-TEST-BU';
  await c.execute({
    sql: `INSERT INTO user_roles (user_role_id, user_id, role_id, effective_from, effective_to,
            assigned_by_user_id, active) VALUES (?, ?, 'ROLE-SALES', '2026-01-01', NULL, ?, 1)`,
    args: [userRoleId, SEED.zuleika, SEED.admin],
  });
  await c.execute({
    sql: `INSERT INTO user_role_scopes (scope_id, user_role_id, scope_type, country_id,
            affiliate_id, business_unit_id, team_id)
          VALUES ('URS-TEST-BU', ?, 'BUSINESS_UNIT', NULL, NULL, 'BU-RET', NULL)`,
    args: [userRoleId],
  });

  // Granted the permission, scoped to a dimension accounts does not carry. The
  // resolver reports the grant and the predicate reaches nothing, which is
  // visible in the result rather than silently widening to everything.
  const resolution = await resolveScope(asClient(c), SEED.zuleika, 'CUSTOMERS.ACCOUNTS.VIEW');
  assert.equal(resolution.granted, true);
  const predicate = scopePredicate(resolution, ACCOUNT_COLUMNS);
  assert.equal(predicate.sql, '1 = 0');

  const listed = await listAccounts(asClient(c), SEED.zuleika, anyQuery);
  assert.equal(listed.items.length, 0);
  assert.equal(listed.total, 0);
  c.close();
});

test('the list and its total are counted through the same predicate', async () => {
  const c = await db();
  await scopeToAffiliate(c, SEED.gabriel, 'ROLE-SALES', 'AFF-KE');

  const scope = await scopedAccounts(asClient(c), SEED.gabriel);
  const listed = await listAccounts(asClient(c), SEED.gabriel, anyQuery);

  // The count the card would show, computed independently through the same
  // predicate. If the list filtered and the count did not, these differ and the
  // card advertises a record nobody can open.
  const counted = query(
    c,
    `SELECT COUNT(*) AS n FROM accounts a WHERE ${scope.sql}`,
    ...(scope.args as unknown[]),
  );
  assert.equal(Number(counted[0]?.n), listed.total);

  // And it is smaller than the unscoped truth, or the test proves nothing.
  const everything = query(c, `SELECT COUNT(*) AS n FROM accounts`)[0]?.n;
  assert.equal(listed.total < Number(everything), true);
  c.close();
});

test('an external portal user reads no internal account at all', async () => {
  const c = await db();
  // The five seeded external users hold ROLE-PORTAL, which the data script
  // grants none of the CUSTOMERS codes. A customer signing in to the portal
  // must not be able to read the internal customer list, and the check is that
  // no grant means DENY_ALL rather than an absent clause, because an absent
  // clause is WHERE 1=1.
  const external = SEED.external[0] as string;
  const scope = await scopedAccounts(asClient(c), external);
  assert.equal(scope.sql, '1 = 0');

  const listed = await listAccounts(asClient(c), external, anyQuery);
  assert.equal(listed.items.length, 0);
  assert.equal(listed.total, 0);
  assert.equal(await getAccount(asClient(c), external, 'ACC-001'), null);

  // Meanwhile an internal finance user does hold VIEW through ROLE-FIN, scoped
  // to their own affiliate. The contrast is the point: the denial above is
  // about holding no grant, not about the resolver failing to find anything.
  const financeScope = await scopedAccounts(asClient(c), SEED.neema);
  assert.notEqual(financeScope.sql, '1 = 0');
  assert.match(financeScope.sql, /a\.affiliate_id IS NOT NULL/);
  c.close();
});

// ---------------------------------------------------------------------------
// Criterion 12: the query count for opening an account.
// ---------------------------------------------------------------------------

test('opening an account issues a bounded number of queries, independent of its size', async () => {
  const c = await db();
  const made = await createAccount(asClient(c), account(), CTX);
  assert.equal(made.ok, true);
  if (!made.ok) return;

  for (let i = 0; i < 12; i++) {
    await createContact(
      asClient(c),
      SEED.admin,
      made.value.accountId,
      contact({ fullName: `Contact ${i}`, email: `c${i}@nyali.example` }),
      CTX,
    );
  }

  // getAccount is two statements (the scope resolution and the row) and
  // accountCounts is one. Three, whatever the account holds.
  let statements = 0;
  const counting = new Proxy(c, {
    get(target, property) {
      if (property === 'execute') {
        return (stmt: unknown) => {
          statements += 1;
          return target.execute(stmt as never);
        };
      }
      return Reflect.get(target, property) as unknown;
    },
  });

  const opened = await getAccount(asClient(counting), SEED.admin, made.value.accountId);
  const counts = await accountCounts(asClient(counting), made.value.accountId);
  assert.notEqual(opened, null);
  assert.equal(statements, 3);
  assert.equal(counts.contacts, 12);

  // The counts for modules that do not exist yet are null, never zero.
  assert.equal(counts.cases, null);
  assert.equal(counts.opportunities, null);
  assert.equal(counts.orders, null);
  assert.equal(counts.activities, null);
  c.close();
});

// ---------------------------------------------------------------------------
// Criterion 14: the nine audit event types.
// ---------------------------------------------------------------------------

test('all nine account audit event types are written with before and after state', async () => {
  const c = await db();
  const made = await createAccount(asClient(c), account(), CTX);
  assert.equal(made.ok, true);
  if (!made.ok) return;
  const accountId = made.value.accountId;

  // One update that changes the type, the status and the manager at once, so
  // each gets its own event beside the general update.
  const changed = await updateAccount(
    asClient(c),
    SEED.admin,
    accountId,
    account({
      accountType: 'CUSTOMER',
      status: 'BLOCKED',
      accountManagerUserId: SEED.james,
    }),
    CTX,
  );
  assert.equal(changed.ok, true);

  const first = await createContact(
    asClient(c),
    SEED.admin,
    accountId,
    contact({ isPrimary: true }),
    CTX,
  );
  assert.equal(first.ok, true);
  if (!first.ok) return;
  await updateContact(
    asClient(c),
    SEED.admin,
    first.value.contactId,
    contact({ jobTitle: 'Head of Procurement', isPrimary: true }),
    CTX,
  );
  await updateContact(
    asClient(c),
    SEED.admin,
    first.value.contactId,
    contact({ jobTitle: 'Head of Procurement', active: false }),
    CTX,
  );

  const written = query(c, `SELECT DISTINCT event_type FROM audit_events ORDER BY event_type`).map(
    (r) => String(r.event_type),
  );
  for (const expected of [
    'ACCOUNT_CREATED',
    'ACCOUNT_UPDATED',
    'ACCOUNT_TYPE_CHANGED',
    'ACCOUNT_STATUS_CHANGED',
    'ACCOUNT_MANAGER_CHANGED',
    'CONTACT_CREATED',
    'CONTACT_UPDATED',
    'CONTACT_DEACTIVATED',
    'PRIMARY_CONTACT_CHANGED',
  ]) {
    assert.equal(written.includes(expected), true, `${expected} was not written`);
  }

  // The type change carries both states, so what changed is readable without a
  // diff of the whole row.
  const typeChange = query(
    c,
    `SELECT before_json, after_json FROM audit_events WHERE event_type = 'ACCOUNT_TYPE_CHANGED'`,
  )[0];
  assert.match(String(typeChange?.before_json), /PROSPECT/);
  assert.match(String(typeChange?.after_json), /CUSTOMER/);

  const statusChange = query(
    c,
    `SELECT before_json, after_json FROM audit_events WHERE event_type = 'ACCOUNT_STATUS_CHANGED'`,
  )[0];
  assert.match(String(statusChange?.before_json), /ACTIVE/);
  assert.match(String(statusChange?.after_json), /BLOCKED/);

  // A create has no before state, which is honest rather than an empty object.
  const created = query(
    c,
    `SELECT before_json FROM audit_events WHERE event_type = 'ACCOUNT_CREATED'`,
  )[0];
  assert.equal(created?.before_json, null);

  // And every row names who did it.
  assert.equal(
    query(c, `SELECT COUNT(*) AS n FROM audit_events WHERE actor_user_id IS NULL`)[0]?.n,
    0,
  );
  c.close();
});

// ---------------------------------------------------------------------------
// The portal indicator, and the validators.
// ---------------------------------------------------------------------------

test('a contact whose preferred channel has no address is refused', () => {
  const noAddress = validateContact({
    fullName: 'Someone Real',
    preferredChannel: 'WHATSAPP',
  });
  assert.equal(noAddress.ok, false);
  if (!noAddress.ok) assert.equal(noAddress.errors[0]?.field, 'whatsapp');

  const withAddress = validateContact({
    fullName: 'Someone Real',
    preferredChannel: 'WHATSAPP',
    whatsapp: '+254700000002',
  });
  assert.equal(withAddress.ok, true);
});

test('an empty credit limit is null and not zero', () => {
  const blank = validateAccount({
    accountName: 'Nyali Transporters Ltd',
    accountType: 'PROSPECT',
    countryId: 'CTR-KE',
    creditLimit: '',
    creditDays: '',
  });
  assert.equal(blank.ok, true);
  if (blank.ok) {
    assert.equal(blank.value.creditLimit, null);
    assert.equal(blank.value.creditDays, null);
  }

  // A deliberate zero survives as a zero: this customer takes no credit.
  const explicit = validateAccount({
    accountName: 'Cash Only Ltd',
    accountType: 'CUSTOMER',
    countryId: 'CTR-KE',
    creditLimit: 0,
    creditDays: 0,
  });
  assert.equal(explicit.ok, true);
  if (explicit.ok) {
    assert.equal(explicit.value.creditLimit, 0);
    assert.equal(explicit.value.creditDays, 0);
  }
});
