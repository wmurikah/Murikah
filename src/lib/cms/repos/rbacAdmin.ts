/**
 * Reads and writes for role and permission administration.
 *
 * THE MATRIX IS DATA
 * Every module, resource and action rendered by the permission matrix comes
 * from the `permissions` table. No module name, resource name or action name is
 * written into this file or into the page that renders it. Inserting a row into
 * `permissions` makes it appear with no code change, which is asserted in
 * rbac.test.ts by inserting one and reading the matrix back.
 *
 * THE WRITE AND ITS AUDIT ROW GO TOGETHER
 * `access_roles`, `role_permissions`, `user_roles` and `user_role_scopes` carry
 * no `updated_at`. A permission change with no audit row leaves no evidence it
 * happened, so every mutation is one `db.batch([...], 'write')`.
 */
import type { Client, InStatement } from '@libsql/client/web';
import type { FieldError } from '../../validation.ts';
import { newId, auditEventStmt } from './authRecords.ts';
import { toDbTimestamp } from '../auth/session.ts';
import type { WriteContext } from '../admin/guard.ts';
import { SCOPE_TYPES, type ScopeType } from '../auth/rbac.ts';

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
const isUnique = (e: unknown) =>
  /UNIQUE constraint failed/i.test(e instanceof Error ? e.message : String(e));
const isCheck = (e: unknown) =>
  /CHECK constraint failed/i.test(e instanceof Error ? e.message : String(e));

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

// ---- the permission catalogue ----------------------------------------------

export interface PermissionRow {
  permissionId: string;
  module: string;
  resource: string;
  action: string;
  description: string | null;
  /** MODULE.RESOURCE.ACTION, the one format used everywhere in this product. */
  code: string;
}

/** The code format. One function, so the resolver, the nav and the tests agree. */
export function permissionCode(module: string, resource: string, action: string): string {
  return `${module}.${resource}.${action}`;
}

export async function listPermissions(db: Client): Promise<PermissionRow[]> {
  const result = await db.execute(
    `SELECT permission_id, module_name, resource_name, action_name, description
     FROM permissions ORDER BY module_name, resource_name, action_name`,
  );
  return result.rows.map((row) => ({
    permissionId: text(row.permission_id),
    module: text(row.module_name),
    resource: text(row.resource_name),
    action: text(row.action_name),
    description: nullableText(row.description),
    code: permissionCode(text(row.module_name), text(row.resource_name), text(row.action_name)),
  }));
}

export interface MatrixAction {
  permissionId: string;
  action: string;
  code: string;
  description: string | null;
  granted: boolean;
  /**
   * A row exists and records `allowed = 0`.
   *
   * Surfaced rather than folded into `granted: false`, because the two are
   * different states and the interface says so: nothing recorded, against a
   * withholding somebody chose. See the rule in ../auth/rbac.ts.
   */
  withheld: boolean;
}
export interface MatrixResource {
  resource: string;
  actions: MatrixAction[];
}
export interface MatrixModule {
  module: string;
  resources: MatrixResource[];
  grantedCount: number;
  totalCount: number;
}

/**
 * The permission matrix for one role, grouped module then resource then action.
 *
 * Grouped from the three columns rather than from a list written here, so the
 * matrix grows when the catalogue does.
 */
export async function permissionMatrix(db: Client, roleId: string): Promise<MatrixModule[]> {
  const permissions = await listPermissions(db);
  const held = await db.execute({
    sql: `SELECT permission_id, allowed FROM role_permissions WHERE role_id = ?`,
    args: [roleId],
  });
  const state = new Map(held.rows.map((r) => [text(r.permission_id), flag(r.allowed)]));

  const modules = new Map<string, Map<string, MatrixAction[]>>();
  for (const p of permissions) {
    const resources = modules.get(p.module) ?? new Map<string, MatrixAction[]>();
    const actions = resources.get(p.resource) ?? [];
    actions.push({
      permissionId: p.permissionId,
      action: p.action,
      code: p.code,
      description: p.description,
      granted: state.get(p.permissionId) === true,
      withheld: state.get(p.permissionId) === false,
    });
    resources.set(p.resource, actions);
    modules.set(p.module, resources);
  }

  return [...modules.entries()].map(([module, resources]) => {
    const grouped = [...resources.entries()].map(([resource, actions]) => ({ resource, actions }));
    const all = grouped.flatMap((r) => r.actions);
    return {
      module,
      resources: grouped,
      grantedCount: all.filter((a) => a.granted).length,
      totalCount: all.length,
    };
  });
}

