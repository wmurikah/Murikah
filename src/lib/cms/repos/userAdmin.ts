/**
 * Reads and writes for user administration.
 *
 * Every statement is parameterised. No SQL in this product is assembled by
 * string concatenation, so a value can never become syntax. Where a filter list
 * needs a variable number of placeholders, the placeholders are generated and
 * the values still bound.
 *
 * THE WRITE AND ITS AUDIT ROW GO TOGETHER
 * `job_titles`, `user_assignments` and `source_identities` carry no
 * `updated_at`, so `audit_events` is the only record that a row ever changed.
 * Every mutation below is a single `db.batch([...], 'write')` carrying the data
 * statements and the audit statement together: both commit or neither does.
 *
 * EVERY JOIN OUT OF `users` IS A LEFT JOIN
 * The five seeded EXTERNAL users have no `user_assignments` row at all. An
 * INNER JOIN would drop them from the directory, and the directory would then
 * be quietly lying about who exists. Every assignment-derived column tolerates
 * null and the row still renders.
 */
import type { Client, InStatement } from '@libsql/client/web';
import type { FieldError } from '../../validation.ts';
import { newId, auditEventStmt } from './authRecords.ts';
import { toDbTimestamp } from '../auth/session.ts';
import { isoDay } from '../admin/userInput.ts';
import type { WriteContext } from '../admin/guard.ts';
import type {
  AssignmentInput,
  CreateUserInput,
  JobTitleInput,
  SourceIdentityInput,
  UpdateUserInput,
} from '../admin/userInput.ts';

type Stmt = Extract<InStatement, { sql: string }>;

export type WriteResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly kind: 'conflict'; readonly fields: FieldError[] }
  | { readonly ok: false; readonly kind: 'invalid_reference'; readonly fields: FieldError[] }
  | { readonly ok: false; readonly kind: 'not_found' };

const text = (v: unknown): string => String(v ?? '');
const nullableText = (v: unknown): string | null =>
  v === null || v === undefined ? null : String(v);
const flag = (v: unknown): boolean => Number(v ?? 0) === 1;

function isUniqueViolation(error: unknown): boolean {
  return /UNIQUE constraint failed/i.test(error instanceof Error ? error.message : String(error));
}
function isCheckViolation(error: unknown): boolean {
  return /CHECK constraint failed/i.test(error instanceof Error ? error.message : String(error));
}
function isForeignKeyViolation(error: unknown): boolean {
  return /FOREIGN KEY constraint failed/i.test(
    error instanceof Error ? error.message : String(error),
  );
}

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

// ---- the directory ---------------------------------------------------------

export interface UserRow {
  userId: string;
  userType: string;
  employeeNo: string | null;
  firstName: string;
  lastName: string;
  displayName: string;
  email: string;
  phone: string | null;
  status: string;
  emailVerifiedAt: string | null;
  timezone: string;
  locale: string;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** All of these are null for an EXTERNAL user, who holds no assignment. */
  jobTitle: string | null;
  department: string | null;
  assignmentLevel: string | null;
  countryName: string | null;
  affiliateName: string | null;
  businessUnitName: string | null;
  teamNames: string | null;
}

/**
 * One row per user, with the primary assignment attached.
 *
 * The assignment join is correlated to a single row rather than joined
 * directly, because a user may hold several and a plain join would return the
 * user once per assignment and silently inflate the directory. `primary_id`
 * picks the one this product calls primary, by the rule in `PRIMARY_PICK`.
 */
const PRIMARY_PICK = `
  SELECT ua.assignment_id FROM user_assignments ua
   WHERE ua.user_id = u.user_id AND ua.active = 1
     AND ua.effective_from <= date('now')
     AND (ua.effective_to IS NULL OR ua.effective_to >= date('now'))
   ORDER BY ua.is_primary DESC, ua.effective_from DESC, ua.assignment_id
   LIMIT 1`;

const USER_SELECT = `
  SELECT u.user_id, u.user_type, u.employee_no, u.first_name, u.last_name, u.display_name,
         u.email, u.phone, u.status, u.email_verified_at, u.timezone, u.locale,
         u.last_login_at, u.created_at, u.updated_at,
         jt.title_name AS job_title, d.department_name AS department,
         ua.assignment_level, c.country_name, a.affiliate_name, b.business_unit_name,
         (SELECT group_concat(t.team_name, ', ') FROM team_members tm
            JOIN teams t ON t.team_id = tm.team_id
           WHERE tm.user_id = u.user_id AND tm.active = 1) AS team_names
  FROM users u
  LEFT JOIN user_assignments ua ON ua.assignment_id = (${PRIMARY_PICK})
  LEFT JOIN job_titles jt ON jt.job_title_id = ua.job_title_id
  LEFT JOIN departments d ON d.department_id = ua.department_id
  LEFT JOIN countries c ON c.country_id = ua.country_id
  LEFT JOIN affiliates a ON a.affiliate_id = ua.affiliate_id
  LEFT JOIN business_units b ON b.business_unit_id = ua.business_unit_id`;

function toUser(row: Record<string, unknown>): UserRow {
  return {
    userId: text(row.user_id),
    userType: text(row.user_type),
    employeeNo: nullableText(row.employee_no),
    firstName: text(row.first_name),
    lastName: text(row.last_name),
    displayName: text(row.display_name),
    email: text(row.email),
    phone: nullableText(row.phone),
    status: text(row.status),
    emailVerifiedAt: nullableText(row.email_verified_at),
    timezone: text(row.timezone),
    locale: text(row.locale),
    lastLoginAt: nullableText(row.last_login_at),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
    jobTitle: nullableText(row.job_title),
    department: nullableText(row.department),
    assignmentLevel: nullableText(row.assignment_level),
    countryName: nullableText(row.country_name),
    affiliateName: nullableText(row.affiliate_name),
    businessUnitName: nullableText(row.business_unit_name),
    teamNames: nullableText(row.team_names),
  };
}

export interface UserFilters {
  search?: string;
  status?: string;
  userType?: string;
  countryId?: string;
  affiliateId?: string;
  businessUnitId?: string;
  departmentId?: string;
  jobTitleId?: string;
  teamId?: string;
  page?: number;
}

/** Twenty-five rows a page. Stated here so the interface and the API agree. */
export const PAGE_SIZE = 25;

