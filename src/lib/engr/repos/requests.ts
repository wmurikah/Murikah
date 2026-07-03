/**
 * Service request queries, every one scoped by org_id. The org id is supplied
 * by the caller from the verified session (locals.engr.orgId), never from the
 * request. Nothing here formats money; there is none on this table.
 */
import type { Client } from '@libsql/client/web';

export type Priority = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export const PRIORITIES: Priority[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

export interface QueueRow {
  id: string;
  requestNo: string;
  stationName: string;
  issue: string;
  priority: string;
  status: string;
  createdAt: string;
}

export interface StationOption {
  id: string;
  code: string;
  name: string;
}

export interface CategoryOption {
  id: string;
  code: string;
  name: string;
}

export interface RequestDetail {
  id: string;
  requestNo: string;
  stationName: string;
  issue: string;
  natureOfBreakdown: string | null;
  priority: string;
  status: string;
  isRepeatCall: boolean;
  createdAt: string;
}

export interface CreateRequestInput {
  orgId: string;
  raisedBy: string;
  stationId: string;
  categoryId: string | null;
  assetId: string | null;
  issue: string;
  natureOfBreakdown: string | null;
  priority: Priority;
  isRepeatCall: boolean;
}

export interface CreatedRequest {
  id: string;
  requestNo: string;
}

// The engineer queue. Default scope is the requests assigned to the current
// engineer; scope 'all' shows every open request for the org. Open means not
// closed or cancelled. Sorted by priority, then by age (oldest first).
export async function listQueue(
  db: Client,
  orgId: string,
  engineerId: string,
  scope: 'mine' | 'all',
  limit = 100,
  filters: { priority?: string; station?: string } = {},
): Promise<QueueRow[]> {
  const mine = scope === 'mine';
  const args: (string | number)[] = [orgId];
  let where = `sr.org_id = ?
             AND sr.deleted_at IS NULL
             AND sr.status NOT IN ('CLOSED','CANCELLED')`;
  if (mine) {
    where += ' AND sr.assigned_engineer_id = ?';
    args.push(engineerId);
  }
  if (filters.priority) {
    where += ' AND sr.priority = ?';
    args.push(filters.priority);
  }
  if (filters.station) {
    where += ' AND sr.station_id = ?';
    args.push(filters.station);
  }
  args.push(limit);
  const res = await db.execute({
    sql: `SELECT sr.id AS id, sr.request_no AS request_no, sr.issue AS issue,
                 sr.priority AS priority, sr.status AS status, sr.created_at AS created_at,
                 s.name AS station_name
            FROM service_requests sr
            JOIN stations s ON s.id = sr.station_id
           WHERE ${where}
        ORDER BY CASE sr.priority
                   WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1
                   WHEN 'MEDIUM' THEN 2 ELSE 3 END,
                 sr.created_at ASC
           LIMIT ?`,
    args,
  });
  return res.rows.map((row) => ({
    id: String(row.id),
    requestNo: String(row.request_no),
    stationName: String(row.station_name),
    issue: String(row.issue),
    priority: String(row.priority),
    status: String(row.status),
    createdAt: String(row.created_at),
  }));
}

export async function listStations(db: Client, orgId: string): Promise<StationOption[]> {
  const res = await db.execute({
    sql: `SELECT id, code, name FROM stations
           WHERE org_id = ? AND deleted_at IS NULL AND status = 'ACTIVE'
        ORDER BY name`,
    args: [orgId],
  });
  return res.rows.map((row) => ({
    id: String(row.id),
    code: String(row.code),
    name: String(row.name),
  }));
}

export async function listAssetCategories(db: Client, orgId: string): Promise<CategoryOption[]> {
  const res = await db.execute({
    sql: `SELECT id, code, name FROM asset_categories WHERE org_id = ? ORDER BY name`,
    args: [orgId],
  });
  return res.rows.map((row) => ({
    id: String(row.id),
    code: String(row.code),
    name: String(row.name),
  }));
}

export async function getRequestById(
  db: Client,
  orgId: string,
  id: string,
): Promise<RequestDetail | null> {
  const res = await db.execute({
    sql: `SELECT sr.id AS id, sr.request_no AS request_no, sr.issue AS issue,
                 sr.nature_of_breakdown AS nature_of_breakdown, sr.priority AS priority,
                 sr.status AS status, sr.is_repeat_call AS is_repeat_call,
                 sr.created_at AS created_at, s.name AS station_name
            FROM service_requests sr
            JOIN stations s ON s.id = sr.station_id
           WHERE sr.org_id = ? AND sr.id = ? AND sr.deleted_at IS NULL
           LIMIT 1`,
    args: [orgId, id],
  });
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    requestNo: String(row.request_no),
    stationName: String(row.station_name),
    issue: String(row.issue),
    natureOfBreakdown: row.nature_of_breakdown === null ? null : String(row.nature_of_breakdown),
    priority: String(row.priority),
    status: String(row.status),
    isRepeatCall: Number(row.is_repeat_call) === 1,
    createdAt: String(row.created_at),
  };
}

// True when a write failed because a UNIQUE constraint (here org_id, request_no)
// was violated, so the caller can retry with the next sequence number.
function isUniqueViolation(err: unknown): boolean {
  const text = String(err instanceof Error ? err.message : err);
  return text.includes('UNIQUE') || text.includes('SQLITE_CONSTRAINT');
}

async function countForYear(db: Client, orgId: string, year: number): Promise<number> {
  const res = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM service_requests WHERE org_id = ? AND request_no LIKE ?`,
    args: [orgId, `SR-${year}-%`],
  });
  return Number(res.rows[0]?.n ?? 0);
}

/**
 * Create a service request and write its audit_logs row atomically. The request
 * number is SR-{year}-{sequence}, unique per org. If two requests race for the
 * same number the UNIQUE (org_id, request_no) constraint rejects the loser and
 * we retry with the next sequence.
 */
export async function createRequest(
  db: Client,
  input: CreateRequestInput,
): Promise<CreatedRequest> {
  const year = new Date().getUTCFullYear();
  const base = await countForYear(db, input.orgId, year);

  for (let attempt = 0; attempt < 5; attempt++) {
    const sequence = base + 1 + attempt;
    const requestNo = `SR-${year}-${String(sequence).padStart(4, '0')}`;
    const id = crypto.randomUUID().replace(/-/g, '');
    try {
      await db.batch(
        [
          {
            sql: `INSERT INTO service_requests
                    (id, org_id, request_no, station_id, asset_id, category_id, raised_by,
                     issue, nature_of_breakdown, is_repeat_call, priority, status)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN')`,
            args: [
              id,
              input.orgId,
              requestNo,
              input.stationId,
              input.assetId,
              input.categoryId,
              input.raisedBy,
              input.issue,
              input.natureOfBreakdown,
              input.isRepeatCall ? 1 : 0,
              input.priority,
            ],
          },
          {
            sql: `INSERT INTO audit_logs
                    (org_id, actor_user_id, action, entity_type, entity_id, after_json)
                  VALUES (?, ?, 'requests.create', 'service_request', ?, ?)`,
            args: [
              input.orgId,
              input.raisedBy,
              id,
              JSON.stringify({ request_no: requestNo, status: 'OPEN' }),
            ],
          },
        ],
        'write',
      );
      return { id, requestNo };
    } catch (err) {
      if (isUniqueViolation(err) && attempt < 4) continue;
      throw err;
    }
  }
  throw new Error('Could not allocate a unique request number');
}