// ---- roles -----------------------------------------------------------------

export interface RoleRow {
  roleId: string;
  roleName: string;
  description: string | null;
  isSystemRole: boolean;
  active: boolean;
  grantedCount: number;
  holderCount: number;
}

const ROLE_SELECT = `
  SELECT ar.role_id, ar.role_name, ar.description, ar.is_system_role, ar.active,
         (SELECT COUNT(*) FROM role_permissions rp WHERE rp.role_id = ar.role_id AND rp.allowed = 1) AS granted_count,
         (SELECT COUNT(DISTINCT ur.user_id) FROM user_roles ur WHERE ur.role_id = ar.role_id AND ur.active = 1) AS holder_count
  FROM access_roles ar`;

function toRole(row: Record<string, unknown>): RoleRow {
  return {
    roleId: text(row.role_id),
    roleName: text(row.role_name),
    description: nullableText(row.description),
    isSystemRole: flag(row.is_system_role),
    active: flag(row.active),
    grantedCount: Number(row.granted_count ?? 0),
    holderCount: Number(row.holder_count ?? 0),
  };
}

export async function listRoles(db: Client): Promise<RoleRow[]> {
  const result = await db.execute(`${ROLE_SELECT} ORDER BY ar.is_system_role DESC, ar.role_name`);
  return result.rows.map(toRole);
}

export async function getRole(db: Client, id: string): Promise<RoleRow | null> {
  const result = await db.execute({
    sql: `${ROLE_SELECT} WHERE ar.role_id = ? LIMIT 1`,
    args: [id],
  });
  const row = result.rows[0];
  return row ? toRole(row) : null;
}

export interface RoleInput {
  roleName: string;
  description: string | null;
  active: boolean;
}

async function roleClash(
  db: Client,
  name: string,
  excludeId: string | null,
): Promise<FieldError[]> {
  const r = await db.execute({
    sql: `SELECT role_id FROM access_roles WHERE role_name = ? AND role_id IS NOT ?`,
    args: [name, excludeId],
  });
  return r.rows.length === 0
    ? []
    : [{ field: 'roleName', message: 'A role with that name already exists.' }];
}

/**
 * Create a role at runtime.
 *
 * The point of this function is that a Credit Manager, a Regional Customer
 * Service Lead or a Data Uploader is configuration rather than a deployment.
 * Nothing about a role's name reaches a code path: the resolver reads
 * permission codes, and a role is a bag of them.
 */
export async function createRole(
  db: Client,
  input: RoleInput,
  ctx: WriteContext,
): Promise<WriteResult<RoleRow>> {
  const clash = await roleClash(db, input.roleName, null);
  if (clash.length > 0) return { ok: false, kind: 'conflict', fields: clash };

  const roleId = newId('ROLE');
  const after = {
    roleName: input.roleName,
    description: input.description,
    isSystemRole: false,
    active: input.active,
  };
  try {
    await db.batch(
      [
        {
          // `is_system_role` is 0 and is not an input. A role created through
          // this screen must never claim the protection section 11 gives the
          // two seeded system roles.
          sql: `INSERT INTO access_roles (role_id, role_name, description, is_system_role, active, created_by_user_id, created_at)
                VALUES (?, ?, ?, 0, ?, ?, ?)`,
          args: [
            roleId,
            input.roleName,
            input.description,
            input.active ? 1 : 0,
            ctx.actorUserId,
            toDbTimestamp(ctx.now),
          ],
        },
        audit(ctx, 'ROLE_CREATED', 'ACCESS_ROLE', roleId, 'CREATE', null, after),
      ],
      'write',
    );
  } catch (error) {
    if (isUnique(error))
      return { ok: false, kind: 'conflict', fields: await roleClash(db, input.roleName, null) };
    throw error;
  }
  const created = await getRole(db, roleId);
  return created ? { ok: true, value: created } : { ok: false, kind: 'not_found' };
}