export interface UserPage {
  items: UserRow[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

/**
 * Filter and search in the database, never in the browser.
 *
 * Filters combine with AND: each one narrows. Search is one term ORed across
 * display name, email and employee number, so a person typing "musembi" or
 * "EMP-1002" finds the same row.
 *
 * Every assignment filter is applied to the primary assignment the directory
 * shows, so what is filtered is what is displayed. A filter that matched a
 * historical assignment while the row displayed the current one would be
 * indefensible to a person reading the screen.
 */
export async function listUsers(db: Client, filters: UserFilters): Promise<UserPage> {
  const where: string[] = [];
  const args: unknown[] = [];

  const search = (filters.search ?? '').trim();
  if (search !== '') {
    // COLLATE NOCASE explicitly: `display_name` and `employee_no` do not carry
    // it in their definitions the way `email` does, so a bare LIKE would be
    // case-sensitive on two of the three columns and a user would see search
    // work for their email and not their name.
    where.push(
      `(u.display_name LIKE ? COLLATE NOCASE OR u.email LIKE ? COLLATE NOCASE OR IFNULL(u.employee_no,'') LIKE ? COLLATE NOCASE)`,
    );
    const like = `%${search}%`;
    args.push(like, like, like);
  }
  const eq = (column: string, value: string | undefined) => {
    if (value !== undefined && value !== '') {
      where.push(`${column} = ?`);
      args.push(value);
    }
  };
  eq('u.status', filters.status);
  eq('u.user_type', filters.userType);
  eq('ua.country_id', filters.countryId);
  eq('ua.affiliate_id', filters.affiliateId);
  eq('ua.business_unit_id', filters.businessUnitId);
  eq('ua.department_id', filters.departmentId);
  eq('ua.job_title_id', filters.jobTitleId);
  if (filters.teamId !== undefined && filters.teamId !== '') {
    where.push(
      `EXISTS (SELECT 1 FROM team_members tm WHERE tm.user_id = u.user_id AND tm.team_id = ? AND tm.active = 1)`,
    );
    args.push(filters.teamId);
  }

  const clause = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';
  const page = Math.max(1, Math.floor(filters.page ?? 1));

  const counted = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM (${USER_SELECT}${clause})`,
    args: args as never[],
  });
  const total = Number(counted.rows[0]?.n ?? 0);

  const result = await db.execute({
    sql: `${USER_SELECT}${clause} ORDER BY u.display_name LIMIT ? OFFSET ?`,
    args: [...args, PAGE_SIZE, (page - 1) * PAGE_SIZE] as never[],
  });
  return {
    items: result.rows.map(toUser),
    total,
    page,
    pageSize: PAGE_SIZE,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
  };
}

export async function getUser(db: Client, id: string): Promise<UserRow | null> {
  const result = await db.execute({
    sql: `${USER_SELECT} WHERE u.user_id = ? LIMIT 1`,
    args: [id],
  });
  const row = result.rows[0];
  return row ? toUser(row) : null;
}

function userState(row: UserRow) {
  return {
    firstName: row.firstName,
    lastName: row.lastName,
    displayName: row.displayName,
    email: row.email,
    employeeNo: row.employeeNo,
    phone: row.phone,
    timezone: row.timezone,
    locale: row.locale,
    status: row.status,
    emailVerified: row.emailVerifiedAt !== null,
  };
}

// ---- creating a user, and the invitation that goes with it -----------------

export interface CreatedUser {
  user: UserRow;
  /** Present only where the environment permits showing it; never stored. */
  invitationToken: string;
}

async function emailClash(
  db: Client,
  email: string,
  excludeId: string | null,
): Promise<FieldError[]> {
  // `users.email` is COLLATE NOCASE UNIQUE, so this comparison is
  // case-insensitive in the database and GABRIEL@... clashes with gabriel@...
  const result = await db.execute({
    sql: `SELECT user_id, display_name FROM users WHERE email = ? AND user_id IS NOT ?`,
    args: [email, excludeId],
  });
  const row = result.rows[0];
  return row
    ? [
        {
          field: 'email',
          message: `That email address already belongs to ${text(row.display_name)}.`,
        },
      ]
    : [];
}

async function employeeClash(
  db: Client,
  employeeNo: string | null,
  excludeId: string | null,
): Promise<FieldError[]> {
  if (employeeNo === null) return [];
  const result = await db.execute({
    sql: `SELECT display_name FROM users WHERE employee_no = ? AND user_id IS NOT ?`,
    args: [employeeNo, excludeId],
  });
  const row = result.rows[0];
  return row
    ? [
        {
          field: 'employeeNo',
          message: `That employee number already belongs to ${text(row.display_name)}.`,
        },
      ]
    : [];
}

/**
 * Create a user as INVITED, with a verification token, in one write.
 *
 * INVITED and not ACTIVE, because the table CHECK refuses an ACTIVE user with a
 * null `email_verified_at` and a new user has verified nothing. The invitation
 * in section 11 is the only route to ACTIVE, and it is a route the database
 * enforces rather than a convention this code follows.
 *
 * The user row, the token row and the audit row are one batch. A user created
 * without a token would be an account nobody could ever activate.
 */
export async function createUser(
  db: Client,
  input: CreateUserInput,
  invitation: {
    tokenId: string;
    tokenHash: string;
    issuedAt: string;
    expiresAt: string;
    rawToken: string;
  },
  ctx: WriteContext,
): Promise<WriteResult<CreatedUser>> {
  const clash = [
    ...(await emailClash(db, input.email, null)),
    ...(await employeeClash(db, input.employeeNo, null)),
  ];
  if (clash.length > 0) return { ok: false, kind: 'conflict', fields: clash };

  const userId = newId('USR');
  const stamp = toDbTimestamp(ctx.now);
  const after = {
    userType: input.userType,
    firstName: input.firstName,
    lastName: input.lastName,
    displayName: input.displayName,
    email: input.email,
    employeeNo: input.employeeNo,
    phone: input.phone,
    timezone: input.timezone,
    locale: input.locale,
    status: 'INVITED',
  };
  try {
    await db.batch(
      [
        {
          sql: `INSERT INTO users (user_id, user_type, employee_no, first_name, last_name, display_name,
                  email, phone, status, email_verified_at, timezone, locale, last_login_at, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'INVITED', NULL, ?, ?, NULL, ?, ?)`,
          args: [
            userId,
            input.userType,
            input.employeeNo,
            input.firstName,
            input.lastName,
            input.displayName,
            input.email,
            input.phone,
            input.timezone,
            input.locale,
            stamp,
            stamp,
          ],
        },
        {
          // Only the hash. The raw token is in the return value and nowhere else.
          sql: `INSERT INTO email_verification_tokens
                  (verification_token_id, user_id, token_hash, issued_at, expires_at, used_at, status)
                VALUES (?, ?, ?, ?, ?, NULL, 'PENDING')`,
          args: [
            invitation.tokenId,
            userId,
            invitation.tokenHash,
            invitation.issuedAt,
            invitation.expiresAt,
          ],
        },
        // The audit row records who was created. It does not record the token,
        // the hash, or the fact that either exists in a form anybody could use.
        audit(ctx, 'USER_CREATED', 'USER', userId, 'CREATE', null, after),
      ],
      'write',
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      const fields = [
        ...(await emailClash(db, input.email, null)),
        ...(await employeeClash(db, input.employeeNo, null)),
      ];
      return {
        ok: false,
        kind: 'conflict',
        fields:
          fields.length > 0
            ? fields
            : [{ field: 'email', message: 'That value is already in use.' }],
      };
    }
    throw error;
  }
  const user = await getUser(db, userId);
  return user
    ? { ok: true, value: { user, invitationToken: invitation.rawToken } }
    : { ok: false, kind: 'not_found' };
}

/**
 * The status an account moves to when its email address changes.
 *
 * INVITED rather than SUSPENDED. The table CHECK forbids an ACTIVE user with a
 * null `email_verified_at`, so the status has to move; the question is where.
 * SUSPENDED reads as an administrative sanction and would show that way in
 * every list and report, which would be a false statement about somebody whose
 * only act was to change their address. INVITED says what is actually true:
 * awaiting verification, exactly as a new account is.
 */
export const STATUS_AFTER_EMAIL_CHANGE = 'INVITED';

export interface UpdatedUser {
  user: UserRow;
  emailChanged: boolean;
  /** Issued only when the email changed, and only returned where permitted. */
  invitationToken: string | null;
}

/**
 * Edit a user.
 *
 * When the email changes, four things happen in one batch and cannot happen
 * separately: the address is stored, `email_verified_at` is cleared, the status
 * moves out of ACTIVE, and a fresh verification token is issued. Doing them in
 * sequence would leave a window where the row violates its own CHECK, and the
 * database would reject the update halfway with the address already changed.
 */
export async function updateUser(
  db: Client,
  id: string,
  input: UpdateUserInput,
  invitation: {
    tokenId: string;
    tokenHash: string;
    issuedAt: string;
    expiresAt: string;
    rawToken: string;
  },
  ctx: WriteContext,
): Promise<WriteResult<UpdatedUser>> {
  const before = await getUser(db, id);
  if (!before) return { ok: false, kind: 'not_found' };

  const clash = [
    ...(await emailClash(db, input.email, id)),
    ...(await employeeClash(db, input.employeeNo, id)),
  ];
  if (clash.length > 0) return { ok: false, kind: 'conflict', fields: clash };

  const emailChanged = input.email.toLowerCase() !== before.email.toLowerCase();
  const status = emailChanged ? STATUS_AFTER_EMAIL_CHANGE : input.status;

  // Asking for ACTIVE without a verified address is a field message, not a
  // constraint error. The CHECK would refuse it either way; this says why.
  if (!emailChanged && status === 'ACTIVE' && before.emailVerifiedAt === null) {
    return {
      ok: false,
      kind: 'invalid_reference',
      fields: [
        {
          field: 'status',
          message:
            'This user cannot be made active until their email address is verified. Send them an invitation instead.',
        },
      ],
    };
  }

  const after = {
    firstName: input.firstName,
    lastName: input.lastName,
    displayName: input.displayName,
    email: input.email,
    employeeNo: input.employeeNo,
    phone: input.phone,
    timezone: input.timezone,
    locale: input.locale,
    status,
    emailVerified: emailChanged ? false : before.emailVerifiedAt !== null,
  };

  const statements: Stmt[] = [
    {
      sql: `UPDATE users SET first_name = ?, last_name = ?, display_name = ?, email = ?,
              employee_no = ?, phone = ?, timezone = ?, locale = ?, status = ?,
              email_verified_at = CASE WHEN ? = 1 THEN NULL ELSE email_verified_at END,
              updated_at = ?
            WHERE user_id = ?`,
      args: [
        input.firstName,
        input.lastName,
        input.displayName,
        input.email,
        input.employeeNo,
        input.phone,
        input.timezone,
        input.locale,
        status,
        emailChanged ? 1 : 0,
        toDbTimestamp(ctx.now),
        id,
      ],
    },
  ];

  if (emailChanged) {
    // Any invitation outstanding against the old address is revoked, so a link
    // sent to an address the person no longer controls stops working.
    statements.push({
      sql: `UPDATE email_verification_tokens SET status = 'REVOKED'
            WHERE user_id = ? AND status = 'PENDING'`,
      args: [id],
    });
    statements.push({
      sql: `INSERT INTO email_verification_tokens
              (verification_token_id, user_id, token_hash, issued_at, expires_at, used_at, status)
            VALUES (?, ?, ?, ?, ?, NULL, 'PENDING')`,
      args: [
        invitation.tokenId,
        id,
        invitation.tokenHash,
        invitation.issuedAt,
        invitation.expiresAt,
      ],
    });
    // The old and new addresses are the point of this record, so they are in
    // it. Nothing else about the token is.
    statements.push(
      audit(
        ctx,
        'USER_EMAIL_CHANGED',
        'USER',
        id,
        'UPDATE',
        { email: before.email },
        { email: input.email },
      ),
    );
  }

  const event =
    status === before.status
      ? 'USER_UPDATED'
      : status === 'SUSPENDED'
        ? 'USER_SUSPENDED'
        : before.status === 'SUSPENDED' && status === 'ACTIVE'
          ? 'USER_REACTIVATED'
          : 'USER_UPDATED';
  statements.push(audit(ctx, event, 'USER', id, 'UPDATE', userState(before), after));

  try {
    await db.batch(statements, 'write');
  } catch (error) {
    if (isUniqueViolation(error)) {
      return {
        ok: false,
        kind: 'conflict',
        fields: [
          ...(await emailClash(db, input.email, id)),
          ...(await employeeClash(db, input.employeeNo, id)),
        ],
      };
    }
    if (isCheckViolation(error)) {
      return {
        ok: false,
        kind: 'invalid_reference',
        fields: [
          {
            field: 'status',
            message: 'This user cannot be made active until their email address is verified.',
          },
        ],
      };
    }
    throw error;
  }

  const user = await getUser(db, id);
  return user
    ? {
        ok: true,
        value: { user, emailChanged, invitationToken: emailChanged ? invitation.rawToken : null },
      }
    : { ok: false, kind: 'not_found' };
}

// ---- assignments -----------------------------------------------------------

export interface AssignmentRow {
  assignmentId: string;
  userId: string;
  jobTitleId: string;
  jobTitle: string;
  departmentId: string;
  department: string;
  level: string;
  countryId: string | null;
  countryName: string | null;
  affiliateId: string | null;
  affiliateName: string | null;
  businessUnitId: string | null;
  businessUnitName: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  isPrimary: boolean;
  active: boolean;
  /** Whether this row is the assignment in force today. */
  current: boolean;
}

const ASSIGNMENT_SELECT = `
  SELECT ua.assignment_id, ua.user_id, ua.job_title_id, ua.department_id, ua.assignment_level,
         ua.country_id, ua.affiliate_id, ua.business_unit_id, ua.effective_from, ua.effective_to,
         ua.is_primary, ua.active,
         jt.title_name, d.department_name, c.country_name, a.affiliate_name, b.business_unit_name,
         CASE WHEN ua.active = 1 AND ua.effective_from <= date('now')
                   AND (ua.effective_to IS NULL OR ua.effective_to >= date('now'))
              THEN 1 ELSE 0 END AS is_current
  FROM user_assignments ua
  JOIN job_titles jt ON jt.job_title_id = ua.job_title_id
  JOIN departments d ON d.department_id = ua.department_id
  LEFT JOIN countries c ON c.country_id = ua.country_id
  LEFT JOIN affiliates a ON a.affiliate_id = ua.affiliate_id
  LEFT JOIN business_units b ON b.business_unit_id = ua.business_unit_id`;

function toAssignment(row: Record<string, unknown>): AssignmentRow {
  return {
    assignmentId: text(row.assignment_id),
    userId: text(row.user_id),
    jobTitleId: text(row.job_title_id),
    jobTitle: text(row.title_name),
    departmentId: text(row.department_id),
    department: text(row.department_name),
    level: text(row.assignment_level),
    countryId: nullableText(row.country_id),
    countryName: nullableText(row.country_name),
    affiliateId: nullableText(row.affiliate_id),
    affiliateName: nullableText(row.affiliate_name),
    businessUnitId: nullableText(row.business_unit_id),
    businessUnitName: nullableText(row.business_unit_name),
    effectiveFrom: text(row.effective_from),
    effectiveTo: nullableText(row.effective_to),
    isPrimary: flag(row.is_primary),
    active: flag(row.active),
    current: flag(row.is_current),
  };
}

export async function listAssignments(db: Client, userId: string): Promise<AssignmentRow[]> {
  const result = await db.execute({
    sql: `${ASSIGNMENT_SELECT} WHERE ua.user_id = ?
          ORDER BY is_current DESC, ua.is_primary DESC, ua.effective_from DESC, ua.assignment_id`,
    args: [userId],
  });
  return result.rows.map(toAssignment);
}

export async function getAssignment(db: Client, id: string): Promise<AssignmentRow | null> {
  const result = await db.execute({
    sql: `${ASSIGNMENT_SELECT} WHERE ua.assignment_id = ? LIMIT 1`,
    args: [id],
  });
  const row = result.rows[0];
  return row ? toAssignment(row) : null;
}

function assignmentState(row: AssignmentRow) {
  return {
    jobTitleId: row.jobTitleId,
    departmentId: row.departmentId,
    level: row.level,
    countryId: row.countryId,
    affiliateId: row.affiliateId,
    businessUnitId: row.businessUnitId,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    isPrimary: row.isPrimary,
    active: row.active,
  };
}

/**
 * THE PRIMARY ASSIGNMENT RULE
 *
 * At most one *active, currently effective* assignment carries `is_primary = 1`
 * per user. Setting a new primary demotes the previous one to `is_primary = 0`
 * in the same batch. The demoted row is not ended, deactivated or altered in
 * any other way: it remains a live assignment that simply is not the primary
 * one, which is what a person holding two posts actually looks like.
 *
 * The database does not enforce this, so this function is the enforcement, and
 * the demotion is part of the same write as the promotion. Two primaries would
 * make Build Prompt 04's header, which reads the primary assignment to render
 * the organisational context, pick one arbitrarily and show a different answer
 * on different requests.
 *
 * A historical row is never rewritten. Superseding an assignment means ending
 * it, per `endAssignment` below, and inserting a new one.
 */
const DEMOTE_OTHER_PRIMARIES: Stmt = {
  sql: `UPDATE user_assignments SET is_primary = 0
        WHERE user_id = ? AND assignment_id IS NOT ? AND active = 1
          AND effective_from <= date('now')
          AND (effective_to IS NULL OR effective_to >= date('now'))`,
  args: [],
};

async function checkAssignmentReferences(
  db: Client,
  input: AssignmentInput,
): Promise<FieldError[]> {
  const errors: FieldError[] = [];
  const exists = async (table: string, column: string, id: string) => {
    const r = await db.execute({
      sql: `SELECT active FROM ${table} WHERE ${column} = ? LIMIT 1`,
      args: [id],
    });
    return r.rows[0];
  };
  const title = await exists('job_titles', 'job_title_id', input.jobTitleId);
  if (!title) errors.push({ field: 'jobTitleId', message: 'That job title does not exist.' });
  else if (!flag(title.active)) {
    errors.push({ field: 'jobTitleId', message: 'That job title is deactivated.' });
  }
  const department = await exists('departments', 'department_id', input.departmentId);
  if (!department) {
    errors.push({ field: 'departmentId', message: 'That department does not exist.' });
  }
  return errors;
}

export async function createAssignment(
  db: Client,
  userId: string,
  input: AssignmentInput,
  ctx: WriteContext,
): Promise<WriteResult<AssignmentRow>> {
  const user = await getUser(db, userId);
  if (!user) return { ok: false, kind: 'not_found' };

  const reference = await checkAssignmentReferences(db, input);
  if (reference.length > 0) return { ok: false, kind: 'invalid_reference', fields: reference };

  const assignmentId = newId('UA');
  const after = {
    userId,
    jobTitleId: input.jobTitleId,
    departmentId: input.departmentId,
    level: input.level,
    countryId: input.countryId,
    affiliateId: input.affiliateId,
    businessUnitId: input.businessUnitId,
    effectiveFrom: input.effectiveFrom,
    effectiveTo: input.effectiveTo,
    isPrimary: input.isPrimary,
    active: input.active,
  };

  const statements: Stmt[] = [];
  if (input.isPrimary) {
    statements.push({ ...DEMOTE_OTHER_PRIMARIES, args: [userId, assignmentId] });
  }
  statements.push({
    sql: `INSERT INTO user_assignments (assignment_id, user_id, job_title_id, department_id,
            assignment_level, country_id, affiliate_id, business_unit_id,
            effective_from, effective_to, is_primary, active, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      assignmentId,
      userId,
      input.jobTitleId,
      input.departmentId,
      input.level,
      input.countryId,
      input.affiliateId,
      input.businessUnitId,
      input.effectiveFrom,
      input.effectiveTo,
      input.isPrimary ? 1 : 0,
      input.active ? 1 : 0,
      toDbTimestamp(ctx.now),
    ],
  });
  statements.push(
    audit(ctx, 'ASSIGNMENT_CREATED', 'USER_ASSIGNMENT', assignmentId, 'CREATE', null, after),
  );

