/**
 * Work-order repository. Creation from a request (the engineer's predefined-rate
 * assignment path) writes the work order, moves the request to ASSIGNED, audits,
 * and notifies the contractor, all atomically. Reads are role-aware. Every query
 * is scoped by org_id. Status is never changed here; that is the state machine.
 */
import type { Client } from '@libsql/client/web';
import { enqueue } from '../notify';
import type { WoStatus } from '../workflow/workOrderState';

const newId = (): string => crypto.randomUUID().replace(/-/g, '');

function isUniqueViolation(err: unknown): boolean {
  const text = String(err instanceof Error ? err.message : err);
  return text.includes('UNIQUE') || text.includes('SQLITE_CONSTRAINT');
}

export interface CreateWorkOrderInput {
  requestId: string;
  contractorId: string;
  slaId: string | null;
}

export type CreateWorkOrderResult =
  | { ok: true; workOrderId: string; woNo: string }
  | { ok: false; code: 'not_found' | 'invalid' | 'conflict'; message: string };

async function countWoForYear(db: Client, orgId: string, year: number): Promise<number> {
  const res = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM work_orders WHERE org_id = ? AND wo_no LIKE ?`,
    args: [orgId, `WO-${year}-%`],
  });
  return Number(res.rows[0]?.n ?? 0);
}

export async function createWorkOrderFromRequest(
  db: Client,
  ctx: { orgId: string; userId: string },
  input: CreateWorkOrderInput,
): Promise<CreateWorkOrderResult> {
  const { orgId } = ctx;

  const reqRes = await db.execute({
    sql: `SELECT id, station_id, category_id, status FROM service_requests
           WHERE id = ? AND org_id = ? AND deleted_at IS NULL LIMIT 1`,
    args: [input.requestId, orgId],
  });
  const request = reqRes.rows[0];
  if (!request) return { ok: false, code: 'not_found', message: 'Request not found.' };
  if (String(request.status) !== 'ACCEPTED') {
    return {
      ok: false,
      code: 'conflict',
      message: 'The request must be accepted before assignment.',
    };
  }
  const stationId = String(request.station_id);
  const categoryId = request.category_id === null ? null : String(request.category_id);

  const contractorRes = await db.execute({
    sql: `SELECT id, is_prequalified, status FROM contractors
           WHERE id = ? AND org_id = ? AND deleted_at IS NULL LIMIT 1`,
    args: [input.contractorId, orgId],
  });
  const contractor = contractorRes.rows[0];
  if (!contractor) return { ok: false, code: 'invalid', message: 'Contractor not found.' };
  if (Number(contractor.is_prequalified) !== 1 || String(contractor.status) !== 'ACTIVE') {
    return {
      ok: false,
      code: 'invalid',
      message: 'The contractor is not pre-qualified and active.',
    };
  }

  const coverage = await db.execute({
    sql: `SELECT
            (SELECT COUNT(*) FROM contractor_stations
              WHERE org_id = ? AND contractor_id = ? AND station_id = ?) AS by_station,
            (SELECT COUNT(*) FROM contractor_categories
              WHERE org_id = ? AND contractor_id = ? AND category_id = ?) AS by_category`,
    args: [orgId, input.contractorId, stationId, orgId, input.contractorId, categoryId],
  });
  const cov = coverage.rows[0];
  const covered = Number(cov?.by_station ?? 0) > 0 || Number(cov?.by_category ?? 0) > 0;
  if (!covered) {
    return {
      ok: false,
      code: 'invalid',
      message: 'The contractor does not cover this station or category.',
    };
  }

  let slaId: string | null = null;
  if (input.slaId) {
    const slaRes = await db.execute({
      sql: `SELECT id FROM slas WHERE id = ? AND org_id = ? LIMIT 1`,
      args: [input.slaId, orgId],
    });
    slaId = slaRes.rows[0] ? input.slaId : null;
  }

  const year = new Date().getUTCFullYear();
  const base = await countWoForYear(db, orgId, year);
  const now = new Date().toISOString();

  for (let attempt = 0; attempt < 5; attempt++) {
    const woNo = `WO-${year}-${String(base + 1 + attempt).padStart(4, '0')}`;
    const id = newId();
    const tx = await db.transaction('write');
    try {
      // Move the request from ACCEPTED to ASSIGNED under an optimistic guard, so
      // two engineers cannot both assign the same request.
      const moved = await tx.execute({
        sql: `UPDATE service_requests SET status = 'ASSIGNED', updated_at = ?
               WHERE id = ? AND org_id = ? AND status = 'ACCEPTED'`,
        args: [now, input.requestId, orgId],
      });
      if (moved.rowsAffected === 0) {
        await tx.rollback();
        return {
          ok: false,
          code: 'conflict',
          message: 'The request is no longer available to assign.',
        };
      }

      await tx.execute({
        sql: `INSERT INTO work_orders
                (id, org_id, wo_no, request_id, station_id, category_id, contractor_id, sla_id,
                 source, assignment_basis, status, created_by)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'REQUEST', 'PREDEFINED_RATE', 'CONTRACTOR_NOTIFIED', ?)`,
        args: [
          id,
          orgId,
          woNo,
          input.requestId,
          stationId,
          categoryId,
          input.contractorId,
          slaId,
          ctx.userId,
        ],
      });

      await tx.execute({
        sql: `INSERT INTO audit_logs
                (org_id, actor_user_id, action, entity_type, entity_id, after_json)
              VALUES (?, ?, 'workorder.create', 'work_order', ?, ?)`,
        args: [
          orgId,
          ctx.userId,
          id,
          JSON.stringify({ wo_no: woNo, status: 'CONTRACTOR_NOTIFIED' }),
        ],
      });

      await enqueue(tx, orgId, {
        recipientType: 'contractor',
        recipientId: input.contractorId,
        templateKey: 'workorder.assigned',
        subject: `New work order ${woNo}`,
        body: `Work order ${woNo} has been assigned to you. Please accept or reject it.`,
        entityType: 'work_order',
        entityId: id,
      });

      await tx.commit();
      return { ok: true, workOrderId: id, woNo };
    } catch (err) {
      await tx.rollback();
      if (isUniqueViolation(err) && attempt < 4) continue;
      throw err;
    }
  }
  return { ok: false, code: 'conflict', message: 'Could not allocate a work order number.' };
}

// ---- reads ------------------------------------------------------------------

export interface WorkOrderListRow {
  id: string;
  woNo: string;
  status: string;
  stationName: string;
  contractorName: string | null;
  technicianName: string | null;
  createdAt: string;
}

export interface WorkOrderDetail extends WorkOrderListRow {
  stationId: string;
  stationManagerId: string | null;
  contractorId: string | null;
  contractorPortalUserId: string | null;
  technicianId: string | null;
  technicianPortalUserId: string | null;
  slaName: string | null;
  requestId: string | null;
  requestNo: string | null;
  source: string;
  assignmentBasis: string;
  createdBy: string;
  contractorAcceptedAt: string | null;
  techAssignedAt: string | null;
  techAcceptedAt: string | null;
  onsiteAt: string | null;
  closedAt: string | null;
}

const LIST_SELECT = `
  SELECT wo.id, wo.wo_no, wo.status, wo.created_at,
         s.name AS station_name,
         c.name AS contractor_name,
         t.full_name AS technician_name
    FROM work_orders wo
    JOIN stations s ON s.id = wo.station_id
    LEFT JOIN contractors c ON c.id = wo.contractor_id
    LEFT JOIN technicians t ON t.id = wo.technician_id
   WHERE wo.org_id = ? AND wo.deleted_at IS NULL`;

function mapListRow(row: Record<string, unknown>): WorkOrderListRow {
  return {
    id: String(row.id),
    woNo: String(row.wo_no),
    status: String(row.status),
    stationName: String(row.station_name),
    contractorName: row.contractor_name == null ? null : String(row.contractor_name),
    technicianName: row.technician_name == null ? null : String(row.technician_name),
    createdAt: String(row.created_at),
  };
}

export async function listForEngineer(
  db: Client,
  orgId: string,
  status?: string,
  station?: string,
): Promise<WorkOrderListRow[]> {
  const args: string[] = [orgId];
  let sql = LIST_SELECT;
  if (status) {
    sql += ' AND wo.status = ?';
    args.push(status);
  }
  if (station) {
    sql += ' AND wo.station_id = ?';
    args.push(station);
  }
  sql += ' ORDER BY wo.created_at DESC LIMIT 200';
  const res = await db.execute({ sql, args });
  return res.rows.map((r) => mapListRow(r as Record<string, unknown>));
}

export async function listForContractor(
  db: Client,
  orgId: string,
  userId: string,
): Promise<WorkOrderListRow[]> {
  const res = await db.execute({
    sql: `${LIST_SELECT}
            AND wo.contractor_id IN (SELECT id FROM contractors WHERE org_id = ? AND portal_user_id = ?)
       ORDER BY wo.created_at DESC LIMIT 200`,
    args: [orgId, orgId, userId],
  });
  return res.rows.map((r) => mapListRow(r as Record<string, unknown>));
}

export async function listForTechnician(
  db: Client,
  orgId: string,
  userId: string,
): Promise<WorkOrderListRow[]> {
  const res = await db.execute({
    sql: `${LIST_SELECT}
            AND wo.technician_id IN (SELECT id FROM technicians WHERE org_id = ? AND portal_user_id = ?)
       ORDER BY wo.created_at DESC LIMIT 200`,
    args: [orgId, orgId, userId],
  });
  return res.rows.map((r) => mapListRow(r as Record<string, unknown>));
}

// Station managers see the work orders at their stations that await an arrival or
// a closure confirmation, the two actions they perform.
export async function listForStationManager(
  db: Client,
  orgId: string,
  userId: string,
): Promise<WorkOrderListRow[]> {
  const res = await db.execute({
    sql: `${LIST_SELECT}
            AND s.station_manager_id = ?
            AND wo.status IN ('TECH_ACCEPTED','WORK_DONE_PENDING_CONFIRM')
       ORDER BY wo.created_at DESC LIMIT 200`,
    args: [orgId, userId],
  });
  return res.rows.map((r) => mapListRow(r as Record<string, unknown>));
}

export async function getWorkOrderDetail(
  db: Client,
  orgId: string,
  id: string,
): Promise<WorkOrderDetail | null> {
  const res = await db.execute({
    sql: `SELECT wo.id, wo.wo_no, wo.status, wo.created_at, wo.source, wo.assignment_basis,
                 wo.created_by, wo.station_id, wo.contractor_id, wo.technician_id, wo.sla_id,
                 wo.request_id, wo.contractor_accepted_at, wo.tech_assigned_at, wo.tech_accepted_at,
                 wo.onsite_at, wo.closed_at,
                 s.name AS station_name, s.station_manager_id AS station_manager_id,
                 c.name AS contractor_name, c.portal_user_id AS contractor_portal_user_id,
                 t.full_name AS technician_name, t.portal_user_id AS technician_portal_user_id,
                 sla.name AS sla_name, r.request_no AS request_no
            FROM work_orders wo
            JOIN stations s ON s.id = wo.station_id
            LEFT JOIN contractors c ON c.id = wo.contractor_id
            LEFT JOIN technicians t ON t.id = wo.technician_id
            LEFT JOIN slas sla ON sla.id = wo.sla_id
            LEFT JOIN service_requests r ON r.id = wo.request_id
           WHERE wo.id = ? AND wo.org_id = ? AND wo.deleted_at IS NULL LIMIT 1`,
    args: [id, orgId],
  });
  const row = res.rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    ...mapListRow(row),
    status: String(row.status) as WoStatus,
    stationId: String(row.station_id),
    stationManagerId: row.station_manager_id == null ? null : String(row.station_manager_id),
    contractorId: row.contractor_id == null ? null : String(row.contractor_id),
    contractorPortalUserId:
      row.contractor_portal_user_id == null ? null : String(row.contractor_portal_user_id),
    technicianId: row.technician_id == null ? null : String(row.technician_id),
    technicianPortalUserId:
      row.technician_portal_user_id == null ? null : String(row.technician_portal_user_id),
    slaName: row.sla_name == null ? null : String(row.sla_name),
    requestId: row.request_id == null ? null : String(row.request_id),
    requestNo: row.request_no == null ? null : String(row.request_no),
    source: String(row.source),
    assignmentBasis: String(row.assignment_basis),
    createdBy: String(row.created_by),
    contractorAcceptedAt:
      row.contractor_accepted_at == null ? null : String(row.contractor_accepted_at),
    techAssignedAt: row.tech_assigned_at == null ? null : String(row.tech_assigned_at),
    techAcceptedAt: row.tech_accepted_at == null ? null : String(row.tech_accepted_at),
    onsiteAt: row.onsite_at == null ? null : String(row.onsite_at),
    closedAt: row.closed_at == null ? null : String(row.closed_at),
  };
}
