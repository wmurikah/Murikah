/**
 * Reads and writes for the organisation master data: countries, affiliates,
 * business units, departments, teams and team membership.
 *
 * Every statement is parameterised. No SQL in this product is assembled by
 * string concatenation, so a value can never become syntax.
 *
 * THE WRITE AND ITS AUDIT ROW GO TOGETHER
 * None of these six tables has an `updated_at` column, so `audit_events` is the
 * only record that a row ever changed. A write that lands without its audit row
 * is therefore not a slightly incomplete success, it is a silent loss of the
 * only history there is. Every mutation below is a `db.batch([...], 'write')`
 * carrying the data statement and the audit statement together: both commit or
 * neither does. There is no ordering in which one can succeed alone, and no
 * `catch` that lets the write stand when the audit fails.
 *
 * IDS
 * `newId(prefix)` from ./authRecords, the one rule this product already uses for
 * USR-, AEV- and ASESS-. A prefix from the seed's own vocabulary plus 16 random
 * bytes as hex. The seeded rows are readable (CTR-KE, AFF-KE, BU-RET); new rows
 * cannot be, because a readable id needs a human to choose it and a uniqueness
 * check to defend it, and a worker has no safe way to hold a counter across
 * isolates. The prefix keeps them recognisable in a join.
 *
 * DUPLICATES ARE CHECKED AND ALSO CAUGHT
 * A SELECT before the INSERT produces a field-level message naming the value
 * that clashes. It cannot be sufficient on its own: another request can insert
 * between the check and the write. So the constraint error is caught as well
 * and mapped to the same message. The check is for the human, the catch is for
 * correctness.
 */
import type { Client, InStatement } from '@libsql/client/web';
import type { FieldError } from '../../validation.ts';
import { newId } from './authRecords.ts';
import { auditEventStmt } from './authRecords.ts';
import { toDbTimestamp } from '../auth/session.ts';
import type {
  AffiliateInput,
  BusinessUnitInput,
  CountryInput,
  DepartmentInput,
  TeamInput,
  TeamMemberInput,
} from '../admin/organisationInput.ts';
import type { WriteContext } from '../admin/guard.ts';

/**
 * One statement, in the shape the client's `batch` takes.
 *
 * The driver's own type rather than a local one, so an argument the driver
 * cannot bind is a compile error here rather than a runtime failure inside a
 * batch that has already written half of what it was asked to.
 */
type Stmt = Extract<InStatement, { sql: string }>;

/**
 * The outcome of a write.
 *
 * `conflict` is a uniqueness rule; `invalid_reference` is a foreign key that
 * names nothing, or names something deactivated; `not_found` is an edit of a
 * row that is not there. They are separate because they are three different
 * sentences to a user and three different status codes.
 */
export type WriteResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly kind: 'conflict'; readonly fields: FieldError[] }
  | { readonly ok: false; readonly kind: 'invalid_reference'; readonly fields: FieldError[] }
  | { readonly ok: false; readonly kind: 'not_found' };

const text = (value: unknown): string => String(value ?? '');
const nullableText = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);
const flag = (value: unknown): boolean => Number(value ?? 0) === 1;

/**
 * Whether a thrown error is the database refusing a uniqueness rule.
 *
 * The two drivers word it differently: `node:sqlite` raises "UNIQUE constraint
 * failed: countries.iso2" and libSQL wraps the same SQLite message. Matching on
 * the shared substring rather than on a driver-specific code keeps the test
 * database and the real one on the same path, which is the point of testing
 * against the operator's own DDL.
 */
function isUniqueViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /UNIQUE constraint failed/i.test(message);
}

function isForeignKeyViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /FOREIGN KEY constraint failed/i.test(message);
}