  try {
    await db.batch(statements, 'write');
  } catch (error) {
    if (isCheckViolation(error)) {
      return {
        ok: false,
        kind: 'invalid_reference',
        fields: [
          {
            field: 'level',
            message:
              'That combination of level and location is not allowed. A Group assignment carries no location, and every other level requires its own.',
          },
        ],
      };
    }
    if (isForeignKeyViolation(error)) {
      return {
        ok: false,
        kind: 'invalid_reference',
        fields: [{ field: 'jobTitleId', message: 'One of the chosen references does not exist.' }],
      };
    }
    throw error;
  }
  const created = await getAssignment(db, assignmentId);
  return created ? { ok: true, value: created } : { ok: false, kind: 'not_found' };
}

/**
 * Edit an assignment in place, or supersede it.
 *
 * The primary flag, the effective dates and the active flag are editable. The
 * level and its location are not: changing where an assignment sits is a
 * different posting, and rewriting the row would erase the record that the
 * person ever held the first one. Supersede instead.
 */
export async function updateAssignment(
  db: Client,
  id: string,
  input: { effectiveTo: string | null; isPrimary: boolean; active: boolean },
  ctx: WriteContext,
): Promise<WriteResult<AssignmentRow>> {
  const before = await getAssignment(db, id);
  if (!before) return { ok: false, kind: 'not_found' };

  if (input.effectiveTo !== null && input.effectiveTo < before.effectiveFrom) {
    return {
      ok: false,
      kind: 'invalid_reference',
      fields: [
        {
          field: 'effectiveTo',
          message: `The end date cannot be before ${before.effectiveFrom}, when the assignment started.`,
        },
      ],
    };
  }

  const after = { ...assignmentState(before), ...input };
  const statements: Stmt[] = [];
  // Promotion demotes the incumbent, in the same write. Demotion does not
  // promote anybody: leaving a user with no primary is a state an
  // administrator can see and fix, and guessing a replacement is not.
  if (input.isPrimary && !before.isPrimary) {
    statements.push({ ...DEMOTE_OTHER_PRIMARIES, args: [before.userId, id] });
  }
  statements.push({
    sql: `UPDATE user_assignments SET effective_to = ?, is_primary = ?, active = ? WHERE assignment_id = ?`,
    args: [input.effectiveTo, input.isPrimary ? 1 : 0, input.active ? 1 : 0, id],
  });
  statements.push(
    audit(
      ctx,
      'ASSIGNMENT_UPDATED',
      'USER_ASSIGNMENT',
      id,
      'UPDATE',
      assignmentState(before),
      after,
    ),
  );

  try {
    await db.batch(statements, 'write');
  } catch (error) {
    if (isCheckViolation(error)) {
      return {
        ok: false,
        kind: 'invalid_reference',
        fields: [
          { field: 'effectiveTo', message: 'The end date cannot be before the start date.' },
        ],
      };
    }
    throw error;
  }
  const updated = await getAssignment(db, id);
  return updated ? { ok: true, value: updated } : { ok: false, kind: 'not_found' };
}