export async function updateRole(
  db: Client,
  id: string,
  input: RoleInput,
  ctx: WriteContext,
): Promise<WriteResult<RoleRow>> {
  const before = await getRole(db, id);
  if (!before) return { ok: false, kind: 'not_found' };

  const clash = await roleClash(db, input.roleName, id);
  if (clash.length > 0) return { ok: false, kind: 'conflict', fields: clash };

  const after = {
    roleName: input.roleName,
    description: input.description,
    isSystemRole: before.isSystemRole,
    active: input.active,
  };
  const event = before.active && !input.active ? 'ROLE_DEACTIVATED' : 'ROLE_UPDATED';
  try {
    await db.batch(
      [
        {
          // `is_system_role` is not in the SET list. The flag is the seed's to
          // set, and a role cannot be promoted into a protected one here.
          sql: `UPDATE access_roles SET role_name = ?, description = ?, active = ? WHERE role_id = ?`,
          args: [input.roleName, input.description, input.active ? 1 : 0, id],
        },
        audit(
          ctx,
          event,
          'ACCESS_ROLE',
          id,
          before.active === input.active ? 'UPDATE' : 'DEACTIVATE',
          {
            roleName: before.roleName,
            description: before.description,
            isSystemRole: before.isSystemRole,
            active: before.active,
          },
          after,
        ),
      ],
      'write',
    );
  } catch (error) {
    if (isUnique(error))
      return { ok: false, kind: 'conflict', fields: await roleClash(db, input.roleName, id) };
    throw error;
  }
  const updated = await getRole(db, id);
  return updated ? { ok: true, value: updated } : { ok: false, kind: 'not_found' };
}

// ---- the last System Administrator ----------------------------------------

/**
 * The permission whose last holder must not be removable.
 *
 * `ADMIN.ROLES.MANAGE` and not `ROLE-ADMIN`: the guard is about the capability,
 * not about a particular row. A deployment that renamed the role or split it in
 * two would still be protected, and a deployment that created a second role
 * carrying the same permission would correctly allow the first to be emptied.
 */
export const LOCKOUT_PERMISSION = 'ADMIN.ROLES.MANAGE';

/**
 * How many people can still administer roles.
 *
 * Counts live grants the way the resolver reads them: an active role, an active
 * and effective assignment, `allowed = 1`. `excludeUserRole` and `excludeRole`
 * let a caller ask the question as it would be after a change, which is the
 * only useful form: asking after the write has happened is asking too late.
 */
export async function countAdministrators(
  db: Client,
  options: { excludeUserRoleId?: string; excludeRoleId?: string; treatRoleInactive?: string } = {},
): Promise<number> {
  const [moduleName, resourceName, actionName] = LOCKOUT_PERMISSION.split('.');
  const result = await db.execute({
    sql: `
      SELECT COUNT(DISTINCT ur.user_id) AS n
      FROM user_roles ur
      JOIN users u ON u.user_id = ur.user_id AND u.status = 'ACTIVE'
      JOIN access_roles ar ON ar.role_id = ur.role_id AND ar.active = 1
      JOIN role_permissions rp ON rp.role_id = ur.role_id AND rp.allowed = 1
      JOIN permissions p ON p.permission_id = rp.permission_id
      WHERE ur.active = 1
        AND ur.effective_from <= date('now')
        AND (ur.effective_to IS NULL OR ur.effective_to >= date('now'))
        AND p.module_name = ? AND p.resource_name = ? AND p.action_name = ?
        AND ur.user_role_id IS NOT ?
        AND ur.role_id IS NOT ?
        AND ar.role_id IS NOT ?`,
    args: [
      moduleName ?? '',
      resourceName ?? '',
      actionName ?? '',
      options.excludeUserRoleId ?? null,
      options.excludeRoleId ?? null,
      options.treatRoleInactive ?? null,
    ],
  });
  return Number(result.rows[0]?.n ?? 0);
}

const LOCKOUT_MESSAGE =
  'That would leave nobody able to administer roles, and there is no way back from it through the interface. Grant the permission to somebody else first.';

/** The refusal, shaped so an endpoint returns it the same way every time. */
export function lockoutRefusal(field: string): WriteResult<never> {
  return { ok: false, kind: 'invalid_reference', fields: [{ field, message: LOCKOUT_MESSAGE }] };
}

// ---- role permissions ------------------------------------------------------

export interface PermissionChange {
  permissionId: string;
  granted: boolean;
}

/**
 * Replace a role's permissions with the submitted set.
 *
 * Two audit rows rather than one: what was granted and what was revoked are
 * different events an administrator will search for separately, and folding
 * them into a single UPDATE would make "when did this role lose audit access"
 * unanswerable without diffing JSON by eye.
 *
 * The lockout guard runs before the write and asks the question in its
 * after-state form. Revoking ADMIN.ROLES.MANAGE from the role that carries the
 * last administrator is refused here, at the endpoint's only route to the
 * table, rather than in the form.
 */
