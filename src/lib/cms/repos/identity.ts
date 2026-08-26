/**
 * Reading the signed-in identity.
 *
 * Every field returned to the browser is named explicitly. Nothing here spreads
 * a database row, because a spread is how `password_hash` reaches a response
 * body the day someone adds a column. The shape is a contract, and widening it
 * has to be a deliberate edit.
 *
 * Access roles and permissions only. `workflow_roles`,
 * `workflow_role_assignments` and `approval_authority_rules` are deliberately
 * not read: application access and approval authority are different things in
 * this schema, and conflating them would mean a Finance Manager title grants
 * approval rights, which is exactly what the separation exists to prevent.
 */
import type { Client } from '@libsql/client/web';

/** A permission, rendered `MODULE.RESOURCE.ACTION` from the three columns. */
export type PermissionCode = string;

export interface CmsRoleSummary {
  roleId: string;
  roleName: string;
}

export interface CmsRoleScope {
  roleId: string;
  scopeType: 'OWN' | 'TEAM' | 'BUSINESS_UNIT' | 'AFFILIATE' | 'COUNTRY' | 'GROUP';
  countryId: string | null;
  affiliateId: string | null;
  businessUnitId: string | null;
  teamId: string | null;
}

export interface CmsAssignment {
  assignmentId: string;
  level: 'GROUP' | 'COUNTRY' | 'AFFILIATE' | 'BUSINESS_UNIT';
  jobTitle: string | null;
  department: string | null;
  countryId: string | null;
  countryName: string | null;
  affiliateId: string | null;
  affiliateName: string | null;
  businessUnitId: string | null;
  businessUnitName: string | null;
}

export interface CmsPortalMembership {
  accountId: string;
  accountName: string | null;
  portalRoleId: string;
  status: string;
}

export interface CmsIdentity {
  userId: string;
  firstName: string;
  lastName: string;
  displayName: string;
  email: string;
  userType: 'INTERNAL' | 'EXTERNAL';
  locale: string;
  timezone: string;
  assignment: CmsAssignment | null;
  roles: CmsRoleSummary[];
  scopes: CmsRoleScope[];
  permissions: PermissionCode[];
  /** Present only for EXTERNAL users; the account scope confining the portal. */
  portalMemberships: CmsPortalMembership[];
}

const text = (value: unknown): string => (typeof value === 'string' ? value : String(value ?? ''));
const nullableText = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);

/**
 * The current organisational assignment: active, primary, and effective today.
 *
 * More than one row can qualify, so the order is deterministic rather than
 * whatever the database returns. The tie is broken by assignment level first,
 * broadest wins (GROUP, then COUNTRY, AFFILIATE, BUSINESS_UNIT), on the
 * reasoning that a group-level posting is the more senior of two live
 * assignments; then by the later `effective_from`, because the more recent
 * posting supersedes; then by `assignment_id`, so the answer never depends on
 * row order.
 */
async function loadAssignment(db: Client, userId: string): Promise<CmsAssignment | null> {
  const result = await db.execute({
    sql: `
      SELECT ua.assignment_id, ua.assignment_level,
             jt.title_name, d.department_name,
             ua.country_id, c.country_name,
             ua.affiliate_id, af.affiliate_name,
             ua.business_unit_id, bu.business_unit_name
      FROM user_assignments ua
      LEFT JOIN job_titles jt ON jt.job_title_id = ua.job_title_id
      LEFT JOIN departments d ON d.department_id = ua.department_id
      LEFT JOIN countries c ON c.country_id = ua.country_id
      LEFT JOIN affiliates af ON af.affiliate_id = ua.affiliate_id
      LEFT JOIN business_units bu ON bu.business_unit_id = ua.business_unit_id
      WHERE ua.user_id = ?
        AND ua.active = 1
        AND ua.is_primary = 1
        AND ua.effective_from <= date('now')
        AND (ua.effective_to IS NULL OR ua.effective_to >= date('now'))
      ORDER BY CASE ua.assignment_level
                 WHEN 'GROUP' THEN 0
                 WHEN 'COUNTRY' THEN 1
                 WHEN 'AFFILIATE' THEN 2
                 ELSE 3
               END,
               ua.effective_from DESC,
               ua.assignment_id
      LIMIT 1`,
    args: [userId],
  });
  const row = result.rows[0];
  if (!row) return null;
  return {
    assignmentId: text(row.assignment_id),
    level: text(row.assignment_level) as CmsAssignment['level'],
    jobTitle: nullableText(row.title_name),
    department: nullableText(row.department_name),
    countryId: nullableText(row.country_id),
    countryName: nullableText(row.country_name),
    affiliateId: nullableText(row.affiliate_id),
    affiliateName: nullableText(row.affiliate_name),
    businessUnitId: nullableText(row.business_unit_id),
    businessUnitName: nullableText(row.business_unit_name),
  };
}