/**
 * CHANGING SOMEBODY'S JOB TITLE, WITHOUT REWRITING WHERE THEY HAVE BEEN.
 *
 * The user Edit screen offers one control for a title, because "what is this
 * person's job title" is the question an administrator actually has. But a
 * title is not a column on `users` and is not copied onto one: it is a
 * property of an ASSIGNMENT, and the assignment is authoritative. So this ends
 * the current primary assignment and inserts a superseding one carrying the
 * new title at the same department, level and location.
 *
 * WHY SUPERSEDE RATHER THAN UPDATE `job_title_id` IN PLACE. `updateAssignment`
 * above deliberately refuses to change an assignment's level or location,
 * under the stated rule that "a historical row is never rewritten" — the
 * record that somebody held the earlier post is the point of keeping it. A
 * title is the same kind of fact. Updating the column would make it impossible
 * to answer "who was the Credit Controller in March", which is exactly the
 * question an audit asks. Superseding answers it from the rows.
 *
 * THE OLD ROW IS ENDED, NOT DELETED AND NOT DEACTIVATED WITHOUT AN END DATE:
 * `effective_to` is set to today and `active` to 0, which is what
 * `is_current` reads, so the assignment stops being in force from now while
 * the row that says it once was stays exactly as written.
 *
 * NO CURRENT ASSIGNMENT MEANS NO TITLE TO CHANGE. `user_assignments` requires
 * a department and a level with its matching location, and neither can be
 * invented from a title. The refusal names the tab that can create one rather
 * than guessing a placement, because guessing an organisational placement is a
 * worse answer than asking for it.
 */
