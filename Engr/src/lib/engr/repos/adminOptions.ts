/**
 * Shared option lists for the admin (Setup) forms. Every query is org-scoped and
 * ordered for a select. Roles include the system roles (org_id IS NULL) plus any
 * org-defined ones, since users are assigned system roles.
 */
import type { Client } from '@libsql/client/web';

export interface Option {
  id: string;
  label: string;
}

export interface RoleOption {
  id: string;
  code: string;
  name: string;
}

export async function listRegionOptions(db: Client, orgId: string): Promise<Option[]> {
  const res = await db.execute({
    sql: `SELECT id, name, code FROM regions WHERE org_id = ? ORDER BY name`,
    args: [orgId],
  });
  return res.rows.map((r) => ({
    id: String(r.id),
    label: r.code === null ? String(r.name) : `${String(r.name)} (${String(r.code)})`,
  }));
}

export async function listStationOptions(db: Client, orgId: string): Promise<Option[]> {
  const res = await db.execute({
    sql: `SELECT id, code, name FROM stations
           WHERE org_id = ? AND deleted_at IS NULL AND status = 'ACTIVE' ORDER BY name`,
    args: [orgId],
  });
  return res.rows.map((r) => ({
    id: String(r.id),
    label: `${String(r.name)} (${String(r.code)})`,
  }));
}

export async function listUserOptions(db: Client, orgId: string): Promise<Option[]> {
  const res = await db.execute({
    sql: `SELECT id, full_name, email FROM users
           WHERE org_id = ? AND deleted_at IS NULL AND status = 'ACTIVE' ORDER BY full_name`,
    args: [orgId],
  });
  return res.rows.map((r) => ({ id: String(r.id), label: `${String(r.full_name)}` }));
}

/** Active users holding one of the requested roles in this organisation.
 * Shared roles are allowed, as are organisation-owned role copies. */
export async function listUserOptionsByRole(
  db: Client,
  orgId: string,
  roleCodes: readonly string[],
  currentUserId?: string | null,
): Promise<Option[]> {
  if (roleCodes.length === 0) return [];
  const placeholders = roleCodes.map(() => '?').join(',');
  const res = await db.execute({
    sql: `SELECT DISTINCT u.id, u.full_name, u.email
            FROM users u
            JOIN user_roles ur ON ur.user_id = u.id
            JOIN roles r ON r.id = ur.role_id
           WHERE u.org_id = ? AND u.deleted_at IS NULL AND u.status = 'ACTIVE'
             AND r.code IN (${placeholders})
             AND (r.org_id IS NULL OR r.org_id = u.org_id)
             AND (
               ? IS NULL OR u.id = ? OR NOT EXISTS (
                 SELECT 1 FROM contractors c
                  WHERE c.org_id = u.org_id AND c.portal_user_id = u.id AND c.deleted_at IS NULL
                 UNION ALL
                 SELECT 1 FROM technicians t
                  WHERE t.org_id = u.org_id AND t.portal_user_id = u.id AND t.deleted_at IS NULL
               )
             )
        ORDER BY u.full_name`,
    args: [orgId, ...roleCodes, currentUserId ?? null, currentUserId ?? null],
  });
  return res.rows.map((r) => ({
    id: String(r.id),
    label: `${String(r.full_name)} (${String(r.email)})`,
  }));
}

export async function listCategoryOptions(db: Client, orgId: string): Promise<Option[]> {
  const res = await db.execute({
    sql: `SELECT id, code, name FROM asset_categories WHERE org_id = ? ORDER BY name`,
    args: [orgId],
  });
  return res.rows.map((r) => ({
    id: String(r.id),
    label: `${String(r.name)} (${String(r.code)})`,
  }));
}

export async function listContractorOptions(
  db: Client,
  orgId: string,
  contractorId?: string,
): Promise<Option[]> {
  const res = await db.execute({
    sql: `SELECT id, name FROM contractors
           WHERE org_id = ? AND deleted_at IS NULL AND status = 'ACTIVE'
             AND (? IS NULL OR id = ?)
        ORDER BY name`,
    args: [orgId, contractorId ?? null, contractorId ?? null],
  });
  return res.rows.map((r) => ({ id: String(r.id), label: String(r.name) }));
}

export async function listRateCardOptions(db: Client, orgId: string): Promise<Option[]> {
  const res = await db.execute({
    sql: `SELECT id, name FROM rate_cards WHERE org_id = ? AND status = 'ACTIVE' ORDER BY name`,
    args: [orgId],
  });
  return res.rows.map((r) => ({ id: String(r.id), label: String(r.name) }));
}

/** System roles (org_id IS NULL) and any org-defined roles, for user assignment. */
export async function listRoleOptions(db: Client, orgId: string): Promise<RoleOption[]> {
  const res = await db.execute({
    sql: `SELECT id, code, name FROM roles WHERE org_id IS NULL OR org_id = ? ORDER BY name`,
    args: [orgId],
  });
  return res.rows.map((r) => ({ id: String(r.id), code: String(r.code), name: String(r.name) }));
}