export async function setRolePermissions(
  db: Client,
  roleId: string,
  changes: PermissionChange[],
  ctx: WriteContext,
): Promise<WriteResult<RoleRow>> {
  const role = await getRole(db, roleId);
  if (!role) return { ok: false, kind: 'not_found' };

  const current = await db.execute({
    sql: `SELECT rp.permission_id, rp.allowed,
                 p.module_name || '.' || p.resource_name || '.' || p.action_name AS code
          FROM role_permissions rp JOIN permissions p ON p.permission_id = rp.permission_id
          WHERE rp.role_id = ?`,
    args: [roleId],
  });
  const before = new Map(current.rows.map((r) => [text(r.permission_id), flag(r.allowed)]));
  const codes = new Map(current.rows.map((r) => [text(r.permission_id), text(r.code)]));

  const catalogue = await listPermissions(db);
  const known = new Map(catalogue.map((p) => [p.permissionId, p]));

  const granted: string[] = [];
  const revoked: string[] = [];
  for (const change of changes) {
    // A permission id the catalogue does not contain is ignored rather than
    // inserted. A crafted payload cannot introduce a code by naming one.
    if (!known.has(change.permissionId)) continue;
    const was = before.get(change.permissionId) === true;
    if (change.granted && !was) granted.push(change.permissionId);
    if (!change.granted && was) revoked.push(change.permissionId);
  }

  if (revoked.some((id) => known.get(id)?.code === LOCKOUT_PERMISSION)) {
    const remaining = await countAdministrators(db, { excludeRoleId: roleId });
    if (remaining === 0) return lockoutRefusal('permissions');
  }

  const statements: Stmt[] = [];
  for (const permissionId of granted) {
    statements.push({
      sql: `INSERT INTO role_permissions (role_permission_id, role_id, permission_id, allowed, created_at)
            VALUES (?, ?, ?, 1, ?)
            ON CONFLICT(role_id, permission_id) DO UPDATE SET allowed = 1`,
      args: [newId('RP'), roleId, permissionId, toDbTimestamp(ctx.now)],
    });
  }
  for (const permissionId of revoked) {
    // Deleted rather than set to `allowed = 0`. Under the rule in
    // ../auth/rbac.ts a withheld row and an absent row read the same to the
    // resolver, and an absent row is the honest record of "not granted".
    statements.push({
      sql: `DELETE FROM role_permissions WHERE role_id = ? AND permission_id = ?`,
      args: [roleId, permissionId],
    });
  }
  if (granted.length > 0) {
    statements.push(
      audit(ctx, 'PERMISSION_GRANTED', 'ACCESS_ROLE', roleId, 'UPDATE', null, {
        roleName: role.roleName,
        codes: granted.map((id) => known.get(id)?.code ?? id),
      }),
    );
  }
  if (revoked.length > 0) {
    statements.push(
      audit(
        ctx,
        'PERMISSION_REVOKED',
        'ACCESS_ROLE',
        roleId,
        'UPDATE',
        {
          roleName: role.roleName,
          codes: revoked.map((id) => known.get(id)?.code ?? codes.get(id) ?? id),
        },
        null,
      ),
    );
  }
  if (statements.length > 0) await db.batch(statements, 'write');

  const updated = await getRole(db, roleId);
  return updated ? { ok: true, value: updated } : { ok: false, kind: 'not_found' };
}

/**
 * WHAT A SET OF ROLES ACTUALLY GRANTS, said in words rather than in codes.
 *
 * The user administration screen shows an administrator the ACCESS a person
 * would end up with, which is a different question from "which roles are
 * ticked". Two roles overlap; one role withholds a code another grants; a
 * deactivated role contributes nothing. Answering it by eye from a list of
 * role names is guesswork, and guessing is how somebody ends up with more
 * than was intended.
 *
 * It is computed exactly the way the resolver computes it, from the same
 * tables, with the same rule for `allowed = 0`: a withholding row contributes
 * nothing and does not veto another role that grants the same code. See
 * ../auth/rbac.ts, which is the authority on that rule; this reads the same
 * data for display and decides nothing.
 *
 * READ FOR EVERY ACTIVE ROLE AT ONCE rather than per role, so the screen can
 * recompute the preview as roles are ticked and unticked without another round
 * trip. One statement, whatever the administrator does next.
 */
