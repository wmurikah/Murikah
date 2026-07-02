/**
 * Allocate a PM occurrence into the work-order spine. This creates the work
 * order at CONTRACTOR_NOTIFIED, the same entry point as a direct predefined-rate
 * assignment, because the contractor is pre-assigned on the schedule but has not
 * yet agreed to this specific job. From here the contractor accepts and the rest
 * of the Prompt 2 flow runs unchanged. Creation is a sibling of
 * createWorkOrderFromRequest; the state machine owns every later status change.
 */
import type { Client } from '@libsql/client/web';
import { enqueue } from '../notify';

const newId = (): string => crypto.randomUUID().replace(/-/g, '');

function isUniqueViolation(err: unknown): boolean {
  const text = String(err instanceof Error ? err.message : err);
  return text.includes('UNIQUE') || text.includes('SQLITE_CONSTRAINT');
}

export type AllocateResult =
  | { ok: true; workOrderId: string; woNo: string }
  | { ok: false; code: 'not_found' | 'invalid' | 'conflict'; message: string };

interface OccurrenceSchedule {
  occurrenceId: string;
  status: string;
  scheduleName: string;
  stationId: string | null;
  categoryId: string | null;
  contractorId: string | null;
  slaId: string | null;
}

async function loadOccurrence(
  db: Client,
  orgId: string,
  occurrenceId: string,
): Promise<OccurrenceSchedule | null> {
  const res = await db.execute({
    sql: `SELECT o.id, o.status, s.name AS schedule_name, s.station_id, s.category_id,
                 s.assigned_contractor_id, s.sla_id
            FROM pm_occurrences o
            JOIN pm_schedules s ON s.id = o.pm_schedule_id
           WHERE o.id = ? AND o.org_id = ? LIMIT 1`,
    args: [occurrenceId, orgId],
  });
  const row = res.rows[0];
  if (!row) return null;
  return {
    occurrenceId: String(row.id),
    status: String(row.status),
    scheduleName: String(row.schedule_name),
    stationId: row.station_id == null ? null : String(row.station_id),
    categoryId: row.category_id == null ? null : String(row.category_id),
    contractorId: row.assigned_contractor_id == null ? null : String(row.assigned_contractor_id),
    slaId: row.sla_id == null ? null : String(row.sla_id),
  };
}

async function countWoForYear(db: Client, orgId: string, year: number): Promise<number> {
  const res = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM work_orders WHERE org_id = ? AND wo_no LIKE ?`,
    args: [orgId, `WO-${year}-%`],
  });
  return Number(res.rows[0]?.n ?? 0);
}

const ALLOCATABLE = ['SCHEDULED', 'NOTIFIED_1M', 'NOTIFIED_2W'];

export async function allocateOccurrence(
  db: Client,
  ctx: { orgId: string; userId: string },
  occurrenceId: string,
): Promise<AllocateResult> {
  const { orgId } = ctx;
  const occ = await loadOccurrence(db, orgId, occurrenceId);
  if (!occ) return { ok: false, code: 'not_found', message: 'Occurrence not found.' };
  if (!ALLOCATABLE.includes(occ.status)) {
    return { ok: false, code: 'conflict', message: 'This occurrence cannot be allocated now.' };
  }
  if (!occ.stationId) {
    return { ok: false, code: 'invalid', message: 'The schedule has no station to allocate to.' };
  }
  if (!occ.contractorId) {
    return { ok: false, code: 'invalid', message: 'The schedule has no assigned contractor.' };
  }
  const stationId = occ.stationId;
  const contractorId = occ.contractorId;

  const year = new Date().getUTCFullYear();
  const base = await countWoForYear(db, orgId, year);
  const now = new Date().toISOString();

  for (let attempt = 0; attempt < 5; attempt++) {
    const woNo = `WO-${year}-${String(base + 1 + attempt).padStart(4, '0')}`;
    const id = newId();
    const tx = await db.transaction('write');
    try {
      const moved = await tx.execute({
        sql: `UPDATE pm_occurrences SET status = 'WORK_ORDER_CREATED', updated_at = ?
               WHERE id = ? AND org_id = ? AND status IN ('SCHEDULED', 'NOTIFIED_1M', 'NOTIFIED_2W')`,
        args: [now, occ.occurrenceId, orgId],
      });
      if (moved.rowsAffected === 0) {
        await tx.rollback();
        return { ok: false, code: 'conflict', message: 'This occurrence was already allocated.' };
      }

      await tx.execute({
        sql: `INSERT INTO work_orders
                (id, org_id, wo_no, pm_occurrence_id, station_id, category_id, contractor_id, sla_id,
                 source, assignment_basis, status, created_by)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PM', 'PM', 'CONTRACTOR_NOTIFIED', ?)`,
        args: [
          id,
          orgId,
          woNo,
          occ.occurrenceId,
          stationId,
          occ.categoryId,
          contractorId,
          occ.slaId,
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
          JSON.stringify({ wo_no: woNo, status: 'CONTRACTOR_NOTIFIED', source: 'PM' }),
        ],
      });

      await enqueue(tx, orgId, {
        recipientType: 'contractor',
        recipientId: contractorId,
        templateKey: 'pm.allocated',
        subject: `Scheduled maintenance work order ${woNo}`,
        body: `Work order ${woNo} for "${occ.scheduleName}" has been assigned to you. Please accept or reject it.`,
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
