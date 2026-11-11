/**
 * Read-only records transcribed from the legacy Hass work order tracker.
 * Never convert these into operational work_orders by guessing workflow status.
 * All queries are scoped by the authenticated owning organisation.
 */
import type { Client } from '@libsql/client/web';

export interface LegacyWorkOrderRow {
  id: string;
  sourceRow: number;
  workOrderReference: string | null;
  reportedDate: string | null;
  location: string;
  sourceLocation: string | null;
  isLinked: boolean;
  contractor: string | null;
  description: string;
  expectedClosure: string | null;
  qualityFlags: string | null;
  reviewState: string;
}
export interface LegacyWorkOrdersPage {
  rows: LegacyWorkOrderRow[];
  total: number;
  page: number;
  pages: number;
}

export async function listLegacyWorkOrders(
  db: Client,
  orgId: string,
  pageNumber: number,
  search = '',
): Promise<LegacyWorkOrdersPage> {
  const page = Number.isSafeInteger(pageNumber) ? Math.max(1, Math.min(pageNumber, 10000)) : 1;
  const pageSize = 75;
  const q = search.trim().slice(0, 100);
  const escaped = q.replace(/[\\%_]/g, '\\$&');
  const where = `h.org_id = ? AND h.review_state <> 'EXCLUDED'` +
    (q ? ` AND (h.wo_reference_source LIKE ? ESCAPE '\\'
       OR h.description LIKE ? ESCAPE '\\'
       OR h.location_source LIKE ? ESCAPE '\\'
       OR h.contractor_source LIKE ? ESCAPE '\\')` : '');
  const args = q ? [orgId, ...Array(4).fill(`%${escaped}`)] : [orgId];
  const totalResult = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM legacy_work_order_history h WHERE ${where}`, args,
  });
  const total = Number(totalResult.rows[0]?.n ?? 0);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(page, pages);
  const result = await db.execute({
    sql: `SELECT h.id, h.source_row, h.wo_reference_source, h.reported_date,
                 h.location_source, h.contractor_source, h.description,
                 h.expected_closure_date, h.quality_flags, h.review_state,
                 s.name AS matched_location,
                 h.suggested_location AS proposed_location,
                 CASE WHEN s.id IS NULL THEN 0 ELSE 1 END AS is_linked
            FROM legacy_work_order_history h
            LEFT JOIN stations s ON s.id = h.station_id AND s.org_id = h.org_id
           WHERE ${where}
        ORDER BY (h.reported_date IS NULL), h.reported_date DESC, h.source_row DESC
           LIMIT ? OFFSET ?`,
    args: [...args, pageSize, (currentPage - 1) * pageSize],
  });
  return {
    total, page: currentPage, pages,
    rows: result.rows.map((r) => ({
      id: String(r.id),
      sourceRow: Number(r.source_row),
      workOrderReference: r.wo_reference_source ? String(r.wo_reference_source) : null,
      reportedDate: r.reported_date ? String(r.reported_date) : null,
      location: r.matched_location
        ? String(r.matched_location)
        : r.proposed_location ? String(r.proposed_location)
        : r.location_source ? String(r.location_source) : 'Unspecified',
      sourceLocation: r.location_source ? String(r.location_source) : null,
      isLinked: Number(r.is_linked) === 1,
      contractor: r.contractor_source ? String(r.contractor_source) : null,
      description: String(r.description),
      expectedClosure: r.expected_closure_date ? String(r.expected_closure_date) : null,
      qualityFlags: r.quality_flags ? String(r.quality_flags) : null,
      reviewState: String(r.review_state),
    })),
  };
}