export interface RolePermissionMap {
  /** roleId -> the permission ids that role grants (allowed = 1). */
  granted: Record<string, string[]>;
  /** Every permission in the catalogue, so a code can be named without a lookup. */
  permissions: PermissionRow[];
}

export async function rolePermissionMap(db: Client): Promise<RolePermissionMap> {
  const [permissions, rows] = await Promise.all([
    listPermissions(db),
    db.execute(
      `SELECT rp.role_id, rp.permission_id
         FROM role_permissions rp
         JOIN access_roles ar ON ar.role_id = rp.role_id
        WHERE rp.allowed = 1 AND ar.active = 1`,
    ),
  ]);
  const granted: Record<string, string[]> = {};
  for (const row of rows.rows) {
    const roleId = text(row.role_id);
    (granted[roleId] ??= []).push(text(row.permission_id));
  }
  return { granted, permissions };
}

export interface EffectiveGroup {
  /** The module, as a readable heading: "Sales orders", not "ORDERS". */
  module: string;
  /** One readable label per capability, already de-duplicated across roles. */
  entries: { label: string; code: string }[];
}

/**
 * The preview, grouped by module and written in words.
 *
 * "Customers / View, Edit" rather than "CUSTOMERS.ACCOUNTS.VIEW,
 * CUSTOMERS.ACCOUNTS.UPDATE". The raw code is carried alongside for the
 * details disclosure, because an administrator debugging a grant needs the
 * exact string and a person reading the screen does not.
 */
export function effectivePermissions(
  map: RolePermissionMap,
  roleIds: readonly string[],
): EffectiveGroup[] {
  const held = new Set<string>();
  for (const roleId of roleIds) for (const id of map.granted[roleId] ?? []) held.add(id);
  const byModule = new Map<string, { label: string; code: string }[]>();
  for (const permission of map.permissions) {
    if (!held.has(permission.permissionId)) continue;
    const module = readable(permission.module);
    const label = `${readable(permission.resource)}: ${readable(permission.action)}`;
    const entries = byModule.get(module) ?? [];
    if (!entries.some((entry) => entry.label === label)) {
      entries.push({ label, code: permission.code });
    }
    byModule.set(module, entries);
  }
  return [...byModule.entries()]
    .map(([module, entries]) => ({
      module,
      entries: [...entries].sort((a, b) => a.label.localeCompare(b.label)),
    }))
    .sort((a, b) => a.module.localeCompare(b.module));
}

