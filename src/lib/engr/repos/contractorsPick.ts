/**
 * Pre-qualified contractors that cover a request's station or category, for the
 * engineer's assignment pick list. Org-scoped.
 */
import type { Client } from '@libsql/client/web';

export interface ContractorOption {
  id: string;
  name: string;
}

export async function listEligibleContractors(
  db: Client,
  orgId: string,
  stationId: string,
  categoryId: string | null,
): Promise<ContractorOption[]> {
  const res = await db.execute({
    sql: `SELECT DISTINCT c.id, c.name
            FROM contractors c
           WHERE c.org_id = ? AND c.deleted_at IS NULL
             AND c.is_prequalified = 1 AND c.status = 'ACTIVE'
             AND (EXISTS (SELECT 1 FROM contractor_stations cs
                           WHERE cs.org_id = ? AND cs.contractor_id = c.id AND cs.station_id = ?)
                  OR (? IS NOT NULL AND EXISTS (SELECT 1 FROM contractor_categories cc
                           WHERE cc.org_id = ? AND cc.contractor_id = c.id AND cc.category_id = ?)))
        ORDER BY c.name`,
    args: [orgId, orgId, stationId, categoryId, orgId, categoryId],
  });
  return res.rows.map((r) => ({ id: String(r.id), name: String(r.name) }));
}
