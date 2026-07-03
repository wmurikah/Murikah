/**
 * Engineer-in-charge routing. Each assignment says which engineer owns a station
 * or a category of work, so a raised request routes to that engineer rather than
 * any engineer. Everything is scoped to the organisation; a station assignment
 * takes precedence over a category assignment when both would match. When no
 * assignment covers a request's scope, the caller falls back to the managers.
 */
import type { Client } from '@libsql/client/web';

const newId = (): string => crypto.randomUUID().replace(/-/g, '');

export type AssignResult =
  | { ok: true; id: string }
  | { ok: false; code: 'invalid' | 'not_found'; message: string };

export interface AssignmentRow {
  id: string;
  engineerName: string;
  scopeType: 'STATION' | 'CATEGORY';
  scopeName: string;
}

export interface EngineerOption {
  id: string;
  name: string;
}

/**
 * The engineer in charge for a request's station or category. A station match is
 * preferred; a category match is the fallback. Returns null when nothing covers
 * the scope, so the caller can route to the managers instead.
 */
export async function resolveEngineerInCharge(
  db: Client,
  orgId: string,
  stationId: string,
  categoryId: string | null,
): Promise<string | null> {
  const res = await db.execute({
    sql: `SELECT engineer_user_id
            FROM engineer_assignments
           WHERE org_id = ?
             AND ( (scope_type = 'STATION' AND station_id = ?)
                   OR (scope_type = 'CATEGORY' AND category_id = ?) )
        ORDER BY CASE scope_type WHEN 'STATION' THEN 0 ELSE 1 END
           LIMIT 1`,
    args: [orgId, stationId, categoryId],
  });
  return res.rows[0] ? String(res.rows[0].engineer_user_id) : null;
}

export async function listAssignments(db: Client, orgId: string): Promise<AssignmentRow[]> {
  const res = await db.execute({
    sql: `SELECT ea.id, ea.scope_type, u.full_name AS engineer_name,
                 s.name AS station_name, c.name AS category_name
            FROM engineer_assignments ea
            JOIN users u ON u.id = ea.engineer_user_id
            LEFT JOIN stations s ON s.id = ea.station_id
            LEFT JOIN asset_categories c ON c.id = ea.category_id
           WHERE ea.org_id = ?
        ORDER BY u.full_name`,
    args: [orgId],
  });
  return res.rows.map((r) => {
    const scopeType = String(r.scope_type) as 'STATION' | 'CATEGORY';
    const scopeName =
      scopeType === 'STATION'
        ? r.station_name == null
          ? 'Station removed'
          : String(r.station_name)
        : r.category_name == null
          ? 'Category removed'
          : String(r.category_name);
    return { id: String(r.id), engineerName: String(r.engineer_name), scopeType, scopeName };
  });
}

// Active users of the organisation, offered as the engineer in charge.
export async function listEngineerCandidates(db: Client, orgId: string): Promise<EngineerOption[]> {
  const res = await db.execute({
    sql: `SELECT id, full_name FROM users
           WHERE org_id = ? AND deleted_at IS NULL AND status = 'ACTIVE'
        ORDER BY full_name`,
    args: [orgId],
  });
  return res.rows.map((r) => ({ id: String(r.id), name: String(r.full_name) }));
}

export async function createAssignment(
  db: Client,
  ctx: { orgId: string; userId: string },
  input: {
    engineerUserId: string;
    scopeType: string;
    stationId: string | null;
    categoryId: string | null;
  },
): Promise<AssignResult> {
  const scopeType = input.scopeType === 'CATEGORY' ? 'CATEGORY' : 'STATION';
  const stationId = scopeType === 'STATION' ? input.stationId : null;
  const categoryId = scopeType === 'CATEGORY' ? input.categoryId : null;
  if (!input.engineerUserId) return { ok: false, code: 'invalid', message: 'Choose an engineer.' };
  if (scopeType === 'STATION' && !stationId)
    return { ok: false, code: 'invalid', message: 'Choose a station.' };
  if (scopeType === 'CATEGORY' && !categoryId)
    return { ok: false, code: 'invalid', message: 'Choose a category.' };

  // The engineer, and the station or category, must all belong to this org.
  const eng = await db.execute({
    sql: `SELECT id FROM users WHERE id = ? AND org_id = ? AND deleted_at IS NULL LIMIT 1`,
    args: [input.engineerUserId, ctx.orgId],
  });
  if (eng.rows.length === 0) return { ok: false, code: 'invalid', message: 'Unknown engineer.' };
  if (stationId) {
    const s = await db.execute({
      sql: `SELECT id FROM stations WHERE id = ? AND org_id = ? AND deleted_at IS NULL LIMIT 1`,
      args: [stationId, ctx.orgId],
    });
    if (s.rows.length === 0) return { ok: false, code: 'invalid', message: 'Unknown station.' };
  }
  if (categoryId) {
    const c = await db.execute({
      sql: `SELECT id FROM asset_categories WHERE id = ? AND org_id = ? LIMIT 1`,
      args: [categoryId, ctx.orgId],
    });
    if (c.rows.length === 0) return { ok: false, code: 'invalid', message: 'Unknown category.' };
  }

  const id = newId();
  const tx = await db.transaction('write');
  try {
    await tx.execute({
      sql: `INSERT INTO engineer_assignments (id, org_id, engineer_user_id, scope_type, station_id, category_id)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [id, ctx.orgId, input.engineerUserId, scopeType, stationId, categoryId],
    });
    await tx.execute({
      sql: `INSERT INTO audit_logs (org_id, actor_user_id, action, entity_type, entity_id, after_json)
            VALUES (?, ?, 'engineer.assign', 'engineer_assignment', ?, ?)`,
      args: [ctx.orgId, ctx.userId, id, JSON.stringify({ scopeType, stationId, categoryId })],
    });
    await tx.commit();
    return { ok: true, id };
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}

export async function deleteAssignment(
  db: Client,
  ctx: { orgId: string; userId: string },
  id: string,
): Promise<AssignResult> {
  const tx = await db.transaction('write');
  try {
    const del = await tx.execute({
      sql: `DELETE FROM engineer_assignments WHERE id = ? AND org_id = ?`,
      args: [id, ctx.orgId],
    });
    if (del.rowsAffected === 0) {
      await tx.rollback();
      return { ok: false, code: 'not_found', message: 'That assignment was not found.' };
    }
    await tx.execute({
      sql: `INSERT INTO audit_logs (org_id, actor_user_id, action, entity_type, entity_id, after_json)
            VALUES (?, ?, 'engineer.unassign', 'engineer_assignment', ?, ?)`,
      args: [ctx.orgId, ctx.userId, id, JSON.stringify({ removed: true })],
    });
    await tx.commit();
    return { ok: true, id };
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}
