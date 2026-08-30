/**
 * Build Prompt 39, section 5: the missing edit screens.
 *
 * An administrator could see customers and users and change neither. The
 * repositories behind both already existed and were correct; what was missing
 * was a screen, a route for the two unique codes, and the two behaviours those
 * codes need — a confirmation that states consequence, and a collision that
 * names the record already holding the value.
 *
 * WHAT IS ASSERTED HERE AND WHY IT IS ASSERTED AT THIS LEVEL. The write rules
 * are database rules, so they are tested against the mirrored live DDL rather
 * than against a mock: an email change that clears verification while leaving
 * the status at ACTIVE is a row `users` will not hold, and the only honest way
 * to prove the screen respects that is to make the database refuse it. The
 * screen-shape rules — no page description, no editable user id, a read-only
 * Roles tab — are properties of the source, so they are asserted against it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTestDb, query, type TestClient } from './support/db.ts';
import { seedHass, SEED } from './support/hassSeed.ts';
import {
  createAccount,
  oracleCodeUsage,
  updateAccount,
  type AccountInput,
} from '../../src/lib/cms/repos/accountAdmin.ts';
import {
  getUser,
  updateUser,
  STATUS_AFTER_EMAIL_CHANGE,
} from '../../src/lib/cms/repos/userAdmin.ts';

const client = (c: TestClient) => c as never;

const CTX = {
  actorUserId: SEED.admin,
  ip: '10.0.0.10',
  userAgent: 'HassCMS Test',
  now: new Date('2026-08-30T09:00:00Z'),
} as const;

const INVITATION = {
  tokenId: 'EVT-TEST-0001',
  tokenHash: 'not-a-real-hash',
  issuedAt: '2026-08-30 09:00:00',
  expiresAt: '2026-09-06 09:00:00',
  rawToken: 'test-only-token',
} as const;

const account = (over: Partial<AccountInput> = {}): AccountInput => ({
  accountName: 'Nyali Transporters Ltd',
  accountType: 'CUSTOMER',
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

/**
 * A database with the permission catalogue reconciled.
 *
 * THE OPERATOR'S OWN SCRIPT, RUN VERBATIM, rather than a hand-copy of what it
 * inserts. `updateAccount` resolves the caller's scope before it writes, so
 * without CUSTOMERS.ACCOUNTS.VIEW every test below would fail with `not_found`
 * — which is precisely the reported fault, and precisely why a test that
 * granted something wider than the script would prove nothing about the
 * product as it will actually be configured.
 */
async function db(): Promise<TestClient> {
  const c = createTestDb();
  await seedHass(c);
  const sql = readFileSync('docs/cms/permissions/12_reconcile_permission_catalogue.sql', 'utf8');
  const code = sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
  for (const statement of code.split(';')) {
    const trimmed = statement.trim();
    if (trimmed !== '') await c.execute(trimmed);
  }
  return c;
}

/* ---------------------------------------------------------------------------
 * The customer screen
 * ------------------------------------------------------------------------ */

test('a name, credit terms and account manager change, with a before and after', async () => {
  const c = await db();
  const made = await createAccount(client(c), account(), CTX);
  assert.ok(made.ok);
  const id = made.value.accountId;

  const saved = await updateAccount(
    client(c),
    SEED.admin,
    id,
    account({
      accountName: 'Nyali Transporters Limited',
      creditLimit: 2500000,
      creditDays: 45,
      accountManagerUserId: SEED.gabriel,
    }),
    CTX,
  );
  assert.ok(saved.ok);
  assert.equal(saved.value.accountName, 'Nyali Transporters Limited');
  assert.equal(saved.value.creditLimit, 2500000);
  assert.equal(saved.value.creditDays, 45);
  assert.equal(saved.value.accountManagerUserId, SEED.gabriel);

  const events = query(
    c,
    `SELECT event_type, before_json, after_json FROM audit_events
      WHERE entity_type = 'ACCOUNT' AND entity_id = ? ORDER BY audit_event_id`,
    id,
  );
  const updated = events.find((row) => row.event_type === 'ACCOUNT_UPDATED');
  assert.ok(updated, 'the change wrote no ACCOUNT_UPDATED event');
  // BEFORE AND AFTER, not just after. An audit row that records only the new
  // value cannot answer what was changed, only what it now is.
  const before = JSON.parse(String(updated.before_json)) as Record<string, unknown>;
  const after = JSON.parse(String(updated.after_json)) as Record<string, unknown>;
  assert.equal(before.accountName, 'Nyali Transporters Ltd');
  assert.equal(after.accountName, 'Nyali Transporters Limited');
  assert.equal(before.creditLimit, null);
  assert.equal(after.creditLimit, 2500000);
  // The manager change is its own event too, so finding it does not mean
  // diffing two blobs.
  assert.ok(events.some((row) => row.event_type === 'ACCOUNT_MANAGER_CHANGED'));
  c.close();
});