export async function changePrimaryJobTitle(
  db: Client,
  userId: string,
  jobTitleId: string,
  ctx: WriteContext,
): Promise<WriteResult<AssignmentRow>> {
  const user = await getUser(db, userId);
  if (!user) return { ok: false, kind: 'not_found' };

  const assignments = await listAssignments(db, userId);
  const current =
    assignments.find((a) => a.current && a.isPrimary) ?? assignments.find((a) => a.current);
  if (current === undefined) {
    return {
      ok: false,
      kind: 'invalid_reference',
      fields: [
        {
          field: 'jobTitleId',
          message:
            'This person has no current assignment, so there is no title to change. Add one on the Assignments tab.',
        },
      ],
    };
  }
  if (current.jobTitleId === jobTitleId) return { ok: true, value: current };

  const title = await db.execute({
    sql: `SELECT title_name, active FROM job_titles WHERE job_title_id = ? LIMIT 1`,
    args: [jobTitleId],
  });
  const titleRow = title.rows[0];
  if (!titleRow) {
    return {
      ok: false,
      kind: 'invalid_reference',
      fields: [{ field: 'jobTitleId', message: 'That job title does not exist.' }],
    };
  }
  if (!flag(titleRow.active)) {
    return {
      ok: false,
      kind: 'invalid_reference',
      fields: [{ field: 'jobTitleId', message: 'That job title is deactivated.' }],
    };
  }

  const today = isoDay(ctx.now);
  // An assignment cannot end before it began. Somebody who was posted today and
  // whose title is corrected the same day gets the end date pinned to the start
  // date, which the table's own CHECK requires.
  const endsAt = today < current.effectiveFrom ? current.effectiveFrom : today;
  const assignmentId = newId('UA');
  const after = {
    userId,
    jobTitleId,
    jobTitle: text(titleRow.title_name),
    departmentId: current.departmentId,
    level: current.level,
    countryId: current.countryId,
    affiliateId: current.affiliateId,
    businessUnitId: current.businessUnitId,
    effectiveFrom: today,
    supersedes: current.assignmentId,
  };

  const statements: Stmt[] = [
    {
      sql: `UPDATE user_assignments SET effective_to = ?, active = 0, is_primary = 0
            WHERE assignment_id = ?`,
      args: [endsAt, current.assignmentId],
    },
    {
      sql: `INSERT INTO user_assignments (assignment_id, user_id, job_title_id, department_id,
              assignment_level, country_id, affiliate_id, business_unit_id,
              effective_from, effective_to, is_primary, active, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, 1, ?)`,
      args: [
        assignmentId,
        userId,
        jobTitleId,
        current.departmentId,
        current.level,
        current.countryId,
        current.affiliateId,
        current.businessUnitId,
        today,
        toDbTimestamp(ctx.now),
      ],
    },
    // One event, on the user, because "their title changed" is the fact an
    // administrator searches for. Both assignment ids are in the payload, so
    // the two rows it moved between are still reachable from it.
    audit(
      ctx,
      'JOB_TITLE_CHANGED',
      'USER',
      userId,
      'UPDATE',
      {
        jobTitleId: current.jobTitleId,
        jobTitle: current.jobTitle,
        assignmentId: current.assignmentId,
        endedAt: endsAt,
      },
      { ...after, assignmentId },
    ),
  ];

  try {
    await db.batch(statements, 'write');
  } catch (error) {
    if (isForeignKeyViolation(error) || isCheckViolation(error)) {
      return {
        ok: false,
        kind: 'invalid_reference',
        fields: [
          { field: 'jobTitleId', message: 'That title could not be applied to this assignment.' },
        ],
      };
    }
    throw error;
  }
  const created = await getAssignment(db, assignmentId);
  return created ? { ok: true, value: created } : { ok: false, kind: 'not_found' };
}