/** The user's live access roles: active and effective today. */
async function loadRoles(db: Client, userId: string): Promise<CmsRoleSummary[]> {
  const result = await db.execute({
    sql: `
      SELECT ar.role_id, ar.role_name
      FROM user_roles ur
      JOIN access_roles ar ON ar.role_id = ur.role_id
      WHERE ur.user_id = ?
        AND ur.active = 1
        AND ur.effective_from <= date('now')
        AND (ur.effective_to IS NULL OR ur.effective_to >= date('now'))
      ORDER BY ar.role_id`,
    args: [userId],
  });
  return result.rows.map((row) => ({
    roleId: text(row.role_id),
    roleName: text(row.role_name),
  }));
}

/**
 * Resolved permission codes, distinct across every live role.
 *
 * `allowed = 1` is required rather than assumed: the column exists so a grant
 * can be recorded and withheld, and reading the row without checking it would
 * turn a denial into a grant.
 */
async function loadPermissions(db: Client, userId: string): Promise<PermissionCode[]> {
  const result = await db.execute({
    sql: `
      SELECT DISTINCT p.module_name, p.resource_name, p.action_name
      FROM user_roles ur
      JOIN role_permissions rp ON rp.role_id = ur.role_id AND rp.allowed = 1
      JOIN permissions p ON p.permission_id = rp.permission_id
      WHERE ur.user_id = ?
        AND ur.active = 1
        AND ur.effective_from <= date('now')
        AND (ur.effective_to IS NULL OR ur.effective_to >= date('now'))
      ORDER BY p.module_name, p.resource_name, p.action_name`,
    args: [userId],
  });
  return result.rows.map(
    (row) => `${text(row.module_name)}.${text(row.resource_name)}.${text(row.action_name)}`,
  );
}

/** Data scopes attached to the user's live roles. */
async function loadScopes(db: Client, userId: string): Promise<CmsRoleScope[]> {
  const result = await db.execute({
    sql: `
      SELECT ur.role_id, s.scope_type, s.country_id, s.affiliate_id, s.business_unit_id, s.team_id
      FROM user_role_scopes s
      JOIN user_roles ur ON ur.user_role_id = s.user_role_id
      WHERE ur.user_id = ?
        AND ur.active = 1
        AND ur.effective_from <= date('now')
        AND (ur.effective_to IS NULL OR ur.effective_to >= date('now'))
      ORDER BY ur.role_id, s.scope_id`,
    args: [userId],
  });
  return result.rows.map((row) => ({
    roleId: text(row.role_id),
    scopeType: text(row.scope_type) as CmsRoleScope['scopeType'],
    countryId: nullableText(row.country_id),
    affiliateId: nullableText(row.affiliate_id),
    businessUnitId: nullableText(row.business_unit_id),
    teamId: nullableText(row.team_id),
  }));
}

/**
 * Portal account scope, for EXTERNAL users only.
 *
 * This is what will later confine a customer to their own account's data, so it
 * is read here and returned rather than left for each module to rediscover.
 * Only ACTIVE memberships count: an INVITED or REVOKED one grants nothing.
 */
async function loadPortalMemberships(db: Client, userId: string): Promise<CmsPortalMembership[]> {
  const result = await db.execute({
    sql: `
      SELECT m.account_id, a.account_name, m.portal_role_id, m.status
      FROM customer_portal_memberships m
      LEFT JOIN accounts a ON a.account_id = m.account_id
      WHERE m.user_id = ? AND m.status = 'ACTIVE'
      ORDER BY m.account_id`,
    args: [userId],
  });
  return result.rows.map((row) => ({
    accountId: text(row.account_id),
    accountName: nullableText(row.account_name),
    portalRoleId: text(row.portal_role_id),
    status: text(row.status),
  }));
}

/**
 * The full identity for `/api/auth/me`. Returns null when the user has gone or
 * is no longer ACTIVE, so a session outlives its user by at most one request.
 */
export async function loadIdentity(db: Client, userId: string): Promise<CmsIdentity | null> {
  const userResult = await db.execute({
    sql: `SELECT user_id, first_name, last_name, display_name, email, user_type, locale, timezone
          FROM users
          WHERE user_id = ? AND status = 'ACTIVE' AND email_verified_at IS NOT NULL`,
    args: [userId],
  });
  const user = userResult.rows[0];
  if (!user) return null;

  const userType = text(user.user_type) as CmsIdentity['userType'];
  const [assignment, roles, permissions, scopes, portalMemberships] = await Promise.all([
    loadAssignment(db, userId),
    loadRoles(db, userId),
    loadPermissions(db, userId),
    loadScopes(db, userId),
    userType === 'EXTERNAL' ? loadPortalMemberships(db, userId) : Promise.resolve([]),
  ]);

  return {
    userId: text(user.user_id),
    firstName: text(user.first_name),
    lastName: text(user.last_name),
    displayName: text(user.display_name),
    email: text(user.email),
    userType,
    locale: text(user.locale),
    timezone: text(user.timezone),
    assignment,
    roles,
    scopes,
    permissions,
    portalMemberships,
  };
}