test('changing the Oracle customer code writes its own audit event', async () => {
  const c = await db();
  const made = await createAccount(client(c), account({ oracleCustomerCode: 'ORA-9001' }), CTX);
  assert.ok(made.ok);
  const id = made.value.accountId;

  const saved = await updateAccount(
    client(c),
    SEED.admin,
    id,
    account({ oracleCustomerCode: 'ORA-9002' }),
    CTX,
  );
  assert.ok(saved.ok);

  const events = query(
    c,
    `SELECT event_type, before_json, after_json FROM audit_events
      WHERE entity_type = 'ACCOUNT' AND entity_id = ? AND event_type = ?`,
    id,
    'ACCOUNT_ORACLE_CODE_CHANGED',
  );
  assert.equal(events.length, 1, 'the Oracle code change has no event of its own');
  assert.equal(JSON.parse(String(events[0]!.before_json)).oracleCustomerCode, 'ORA-9001');
  assert.equal(JSON.parse(String(events[0]!.after_json)).oracleCustomerCode, 'ORA-9002');
  c.close();
});

test('changing the account code writes its own audit event too', async () => {
  const c = await db();
  const made = await createAccount(client(c), account({ accountCode: 'CUST-1' }), CTX);
  assert.ok(made.ok);
  const saved = await updateAccount(
    client(c),
    SEED.admin,
    made.value.accountId,
    account({ accountCode: 'CUST-2' }),
    CTX,
  );
  assert.ok(saved.ok);
  assert.equal(
    query(
      c,
      `SELECT COUNT(*) AS n FROM audit_events WHERE entity_id = ? AND event_type = 'ACCOUNT_CODE_CHANGED'`,
      made.value.accountId,
    )[0]!.n,
    1,
  );
  c.close();
});

test('the confirmation states how many orders match the code', async () => {
  const c = await db();
  const made = await createAccount(client(c), account({ oracleCustomerCode: 'ORA-7000' }), CTX);
  assert.ok(made.ok);
  const id = made.value.accountId;

  // THE TWO NUMBERS ANSWER TWO DIFFERENT QUESTIONS, which is why both are
  // shown: orders are what belongs to the customer today, extract rows are
  // what the importer will match tomorrow.
  const empty = await oracleCodeUsage(client(c), id, 'ORA-7000');
  assert.deepEqual(empty, { orders: 0, extractRows: 0 });

  await c.execute({
    sql: `INSERT INTO sales_orders (sales_order_id, document_number, affiliate_id, account_id,
            order_created_at, status)
          VALUES ('SO-T1','DOC-T1','AFF-KE', ?, '2026-05-10 08:00:00','READY')`,
    args: [id],
  });
  const used = await oracleCodeUsage(client(c), id, 'ORA-7000');
  assert.equal(used.orders, 1, 'the confirmation would understate the change');
  c.close();
});

test('a duplicate Oracle code or account code names the account already holding it', async () => {
  const c = await db();
  const first = await createAccount(
    client(c),
    account({
      accountName: 'Bamburi Cement PLC',
      oracleCustomerCode: 'ORA-DUP',
      accountCode: 'AC-DUP',
    }),
    CTX,
  );
  assert.ok(first.ok);
  const second = await createAccount(
    client(c),
    account({ accountName: 'Second Company Ltd' }),
    CTX,
  );
  assert.ok(second.ok);

  // ORACLE CODE. Not "another account already holds that code", which tells
  // somebody they cannot proceed and nothing about what to do next.
  const onOracle = await updateAccount(
    client(c),
    SEED.admin,
    second.value.accountId,
    account({ accountName: 'Second Company Ltd', oracleCustomerCode: 'ORA-DUP' }),
    CTX,
  );
  assert.equal(onOracle.ok, false);
  if (onOracle.ok || onOracle.kind === 'not_found') return;
  assert.equal(onOracle.kind, 'conflict');
  const oracleField = onOracle.fields[0]!;
  assert.equal(oracleField.field, 'oracleCustomerCode');
  assert.match(oracleField.message, /Bamburi Cement PLC/);
  assert.match(oracleField.message, /ORA-DUP/);
  assert.equal(
    (oracleField as { holderAccountId?: string }).holderAccountId,
    first.value.accountId,
    'the message names the holder but the screen cannot link to it',
  );

  // ACCOUNT CODE. Same treatment, because it is unique for the same reason.
  const onCode = await updateAccount(
    client(c),
    SEED.admin,
    second.value.accountId,
    account({ accountName: 'Second Company Ltd', accountCode: 'AC-DUP' }),
    CTX,
  );
  assert.equal(onCode.ok, false);
  if (onCode.ok || onCode.kind === 'not_found') return;
  const codeField = onCode.fields[0]!;
  assert.equal(codeField.field, 'accountCode');
  assert.match(codeField.message, /Bamburi Cement PLC/);
  assert.equal((codeField as { holderAccountId?: string }).holderAccountId, first.value.accountId);
  c.close();
});