// ---- job titles ------------------------------------------------------------

export interface JobTitleRow {
  jobTitleId: string;
  titleName: string;
  departmentId: string | null;
  department: string | null;
  description: string | null;
  active: boolean;
  /** How many users hold this title. Three hold Finance Manager in the seed. */
  holderCount: number;
}

const JOB_TITLE_SELECT = `
  SELECT jt.job_title_id, jt.title_name, jt.department_id, jt.description, jt.active,
         d.department_name,
         (SELECT COUNT(DISTINCT ua.user_id) FROM user_assignments ua
           WHERE ua.job_title_id = jt.job_title_id AND ua.active = 1) AS holder_count
  FROM job_titles jt
  LEFT JOIN departments d ON d.department_id = jt.department_id`;

function toJobTitle(row: Record<string, unknown>): JobTitleRow {
  return {
    jobTitleId: text(row.job_title_id),
    titleName: text(row.title_name),
    departmentId: nullableText(row.department_id),
    department: nullableText(row.department_name),
    description: nullableText(row.description),
    active: flag(row.active),
    holderCount: Number(row.holder_count ?? 0),
  };
}

export async function listJobTitles(db: Client): Promise<JobTitleRow[]> {
  const result = await db.execute(`${JOB_TITLE_SELECT} ORDER BY jt.title_name`);
  return result.rows.map(toJobTitle);
}

export async function getJobTitle(db: Client, id: string): Promise<JobTitleRow | null> {
  const result = await db.execute({
    sql: `${JOB_TITLE_SELECT} WHERE jt.job_title_id = ? LIMIT 1`,
    args: [id],
  });
  const row = result.rows[0];
  return row ? toJobTitle(row) : null;
}

async function titleClash(
  db: Client,
  name: string,
  excludeId: string | null,
): Promise<FieldError[]> {
  const result = await db.execute({
    sql: `SELECT job_title_id FROM job_titles WHERE title_name = ? AND job_title_id IS NOT ?`,
    args: [name, excludeId],
  });
  return result.rows.length === 0
    ? []
    : [{ field: 'titleName', message: 'A job title with that name already exists.' }];
}

export async function createJobTitle(
  db: Client,
  input: JobTitleInput,
  ctx: WriteContext,
): Promise<WriteResult<JobTitleRow>> {
  const clash = await titleClash(db, input.titleName, null);
  if (clash.length > 0) return { ok: false, kind: 'conflict', fields: clash };

  const jobTitleId = newId('JT');
  const after = {
    titleName: input.titleName,
    departmentId: input.departmentId,
    description: input.description,
    active: input.active,
  };
  try {
    await db.batch(
      [
        {
          sql: `INSERT INTO job_titles (job_title_id, title_name, department_id, description, active, created_at)
                VALUES (?, ?, ?, ?, ?, ?)`,
          args: [
            jobTitleId,
            input.titleName,
            input.departmentId,
            input.description,
            input.active ? 1 : 0,
            toDbTimestamp(ctx.now),
          ],
        },
        audit(ctx, 'JOB_TITLE_CREATED', 'JOB_TITLE', jobTitleId, 'CREATE', null, after),
      ],
      'write',
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      return { ok: false, kind: 'conflict', fields: await titleClash(db, input.titleName, null) };
    }
    throw error;
  }
  const created = await getJobTitle(db, jobTitleId);
  return created ? { ok: true, value: created } : { ok: false, kind: 'not_found' };
}