/** SALES_ORDERS -> "Sales orders". Nothing is written down; the catalogue decides. */
function readable(value: string): string {
  const words = value.toLowerCase().replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// ---- user roles and their scopes -------------------------------------------

export interface ScopeInput {
  scopeType: ScopeType;
  countryId: string | null;
  affiliateId: string | null;
  businessUnitId: string | null;
  teamId: string | null;
}

export interface UserRoleInput {
  roleId: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  active: boolean;
  scopes: ScopeInput[];
}

export interface UserRoleRow {
  userRoleId: string;
  userId: string;
  roleId: string;
  roleName: string;
  isSystemRole: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
  active: boolean;
  current: boolean;
  scopes: { scopeId: string; scopeType: string; target: string | null }[];
}

export async function listUserRoleAssignments(db: Client, userId: string): Promise<UserRoleRow[]> {
  const roles = await db.execute({
    sql: `SELECT ur.user_role_id, ur.user_id, ur.role_id, ar.role_name, ar.is_system_role,
                 ur.effective_from, ur.effective_to, ur.active,
                 CASE WHEN ur.active = 1 AND ur.effective_from <= date('now')
                           AND (ur.effective_to IS NULL OR ur.effective_to >= date('now'))
                      THEN 1 ELSE 0 END AS is_current
          FROM user_roles ur JOIN access_roles ar ON ar.role_id = ur.role_id
          WHERE ur.user_id = ? ORDER BY is_current DESC, ar.role_name`,
    args: [userId],
  });
  const scopes = await db.execute({
    sql: `SELECT s.scope_id, s.user_role_id, s.scope_type,
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
    userRoleId: text(row.user_role_id),
    userId: text(row.user_id),
    roleId: text(row.role_id),
    roleName: text(row.role_name),
    isSystemRole: flag(row.is_system_role),
    effectiveFrom: text(row.effective_from),
    effectiveTo: nullableText(row.effective_to),
    active: flag(row.active),
    current: flag(row.is_current),
    scopes: scopes.rows
      .filter((s) => text(s.user_role_id) === text(row.user_role_id))
      .map((s) => ({
        scopeId: text(s.scope_id),
        scopeType: text(s.scope_type),
        target: nullableText(s.target),
      })),
  }));
}

/** The location column each scope type requires, and the ones it forbids. */
function scopeColumns(scope: ScopeInput):
  | {
      country: string | null;
      affiliate: string | null;
      businessUnit: string | null;
      team: string | null;
    }
  | FieldError {
  switch (scope.scopeType) {
    case 'OWN':
    case 'GROUP':
      // The CHECK permits both with none, and sending anything else would be a
      // value nothing reads.
      return { country: null, affiliate: null, businessUnit: null, team: null };
    case 'COUNTRY':
      return scope.countryId
        ? { country: scope.countryId, affiliate: null, businessUnit: null, team: null }
        : { field: 'scopes', message: 'A country scope needs a country.' };
    case 'AFFILIATE':
      return scope.affiliateId
        ? { country: null, affiliate: scope.affiliateId, businessUnit: null, team: null }
        : { field: 'scopes', message: 'An affiliate scope needs an affiliate.' };
    case 'BUSINESS_UNIT':
      return scope.businessUnitId
        ? { country: null, affiliate: null, businessUnit: scope.businessUnitId, team: null }
        : { field: 'scopes', message: 'A business unit scope needs a business unit.' };
    case 'TEAM':
      return scope.teamId
        ? { country: null, affiliate: null, businessUnit: null, team: scope.teamId }
        : { field: 'scopes', message: 'A team scope needs a team.' };
  }
}

/**
 * NOBODY GRANTS THEMSELVES ACCESS, and the server is where that is decided.
 *
 * GRANTS, not touches: giving up your own role is allowed, because it takes
 * access away and the last-administrator guard already refuses the one removal
 * that cannot be undone. What is refused is assigning yourself a role,
 * reactivating one of your own that had lapsed, and replacing your own scopes
 * — each of which ends with the caller holding more than they started with.
 *
 * User administration now edits a person's roles from the same screen that
 * edits their name, and an administrator can open their own record. Hiding the
 * control on that one screen would be presentation, not a control: the
 * endpoint is reachable with curl and the payload is the attack surface. So
 * the refusal lives at the only route into `user_roles`, and it compares the
 * subject against the SESSION's actor rather than against anything in the
 * body.
 *
 * Two administrators, not one, is the shape this enforces: access is granted
 * by somebody else, which is the property an audit trail is supposed to be
 * able to demonstrate. The last-administrator guard below keeps that from
 * becoming a lockout — the capability can never be reduced to nobody, so there
 * is always a second person who can do it.
 */
const SELF_GRANT_REFUSAL: WriteResult<never> = {
  ok: false,
  kind: 'invalid_reference',
  fields: [
    {
      field: 'roleId',
      message: 'You cannot change your own access. Ask another administrator.',
    },
  ],
};

/**
 * Assign a role to a user, with its scopes, in one write.
 *
 * A scope is never inferred from a job title, a department or a team
 * membership. It is what an administrator configured and nothing else.
 */
export async function assignUserRole(
  db: Client,
  userId: string,
  input: UserRoleInput,
  ctx: WriteContext,
): Promise<WriteResult<UserRoleRow>> {
  const user = await db.execute({
    sql: `SELECT user_id FROM users WHERE user_id = ?`,
    args: [userId],
  });
  if (user.rows.length === 0) return { ok: false, kind: 'not_found' };
  if (userId === ctx.actorUserId) return SELF_GRANT_REFUSAL;
  const role = await getRole(db, input.roleId);
  if (!role) {
    return {
      ok: false,
      kind: 'invalid_reference',
      fields: [{ field: 'roleId', message: 'That role does not exist.' }],
    };
  }

  const resolved: {
    scope: ScopeInput;
    columns: {
      country: string | null;
      affiliate: string | null;
      businessUnit: string | null;
      team: string | null;
    };
  }[] = [];
  for (const scope of input.scopes) {
    if (!SCOPE_TYPES.includes(scope.scopeType)) {
      return {
        ok: false,
        kind: 'invalid_reference',
        fields: [{ field: 'scopes', message: 'Choose a scope type.' }],
      };
    }
    const columns = scopeColumns(scope);
    if ('field' in columns) return { ok: false, kind: 'invalid_reference', fields: [columns] };
    resolved.push({ scope, columns });
  }

  const userRoleId = newId('UR');
  const statements: Stmt[] = [
    {
      sql: `INSERT INTO user_roles (user_role_id, user_id, role_id, effective_from, effective_to, assigned_by_user_id, active)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [
        userRoleId,
        userId,
        input.roleId,
        input.effectiveFrom,
        input.effectiveTo,
        ctx.actorUserId,
        input.active ? 1 : 0,
      ],
    },
    audit(ctx, 'USER_ROLE_ASSIGNED', 'USER_ROLE', userRoleId, 'CREATE', null, {
      userId,
      roleId: input.roleId,
      roleName: role.roleName,
      effectiveFrom: input.effectiveFrom,
      effectiveTo: input.effectiveTo,
      active: input.active,
    }),
  ];
  for (const { scope, columns } of resolved) {
    const scopeId = newId('SCOPE');
    statements.push({
      sql: `INSERT INTO user_role_scopes (scope_id, user_role_id, scope_type, country_id, affiliate_id, business_unit_id, team_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        scopeId,
        userRoleId,
        scope.scopeType,
        columns.country,
        columns.affiliate,
        columns.businessUnit,
        columns.team,
        toDbTimestamp(ctx.now),
      ],
    });
    statements.push(
      audit(ctx, 'ROLE_SCOPE_ASSIGNED', 'USER_ROLE_SCOPE', scopeId, 'CREATE', null, {
        userRoleId,
        scopeType: scope.scopeType,
        ...columns,
      }),
    );
  }

  try {
    await db.batch(statements, 'write');
  } catch (error) {
    if (isUnique(error)) {
      return {
        ok: false,
        kind: 'conflict',
        fields: [
          {
            field: 'effectiveFrom',
            message: 'That role is already assigned to this person from that date.',
          },
        ],
      };
    }
    if (isCheck(error)) {
      return {
        ok: false,
        kind: 'invalid_reference',
        fields: [{ field: 'scopes', message: 'That scope and its target do not match.' }],
      };
    }
    throw error;
  }
  const rows = await listUserRoleAssignments(db, userId);
  const created = rows.find((r) => r.userRoleId === userRoleId);
  return created ? { ok: true, value: created } : { ok: false, kind: 'not_found' };
}

/**
 * End or reactivate a role assignment, and replace its scopes.
 *
 * The lockout guard runs first and in the after-state form: removing the last
 * live grant of ADMIN.ROLES.MANAGE is refused before anything is written.
 */
export async function updateUserRole(
  db: Client,
  userRoleId: string,
  input: { effectiveTo: string | null; active: boolean; scopes: ScopeInput[] | null },
  ctx: WriteContext,
): Promise<WriteResult<UserRoleRow>> {
  const found = await db.execute({
    sql: `SELECT ur.user_role_id, ur.user_id, ur.role_id, ur.effective_from, ur.effective_to, ur.active, ar.role_name
          FROM user_roles ur JOIN access_roles ar ON ar.role_id = ur.role_id
          WHERE ur.user_role_id = ? LIMIT 1`,
    args: [userRoleId],
  });
  const row = found.rows[0];
  if (!row) return { ok: false, kind: 'not_found' };
  const userId = text(row.user_id);

  const removing =
    !input.active ||
    (input.effectiveTo !== null && input.effectiveTo < new Date().toISOString().slice(0, 10));
  // GIVING UP YOUR OWN ACCESS IS NOT ESCALATION, so it is allowed; anything
  // else on your own grant is refused. Reactivating a lapsed role and
  // replacing its scopes both END with the caller holding more than they did,
  // which is the thing the rule exists to stop, and neither announces itself
  // as an assignment. A pure removal announces nothing but a loss, and the
  // last-administrator guard below still decides whether it is survivable.
  if (userId === ctx.actorUserId && (!removing || input.scopes !== null)) {
    return SELF_GRANT_REFUSAL;
  }
  if (removing) {
    const remaining = await countAdministrators(db, { excludeUserRoleId: userRoleId });
    const wasAdministrator = (await countAdministrators(db)) > remaining;
    if (wasAdministrator && remaining === 0) return lockoutRefusal('active');
  }

  const statements: Stmt[] = [
    {
      sql: `UPDATE user_roles SET effective_to = ?, active = ? WHERE user_role_id = ?`,
      args: [input.effectiveTo, input.active ? 1 : 0, userRoleId],
    },
    audit(
      ctx,
      input.active ? 'USER_ROLE_ASSIGNED' : 'USER_ROLE_REMOVED',
      'USER_ROLE',
      userRoleId,
      'UPDATE',
      {
        effectiveTo: nullableText(row.effective_to),
        active: flag(row.active),
      },
      { effectiveTo: input.effectiveTo, active: input.active },
    ),
  ];

  if (input.scopes !== null) {
    const resolved: { scope: ScopeInput; columns: ReturnType<typeof scopeColumns> }[] = [];
    for (const scope of input.scopes) {
      const columns = scopeColumns(scope);
      if ('field' in columns) return { ok: false, kind: 'invalid_reference', fields: [columns] };
      resolved.push({ scope, columns });
    }
    const existing = await db.execute({
      sql: `SELECT scope_type, country_id, affiliate_id, business_unit_id, team_id FROM user_role_scopes WHERE user_role_id = ?`,
      args: [userRoleId],
    });
    statements.push({
      sql: `DELETE FROM user_role_scopes WHERE user_role_id = ?`,
      args: [userRoleId],
    });
    for (const { scope, columns } of resolved) {
      if ('field' in columns) continue;
      statements.push({
        sql: `INSERT INTO user_role_scopes (scope_id, user_role_id, scope_type, country_id, affiliate_id, business_unit_id, team_id, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          newId('SCOPE'),
          userRoleId,
          scope.scopeType,
          columns.country,
          columns.affiliate,
          columns.businessUnit,
          columns.team,
          toDbTimestamp(ctx.now),
        ],
      });
    }
    statements.push(
      audit(
        ctx,
        'ROLE_SCOPE_CHANGED',
        'USER_ROLE',
        userRoleId,
        'UPDATE',
        existing.rows.map((r) => ({
          scopeType: text(r.scope_type),
          countryId: nullableText(r.country_id),
          affiliateId: nullableText(r.affiliate_id),
          businessUnitId: nullableText(r.business_unit_id),
          teamId: nullableText(r.team_id),
        })),
        resolved.map(({ scope, columns }) => ({
          scopeType: scope.scopeType,
          ...('field' in columns ? {} : columns),
        })),
      ),
    );
  }

  try {
    await db.batch(statements, 'write');
  } catch (error) {
    if (isCheck(error)) {
      return {
        ok: false,
        kind: 'invalid_reference',
        fields: [{ field: 'scopes', message: 'That scope and its target do not match.' }],
      };
    }
    throw error;
  }
  const rows = await listUserRoleAssignments(db, userId);
  const updated = rows.find((r) => r.userRoleId === userRoleId);
  return updated ? { ok: true, value: updated } : { ok: false, kind: 'not_found' };
}