/** The audit statement that accompanies every data statement below. */
function audit(
  ctx: WriteContext,
  entityType: string,
  entityId: string,
  action: 'CREATE' | 'UPDATE' | 'DEACTIVATE' | 'ACTIVATE',
  before: unknown,
  after: unknown,
): Stmt {
  return auditEventStmt({
    actorUserId: ctx.actorUserId,
    // The event type names the subject; the action names what happened to it.
    // Both are recorded because a reader filtering for organisation changes
    // should not have to know every entity type to find them.
    eventType: 'ORGANISATION_CHANGE',
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

// ---- countries -------------------------------------------------------------

export interface CountryRow {
  countryId: string;
  iso2: string;
  countryName: string;
  timezone: string;
  currencyCode: string;
  active: boolean;
  createdAt: string;
  /** How many affiliates point at this country, active and inactive. */
  affiliateCount: number;
}

const COUNTRY_SELECT = `
  SELECT c.country_id, c.iso2, c.country_name, c.timezone, c.currency_code, c.active, c.created_at,
         (SELECT COUNT(*) FROM affiliates a WHERE a.country_id = c.country_id) AS affiliate_count
  FROM countries c`;

function toCountry(row: Record<string, unknown>): CountryRow {
  return {
    countryId: text(row.country_id),
    iso2: text(row.iso2),
    countryName: text(row.country_name),
    timezone: text(row.timezone),
    currencyCode: text(row.currency_code),
    active: flag(row.active),
    createdAt: text(row.created_at),
    affiliateCount: Number(row.affiliate_count ?? 0),
  };
}

export async function listCountries(db: Client): Promise<CountryRow[]> {
  const result = await db.execute(`${COUNTRY_SELECT} ORDER BY c.country_name`);
  return result.rows.map(toCountry);
}

export async function getCountry(db: Client, id: string): Promise<CountryRow | null> {
  const result = await db.execute({
    sql: `${COUNTRY_SELECT} WHERE c.country_id = ? LIMIT 1`,
    args: [id],
  });
  const row = result.rows[0];
  return row ? toCountry(row) : null;
}

/** The values an audit row records. The counted column is not one of them. */
function countryState(row: CountryRow) {
  return {
    iso2: row.iso2,
    countryName: row.countryName,
    timezone: row.timezone,
    currencyCode: row.currencyCode,
    active: row.active,
  };
}

async function countryClash(
  db: Client,
  input: { iso2: string; countryName: string },
  excludeId: string | null,
): Promise<FieldError[]> {
  const result = await db.execute({
    sql: `SELECT country_id, iso2, country_name FROM countries
          WHERE (iso2 = ? OR country_name = ?) AND country_id IS NOT ?`,
    args: [input.iso2, input.countryName, excludeId],
  });
  const errors: FieldError[] = [];
  for (const row of result.rows) {
    if (text(row.iso2) === input.iso2) {
      errors.push({ field: 'iso2', message: `${input.iso2} is already used by another country.` });
    }
    if (text(row.country_name) === input.countryName) {
      errors.push({ field: 'countryName', message: 'A country with that name already exists.' });
    }
  }
  return errors;
}

export async function createCountry(
  db: Client,
  input: CountryInput,
  ctx: WriteContext,
): Promise<WriteResult<CountryRow>> {
  const clash = await countryClash(db, input, null);
  if (clash.length > 0) return { ok: false, kind: 'conflict', fields: clash };

  const countryId = newId('CTR');
  const after = {
    iso2: input.iso2,
    countryName: input.countryName,
    timezone: input.timezone,
    currencyCode: input.currencyCode,
    active: input.active,
  };
  try {
    await db.batch(
      [
        {
          sql: `INSERT INTO countries (country_id, iso2, country_name, timezone, currency_code, active, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)`,
          args: [
            countryId,
            input.iso2,
            input.countryName,
            input.timezone,
            input.currencyCode,
            input.active ? 1 : 0,
            toDbTimestamp(ctx.now),
          ],
        },
        audit(ctx, 'COUNTRY', countryId, 'CREATE', null, after),
      ],
      'write',
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      return { ok: false, kind: 'conflict', fields: await countryClash(db, input, null) };
    }
    throw error;
  }
  const created = await getCountry(db, countryId);
  return created ? { ok: true, value: created } : { ok: false, kind: 'not_found' };
}

export async function updateCountry(
  db: Client,
  id: string,
  input: CountryInput,
  ctx: WriteContext,
): Promise<WriteResult<CountryRow>> {
  const before = await getCountry(db, id);
  if (!before) return { ok: false, kind: 'not_found' };

  const clash = await countryClash(db, input, id);
  if (clash.length > 0) return { ok: false, kind: 'conflict', fields: clash };

  const after = {
    iso2: input.iso2,
    countryName: input.countryName,
    timezone: input.timezone,
    currencyCode: input.currencyCode,
    active: input.active,
  };
  try {
    await db.batch(
      [
        {
          sql: `UPDATE countries SET iso2 = ?, country_name = ?, timezone = ?, currency_code = ?, active = ?
                WHERE country_id = ?`,
          args: [
            input.iso2,
            input.countryName,
            input.timezone,
            input.currencyCode,
            input.active ? 1 : 0,
            id,
          ],
        },
        audit(
          ctx,
          'COUNTRY',
          id,
          actionFor(before.active, input.active),
          countryState(before),
          after,
        ),
      ],
      'write',
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      return { ok: false, kind: 'conflict', fields: await countryClash(db, input, id) };
    }
    throw error;
  }
  const updated = await getCountry(db, id);
  return updated ? { ok: true, value: updated } : { ok: false, kind: 'not_found' };
}

/**
 * Whether this edit reads as a status change or an ordinary edit.
 *
 * A deactivation is the change an administrator will look for in the audit log
 * later, so it is named as one rather than being an UPDATE that happens to have
 * flipped a flag.
 */
function actionFor(was: boolean, now: boolean): 'UPDATE' | 'DEACTIVATE' | 'ACTIVATE' {
  if (was === now) return 'UPDATE';
  return now ? 'ACTIVATE' : 'DEACTIVATE';
}

// ---- affiliates ------------------------------------------------------------

export interface AffiliateRow {
  affiliateId: string;
  affiliateCode: string;
  affiliateName: string;
  countryId: string;
  countryName: string;
  active: boolean;
  createdAt: string;
  /** Teams and user assignments that would lose a selectable affiliate. */
  teamCount: number;
  assignmentCount: number;
}

const AFFILIATE_SELECT = `
  SELECT a.affiliate_id, a.affiliate_code, a.affiliate_name, a.country_id, a.active, a.created_at,
         c.country_name,
         (SELECT COUNT(*) FROM teams t WHERE t.affiliate_id = a.affiliate_id) AS team_count,
         (SELECT COUNT(*) FROM user_assignments ua WHERE ua.affiliate_id = a.affiliate_id) AS assignment_count
  FROM affiliates a
  JOIN countries c ON c.country_id = a.country_id`;

function toAffiliate(row: Record<string, unknown>): AffiliateRow {
  return {
    affiliateId: text(row.affiliate_id),
    affiliateCode: text(row.affiliate_code),
    affiliateName: text(row.affiliate_name),
    countryId: text(row.country_id),
    countryName: text(row.country_name),
    active: flag(row.active),
    createdAt: text(row.created_at),
    teamCount: Number(row.team_count ?? 0),
    assignmentCount: Number(row.assignment_count ?? 0),
  };
}

export async function listAffiliates(db: Client): Promise<AffiliateRow[]> {
  const result = await db.execute(
    `${AFFILIATE_SELECT} ORDER BY c.country_name, a.affiliate_name, a.affiliate_code`,
  );
  return result.rows.map(toAffiliate);
}

export async function getAffiliate(db: Client, id: string): Promise<AffiliateRow | null> {
  const result = await db.execute({
    sql: `${AFFILIATE_SELECT} WHERE a.affiliate_id = ? LIMIT 1`,
    args: [id],
  });
  const row = result.rows[0];
  return row ? toAffiliate(row) : null;
}

function affiliateState(row: AffiliateRow) {
  return {
    affiliateCode: row.affiliateCode,
    affiliateName: row.affiliateName,
    countryId: row.countryId,
    active: row.active,
  };
}

async function affiliateCodeClash(
  db: Client,
  code: string,
  excludeId: string | null,
): Promise<FieldError[]> {
  const result = await db.execute({
    sql: `SELECT affiliate_id FROM affiliates WHERE affiliate_code = ? AND affiliate_id IS NOT ?`,
    args: [code, excludeId],
  });
  return result.rows.length === 0
    ? []
    : [{ field: 'affiliateCode', message: `${code} is already used by another affiliate.` }];
}

/**
 * The country must exist and be active.
 *
 * "Active" is a rule of this phase rather than of the schema: the foreign key
 * would happily accept a deactivated country, and deactivation is meant to stop
 * a value being chosen for new records. An edit that leaves the country
 * unchanged is exempt, so deactivating a country does not make its existing
 * affiliates uneditable.
 */
async function checkCountrySelectable(
  db: Client,
  countryId: string,
  unchangedFrom: string | null,
): Promise<FieldError[]> {
  if (countryId === unchangedFrom) return [];
  const result = await db.execute({
    sql: `SELECT active FROM countries WHERE country_id = ? LIMIT 1`,
    args: [countryId],
  });
  const row = result.rows[0];
  if (!row) return [{ field: 'countryId', message: 'That country does not exist.' }];
  if (!flag(row.active)) {
    return [
      {
        field: 'countryId',
        message: 'That country is deactivated and cannot be chosen for new records.',
      },
    ];
  }
  return [];
}

export async function createAffiliate(
  db: Client,
  input: AffiliateInput,
  ctx: WriteContext,
): Promise<WriteResult<AffiliateRow>> {
  const reference = await checkCountrySelectable(db, input.countryId, null);
  if (reference.length > 0) return { ok: false, kind: 'invalid_reference', fields: reference };

  const clash = await affiliateCodeClash(db, input.affiliateCode, null);
  if (clash.length > 0) return { ok: false, kind: 'conflict', fields: clash };

  const affiliateId = newId('AFF');
  const after = {
    affiliateCode: input.affiliateCode,
    affiliateName: input.affiliateName,
    countryId: input.countryId,
    active: input.active,
  };
  try {
    await db.batch(
      [
        {
          sql: `INSERT INTO affiliates (affiliate_id, affiliate_code, affiliate_name, country_id, active, created_at)
                VALUES (?, ?, ?, ?, ?, ?)`,
          args: [
            affiliateId,
            input.affiliateCode,
            input.affiliateName,
            input.countryId,
            input.active ? 1 : 0,
            toDbTimestamp(ctx.now),
          ],
        },
        audit(ctx, 'AFFILIATE', affiliateId, 'CREATE', null, after),
      ],
      'write',
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      return {
        ok: false,
        kind: 'conflict',
        fields: await affiliateCodeClash(db, input.affiliateCode, null),
      };
    }
    if (isForeignKeyViolation(error)) {
      return {
        ok: false,
        kind: 'invalid_reference',
        fields: [{ field: 'countryId', message: 'That country does not exist.' }],
      };
    }
    throw error;
  }
  const created = await getAffiliate(db, affiliateId);
  return created ? { ok: true, value: created } : { ok: false, kind: 'not_found' };
}

export async function updateAffiliate(
  db: Client,
  id: string,
  input: AffiliateInput,
  ctx: WriteContext,
): Promise<WriteResult<AffiliateRow>> {
  const before = await getAffiliate(db, id);
  if (!before) return { ok: false, kind: 'not_found' };

  const reference = await checkCountrySelectable(db, input.countryId, before.countryId);
  if (reference.length > 0) return { ok: false, kind: 'invalid_reference', fields: reference };

  const clash = await affiliateCodeClash(db, input.affiliateCode, id);
  if (clash.length > 0) return { ok: false, kind: 'conflict', fields: clash };

  const after = {
    affiliateCode: input.affiliateCode,
    affiliateName: input.affiliateName,
    countryId: input.countryId,
    active: input.active,
  };
  try {
    await db.batch(
      [
        {
          sql: `UPDATE affiliates SET affiliate_code = ?, affiliate_name = ?, country_id = ?, active = ?
                WHERE affiliate_id = ?`,
          args: [
            input.affiliateCode,
            input.affiliateName,
            input.countryId,
            input.active ? 1 : 0,
            id,
          ],
        },
        audit(
          ctx,
          'AFFILIATE',
          id,
          actionFor(before.active, input.active),
          affiliateState(before),
          after,
        ),
      ],
      'write',
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      return {
        ok: false,
        kind: 'conflict',
        fields: await affiliateCodeClash(db, input.affiliateCode, id),
      };
    }
    throw error;
  }
  const updated = await getAffiliate(db, id);
  return updated ? { ok: true, value: updated } : { ok: false, kind: 'not_found' };
}

// ---- business units --------------------------------------------------------

export interface BusinessUnitRow {
  businessUnitId: string;
  businessUnitCode: string;
  businessUnitName: string;
  description: string | null;
  active: boolean;
  createdAt: string;
  teamCount: number;
  assignmentCount: number;
}

const BUSINESS_UNIT_SELECT = `
  SELECT b.business_unit_id, b.business_unit_code, b.business_unit_name, b.description,
         b.active, b.created_at,
         (SELECT COUNT(*) FROM teams t WHERE t.business_unit_id = b.business_unit_id) AS team_count,
         (SELECT COUNT(*) FROM user_assignments ua WHERE ua.business_unit_id = b.business_unit_id) AS assignment_count
  FROM business_units b`;

function toBusinessUnit(row: Record<string, unknown>): BusinessUnitRow {
  return {
    businessUnitId: text(row.business_unit_id),
    businessUnitCode: text(row.business_unit_code),
    businessUnitName: text(row.business_unit_name),
    description: nullableText(row.description),
    active: flag(row.active),
    createdAt: text(row.created_at),
    teamCount: Number(row.team_count ?? 0),
    assignmentCount: Number(row.assignment_count ?? 0),
  };
}

export async function listBusinessUnits(db: Client): Promise<BusinessUnitRow[]> {
  const result = await db.execute(`${BUSINESS_UNIT_SELECT} ORDER BY b.business_unit_name`);
  return result.rows.map(toBusinessUnit);
}

export async function getBusinessUnit(db: Client, id: string): Promise<BusinessUnitRow | null> {
  const result = await db.execute({
    sql: `${BUSINESS_UNIT_SELECT} WHERE b.business_unit_id = ? LIMIT 1`,
    args: [id],
  });
  const row = result.rows[0];
  return row ? toBusinessUnit(row) : null;
}

function businessUnitState(row: BusinessUnitRow) {
  return {
    businessUnitCode: row.businessUnitCode,
    businessUnitName: row.businessUnitName,
    description: row.description,
    active: row.active,
  };
}

async function businessUnitClash(
  db: Client,
  input: { businessUnitCode: string; businessUnitName: string },
  excludeId: string | null,
): Promise<FieldError[]> {
  const result = await db.execute({
    sql: `SELECT business_unit_id, business_unit_code, business_unit_name FROM business_units
          WHERE (business_unit_code = ? OR business_unit_name = ?) AND business_unit_id IS NOT ?`,
    args: [input.businessUnitCode, input.businessUnitName, excludeId],
  });
  const errors: FieldError[] = [];
  for (const row of result.rows) {
    if (text(row.business_unit_code) === input.businessUnitCode) {
      errors.push({
        field: 'businessUnitCode',
        message: `${input.businessUnitCode} is already used by another business unit.`,
      });
    }
    if (text(row.business_unit_name) === input.businessUnitName) {
      errors.push({
        field: 'businessUnitName',
        message: 'A business unit with that name already exists.',
      });
    }
  }
  return errors;
}

export async function createBusinessUnit(
  db: Client,
  input: BusinessUnitInput,
  ctx: WriteContext,
): Promise<WriteResult<BusinessUnitRow>> {
  const clash = await businessUnitClash(db, input, null);
  if (clash.length > 0) return { ok: false, kind: 'conflict', fields: clash };

  const businessUnitId = newId('BU');
  const after = {
    businessUnitCode: input.businessUnitCode,
    businessUnitName: input.businessUnitName,
    description: input.description,
    active: input.active,
  };
  try {
    await db.batch(
      [
        {
          sql: `INSERT INTO business_units (business_unit_id, business_unit_code, business_unit_name,
                  description, active, created_at)
                VALUES (?, ?, ?, ?, ?, ?)`,
          args: [
            businessUnitId,
            input.businessUnitCode,
            input.businessUnitName,
            input.description,
            input.active ? 1 : 0,
            toDbTimestamp(ctx.now),
          ],
        },
        audit(ctx, 'BUSINESS_UNIT', businessUnitId, 'CREATE', null, after),
      ],
      'write',
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      return { ok: false, kind: 'conflict', fields: await businessUnitClash(db, input, null) };
    }
    throw error;
  }
  const created = await getBusinessUnit(db, businessUnitId);
  return created ? { ok: true, value: created } : { ok: false, kind: 'not_found' };
}

export async function updateBusinessUnit(
  db: Client,
  id: string,
  input: BusinessUnitInput,
  ctx: WriteContext,
): Promise<WriteResult<BusinessUnitRow>> {
  const before = await getBusinessUnit(db, id);
  if (!before) return { ok: false, kind: 'not_found' };

  const clash = await businessUnitClash(db, input, id);
  if (clash.length > 0) return { ok: false, kind: 'conflict', fields: clash };

  const after = {
    businessUnitCode: input.businessUnitCode,
    businessUnitName: input.businessUnitName,
    description: input.description,
    active: input.active,
  };
  try {
    await db.batch(
      [
        {
          sql: `UPDATE business_units SET business_unit_code = ?, business_unit_name = ?,
                  description = ?, active = ?
                WHERE business_unit_id = ?`,
          args: [
            input.businessUnitCode,
            input.businessUnitName,
            input.description,
            input.active ? 1 : 0,
            id,
          ],
        },
        audit(
          ctx,
          'BUSINESS_UNIT',
          id,
          actionFor(before.active, input.active),
          businessUnitState(before),
          after,
        ),
      ],
      'write',
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      return { ok: false, kind: 'conflict', fields: await businessUnitClash(db, input, id) };
    }
    throw error;
  }
  const updated = await getBusinessUnit(db, id);
  return updated ? { ok: true, value: updated } : { ok: false, kind: 'not_found' };
}

// ---- departments -----------------------------------------------------------

export interface DepartmentRow {
  departmentId: string;
  departmentName: string;
  description: string | null;
  active: boolean;
  createdAt: string;
  /**
   * Job titles pointing here. A later phase links job titles to departments in
   * the interface; the column already exists and is already populated by the
   * seed, so a deactivation that would strand one is counted now rather than
   * discovered then.
   */
  jobTitleCount: number;
  assignmentCount: number;
}

const DEPARTMENT_SELECT = `
  SELECT d.department_id, d.department_name, d.description, d.active, d.created_at,
         (SELECT COUNT(*) FROM job_titles j WHERE j.department_id = d.department_id) AS job_title_count,
         (SELECT COUNT(*) FROM user_assignments ua WHERE ua.department_id = d.department_id) AS assignment_count
  FROM departments d`;

function toDepartment(row: Record<string, unknown>): DepartmentRow {
  return {
    departmentId: text(row.department_id),
    departmentName: text(row.department_name),
    description: nullableText(row.description),
    active: flag(row.active),
    createdAt: text(row.created_at),
    jobTitleCount: Number(row.job_title_count ?? 0),
    assignmentCount: Number(row.assignment_count ?? 0),
  };
}

export async function listDepartments(db: Client): Promise<DepartmentRow[]> {
  const result = await db.execute(`${DEPARTMENT_SELECT} ORDER BY d.department_name`);
  return result.rows.map(toDepartment);
}

export async function getDepartment(db: Client, id: string): Promise<DepartmentRow | null> {
  const result = await db.execute({
    sql: `${DEPARTMENT_SELECT} WHERE d.department_id = ? LIMIT 1`,
    args: [id],
  });
  const row = result.rows[0];
  return row ? toDepartment(row) : null;
}

function departmentState(row: DepartmentRow) {
  return {
    departmentName: row.departmentName,
    description: row.description,
    active: row.active,
  };
}

async function departmentClash(
  db: Client,
  name: string,
  excludeId: string | null,
): Promise<FieldError[]> {
  const result = await db.execute({
    sql: `SELECT department_id FROM departments WHERE department_name = ? AND department_id IS NOT ?`,
    args: [name, excludeId],
  });
  return result.rows.length === 0
    ? []
    : [{ field: 'departmentName', message: 'A department with that name already exists.' }];
}

export async function createDepartment(
  db: Client,
  input: DepartmentInput,
  ctx: WriteContext,
): Promise<WriteResult<DepartmentRow>> {
  const clash = await departmentClash(db, input.departmentName, null);
  if (clash.length > 0) return { ok: false, kind: 'conflict', fields: clash };

  const departmentId = newId('DEP');
  const after = {
    departmentName: input.departmentName,
    description: input.description,
    active: input.active,
  };
  try {
    await db.batch(
      [
        {
          sql: `INSERT INTO departments (department_id, department_name, description, active, created_at)
                VALUES (?, ?, ?, ?, ?)`,
          args: [
            departmentId,
            input.departmentName,
            input.description,
            input.active ? 1 : 0,
            toDbTimestamp(ctx.now),
          ],
        },
        audit(ctx, 'DEPARTMENT', departmentId, 'CREATE', null, after),
      ],
      'write',
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      return {
        ok: false,
        kind: 'conflict',
        fields: await departmentClash(db, input.departmentName, null),
      };
    }
    throw error;
  }
  const created = await getDepartment(db, departmentId);
  return created ? { ok: true, value: created } : { ok: false, kind: 'not_found' };
}

export async function updateDepartment(
  db: Client,
  id: string,
  input: DepartmentInput,
  ctx: WriteContext,
): Promise<WriteResult<DepartmentRow>> {
  const before = await getDepartment(db, id);
  if (!before) return { ok: false, kind: 'not_found' };

  const clash = await departmentClash(db, input.departmentName, id);
  if (clash.length > 0) return { ok: false, kind: 'conflict', fields: clash };

  const after = {
    departmentName: input.departmentName,
    description: input.description,
    active: input.active,
  };
  try {
    await db.batch(
      [
        {
          sql: `UPDATE departments SET department_name = ?, description = ?, active = ?
                WHERE department_id = ?`,
          args: [input.departmentName, input.description, input.active ? 1 : 0, id],
        },
        audit(
          ctx,
          'DEPARTMENT',
          id,
          actionFor(before.active, input.active),
          departmentState(before),
          after,
        ),
      ],
      'write',
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      return {
        ok: false,
        kind: 'conflict',
        fields: await departmentClash(db, input.departmentName, id),
      };
    }
    throw error;
  }
  const updated = await getDepartment(db, id);
  return updated ? { ok: true, value: updated } : { ok: false, kind: 'not_found' };
}

// ---- teams -----------------------------------------------------------------

export interface TeamRow {
  teamId: string;
  teamName: string;
  teamType: string;
  /** Null is a Group-wide team, not a team missing its affiliate. */
  affiliateId: string | null;
  affiliateName: string | null;
  businessUnitId: string | null;
  businessUnitName: string | null;
  managerUserId: string | null;
  managerName: string | null;
  active: boolean;
  createdAt: string;
  /** Members effective today. Historical rows are not counted here. */
  currentMemberCount: number;
}

/**
 * LEFT JOIN on all three references, because all three are nullable and an
 * INNER JOIN would silently drop exactly the teams this phase exists to prove
 * are possible: the Group-wide team with no affiliate, and the team with no
 * manager.
 */
const TEAM_SELECT = `
  SELECT t.team_id, t.team_name, t.team_type, t.affiliate_id, t.business_unit_id,
         t.manager_user_id, t.active, t.created_at,
         a.affiliate_name, b.business_unit_name, u.display_name AS manager_name,
         (SELECT COUNT(*) FROM team_members m
           WHERE m.team_id = t.team_id AND m.active = 1
             AND m.effective_from <= date('now')
             AND (m.effective_to IS NULL OR m.effective_to >= date('now'))) AS current_member_count
  FROM teams t
  LEFT JOIN affiliates a ON a.affiliate_id = t.affiliate_id
  LEFT JOIN business_units b ON b.business_unit_id = t.business_unit_id
  LEFT JOIN users u ON u.user_id = t.manager_user_id`;

function toTeam(row: Record<string, unknown>): TeamRow {
  return {
    teamId: text(row.team_id),
    teamName: text(row.team_name),
    teamType: text(row.team_type),
    affiliateId: nullableText(row.affiliate_id),
    affiliateName: nullableText(row.affiliate_name),
    businessUnitId: nullableText(row.business_unit_id),
    businessUnitName: nullableText(row.business_unit_name),
    managerUserId: nullableText(row.manager_user_id),
    managerName: nullableText(row.manager_name),
    active: flag(row.active),
    createdAt: text(row.created_at),
    currentMemberCount: Number(row.current_member_count ?? 0),
  };
}

export async function listTeams(db: Client): Promise<TeamRow[]> {
  const result = await db.execute(`${TEAM_SELECT} ORDER BY t.team_name`);
  return result.rows.map(toTeam);
}

export async function getTeam(db: Client, id: string): Promise<TeamRow | null> {
  const result = await db.execute({
    sql: `${TEAM_SELECT} WHERE t.team_id = ? LIMIT 1`,
    args: [id],
  });
  const row = result.rows[0];
  return row ? toTeam(row) : null;
}

function teamState(row: TeamRow) {
  return {
    teamName: row.teamName,
    teamType: row.teamType,
    affiliateId: row.affiliateId,
    businessUnitId: row.businessUnitId,
    managerUserId: row.managerUserId,
    active: row.active,
  };
}

async function teamNameClash(
  db: Client,
  name: string,
  excludeId: string | null,
): Promise<FieldError[]> {
  const result = await db.execute({
    sql: `SELECT team_id FROM teams WHERE team_name = ? AND team_id IS NOT ?`,
    args: [name, excludeId],
  });
  return result.rows.length === 0
    ? []
    : [{ field: 'teamName', message: 'A team with that name already exists.' }];
}

/**
 * The optional references, checked only when supplied.
 *
 * Null is never an error here. A team with no affiliate, no business unit and
 * no manager is a valid Group team, and treating an absent value as a missing
 * one is how the seeded `Group Finance` team would have become unrepresentable.
 */
async function checkTeamReferences(
  db: Client,
  input: TeamInput,
  before: TeamRow | null,
): Promise<FieldError[]> {
  const errors: FieldError[] = [];

  if (input.affiliateId !== null && input.affiliateId !== (before?.affiliateId ?? null)) {
    const result = await db.execute({
      sql: `SELECT active FROM affiliates WHERE affiliate_id = ? LIMIT 1`,
      args: [input.affiliateId],
    });
    const row = result.rows[0];
    if (!row) errors.push({ field: 'affiliateId', message: 'That affiliate does not exist.' });
    else if (!flag(row.active)) {
      errors.push({ field: 'affiliateId', message: 'That affiliate is deactivated.' });
    }
  }

  if (input.businessUnitId !== null && input.businessUnitId !== (before?.businessUnitId ?? null)) {
    const result = await db.execute({
      sql: `SELECT active FROM business_units WHERE business_unit_id = ? LIMIT 1`,
      args: [input.businessUnitId],
    });
    const row = result.rows[0];
    if (!row) {
      errors.push({ field: 'businessUnitId', message: 'That business unit does not exist.' });
    } else if (!flag(row.active)) {
      errors.push({ field: 'businessUnitId', message: 'That business unit is deactivated.' });
    }
  }

  if (input.managerUserId !== null && input.managerUserId !== (before?.managerUserId ?? null)) {
    const result = await db.execute({
      sql: `SELECT status, user_type FROM users WHERE user_id = ? LIMIT 1`,
      args: [input.managerUserId],
    });
    const row = result.rows[0];
    if (!row) errors.push({ field: 'managerUserId', message: 'That person does not exist.' });
    else if (text(row.status) !== 'ACTIVE') {
      errors.push({ field: 'managerUserId', message: 'That person is not an active user.' });
    } else if (text(row.user_type) !== 'INTERNAL') {
      // A customer portal contact managing a Hass team is not a scenario; the
      // foreign key permits it and this does not.
      errors.push({ field: 'managerUserId', message: 'A team manager must be a staff user.' });
    }
  }

  return errors;
}

export async function createTeam(
  db: Client,
  input: TeamInput,
  ctx: WriteContext,
): Promise<WriteResult<TeamRow>> {
  const reference = await checkTeamReferences(db, input, null);
  if (reference.length > 0) return { ok: false, kind: 'invalid_reference', fields: reference };

  const clash = await teamNameClash(db, input.teamName, null);
  if (clash.length > 0) return { ok: false, kind: 'conflict', fields: clash };

  const teamId = newId('TEAM');
  const after = {
    teamName: input.teamName,
    teamType: input.teamType,
    affiliateId: input.affiliateId,
    businessUnitId: input.businessUnitId,
    managerUserId: input.managerUserId,
    active: input.active,
  };
  try {
    await db.batch(
      [
        {
          sql: `INSERT INTO teams (team_id, team_name, team_type, affiliate_id, business_unit_id,
                  manager_user_id, active, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            teamId,
            input.teamName,
            input.teamType,
            input.affiliateId,
            input.businessUnitId,
            input.managerUserId,
            input.active ? 1 : 0,
            toDbTimestamp(ctx.now),
          ],
        },
        audit(ctx, 'TEAM', teamId, 'CREATE', null, after),
      ],
      'write',
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      return { ok: false, kind: 'conflict', fields: await teamNameClash(db, input.teamName, null) };
    }
    if (isForeignKeyViolation(error)) {
      return {
        ok: false,
        kind: 'invalid_reference',
        fields: [{ field: 'teamName', message: 'One of the chosen references does not exist.' }],
      };
    }
    throw error;
  }
  const created = await getTeam(db, teamId);
  return created ? { ok: true, value: created } : { ok: false, kind: 'not_found' };
}

export async function updateTeam(
  db: Client,
  id: string,
  input: TeamInput,
  ctx: WriteContext,
): Promise<WriteResult<TeamRow>> {
  const before = await getTeam(db, id);
  if (!before) return { ok: false, kind: 'not_found' };

  const reference = await checkTeamReferences(db, input, before);
  if (reference.length > 0) return { ok: false, kind: 'invalid_reference', fields: reference };

  const clash = await teamNameClash(db, input.teamName, id);
  if (clash.length > 0) return { ok: false, kind: 'conflict', fields: clash };

  const after = {
    teamName: input.teamName,
    teamType: input.teamType,
    affiliateId: input.affiliateId,
    businessUnitId: input.businessUnitId,
    managerUserId: input.managerUserId,
    active: input.active,
  };
  try {
    await db.batch(
      [
        {
          sql: `UPDATE teams SET team_name = ?, team_type = ?, affiliate_id = ?, business_unit_id = ?,
                  manager_user_id = ?, active = ?
                WHERE team_id = ?`,
          args: [
            input.teamName,
            input.teamType,
            input.affiliateId,
            input.businessUnitId,
            input.managerUserId,
            input.active ? 1 : 0,
            id,
          ],
        },
        audit(ctx, 'TEAM', id, actionFor(before.active, input.active), teamState(before), after),
      ],
      'write',
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      return { ok: false, kind: 'conflict', fields: await teamNameClash(db, input.teamName, id) };
    }
    throw error;
  }
  const updated = await getTeam(db, id);
  return updated ? { ok: true, value: updated } : { ok: false, kind: 'not_found' };
}

// ---- team membership -------------------------------------------------------

export interface TeamMemberRow {
  teamMemberId: string;
  teamId: string;
  userId: string;
  displayName: string;
  email: string;
  memberRole: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  active: boolean;
  /** Whether this row is the membership in force today. */
  current: boolean;
}

/**
 * `users` is joined for a name, and only the two columns a list needs are
 * selected. `SELECT u.*` here would put `password_hash` one careless spread
 * away from a response body.
 */
const TEAM_MEMBER_SELECT = `
  SELECT m.team_member_id, m.team_id, m.user_id, m.member_role, m.effective_from,
         m.effective_to, m.active,
         u.display_name, u.email,
         CASE WHEN m.active = 1
                   AND m.effective_from <= date('now')
                   AND (m.effective_to IS NULL OR m.effective_to >= date('now'))
              THEN 1 ELSE 0 END AS is_current
  FROM team_members m
  JOIN users u ON u.user_id = m.user_id`;

function toTeamMember(row: Record<string, unknown>): TeamMemberRow {
  return {
    teamMemberId: text(row.team_member_id),
    teamId: text(row.team_id),
    userId: text(row.user_id),
    displayName: text(row.display_name),
    email: text(row.email),
    memberRole: nullableText(row.member_role),
    effectiveFrom: text(row.effective_from),
    effectiveTo: nullableText(row.effective_to),
    active: flag(row.active),
    current: flag(row.is_current),
  };
}

/**
 * Membership rows for a team.
 *
 * `includeHistorical` defaults to false, so a caller that forgets to think
 * about it gets the current membership rather than a list mixing people who
 * left in 2024 with people who are on the team today.
 */
export async function listTeamMembers(
  db: Client,
  teamId: string,
  includeHistorical = false,
): Promise<TeamMemberRow[]> {
  const rows = await db.execute({
    sql: `${TEAM_MEMBER_SELECT} WHERE m.team_id = ? ORDER BY is_current DESC, m.effective_from DESC, u.display_name`,
    args: [teamId],
  });
  const all = rows.rows.map(toTeamMember);
  return includeHistorical ? all : all.filter((row) => row.current);
}

export async function getTeamMember(db: Client, id: string): Promise<TeamMemberRow | null> {
  const result = await db.execute({
    sql: `${TEAM_MEMBER_SELECT} WHERE m.team_member_id = ? LIMIT 1`,
    args: [id],
  });
  const row = result.rows[0];
  return row ? toTeamMember(row) : null;
}

function memberState(row: TeamMemberRow) {
  return {
    teamId: row.teamId,
    userId: row.userId,
    memberRole: row.memberRole,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    active: row.active,
  };
}

/**
 * Add a person to a team, effective from a date.
 *
 * `UNIQUE(team_id, user_id, effective_from)` means the same person cannot be
 * added to the same team on the same date twice. That is a real rule and not a
 * nuisance: two rows would make "when did they join" unanswerable. It is
 * reported as a validation message on the date field, because moving the date
 * is what the user actually wants to do about it.
 */
export async function addTeamMember(
  db: Client,
  teamId: string,
  input: TeamMemberInput,
  ctx: WriteContext,
): Promise<WriteResult<TeamMemberRow>> {
  const team = await getTeam(db, teamId);
  if (!team) return { ok: false, kind: 'not_found' };

  const user = await db.execute({
    sql: `SELECT status FROM users WHERE user_id = ? LIMIT 1`,
    args: [input.userId],
  });
  if (user.rows.length === 0) {
    return {
      ok: false,
      kind: 'invalid_reference',
      fields: [{ field: 'userId', message: 'That person does not exist.' }],
    };
  }

  const duplicate = await db.execute({
    sql: `SELECT team_member_id FROM team_members
          WHERE team_id = ? AND user_id = ? AND effective_from = ?`,
    args: [teamId, input.userId, input.effectiveFrom],
  });
  const alreadyOnThatDate: FieldError[] = [
    {
      field: 'effectiveFrom',
      message: 'That person is already recorded on this team from that date. Choose another date.',
    },
  ];
  if (duplicate.rows.length > 0) {
    return { ok: false, kind: 'conflict', fields: alreadyOnThatDate };
  }

  const teamMemberId = newId('TM');
  const after = {
    teamId,
    userId: input.userId,
    memberRole: input.memberRole,
    effectiveFrom: input.effectiveFrom,
    effectiveTo: null,
    active: true,
  };
  try {
    await db.batch(
      [
        {
          sql: `INSERT INTO team_members (team_member_id, team_id, user_id, member_role,
                  effective_from, effective_to, active)
                VALUES (?, ?, ?, ?, ?, NULL, 1)`,
          args: [teamMemberId, teamId, input.userId, input.memberRole, input.effectiveFrom],
        },
        audit(ctx, 'TEAM_MEMBER', teamMemberId, 'CREATE', null, after),
      ],
      'write',
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      return { ok: false, kind: 'conflict', fields: alreadyOnThatDate };
    }
    if (isForeignKeyViolation(error)) {
      return {
        ok: false,
        kind: 'invalid_reference',
        fields: [{ field: 'userId', message: 'That person does not exist.' }],
      };
    }
    throw error;
  }
  const created = await getTeamMember(db, teamMemberId);
  return created ? { ok: true, value: created } : { ok: false, kind: 'not_found' };
}

/**
 * End a membership.
 *
 * Never a DELETE. The row stays, `effective_to` is stamped and `active` becomes
 * 0, so "who was on this team in March" remains answerable. There is no code
 * path in this phase that removes a `team_members` row, and there is no DELETE
 * verb on the endpoint that calls this.
 */
export async function endTeamMembership(
  db: Client,
  teamMemberId: string,
  effectiveTo: string,
  ctx: WriteContext,
): Promise<WriteResult<TeamMemberRow>> {
  const before = await getTeamMember(db, teamMemberId);
  if (!before) return { ok: false, kind: 'not_found' };

  if (effectiveTo < before.effectiveFrom) {
    return {
      ok: false,
      kind: 'invalid_reference',
      fields: [
        {
          field: 'effectiveTo',
          message: `The end date cannot be before ${before.effectiveFrom}, when the membership started.`,
        },
      ],
    };
  }

  const after = { ...memberState(before), effectiveTo, active: false };
  await db.batch(
    [
      {
        sql: `UPDATE team_members SET effective_to = ?, active = 0 WHERE team_member_id = ?`,
        args: [effectiveTo, teamMemberId],
      },
      audit(ctx, 'TEAM_MEMBER', teamMemberId, 'DEACTIVATE', memberState(before), after),
    ],
    'write',
  );

  const updated = await getTeamMember(db, teamMemberId);
  return updated ? { ok: true, value: updated } : { ok: false, kind: 'not_found' };
}

// ---- selectable references for the interface -------------------------------

export interface SelectableUser {
  userId: string;
  displayName: string;
  email: string;
}

/**
 * The staff a team manager or member can be chosen from.
 *
 * Named columns only, for the reason given above TEAM_MEMBER_SELECT: this row
 * reaches a rendered page and a JSON body, and `users` holds a password hash.
 */
export async function listSelectableUsers(db: Client): Promise<SelectableUser[]> {
  const result = await db.execute(
    `SELECT user_id, display_name, email FROM users
      WHERE status = 'ACTIVE' AND user_type = 'INTERNAL'
      ORDER BY display_name`,
  );
  return result.rows.map((row) => ({
    userId: text(row.user_id),
    displayName: text(row.display_name),
    email: text(row.email),
  }));
}