export async function updateJobTitle(
  db: Client,
  id: string,
  input: JobTitleInput,
  ctx: WriteContext,
): Promise<WriteResult<JobTitleRow>> {
  const before = await getJobTitle(db, id);
  if (!before) return { ok: false, kind: 'not_found' };

  const clash = await titleClash(db, input.titleName, id);
  if (clash.length > 0) return { ok: false, kind: 'conflict', fields: clash };

  const after = {
    titleName: input.titleName,
    departmentId: input.departmentId,
    description: input.description,
    active: input.active,
  };
  try {
    await db.batch(
      [
        {
          sql: `UPDATE job_titles SET title_name = ?, department_id = ?, description = ?, active = ?
                WHERE job_title_id = ?`,
          args: [input.titleName, input.departmentId, input.description, input.active ? 1 : 0, id],
        },
        audit(
          ctx,
          'JOB_TITLE_UPDATED',
          'JOB_TITLE',
          id,
          before.active === input.active ? 'UPDATE' : input.active ? 'ACTIVATE' : 'DEACTIVATE',
          {
            titleName: before.titleName,
            departmentId: before.departmentId,
            description: before.description,
            active: before.active,
          },
          after,
        ),
      ],
      'write',
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      return { ok: false, kind: 'conflict', fields: await titleClash(db, input.titleName, id) };
    }
    throw error;
  }
  const updated = await getJobTitle(db, id);
  return updated ? { ok: true, value: updated } : { ok: false, kind: 'not_found' };
}

// ---- source identities -----------------------------------------------------

export interface SourceIdentityRow {
  sourceIdentityId: string;
  sourceSystemId: string;
  sourceSystem: string;
  userId: string;
  displayName: string;
  externalUsername: string;
  affiliateId: string | null;
  affiliateName: string | null;
  active: boolean;
}

/** Named columns only: `users` holds a password hash and this row is returned. */
const SOURCE_IDENTITY_SELECT = `
  SELECT si.source_identity_id, si.source_system_id, si.user_id, si.external_username,
         si.affiliate_id, si.active,
         ss.system_name, u.display_name, a.affiliate_name
  FROM source_identities si
  JOIN source_systems ss ON ss.source_system_id = si.source_system_id
  JOIN users u ON u.user_id = si.user_id
  LEFT JOIN affiliates a ON a.affiliate_id = si.affiliate_id`;

function toSourceIdentity(row: Record<string, unknown>): SourceIdentityRow {
  return {
    sourceIdentityId: text(row.source_identity_id),
    sourceSystemId: text(row.source_system_id),
    sourceSystem: text(row.system_name),
    userId: text(row.user_id),
    displayName: text(row.display_name),
    externalUsername: text(row.external_username),
    affiliateId: nullableText(row.affiliate_id),
    affiliateName: nullableText(row.affiliate_name),
    active: flag(row.active),
  };
}

export async function listSourceIdentities(
  db: Client,
  userId?: string,
): Promise<SourceIdentityRow[]> {
  const result = userId
    ? await db.execute({
        sql: `${SOURCE_IDENTITY_SELECT} WHERE si.user_id = ? ORDER BY ss.system_name, si.external_username`,
        args: [userId],
      })
    : await db.execute(`${SOURCE_IDENTITY_SELECT} ORDER BY ss.system_name, si.external_username`);
  return result.rows.map(toSourceIdentity);
}

/**
 * Map an external username to an existing user.
 *
 * `UNIQUE(source_system_id, external_username)` with `external_username`
 * `COLLATE NOCASE` means one mapping per system per name, and that
 * `GABRIEL.MUSEMBI` and `gabriel.musembi` are the same row. The clash message
 * names the person who already holds it, because "already exists" leaves an
 * administrator with nowhere to go.
 *
 * This never creates a user. `userId` selects one that exists, and a missing
 * one is a validation failure rather than an invitation to invent an account.
 */
export async function mapSourceIdentity(
  db: Client,
  input: SourceIdentityInput,
  ctx: WriteContext,
): Promise<WriteResult<SourceIdentityRow>> {
  const user = await getUser(db, input.userId);
  if (!user) {
    return {
      ok: false,
      kind: 'invalid_reference',
      fields: [{ field: 'userId', message: 'That person does not exist. Create the user first.' }],
    };
  }

  const taken = async (): Promise<FieldError[]> => {
    const result = await db.execute({
      sql: `SELECT u.display_name FROM source_identities si JOIN users u ON u.user_id = si.user_id
            WHERE si.source_system_id = ? AND si.external_username = ?`,
      args: [input.sourceSystemId, input.externalUsername],
    });
    const row = result.rows[0];
    return row
      ? [
          {
            field: 'externalUsername',
            message: `That username is already mapped to ${text(row.display_name)} on this system.`,
          },
        ]
      : [];
  };
  const clash = await taken();
  if (clash.length > 0) return { ok: false, kind: 'conflict', fields: clash };

  const sourceIdentityId = newId('SI');
  const after = {
    sourceSystemId: input.sourceSystemId,
    userId: input.userId,
    externalUsername: input.externalUsername,
    affiliateId: input.affiliateId,
    active: input.active,
  };
  try {
    await db.batch(
      [
        {
          sql: `INSERT INTO source_identities (source_identity_id, source_system_id, user_id,
                  external_username, affiliate_id, active, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)`,
          args: [
            sourceIdentityId,
            input.sourceSystemId,
            input.userId,
            input.externalUsername,
            input.affiliateId,
            input.active ? 1 : 0,
            toDbTimestamp(ctx.now),
          ],
        },
        audit(
          ctx,
          'SOURCE_IDENTITY_MAPPED',
          'SOURCE_IDENTITY',
          sourceIdentityId,
          'CREATE',
          null,
          after,
        ),
      ],
      'write',
    );
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, kind: 'conflict', fields: await taken() };
    if (isForeignKeyViolation(error)) {
      return {
        ok: false,
        kind: 'invalid_reference',
        fields: [{ field: 'sourceSystemId', message: 'That source system does not exist.' }],
      };
    }
    throw error;
  }
  const rows = await listSourceIdentities(db, input.userId);
  const created = rows.find((r) => r.sourceIdentityId === sourceIdentityId);
  return created ? { ok: true, value: created } : { ok: false, kind: 'not_found' };
}

// ---- what the detail page's other tabs read --------------------------------

export interface SecurityView {
  status: string;
  emailVerifiedAt: string | null;
  lastLoginAt: string | null;
  hasCredential: boolean;
  mfaEnabled: boolean;
  recentAttempts: { at: string; success: boolean; reason: string | null; ip: string | null }[];
}