/** Who holds a role, for the role detail screen. */
export async function listRoleHolders(
  db: Client,
  roleId: string,
): Promise<
  { userId: string; displayName: string; email: string; scopes: string[]; current: boolean }[]
> {
  const result = await db.execute({
    sql: `SELECT u.user_id, u.display_name, u.email, ur.user_role_id,
                 CASE WHEN ur.active = 1 AND ur.effective_from <= date('now')
                           AND (ur.effective_to IS NULL OR ur.effective_to >= date('now'))
                      THEN 1 ELSE 0 END AS is_current,
                 (SELECT group_concat(s.scope_type || COALESCE(': ' || COALESCE(c.country_name, a.affiliate_name, b.business_unit_name, t.team_name), ''), '; ')
                    FROM user_role_scopes s
                    LEFT JOIN countries c ON c.country_id = s.country_id
                    LEFT JOIN affiliates a ON a.affiliate_id = s.affiliate_id
                    LEFT JOIN business_units b ON b.business_unit_id = s.business_unit_id
                    LEFT JOIN teams t ON t.team_id = s.team_id
                   WHERE s.user_role_id = ur.user_role_id) AS scope_text
          FROM user_roles ur JOIN users u ON u.user_id = ur.user_id
          WHERE ur.role_id = ? ORDER BY is_current DESC, u.display_name`,
    args: [roleId],
  });
  return result.rows.map((row) => ({
    userId: text(row.user_id),
    displayName: text(row.display_name),
    email: text(row.email),
    scopes: text(row.scope_text) === '' ? [] : text(row.scope_text).split('; '),
    current: flag(row.is_current),
  }));
}