/* ---------------------------------------------------------------------------
 * The user screen
 * ------------------------------------------------------------------------ */

test('a name, email and employee number change, with audit rows', async () => {
  const c = await db();
  const before = await getUser(client(c), SEED.gabriel);
  assert.ok(before);

  const saved = await updateUser(
    client(c),
    SEED.gabriel,
    {
      firstName: 'Gabriel',
      lastName: 'Otieno',
      displayName: 'Gabriel O. Otieno',
      email: before.email,
      employeeNo: 'EMP-99001',
      phone: before.phone,
      timezone: before.timezone,
      locale: before.locale,
      status: before.status as 'ACTIVE',
    },
    INVITATION,
    CTX,
  );
  assert.ok(saved.ok);
  assert.equal(saved.value.user.displayName, 'Gabriel O. Otieno');
  assert.equal(saved.value.user.employeeNo, 'EMP-99001');
  assert.ok(
    query(
      c,
      `SELECT COUNT(*) AS n FROM audit_events WHERE entity_type = 'USER' AND entity_id = ?`,
      SEED.gabriel,
    )[0]!.n !== 0,
    'the change wrote no audit row',
  );
  c.close();
});

test('changing an email clears verification and moves the status in one operation', async () => {
  const c = await db();
  const before = await getUser(client(c), SEED.gabriel);
  assert.ok(before);
  assert.equal(before.status, 'ACTIVE');
  assert.ok(before.emailVerifiedAt !== null, 'the fixture should start verified');

  const saved = await updateUser(
    client(c),
    SEED.gabriel,
    {
      firstName: before.firstName,
      lastName: before.lastName,
      displayName: before.displayName,
      email: 'gabriel.otieno.new@hasspetroleum.com',
      employeeNo: before.employeeNo,
      phone: before.phone,
      timezone: before.timezone,
      locale: before.locale,
      // ACTIVE is ASKED FOR AND NOT HONOURED, deliberately: the table's CHECK
      // forbids an active account with an unverified address, so the write
      // decides the status rather than the caller.
      status: 'ACTIVE',
    },
    INVITATION,
    CTX,
  );
  assert.ok(saved.ok);
  assert.equal(saved.value.emailChanged, true);

  const row = query(
    c,
    `SELECT email, status, email_verified_at FROM users WHERE user_id = ?`,
    SEED.gabriel,
  )[0]!;
  assert.equal(row.email, 'gabriel.otieno.new@hasspetroleum.com');
  assert.equal(row.email_verified_at, null, 'verification was not cleared');
  assert.equal(row.status, STATUS_AFTER_EMAIL_CHANGE, 'the status did not move with it');
  // IN ONE OPERATION. If the two had been written in sequence the row would
  // have violated its own CHECK halfway, so a row that exists in this state at
  // all is the proof: the database would have refused a partial write.
  assert.notEqual(row.status, 'ACTIVE');
  c.close();
});

test('a duplicate email or employee number names the holder', async () => {
  const c = await db();
  const victim = await getUser(client(c), SEED.gabriel);
  const other = await getUser(client(c), SEED.victor);
  assert.ok(victim && other);

  const onEmail = await updateUser(
    client(c),
    SEED.gabriel,
    {
      firstName: victim.firstName,
      lastName: victim.lastName,
      displayName: victim.displayName,
      email: other.email,
      employeeNo: victim.employeeNo,
      phone: victim.phone,
      timezone: victim.timezone,
      locale: victim.locale,
      status: victim.status as 'ACTIVE',
    },
    INVITATION,
    CTX,
  );
  assert.equal(onEmail.ok, false);
  if (onEmail.ok || onEmail.kind === 'not_found') return;
  assert.equal(onEmail.fields[0]!.field, 'email');
  assert.match(onEmail.fields[0]!.message, new RegExp(other.displayName));

  if (other.employeeNo !== null) {
    const onEmployee = await updateUser(
      client(c),
      SEED.gabriel,
      {
        firstName: victim.firstName,
        lastName: victim.lastName,
        displayName: victim.displayName,
        email: victim.email,
        employeeNo: other.employeeNo,
        phone: victim.phone,
        timezone: victim.timezone,
        locale: victim.locale,
        status: victim.status as 'ACTIVE',
      },
      INVITATION,
      CTX,
    );
    assert.equal(onEmployee.ok, false);
    if (!onEmployee.ok && onEmployee.kind !== 'not_found') {
      assert.equal(onEmployee.fields[0]!.field, 'employeeNo');
      assert.match(onEmployee.fields[0]!.message, new RegExp(other.displayName));
    }
  }
  c.close();
});

