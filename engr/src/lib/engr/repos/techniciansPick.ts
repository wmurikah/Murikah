/**
 * Technician pick list for a contractor, and the contractor a portal user
 * belongs to. Org-scoped.
 */
import type { Client } from '@libsql/client/web';

export interface TechnicianOption {
  id: string;
  name: string;
}

export async function listTechniciansForContractor(
  db: Client,
  orgId: string,
  contractorId: string,
): Promise<TechnicianOption[]> {
  const res = await db.execute({
    sql: `SELECT id, full_name FROM technicians
           WHERE org_id = ? AND contractor_id = ? AND deleted_at IS NULL AND status = 'ACTIVE'
        ORDER BY full_name`,
    args: [orgId, contractorId],
  });
  return res.rows.map((r) => ({ id: String(r.id), name: String(r.full_name) }));
}

/** The contractor whose portal account this user is, or null. */
export async function contractorForUser(
  db: Client,
  orgId: string,
  userId: string,
): Promise<string | null> {
  const res = await db.execute({
    sql: `SELECT id FROM contractors WHERE org_id = ? AND portal_user_id = ? AND deleted_at IS NULL LIMIT 1`,
    args: [orgId, userId],
  });
  return res.rows[0] ? String(res.rows[0].id) : null;
}
