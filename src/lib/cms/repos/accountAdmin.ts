/**
 * Reads and writes for the customer account, the spine of the whole product.
 *
 * ONE ACCOUNT TABLE
 * A company is created here and nowhere else. CRM, service, orders,
 * opportunities and the portal all reference `accounts.account_id`. There is no
 * per-module customer list and there must never be one, which is why lead
 * conversion in a later phase calls `createAccount` below rather than writing
 * its own insert.
 *
 * SCOPE COMES FROM THE BUILD PROMPT 07 RESOLVER
 * `resolveScope` and `scopePredicate` are called, never re-implemented. The
 * predicate goes into the WHERE clause of the list query, the count query and
 * the single-record read, so a count can never reveal a record the caller
 * cannot open. That is not a convention maintained by care: `scopedAccounts`
 * below is the only way any of them build their WHERE clause.
 *
 * WHAT THE DATABASE WILL NOT ENFORCE, AND THIS FILE DOES
 *   - `accounts` carries `country_id` and `affiliate_id` independently, so the
 *     database happily accepts a Kenya account under a Uganda affiliate.
 *   - `contacts.is_primary` is a plain flag with no constraint, so the database
 *     happily accepts two primary contacts on one account.
 * Both are enforced here, transactionally, and both are tested.
 */
import type { Client, InStatement } from '@libsql/client/web';
import type { FieldError } from '../../validation.ts';
import { newId, auditEventStmt } from './authRecords.ts';
import { toDbTimestamp } from '../auth/session.ts';
import type { WriteContext } from '../admin/guard.ts';
import {
  resolveScope,
  scopePredicate,
  DENY_ALL,
  type Predicate,
  type ScopedColumns,
} from '../auth/rbac.ts';
import { ACCOUNTS_VIEW } from '../permissions.ts';

type Stmt = Extract<InStatement, { sql: string }>;

/**
 * A field message that also names the record already holding a unique value.
 *
 * The extra fields are optional and carried on the shared `FieldError`
 * structurally rather than by widening it: a collision is the only place in the
 * product where the useful next action is "open the other record", and the
 * contact form on the marketing site has no business growing two fields for it.
 */
export interface ConflictFieldError extends FieldError {
  readonly holderAccountId?: string;
  readonly holderAccountName?: string;
}

export type WriteResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly kind: 'conflict'; readonly fields: FieldError[] }
  | { readonly ok: false; readonly kind: 'invalid_reference'; readonly fields: FieldError[] }
  | { readonly ok: false; readonly kind: 'not_found' };

const text = (v: unknown): string => String(v ?? '');
const nullableText = (v: unknown): string | null =>
  v === null || v === undefined ? null : String(v);
const nullableNumber = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v);
const isUnique = (e: unknown) =>
  /UNIQUE constraint failed/i.test(e instanceof Error ? e.message : String(e));
const isForeignKey = (e: unknown) =>
  /FOREIGN KEY constraint failed/i.test(e instanceof Error ? e.message : String(e));

function audit(
  ctx: WriteContext,
  eventType: string,
  entityType: string,
  entityId: string,
  action: string,
  before: unknown,
  after: unknown,
): Stmt {
  return auditEventStmt({
    actorUserId: ctx.actorUserId,
    eventType,
    entityType,
    entityId,
    action,
    beforeJson: before === null ? null : JSON.stringify(before),
    afterJson: after === null ? null : JSON.stringify(after),
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    now: ctx.now,
  }) as Stmt;
}

/** The audit event types this phase writes. Named once. */
export const ACCOUNT_AUDIT = {
  created: 'ACCOUNT_CREATED',
  updated: 'ACCOUNT_UPDATED',
  typeChanged: 'ACCOUNT_TYPE_CHANGED',
  statusChanged: 'ACCOUNT_STATUS_CHANGED',
  managerChanged: 'ACCOUNT_MANAGER_CHANGED',
  /**
   * THE ORACLE CODE GETS ITS OWN EVENT, AND SO DOES THE ACCOUNT CODE.
   *
   * The Oracle customer code is the key the importer matches an extract row on.
   * Changing it silently re-points every future import at a different account,
   * and the effect does not show up until the next extract lands. Finding out
   * when that happened must not mean diffing two JSON blobs inside an
   * ACCOUNT_UPDATED event among fifteen other fields, so it is its own row with
   * its own type, and the audit search finds it by name.
   */
  oracleCodeChanged: 'ACCOUNT_ORACLE_CODE_CHANGED',
  accountCodeChanged: 'ACCOUNT_CODE_CHANGED',
  contactCreated: 'CONTACT_CREATED',
  contactUpdated: 'CONTACT_UPDATED',
  contactDeactivated: 'CONTACT_DEACTIVATED',
  primaryContactChanged: 'PRIMARY_CONTACT_CHANGED',
} as const;

/**
 * The columns `accounts` offers the scope resolver.
 *
 * There is no `team` and no `businessUnit`, because the table has neither
 * column. A TEAM or BUSINESS_UNIT scope therefore contributes no branch and
 * reaches no account, which is the resolver's documented behaviour for a
 * dimension a module does not support.
 *
 * That is a deliberate choice not to derive access through related records. The
 * alternative, letting a business-unit scope reach an account because a lead in
 * that unit points at it, would mean the set of accounts a person can see
 * changes when somebody else creates a lead. Access that moves for reasons
 * outside the account is access nobody can reason about, and it cannot be
 * revoked by editing the account.
 *
 * `owner` is the account manager, which is what OWN means on this table.
 */