/* ---------------------------------------------------------------------------
 * The screens themselves
 * ------------------------------------------------------------------------ */

const CUSTOMER_FORM = 'src/components/cms/CmsAccountEditForm.astro';
const CODES_FORM = 'src/components/cms/CmsAccountCodesForm.astro';
const USER_FORM = 'src/components/cms/CmsUserEditForm.astro';

test('user_id is not editable anywhere', () => {
  const source = readFileSync(USER_FORM, 'utf8');
  // NO INPUT AT ALL, which is a stronger guarantee than a disabled one: a
  // disabled field is one attribute away from being editable and a paragraph
  // is not.
  assert.ok(!/name="userId"|name='userId'/.test(source), 'the user form carries a userId field');
  assert.ok(!/id="u-userId"/.test(source), 'the user form carries a userId input');
  // And the payload cannot carry one either: it is built from the form's own
  // fields, and there is no field.
  const template = source.slice(0, source.indexOf('<script>'));
  assert.ok(!/<CmsInput[^>]*userId/i.test(template));
  // The user's own API route does not accept it either.
  const input = readFileSync('src/lib/cms/admin/userInput.ts', 'utf8');
  const update = input.slice(input.indexOf('export interface UpdateUserInput'));
  assert.ok(
    !/\buserId\b/.test(update.slice(0, update.indexOf('}'))),
    'UpdateUserInput has a userId',
  );
});

test('the Roles tab is still read-only from the edit form', () => {
  const source = readFileSync(USER_FORM, 'utf8');
  // Nothing in this form touches a role, which is also the simplest protection
  // against somebody editing their own access from a profile screen.
  assert.ok(!/role/i.test(source.slice(source.indexOf('<form'))) || !/name="role/i.test(source));
  assert.ok(!/api\/admin\/users\/[^']*\/roles/.test(source), 'the user form writes roles');
  // And the page says so where a reader can see it.
  const page = readFileSync('src/pages/cms/app/administration/users/[id].astro', 'utf8');
  assert.match(page, /The Roles tab stays read-only/);
});

test('neither screen carries a page description', () => {
  for (const path of [CUSTOMER_FORM, CODES_FORM, USER_FORM]) {
    const source = readFileSync(path, 'utf8');
    const template = source.slice(source.indexOf('---', 3) + 3, source.indexOf('<script>'));
    // A `description` prop passed to a header is the shape a page description
    // takes in this application. There is no header here and no prop to pass.
    assert.ok(!/description=/.test(template), `${path} passes a description`);
    assert.ok(!/<CmsPageHeader/.test(template), `${path} renders a page header of its own`);
  }
});

test('the two unique codes are not in the ordinary customer form', () => {
  // THE STRUCTURAL GUARANTEE. They cannot share a submit, so they cannot share
  // a confirmation, so the confirmation for a phone number can never become the
  // confirmation for the key the importer matches on.
  const source = readFileSync(CUSTOMER_FORM, 'utf8');
  const template = source.slice(0, source.indexOf('<script>'));
  assert.ok(!/name="oracleCustomerCode"/.test(template));
  assert.ok(!/name="accountCode"/.test(template));
  // And they ARE in their own form, which posts to its own route.
  const codes = readFileSync(CODES_FORM, 'utf8');
  assert.match(codes, /name="oracleCustomerCode"/);
  assert.match(codes, /name="accountCode"/);
  assert.match(codes, /\/identifiers/);
  // Which confirms before it writes.
  assert.match(codes, /cms-account-codes-confirm/);
});

test('the credit fields are absent, and said to be absent, without the permission', () => {
  const source = readFileSync(CUSTOMER_FORM, 'utf8');
  // A BLANK FIELD WOULD BE A FALSE STATEMENT about the business rather than a
  // true one about the reader's access.
  assert.match(source, /maySeeCreditTerms \? \(/);
  assert.match(source, /are recorded and are not shown to you/);
  // And the values are not sent, so a save cannot blank what it cannot show.
  assert.match(source, /!creditVisible && \(name === 'creditLimit' \|\| name === 'creditDays'\)/);
});