/**
 * The Security tab.
 *
 * Booleans, never values. `hasCredential` is `COUNT(*) > 0` and not the hash;
 * `mfaEnabled` is a flag and not the secret. There is no query in this file
 * that selects `password_hash`, `refresh_token_hash` or `secret_encrypted`, so
 * none of them can reach a response by being spread out of a row.
 */
export async function getSecurity(db: Client, userId: string): Promise<SecurityView | null> {
  const user = await getUser(db, userId);
  if (!user) return null;

  const credential = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM auth_credentials WHERE user_id = ?`,
    args: [userId],
  });
  const mfa = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM mfa_methods WHERE user_id = ? AND enabled = 1`,
    args: [userId],
  });
  const attempts = await db.execute({
    sql: `SELECT attempted_at, success, failure_reason, ip_address FROM login_attempts
          WHERE user_id = ? ORDER BY attempted_at DESC LIMIT 10`,
    args: [userId],
  });
  return {
    status: user.status,
    emailVerifiedAt: user.emailVerifiedAt,
    lastLoginAt: user.lastLoginAt,
    hasCredential: Number(credential.rows[0]?.n ?? 0) > 0,
    mfaEnabled: Number(mfa.rows[0]?.n ?? 0) > 0,
    recentAttempts: attempts.rows.map((row) => ({
      at: text(row.attempted_at),
      success: flag(row.success),
      reason: nullableText(row.failure_reason),
      ip: nullableText(row.ip_address),
    })),
  };
}

export interface AuditRow {
  eventType: string;
  action: string;
  actor: string | null;
  at: string;
  beforeJson: string | null;
  afterJson: string | null;
}

export interface RoleView {
  roleId: string;
  roleName: string;
  isSystemRole: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
  active: boolean;
  scopes: { scopeType: string; target: string | null }[];
}

/**
 * The Roles tab, read-only in this phase.
 *
 * Read-only is the security decision, not a shortfall: this phase does not
 * expose role assignment at all, so a user editing their own profile has no
 * path to granting themselves access. Build Prompt 07 makes it writable and
 * carries the privilege-escalation protection that then becomes load-bearing.
 */
export async function listUserRoles(db: Client, userId: string): Promise<RoleView[]> {
  const roles = await db.execute({
    sql: `SELECT ur.user_role_id, ur.role_id, ar.role_name, ar.is_system_role,
                 ur.effective_from, ur.effective_to, ur.active
          FROM user_roles ur JOIN access_roles ar ON ar.role_id = ur.role_id
          WHERE ur.user_id = ? ORDER BY ar.role_name`,
    args: [userId],
  });
  const scopes = await db.execute({
    sql: `SELECT s.user_role_id, s.scope_type,
                 COALESCE(c.country_name, a.affiliate_name, b.business_unit_name, t.team_name) AS target
          FROM user_role_scopes s
          JOIN user_roles ur ON ur.user_role_id = s.user_role_id
          LEFT JOIN countries c ON c.country_id = s.country_id
          LEFT JOIN affiliates a ON a.affiliate_id = s.affiliate_id
          LEFT JOIN business_units b ON b.business_unit_id = s.business_unit_id
          LEFT JOIN teams t ON t.team_id = s.team_id
          WHERE ur.user_id = ?`,
    args: [userId],
  });
  return roles.rows.map((row) => ({
    roleId: text(row.role_id),
    roleName: text(row.role_name),
    isSystemRole: flag(row.is_system_role),
    effectiveFrom: text(row.effective_from),
    effectiveTo: nullableText(row.effective_to),
    active: flag(row.active),
    scopes: scopes.rows
      .filter((s) => text(s.user_role_id) === text(row.user_role_id))
      .map((s) => ({ scopeType: text(s.scope_type), target: nullableText(s.target) })),
  }));
}

export interface WorkflowAuthorityView {
  assignmentId: string;
  roleCode: string;
  roleName: string;
  scopeType: string;
  target: string | null;
  priority: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  active: boolean;
}

/** The Workflow Authority tab, read-only in this phase. Build Prompt 08 owns it. */
export async function listWorkflowAuthority(
  db: Client,
  userId: string,
): Promise<WorkflowAuthorityView[]> {
  const result = await db.execute({
    sql: `SELECT wra.workflow_role_assignment_id, wr.role_code, wr.role_name, wra.scope_type,
                 COALESCE(c.country_name, a.affiliate_name, b.business_unit_name) AS target,
                 wra.priority, wra.effective_from, wra.effective_to, wra.active
          FROM workflow_role_assignments wra
          JOIN workflow_roles wr ON wr.workflow_role_id = wra.workflow_role_id
          LEFT JOIN countries c ON c.country_id = wra.country_id
          LEFT JOIN affiliates a ON a.affiliate_id = wra.affiliate_id
          LEFT JOIN business_units b ON b.business_unit_id = wra.business_unit_id
          WHERE wra.user_id = ? ORDER BY wr.role_name, wra.priority`,
    args: [userId],
  });
  return result.rows.map((row) => ({
    assignmentId: text(row.workflow_role_assignment_id),
    roleCode: text(row.role_code),
    roleName: text(row.role_name),
    scopeType: text(row.scope_type),
    target: nullableText(row.target),
    priority: Number(row.priority ?? 100),
    effectiveFrom: text(row.effective_from),
    effectiveTo: nullableText(row.effective_to),
    active: flag(row.active),
  }));
}

export interface TeamMembershipView {
  teamId: string;
  teamName: string;
  memberRole: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  active: boolean;
}

export async function listUserTeams(db: Client, userId: string): Promise<TeamMembershipView[]> {
  const result = await db.execute({
    sql: `SELECT tm.team_id, t.team_name, tm.member_role, tm.effective_from, tm.effective_to, tm.active
          FROM team_members tm JOIN teams t ON t.team_id = tm.team_id
          WHERE tm.user_id = ? ORDER BY tm.active DESC, t.team_name`,
    args: [userId],
  });
  return result.rows.map((row) => ({
    teamId: text(row.team_id),
    teamName: text(row.team_name),
    memberRole: nullableText(row.member_role),
    effectiveFrom: text(row.effective_from),
    effectiveTo: nullableText(row.effective_to),
    active: flag(row.active),
  }));
}

/** Lookups the create and edit forms need. */
export async function listSourceSystems(
  db: Client,
): Promise<{ sourceSystemId: string; systemName: string }[]> {
  const result = await db.execute(
    `SELECT source_system_id, system_name FROM source_systems WHERE active = 1 ORDER BY system_name`,
  );
  return result.rows.map((row) => ({
    sourceSystemId: text(row.source_system_id),
    systemName: text(row.system_name),
  }));
}