export const ACCOUNT_COLUMNS: ScopedColumns = {
  country: 'a.country_id',
  affiliate: 'a.affiliate_id',
  owner: 'a.account_manager_user_id',
};

/**
 * The predicate every account read runs through.
 *
 * One function, so the list, the counts and the single-record fetch cannot
 * drift apart. A caller who holds no grant at all gets DENY_ALL rather than an
 * absent clause, because an absent clause is `WHERE 1=1`.
 */
export async function scopedAccounts(db: Client, userId: string): Promise<Predicate> {
  const resolution = await resolveScope(db, userId, ACCOUNTS_VIEW);
  if (!resolution.granted) return DENY_ALL;
  return scopePredicate(resolution, ACCOUNT_COLUMNS);
}

// ---- reading -----------------------------------------------------------------

export interface AccountRow {
  accountId: string;
  accountCode: string | null;
  accountName: string;
  accountType: string;
  oracleCustomerCode: string | null;
  industry: string | null;
  segment: string | null;
  countryId: string;
  countryName: string;
  affiliateId: string | null;
  affiliateName: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  taxPin: string | null;
  creditLimit: number | null;
  creditDays: number | null;
  accountManagerUserId: string | null;
  accountManagerName: string | null;
  customerSince: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

const ACCOUNT_SELECT = `
  SELECT a.account_id, a.account_code, a.account_name, a.account_type,
         a.oracle_customer_code, a.industry, a.segment, a.country_id, c.country_name,
         a.affiliate_id, af.affiliate_name, a.address, a.phone, a.email, a.website,
         a.tax_pin, a.credit_limit, a.credit_days, a.account_manager_user_id,
         u.display_name AS manager_name, a.customer_since, a.status,
         a.created_at, a.updated_at
  FROM accounts a
  JOIN countries c ON c.country_id = a.country_id
  LEFT JOIN affiliates af ON af.affiliate_id = a.affiliate_id
  LEFT JOIN users u ON u.user_id = a.account_manager_user_id`;

function toAccount(row: Record<string, unknown>): AccountRow {
  return {
    accountId: text(row.account_id),
    accountCode: nullableText(row.account_code),
    accountName: text(row.account_name),
    accountType: text(row.account_type),
    oracleCustomerCode: nullableText(row.oracle_customer_code),
    industry: nullableText(row.industry),
    segment: nullableText(row.segment),
    countryId: text(row.country_id),
    countryName: text(row.country_name),
    affiliateId: nullableText(row.affiliate_id),
    affiliateName: nullableText(row.affiliate_name),
    address: nullableText(row.address),
    phone: nullableText(row.phone),
    email: nullableText(row.email),
    website: nullableText(row.website),
    taxPin: nullableText(row.tax_pin),
    creditLimit: nullableNumber(row.credit_limit),
    creditDays: nullableNumber(row.credit_days),
    accountManagerUserId: nullableText(row.account_manager_user_id),
    accountManagerName: nullableText(row.manager_name),
    customerSince: nullableText(row.customer_since),
    status: text(row.status),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

export const PAGE_SIZE = 25;

export interface AccountQuery {
  readonly search: string;
  readonly accountType: string | null;
  readonly status: string | null;
  readonly countryId: string | null;
  readonly affiliateId: string | null;
  readonly segment: string | null;
  readonly accountManagerUserId: string | null;
  readonly page: number;
  readonly sort: 'name' | 'created' | 'updated';
}

export interface AccountPage {
  items: AccountRow[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * Build the filter clause once, so the list and its count cannot disagree.
 *
 * Returned as a fragment plus args rather than interpolated, because every
 * value below reaches the database as a bound parameter. Nothing here
 * concatenates a value into SQL.
 */
function accountFilters(input: AccountQuery, scope: Predicate): { sql: string; args: unknown[] } {
  const where: string[] = [scope.sql];
  const args: unknown[] = [...scope.args];

  if (input.search.trim() !== '') {
    const needle = `%${input.search.trim()}%`;
    // COLLATE NOCASE on each comparison. `accounts.email` carries the collation
    // in its definition; account_name, account_code, oracle_customer_code,
    // tax_pin and phone do not, so relying on the column would make five of the
    // six case-sensitive and one not.
    where.push(`(a.account_name LIKE ? COLLATE NOCASE
             OR a.account_code LIKE ? COLLATE NOCASE
             OR a.oracle_customer_code LIKE ? COLLATE NOCASE
             OR a.tax_pin LIKE ? COLLATE NOCASE
             OR a.email LIKE ? COLLATE NOCASE
             OR a.phone LIKE ? COLLATE NOCASE)`);
    args.push(needle, needle, needle, needle, needle, needle);
  }
  const eq = (column: string, value: string | null) => {
    if (value === null || value === '') return;
    where.push(`${column} = ?`);
    args.push(value);
  };
  eq('a.account_type', input.accountType);
  eq('a.status', input.status);
  eq('a.country_id', input.countryId);
  eq('a.affiliate_id', input.affiliateId);
  eq('a.segment', input.segment);
  eq('a.account_manager_user_id', input.accountManagerUserId);

  return { sql: where.join(' AND '), args };
}

const ORDER_BY: Readonly<Record<AccountQuery['sort'], string>> = {
  name: 'a.account_name COLLATE NOCASE',
  created: 'a.created_at DESC',
  updated: 'a.updated_at DESC',
};

/**
 * The account list, filtered, searched, sorted and paginated in the database.
 *
 * The scope predicate is the first clause of the WHERE, always. Nothing is
 * fetched and then discarded, in the server or in the browser.
 */
export async function listAccounts(
  db: Client,
  userId: string,
  input: AccountQuery,
): Promise<AccountPage> {
  const scope = await scopedAccounts(db, userId);
  const filter = accountFilters(input, scope);
  const page = Math.max(1, input.page);

  const rows = await db.execute({
    sql: `${ACCOUNT_SELECT} WHERE ${filter.sql}
          ORDER BY ${ORDER_BY[input.sort]} LIMIT ? OFFSET ?`,
    args: [...filter.args, PAGE_SIZE, (page - 1) * PAGE_SIZE] as never[],
  });
  const counted = await db.execute({
    sql: `SELECT COUNT(*) AS total FROM accounts a
          JOIN countries c ON c.country_id = a.country_id
          LEFT JOIN affiliates af ON af.affiliate_id = a.affiliate_id
          LEFT JOIN users u ON u.user_id = a.account_manager_user_id
          WHERE ${filter.sql}`,
    args: filter.args as never[],
  });

  return {
    items: rows.rows.map((row) => toAccount(row as unknown as Record<string, unknown>)),
    total: Number(counted.rows[0]?.total ?? 0),
    page,
    pageSize: PAGE_SIZE,
  };
}

/**
 * One account, or null when it does not exist OR is out of scope.
 *
 * The two are deliberately indistinguishable to the caller. Returning 404 for
 * out of scope and 404 for absent means a probe cannot use the difference to
 * discover that a Uganda account exists.
 */
export async function getAccount(
  db: Client,
  userId: string,
  accountId: string,
): Promise<AccountRow | null> {
  const scope = await scopedAccounts(db, userId);
  const result = await db.execute({
    sql: `${ACCOUNT_SELECT} WHERE a.account_id = ? AND ${scope.sql} LIMIT 1`,
    args: [accountId, ...scope.args] as never[],
  });
  const row = result.rows[0];
  return row === undefined ? null : toAccount(row as unknown as Record<string, unknown>);
}

/**
 * The counts shown beside an account.
 *
 * WHAT IS COUNTED, AND WHAT IS DELIBERATELY NOT
 * Contacts and portal memberships exist, so they are counted. Cases,
 * opportunities, orders and activities are later phases and their tables are
 * not in this database yet, so they are `null`, and the interface reads "Not
 * available" rather than "0".
 *
 * That is section 0d applied where it is easiest to break: a zero here would be
 * a claim that this customer has no open cases, which is a statement about the
 * business. "Not built yet" and "none" are different facts and the difference
 * matters to whoever is about to block the account.
 */
export interface AccountCounts {
  contacts: number;
  activeContacts: number;
  portalMemberships: number;
  cases: number | null;
  opportunities: number | null;
  orders: number | null;
  activities: number | null;
}

export async function accountCounts(db: Client, accountId: string): Promise<AccountCounts> {
  const result = await db.execute({
    sql: `SELECT
            (SELECT COUNT(*) FROM contacts WHERE account_id = ?) AS contacts,
            (SELECT COUNT(*) FROM contacts WHERE account_id = ? AND active = 1) AS active_contacts,
            (SELECT COUNT(*) FROM customer_portal_memberships WHERE account_id = ?) AS portal`,
    args: [accountId, accountId, accountId],
  });
  const row = result.rows[0];
  return {
    contacts: Number(row?.contacts ?? 0),
    activeContacts: Number(row?.active_contacts ?? 0),
    portalMemberships: Number(row?.portal ?? 0),
    cases: null,
    opportunities: null,
    orders: null,
    activities: null,
  };
}

// ---- creating and editing ----------------------------------------------------

export interface AccountInput {
  accountName: string;
  accountType: string;
  accountCode: string | null;
  oracleCustomerCode: string | null;
  industry: string | null;
  segment: string | null;
  countryId: string;
  affiliateId: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  taxPin: string | null;
  creditLimit: number | null;
  creditDays: number | null;
  accountManagerUserId: string | null;
  customerSince: string | null;
  status: string;
}

/**
 * The affiliate must sit in the chosen country.
 *
 * `affiliates.country_id` exists, and `accounts` carries country and affiliate
 * as two independent columns with two independent foreign keys, so the database
 * accepts a Kenya account under a Uganda affiliate without complaint. Nothing
 * downstream would notice until a scope query returned a record to the wrong
 * country.
 */
async function checkAffiliate(
  db: Client,
  countryId: string,
  affiliateId: string | null,
): Promise<FieldError[]> {
  if (affiliateId === null) return [];
  const result = await db.execute({
    sql: `SELECT country_id FROM affiliates WHERE affiliate_id = ? LIMIT 1`,
    args: [affiliateId],
  });
  const row = result.rows[0];
  if (row === undefined) {
    return [{ field: 'affiliateId', message: 'That affiliate does not exist.' }];
  }
  if (text(row.country_id) !== countryId) {
    return [
      {
        field: 'affiliateId',
        message: 'That affiliate belongs to a different country from the one selected.',
      },
    ];
  }
  return [];
}

/**
 * Accounts that look like the one about to be created.
 *
 * Five signals, each an exact match except the name. Returned for a human to
 * judge; nothing here merges anything, and nothing here blocks the create. The
 * UNIQUE constraints on `account_code` and `oracle_customer_code` are the hard
 * stop, and they surface as a field message rather than a 500.
 *
 * Scope-filtered like every other read: a duplicate check must not become a way
 * to confirm that a customer exists in a country the caller cannot see. The
 * consequence is honest and worth stating on screen: a caller may create a
 * duplicate of a record they are not allowed to know about, and the UNIQUE
 * constraint is what catches the case that actually matters.
 */
export interface DuplicateCandidate {
  accountId: string;
  accountName: string;
  accountCode: string | null;
  oracleCustomerCode: string | null;
  status: string;
  matchedOn: string[];
}

export async function findDuplicates(
  db: Client,
  userId: string,
  input: {
    accountName: string;
    oracleCustomerCode: string | null;
    taxPin: string | null;
    email: string | null;
    phone: string | null;
  },
): Promise<DuplicateCandidate[]> {
  const scope = await scopedAccounts(db, userId);
  const name = input.accountName.trim();
  if (name === '') return [];

  const result = await db.execute({
    sql: `SELECT a.account_id, a.account_name, a.account_code, a.oracle_customer_code, a.status,
                 a.tax_pin, a.email, a.phone
          FROM accounts a
          WHERE ${scope.sql}
            AND (a.account_name LIKE ? COLLATE NOCASE
              OR (? IS NOT NULL AND a.oracle_customer_code = ?)
              OR (? IS NOT NULL AND a.tax_pin = ?)
              OR (? IS NOT NULL AND a.email = ?)
              OR (? IS NOT NULL AND a.phone = ?))
          ORDER BY a.account_name COLLATE NOCASE
          LIMIT 10`,
    args: [
      ...scope.args,
      `%${name}%`,
      input.oracleCustomerCode,
      input.oracleCustomerCode,
      input.taxPin,
      input.taxPin,
      input.email,
      input.email,
      input.phone,
      input.phone,
    ] as never[],
  });

  return result.rows.map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    const matchedOn: string[] = [];
    if (text(row.account_name).toLowerCase().includes(name.toLowerCase())) {
      matchedOn.push('a similar name');
    }
    if (
      input.oracleCustomerCode !== null &&
      nullableText(row.oracle_customer_code) === input.oracleCustomerCode
    ) {
      matchedOn.push('the same Oracle customer code');
    }
    if (input.taxPin !== null && nullableText(row.tax_pin) === input.taxPin) {
      matchedOn.push('the same tax PIN');
    }
    if (
      input.email !== null &&
      nullableText(row.email)?.toLowerCase() === input.email.toLowerCase()
    ) {
      matchedOn.push('the same email address');
    }
    if (input.phone !== null && nullableText(row.phone) === input.phone) {
      matchedOn.push('the same phone number');
    }
    return {
      accountId: text(row.account_id),
      accountName: text(row.account_name),
      accountCode: nullableText(row.account_code),
      oracleCustomerCode: nullableText(row.oracle_customer_code),
      status: text(row.status),
      matchedOn,
    };
  });
}

/**
 * A collision names the account already holding the value.
 *
 * "Another account already holds that code" tells somebody they cannot proceed
 * and nothing about what to do next. Nine times in ten the holder is the record
 * they actually meant to edit, or a duplicate somebody created last year, and
 * either way the next action is to open it. So the message names it and the
 * screen links to it.
 *
 * The lookup is deliberately UNSCOPED, and the consequence is stated rather
 * than hidden: a caller may be told the name of an account in a country they
 * cannot otherwise see. The alternative is refusing the write while claiming
 * nothing holds the code, which is a lie the person cannot act on and which
 * sends them to an administrator to find out what the database already told
 * the database. A unique key is a global fact about the system; concealing who
 * holds it does not conceal that somebody does.
 */
async function accountConflict(
  db: Client,
  input: AccountInput,
  error: unknown,
): Promise<ConflictFieldError> {
  const message = error instanceof Error ? error.message : '';
  const onOracle = /oracle_customer_code/i.test(message);
  const field = onOracle ? 'oracleCustomerCode' : 'accountCode';
  const column = onOracle ? 'oracle_customer_code' : 'account_code';
  const value = onOracle ? input.oracleCustomerCode : input.accountCode;
  const label = onOracle ? 'Oracle customer code' : 'account code';
  if (value === null) return { field, message: `Another account already holds that ${label}.` };
  const found = await db.execute({
    sql: `SELECT account_id, account_name FROM accounts WHERE ${column} = ? LIMIT 1`,
    args: [value],
  });
  const row = found.rows[0];
  if (row === undefined) return { field, message: `Another account already holds that ${label}.` };
  return {
    field,
    message: `${text(row.account_name)} already holds the ${label} ${value}.`,
    holderAccountId: text(row.account_id),
    holderAccountName: text(row.account_name),
  };
}

/**
 * How many orders currently match an Oracle customer code.
 *
 * TWO COUNTS, BECAUSE THEY ANSWER TWO DIFFERENT QUESTIONS. `orders` is how many
 * sales orders belong to the account today, which is what stops pointing at
 * this customer if the code moves. `extractRows` is how many rows of imported
 * extract carry the code literally, which is what the importer matches on and
 * therefore what will be re-pointed by the NEXT import. A code with no orders
 * and four hundred extract rows is still a consequential change, and a
 * confirmation that showed only the first number would say it was safe.
 */
export interface OracleCodeUsage {
  readonly orders: number;
  readonly extractRows: number;
}

export async function oracleCodeUsage(
  db: Client,
  accountId: string,
  code: string | null,
): Promise<OracleCodeUsage> {
  const [orders, rows] = await Promise.all([
    db.execute({
      sql: `SELECT COUNT(*) AS n FROM sales_orders WHERE account_id = ?`,
      args: [accountId],
    }),
    code === null
      ? Promise.resolve({ rows: [{ n: 0 }] })
      : db.execute({
          sql: `SELECT COUNT(*) AS n FROM so_extract_rows WHERE customer_code = ?`,
          args: [code],
        }),
  ]);
  return {
    orders: Number((orders.rows[0] as Record<string, unknown>)?.n ?? 0),
    extractRows: Number((rows.rows[0] as Record<string, unknown>)?.n ?? 0),
  };
}

export async function createAccount(
  db: Client,
  input: AccountInput,
  ctx: WriteContext,
): Promise<WriteResult<AccountRow>> {
  const problems = await checkAffiliate(db, input.countryId, input.affiliateId);
  if (problems.length > 0) return { ok: false, kind: 'invalid_reference', fields: problems };

  const id = newId('ACC');
  const now = toDbTimestamp(ctx.now);
  try {
    await db.batch(
      [
        {
          sql: `INSERT INTO accounts
                  (account_id, account_code, account_name, account_type, oracle_customer_code,
                   industry, segment, country_id, affiliate_id, address, phone, email, website,
                   tax_pin, credit_limit, credit_days, account_manager_user_id, customer_since,
                   status, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            id,
            input.accountCode,
            input.accountName,
            input.accountType,
            input.oracleCustomerCode,
            input.industry,
            input.segment,
            input.countryId,
            input.affiliateId,
            input.address,
            input.phone,
            input.email,
            input.website,
            input.taxPin,
            input.creditLimit,
            input.creditDays,
            input.accountManagerUserId,
            input.customerSince,
            input.status,
            now,
            now,
          ],
        },
        audit(ctx, ACCOUNT_AUDIT.created, 'ACCOUNT', id, 'CREATE', null, input),
      ],
      'write',
    );
  } catch (error) {
    if (isUnique(error)) {
      return { ok: false, kind: 'conflict', fields: [await accountConflict(db, input, error)] };
    }
    if (isForeignKey(error)) {
      return {
        ok: false,
        kind: 'invalid_reference',
        fields: [
          {
            field: 'countryId',
            message: 'That country, affiliate or account manager does not exist.',
          },
        ],
      };
    }
    throw error;
  }
  const created = await getAccountUnscoped(db, id);
  return created === null ? { ok: false, kind: 'not_found' } : { ok: true, value: created };
}

/**
 * Read back a row the caller has just written.
 *
 * Unscoped on purpose, and used for exactly that. A create is authorised before
 * it happens; refusing to return the row afterwards because the new account
 * sits outside the author's read scope would fail a write that already
 * succeeded. Every other read in this file is scoped.
 */
async function getAccountUnscoped(db: Client, accountId: string): Promise<AccountRow | null> {
  const result = await db.execute({
    sql: `${ACCOUNT_SELECT} WHERE a.account_id = ? LIMIT 1`,
    args: [accountId],
  });
  const row = result.rows[0];
  return row === undefined ? null : toAccount(row as unknown as Record<string, unknown>);
}

/**
 * Update an account, writing one audit row per thing that actually changed.
 *
 * Type, status and account manager each get their own event beside the general
 * update, because each is a different question somebody asks the trail later:
 * when did this prospect become a customer, when was this account blocked, and
 * who owned it in March. Folding all three into ACCOUNT_UPDATED would make
 * every one of those a JSON diff hunt.
 */
export async function updateAccount(
  db: Client,
  userId: string,
  accountId: string,
  input: AccountInput,
  ctx: WriteContext,
): Promise<WriteResult<AccountRow>> {
  const before = await getAccount(db, userId, accountId);
  if (before === null) return { ok: false, kind: 'not_found' };

  const problems = await checkAffiliate(db, input.countryId, input.affiliateId);
  if (problems.length > 0) return { ok: false, kind: 'invalid_reference', fields: problems };

  const statements: Stmt[] = [
    {
      sql: `UPDATE accounts
            SET account_code = ?, account_name = ?, account_type = ?, oracle_customer_code = ?,
                industry = ?, segment = ?, country_id = ?, affiliate_id = ?, address = ?,
                phone = ?, email = ?, website = ?, tax_pin = ?, credit_limit = ?,
                credit_days = ?, account_manager_user_id = ?, customer_since = ?, status = ?,
                updated_at = ?
            WHERE account_id = ?`,
      args: [
        input.accountCode,
        input.accountName,
        input.accountType,
        input.oracleCustomerCode,
        input.industry,
        input.segment,
        input.countryId,
        input.affiliateId,
        input.address,
        input.phone,
        input.email,
        input.website,
        input.taxPin,
        input.creditLimit,
        input.creditDays,
        input.accountManagerUserId,
        input.customerSince,
        input.status,
        toDbTimestamp(ctx.now),
        accountId,
      ],
    },
    audit(ctx, ACCOUNT_AUDIT.updated, 'ACCOUNT', accountId, 'UPDATE', before, input),
  ];

  if (before.accountType !== input.accountType) {
    statements.push(
      audit(
        ctx,
        ACCOUNT_AUDIT.typeChanged,
        'ACCOUNT',
        accountId,
        'TYPE_CHANGE',
        {
          accountType: before.accountType,
        },
        { accountType: input.accountType },
      ),
    );
  }
  if (before.status !== input.status) {
    statements.push(
      audit(
        ctx,
        ACCOUNT_AUDIT.statusChanged,
        'ACCOUNT',
        accountId,
        'STATUS_CHANGE',
        {
          status: before.status,
        },
        { status: input.status },
      ),
    );
  }
  if (before.oracleCustomerCode !== input.oracleCustomerCode) {
    statements.push(
      audit(
        ctx,
        ACCOUNT_AUDIT.oracleCodeChanged,
        'ACCOUNT',
        accountId,
        'ORACLE_CODE_CHANGE',
        { oracleCustomerCode: before.oracleCustomerCode },
        { oracleCustomerCode: input.oracleCustomerCode },
      ),
    );
  }
  if (before.accountCode !== input.accountCode) {
    statements.push(
      audit(
        ctx,
        ACCOUNT_AUDIT.accountCodeChanged,
        'ACCOUNT',
        accountId,
        'ACCOUNT_CODE_CHANGE',
        { accountCode: before.accountCode },
        { accountCode: input.accountCode },
      ),
    );
  }
  if (before.accountManagerUserId !== input.accountManagerUserId) {
    statements.push(
      audit(
        ctx,
        ACCOUNT_AUDIT.managerChanged,
        'ACCOUNT',
        accountId,
        'MANAGER_CHANGE',
        {
          accountManagerUserId: before.accountManagerUserId,
        },
        { accountManagerUserId: input.accountManagerUserId },
      ),
    );
  }

  try {
    await db.batch(statements, 'write');
  } catch (error) {
    if (isUnique(error)) {
      return { ok: false, kind: 'conflict', fields: [await accountConflict(db, input, error)] };
    }
    if (isForeignKey(error)) {
      return {
        ok: false,
        kind: 'invalid_reference',
        fields: [
          {
            field: 'countryId',
            message: 'That country, affiliate or account manager does not exist.',
          },
        ],
      };
    }
    throw error;
  }
  const after = await getAccountUnscoped(db, accountId);
  return after === null ? { ok: false, kind: 'not_found' } : { ok: true, value: after };
}

// ---- contacts ----------------------------------------------------------------

export interface ContactRow {
  contactId: string;
  accountId: string;
  fullName: string;
  jobTitle: string | null;
  email: string | null;
  phone: string | null;
  whatsapp: string | null;
  preferredChannel: string | null;
  isPrimary: boolean;
  active: boolean;
  createdAt: string;
  /**
   * The portal state, or null when the contact has no membership.
   *
   * Populated only for a caller holding CUSTOMERS.PORTAL_ACCESS.VIEW. The
   * filtering happens in the query, not in the template: a value that reaches
   * the response body has leaked, whatever the interface does with it.
   */
  portalStatus: string | null;
}

function toContact(row: Record<string, unknown>): ContactRow {
  return {
    contactId: text(row.contact_id),
    accountId: text(row.account_id),
    fullName: text(row.full_name),
    jobTitle: nullableText(row.job_title),
    email: nullableText(row.email),
    phone: nullableText(row.phone),
    whatsapp: nullableText(row.whatsapp),
    preferredChannel: nullableText(row.preferred_channel),
    isPrimary: Number(row.is_primary ?? 0) === 1,
    active: Number(row.active ?? 0) === 1,
    createdAt: text(row.created_at),
    portalStatus: nullableText(row.portal_status),
  };
}

/**
 * The contacts of one account, with the portal indicator where permitted.
 *
 * `includePortal` decides whether the membership is joined at all. When it is
 * false the column is a literal NULL, so the response body cannot carry a
 * portal state to a caller who may not see one. Hiding it in the template would
 * leave it in the JSON.
 *
 * A portal membership is matched to a contact by email, because
 * `customer_portal_memberships` links a `user_id` to an `account_id` and
 * carries no contact reference. That is stated rather than hidden: it is the
 * only join the schema supports, and a contact with no email therefore never
 * shows an indicator even when the person has portal access.
 */
export async function listContacts(
  db: Client,
  userId: string,
  accountId: string,
  includePortal: boolean,
): Promise<ContactRow[] | null> {
  const account = await getAccount(db, userId, accountId);
  if (account === null) return null;

  const portalColumn = includePortal
    ? `(SELECT m.status FROM customer_portal_memberships m
        JOIN users pu ON pu.user_id = m.user_id
        WHERE m.account_id = ct.account_id AND ct.email IS NOT NULL
          AND pu.email = ct.email LIMIT 1)`
    : `NULL`;

  const result = await db.execute({
    sql: `SELECT ct.contact_id, ct.account_id, ct.full_name, ct.job_title, ct.email, ct.phone,
                 ct.whatsapp, ct.preferred_channel, ct.is_primary, ct.active, ct.created_at,
                 ${portalColumn} AS portal_status
          FROM contacts ct
          WHERE ct.account_id = ?
          ORDER BY ct.is_primary DESC, ct.active DESC, ct.full_name COLLATE NOCASE`,
    args: [accountId],
  });
  return result.rows.map((row) => toContact(row as unknown as Record<string, unknown>));
}

export async function getContact(db: Client, contactId: string): Promise<ContactRow | null> {
  const result = await db.execute({
    sql: `SELECT contact_id, account_id, full_name, job_title, email, phone, whatsapp,
                 preferred_channel, is_primary, active, created_at, NULL AS portal_status
          FROM contacts WHERE contact_id = ? LIMIT 1`,
    args: [contactId],
  });
  const row = result.rows[0];
  return row === undefined ? null : toContact(row as unknown as Record<string, unknown>);
}

export interface ContactInput {
  fullName: string;
  jobTitle: string | null;
  email: string | null;
  phone: string | null;
  whatsapp: string | null;
  preferredChannel: string | null;
  isPrimary: boolean;
  active: boolean;
}

/**
 * The two statements that keep exactly one primary contact on an account.
 *
 * Clear every other primary, then set this one. Emitted together so a caller
 * can only ever put them in the same batch, and therefore the same transaction.
 *
 * The database will not do this. `contacts.is_primary` is a plain INTEGER with
 * a CHECK on the value and nothing at all on how many rows may hold a 1, so two
 * simultaneous requests each doing a naive UPDATE leave two primaries and
 * nothing complains.
 *
 * Written as clear-then-set rather than swap-if-different because the invariant
 * survives either ordering: whichever of two concurrent transactions commits
 * second clears the first one's winner and sets its own, so the final state is
 * exactly one primary either way. A test runs both and counts the rows.
 */
function primaryStatements(accountId: string, contactId: string): Stmt[] {
  return [
    {
      sql: `UPDATE contacts SET is_primary = 0
            WHERE account_id = ? AND contact_id <> ? AND is_primary = 1`,
      args: [accountId, contactId],
    },
    {
      sql: `UPDATE contacts SET is_primary = 1 WHERE contact_id = ?`,
      args: [contactId],
    },
  ];
}

export async function createContact(
  db: Client,
  userId: string,
  accountId: string,
  input: ContactInput,
  ctx: WriteContext,
): Promise<WriteResult<ContactRow>> {
  const account = await getAccount(db, userId, accountId);
  if (account === null) return { ok: false, kind: 'not_found' };

  const id = newId('CON');
  const statements: Stmt[] = [
    {
      sql: `INSERT INTO contacts
              (contact_id, account_id, full_name, job_title, email, phone, whatsapp,
               preferred_channel, is_primary, active, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      args: [
        id,
        accountId,
        input.fullName,
        input.jobTitle,
        input.email,
        input.phone,
        input.whatsapp,
        input.preferredChannel,
        input.active ? 1 : 0,
        toDbTimestamp(ctx.now),
      ],
    },
  ];

  // Inserted with is_primary = 0 and promoted in the same batch, so the
  // clear-then-set pair runs identically whether the contact is new or existing.
  if (input.isPrimary) {
    statements.push(...primaryStatements(accountId, id));
    statements.push(
      audit(
        ctx,
        ACCOUNT_AUDIT.primaryContactChanged,
        'ACCOUNT',
        accountId,
        'PRIMARY_CONTACT',
        null,
        {
          contactId: id,
          fullName: input.fullName,
        },
      ),
    );
  }
  statements.push(
    audit(ctx, ACCOUNT_AUDIT.contactCreated, 'CONTACT', id, 'CREATE', null, {
      ...input,
      accountId,
    }),
  );

  try {
    await db.batch(statements, 'write');
  } catch (error) {
    if (isForeignKey(error)) {
      return {
        ok: false,
        kind: 'invalid_reference',
        fields: [{ field: 'accountId', message: 'That account does not exist.' }],
      };
    }
    throw error;
  }
  const created = await getContact(db, id);
  return created === null ? { ok: false, kind: 'not_found' } : { ok: true, value: created };
}

export async function updateContact(
  db: Client,
  userId: string,
  contactId: string,
  input: ContactInput,
  ctx: WriteContext,
): Promise<WriteResult<ContactRow>> {
  const before = await getContact(db, contactId);
  if (before === null) return { ok: false, kind: 'not_found' };

  // A contact id is not an access grant. The account behind it decides.
  const account = await getAccount(db, userId, before.accountId);
  if (account === null) return { ok: false, kind: 'not_found' };

  const deactivating = before.active && !input.active;
  const statements: Stmt[] = [
    {
      sql: `UPDATE contacts
            SET full_name = ?, job_title = ?, email = ?, phone = ?, whatsapp = ?,
                preferred_channel = ?, active = ?
            WHERE contact_id = ?`,
      args: [
        input.fullName,
        input.jobTitle,
        input.email,
        input.phone,
        input.whatsapp,
        input.preferredChannel,
        input.active ? 1 : 0,
        contactId,
      ],
    },
  ];

  // A deactivated contact cannot stay primary: the rule is one primary ACTIVE
  // contact, and leaving the flag on a dormant row would make the account
  // appear to have a primary nobody can reach.
  if (input.isPrimary && input.active) {
    statements.push(...primaryStatements(before.accountId, contactId));
    if (!before.isPrimary) {
      statements.push(
        audit(
          ctx,
          ACCOUNT_AUDIT.primaryContactChanged,
          'ACCOUNT',
          before.accountId,
          'PRIMARY_CONTACT',
          {
            contactId: null,
          },
          { contactId, fullName: input.fullName },
        ),
      );
    }
  } else if (before.isPrimary) {
    statements.push({
      sql: `UPDATE contacts SET is_primary = 0 WHERE contact_id = ?`,
      args: [contactId],
    });
    statements.push(
      audit(
        ctx,
        ACCOUNT_AUDIT.primaryContactChanged,
        'ACCOUNT',
        before.accountId,
        'PRIMARY_CONTACT',
        {
          contactId,
        },
        { contactId: null },
      ),
    );
  }

  statements.push(
    audit(
      ctx,
      deactivating ? ACCOUNT_AUDIT.contactDeactivated : ACCOUNT_AUDIT.contactUpdated,
      'CONTACT',
      contactId,
      deactivating ? 'DEACTIVATE' : 'UPDATE',
      before,
      input,
    ),
  );

  await db.batch(statements, 'write');
  const after = await getContact(db, contactId);
  return after === null ? { ok: false, kind: 'not_found' } : { ok: true, value: after };
}

/** How many primary active contacts an account holds. The invariant, queryable. */
export async function primaryContactCount(db: Client, accountId: string): Promise<number> {
  const result = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM contacts WHERE account_id = ? AND is_primary = 1`,
    args: [accountId],
  });
  return Number(result.rows[0]?.n ?? 0);
}

// ---- selection lists ---------------------------------------------------------

export interface Option {
  id: string;
  label: string;
  parentId?: string | null;
}

/**
 * The account managers this principal may assign.
 *
 * Section 3: offer only users the acting principal is authorised to assign.
 * The list is the internal, active users whose own assignment falls inside the
 * caller's account scope, so a Kenya-scoped user cannot hand an account to a
 * Uganda colleague and thereby make it invisible to themselves.
 */
export async function assignableManagers(db: Client, userId: string): Promise<Option[]> {
  const scope = await scopedAccounts(db, userId);
  const result = await db.execute({
    sql: `SELECT DISTINCT u.user_id AS id, u.display_name AS label
          FROM users u
          LEFT JOIN user_assignments ua ON ua.user_id = u.user_id AND ua.is_primary = 1
          WHERE u.status = 'ACTIVE' AND u.user_type = 'INTERNAL'
            AND (
              ${
                scope.sql === '1 = 1'
                  ? '1 = 1'
                  : `EXISTS (
                SELECT 1 FROM accounts a
                WHERE ${scope.sql}
                  AND (a.country_id = ua.country_id OR a.affiliate_id = ua.affiliate_id
                       OR a.account_manager_user_id = u.user_id)
              )`
              }
            )
          ORDER BY u.display_name`,
    args: (scope.sql === '1 = 1' ? [] : scope.args) as never[],
  });
  return result.rows.map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    return { id: text(row.id), label: text(row.label) };
  });
}

export interface AccountOptions {
  countries: Option[];
  affiliates: Option[];
  managers: Option[];
  segments: string[];
}

export async function accountOptions(db: Client, userId: string): Promise<AccountOptions> {
  const [countries, affiliates, segments] = await db.batch(
    [
      `SELECT country_id AS id, country_name AS label FROM countries WHERE active = 1
        ORDER BY country_name`,
      `SELECT affiliate_id AS id, affiliate_name AS label, country_id AS parent
         FROM affiliates WHERE active = 1 ORDER BY affiliate_name`,
      `SELECT DISTINCT segment AS label FROM accounts WHERE segment IS NOT NULL
        ORDER BY segment`,
    ],
    'read',
  );
  const options = (result: { rows: Record<string, unknown>[] }): Option[] =>
    result.rows.map((row) => ({
      id: text(row.id),
      label: text(row.label),
      parentId: row.parent === undefined ? null : nullableText(row.parent),
    }));
  return {
    countries: options(countries as unknown as { rows: Record<string, unknown>[] }),
    affiliates: options(affiliates as unknown as { rows: Record<string, unknown>[] }),
    managers: await assignableManagers(db, userId),
    segments: (segments as unknown as { rows: Record<string, unknown>[] }).rows.map((row) =>
      text(row.label),
    ),
  };
}
