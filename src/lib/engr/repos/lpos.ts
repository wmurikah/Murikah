/**
 * Local purchase order (LPO) repository. An LPO groups several work orders across
 * different stations for one contractor, so the trip can carry a single mileage
 * claim. Attaching a work order only sets its lpo_id; its state-machine status is
 * never written here. Every query is org-scoped.
 */
import type { Client } from '@libsql/client/web';
import { enqueue } from '../notify';

const newId = (): string => crypto.randomUUID().replace(/-/g, '');

function isUniqueViolation(err: unknown): boolean {
  const text = String(err instanceof Error ? err.message : err);
  return text.includes('UNIQUE') || text.includes('SQLITE_CONSTRAINT');
}

const OPEN_WO_STATUSES = "('CLOSED','CANCELLED')"; // closed set, for the close guard

export type LpoResult =
  | { ok: true; lpoId: string; lpoNo: string }
  | { ok: false; code: 'not_found' | 'invalid' | 'conflict'; message: string };

export type WoInLpoResult =
  | { ok: true; workOrderId: string; woNo: string }
  | { ok: false; code: 'not_found' | 'invalid' | 'conflict'; message: string };

export type SimpleResult =
  | { ok: true }
  | { ok: false; code: 'not_found' | 'invalid' | 'conflict'; message: string };

async function countLpoForYear(db: Client, orgId: string, year: number): Promise<number> {
  const res = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM lpos WHERE org_id = ? AND lpo_no LIKE ?`,
    args: [orgId, `LPO-${year}-%`],
  });
  return Number(res.rows[0]?.n ?? 0);
}

async function countWoForYear(db: Client, orgId: string, year: number): Promise<number> {
  const res = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM work_orders WHERE org_id = ? AND wo_no LIKE ?`,
    args: [orgId, `WO-${year}-%`],
  });
  return Number(res.rows[0]?.n ?? 0);
}

export async function createLpo(
  db: Client,
  ctx: { orgId: string; userId: string },
  input: {
    contractorId: string;
    baseStationId: string | null;
    regionId?: string | null;
    notes?: string | null;
  },
): Promise<LpoResult> {
  const { orgId } = ctx;
  const contractor = await db.execute({
    sql: `SELECT id FROM contractors WHERE id = ? AND org_id = ? AND deleted_at IS NULL AND status = 'ACTIVE' LIMIT 1`,
    args: [input.contractorId, orgId],
  });
  if (!contractor.rows[0]) {
    return { ok: false, code: 'invalid', message: 'Choose an active contractor.' };
  }

  // The document carries where it belongs: default the region from the base
  // station's region unless one is supplied, so the LPO is complete on its face.
  let regionId = input.regionId ?? null;
  if (!regionId && input.baseStationId) {
    const st = await db.execute({
      sql: `SELECT region_id FROM stations WHERE id = ? AND org_id = ? LIMIT 1`,
      args: [input.baseStationId, orgId],
    });
    regionId = st.rows[0]?.region_id == null ? null : String(st.rows[0].region_id);
  }
  const notes = input.notes && input.notes.trim().length > 0 ? input.notes.trim() : null;

  const year = new Date().getUTCFullYear();
  const base = await countLpoForYear(db, orgId, year);

  for (let attempt = 0; attempt < 5; attempt++) {
    const lpoNo = `LPO-${year}-${String(base + 1 + attempt).padStart(4, '0')}`;
    const id = newId();
    const tx = await db.transaction('write');
    try {
      // A draft: version 1, no approved_at yet. The contractor is notified at
      // issue, not now, because a draft is not yet a financial commitment.
      await tx.execute({
        sql: `INSERT INTO lpos (id, org_id, lpo_no, contractor_id, created_by, base_station_id, region_id, notes, version, status)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'OPEN')`,
        args: [
          id,
          orgId,
          lpoNo,
          input.contractorId,
          ctx.userId,
          input.baseStationId,
          regionId,
          notes,
        ],
      });
      await tx.execute({
        sql: `INSERT INTO audit_logs (org_id, actor_user_id, action, entity_type, entity_id, after_json)
              VALUES (?, ?, 'lpo.create', 'lpo', ?, ?)`,
        args: [orgId, ctx.userId, id, JSON.stringify({ lpo_no: lpoNo, version: 1 })],
      });
      await tx.commit();
      return { ok: true, lpoId: id, lpoNo };
    } catch (err) {
      await tx.rollback();
      if (isUniqueViolation(err) && attempt < 4) continue;
      throw err;
    }
  }
  return { ok: false, code: 'conflict', message: 'Could not allocate an LPO number.' };
}

interface LpoCore {
  id: string;
  contractorId: string;
  baseStationId: string | null;
  status: string;
  approvedAt: string | null;
  sealedAt: string | null;
  cancelledAt: string | null;
}

async function loadLpo(db: Client, orgId: string, lpoId: string): Promise<LpoCore | null> {
  const res = await db.execute({
    sql: `SELECT id, contractor_id, base_station_id, status, approved_at, sealed_at, cancelled_at
            FROM lpos WHERE id = ? AND org_id = ? LIMIT 1`,
    args: [lpoId, orgId],
  });
  const row = res.rows[0];
  if (!row) return null;
  const orNull = (v: unknown): string | null => (v == null ? null : String(v));
  return {
    id: String(row.id),
    contractorId: String(row.contractor_id),
    baseStationId: row.base_station_id == null ? null : String(row.base_station_id),
    status: String(row.status),
    approvedAt: orNull(row.approved_at),
    sealedAt: orNull(row.sealed_at),
    cancelledAt: orNull(row.cancelled_at),
  };
}

// A draft is editable: no approval, seal or cancellation yet. Once approved or
// sealed, the lines are frozen and no work order may be added or attached.
function isDraft(lpo: LpoCore): boolean {
  return lpo.approvedAt == null && lpo.sealedAt == null && lpo.cancelledAt == null;
}

async function markInProgress(
  tx: Awaited<ReturnType<Client['transaction']>>,
  orgId: string,
  lpoId: string,
  now: string,
): Promise<void> {
  await tx.execute({
    sql: `UPDATE lpos SET status = 'IN_PROGRESS', updated_at = ? WHERE id = ? AND org_id = ? AND status = 'OPEN'`,
    args: [now, lpoId, orgId],
  });
}

/**
 * Create a new work order inside the LPO on predefined rates, at its own station,
 * entering the flow at CONTRACTOR_NOTIFIED. Creation sets the initial status; the
 * state machine owns every later change.
 */
export async function createWorkOrderInLpo(
  db: Client,
  ctx: { orgId: string; userId: string },
  input: {
    lpoId: string;
    stationId: string;
    categoryId: string | null;
    slaId: string | null;
    mileageReferenceStationId: string | null;
  },
): Promise<WoInLpoResult> {
  const { orgId } = ctx;
  const lpo = await loadLpo(db, orgId, input.lpoId);
  if (!lpo) return { ok: false, code: 'not_found', message: 'LPO not found.' };
  if (!isDraft(lpo)) {
    return {
      ok: false,
      code: 'conflict',
      message: 'This LPO is approved or sealed and can no longer take work orders.',
    };
  }
  const station = await db.execute({
    sql: `SELECT id FROM stations WHERE id = ? AND org_id = ? AND deleted_at IS NULL LIMIT 1`,
    args: [input.stationId, orgId],
  });
  if (!station.rows[0]) return { ok: false, code: 'invalid', message: 'Choose a valid station.' };

  const year = new Date().getUTCFullYear();
  const base = await countWoForYear(db, orgId, year);
  const now = new Date().toISOString();

  for (let attempt = 0; attempt < 5; attempt++) {
    const woNo = `WO-${year}-${String(base + 1 + attempt).padStart(4, '0')}`;
    const id = newId();
    const tx = await db.transaction('write');
    try {
      await tx.execute({
        sql: `INSERT INTO work_orders
                (id, org_id, wo_no, lpo_id, station_id, base_station_id, mileage_reference_station_id,
                 category_id, contractor_id, sla_id, source, assignment_basis, status, created_by)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'LPO', 'PREDEFINED_RATE', 'CONTRACTOR_NOTIFIED', ?)`,
        args: [
          id,
          orgId,
          woNo,
          input.lpoId,
          input.stationId,
          lpo.baseStationId,
          input.mileageReferenceStationId,
          input.categoryId,
          lpo.contractorId,
          input.slaId,
          ctx.userId,
        ],
      });
      await tx.execute({
        sql: `INSERT INTO audit_logs (org_id, actor_user_id, action, entity_type, entity_id, after_json)
              VALUES (?, ?, 'workorder.create', 'work_order', ?, ?)`,
        args: [
          orgId,
          ctx.userId,
          id,
          JSON.stringify({
            wo_no: woNo,
            status: 'CONTRACTOR_NOTIFIED',
            source: 'LPO',
            lpo_id: input.lpoId,
          }),
        ],
      });
      await enqueue(tx, orgId, {
        recipientType: 'contractor',
        recipientId: lpo.contractorId,
        templateKey: 'workorder.assigned',
        subject: `New work order ${woNo}`,
        body: `Work order ${woNo} has been added to your LPO. Please accept or reject it.`,
        entityType: 'work_order',
        entityId: id,
      });
      await markInProgress(tx, orgId, input.lpoId, now);
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

/** Attach an existing work order for the same contractor to the LPO. */
export async function attachWorkOrder(
  db: Client,
  ctx: { orgId: string; userId: string },
  lpoId: string,
  workOrderId: string,
): Promise<SimpleResult> {
  const { orgId } = ctx;
  const lpo = await loadLpo(db, orgId, lpoId);
  if (!lpo) return { ok: false, code: 'not_found', message: 'LPO not found.' };
  if (!isDraft(lpo)) {
    return {
      ok: false,
      code: 'conflict',
      message: 'This LPO is approved or sealed and can no longer take work orders.',
    };
  }
  const now = new Date().toISOString();
  const tx = await db.transaction('write');
  try {
    const moved = await tx.execute({
      sql: `UPDATE work_orders SET lpo_id = ?, updated_at = ?
             WHERE id = ? AND org_id = ? AND contractor_id = ? AND lpo_id IS NULL AND deleted_at IS NULL`,
      args: [lpoId, now, workOrderId, orgId, lpo.contractorId],
    });
    if (moved.rowsAffected === 0) {
      await tx.rollback();
      return {
        ok: false,
        code: 'conflict',
        message: 'That work order is not available to attach, or belongs to another contractor.',
      };
    }
    await tx.execute({
      sql: `INSERT INTO audit_logs (org_id, actor_user_id, action, entity_type, entity_id, after_json)
            VALUES (?, ?, 'lpo.attach', 'work_order', ?, ?)`,
      args: [orgId, ctx.userId, workOrderId, JSON.stringify({ lpo_id: lpoId })],
    });
    await markInProgress(tx, orgId, lpoId, now);
    await tx.commit();
    return { ok: true };
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}

/** Close the LPO. Guarded: every attached work order must be CLOSED or CANCELLED. */
export async function closeLpo(
  db: Client,
  ctx: { orgId: string; userId: string },
  lpoId: string,
): Promise<SimpleResult> {
  const { orgId } = ctx;
  const now = new Date().toISOString();
  const res = await db.execute({
    sql: `UPDATE lpos SET status = 'CLOSED', updated_at = ?
           WHERE id = ? AND org_id = ? AND status IN ('OPEN','IN_PROGRESS')
             AND NOT EXISTS (
               SELECT 1 FROM work_orders wo
                WHERE wo.lpo_id = lpos.id AND wo.org_id = lpos.org_id
                  AND wo.deleted_at IS NULL AND wo.status NOT IN ${OPEN_WO_STATUSES}
             )`,
    args: [now, lpoId, orgId],
  });
  if (res.rowsAffected === 0) {
    return {
      ok: false,
      code: 'conflict',
      message: 'The LPO can only be closed once every work order is closed or cancelled.',
    };
  }
  await db.execute({
    sql: `INSERT INTO audit_logs (org_id, actor_user_id, action, entity_type, entity_id, after_json)
          VALUES (?, ?, 'lpo.close', 'lpo', ?, ?)`,
    args: [orgId, ctx.userId, lpoId, JSON.stringify({ status: 'CLOSED' })],
  });
  return { ok: true };
}

/**
 * Recompute lpos.total_minor from the approved costs available so far: approved
 * work-order costs (Prompt 6) plus the approved mileage claim. Called after
 * mileage approval; forward-compatible with the costing prompt.
 */
export async function recomputeTotal(db: Client, orgId: string, lpoId: string): Promise<void> {
  const woCosts = await db.execute({
    sql: `SELECT COALESCE(SUM(wc.total_minor), 0) AS total
            FROM work_costs wc
            JOIN work_orders wo ON wo.id = wc.work_order_id
           WHERE wo.lpo_id = ? AND wc.org_id = ? AND wc.status = 'APPROVED'`,
    args: [lpoId, orgId],
  });
  const mileage = await db.execute({
    sql: `SELECT COALESCE(SUM(amount_minor), 0) AS total
            FROM mileage_claims WHERE lpo_id = ? AND org_id = ? AND status = 'APPROVED'`,
    args: [lpoId, orgId],
  });
  const total = Number(woCosts.rows[0]?.total ?? 0) + Number(mileage.rows[0]?.total ?? 0);
  // Never touch a sealed LPO: its total is frozen at issue, so a later cost or
  // mileage approval cannot mutate the sealed document's financial fields.
  await db.execute({
    sql: `UPDATE lpos SET total_minor = ?, updated_at = ? WHERE id = ? AND org_id = ? AND sealed_at IS NULL`,
    args: [total, new Date().toISOString(), lpoId, orgId],
  });
}

// ---- reads ------------------------------------------------------------------

export interface LpoListRow {
  id: string;
  lpoNo: string;
  contractorName: string;
  baseStationName: string | null;
  status: string;
  totalMinor: number;
  currency: string;
  woCount: number;
  createdAt: string;
}

const LPO_LIST_SELECT = `
  SELECT l.id, l.lpo_no, l.status, l.total_minor, l.currency, l.created_at,
         c.name AS contractor_name, s.name AS base_station_name,
         (SELECT COUNT(*) FROM work_orders wo WHERE wo.lpo_id = l.id) AS wo_count
    FROM lpos l
    JOIN contractors c ON c.id = l.contractor_id
    LEFT JOIN stations s ON s.id = l.base_station_id
   WHERE l.org_id = ?`;

function mapLpoRow(row: Record<string, unknown>): LpoListRow {
  return {
    id: String(row.id),
    lpoNo: String(row.lpo_no),
    contractorName: String(row.contractor_name),
    baseStationName: row.base_station_name == null ? null : String(row.base_station_name),
    status: String(row.status),
    totalMinor: Number(row.total_minor ?? 0),
    currency: String(row.currency),
    woCount: Number(row.wo_count ?? 0),
    createdAt: String(row.created_at),
  };
}

export async function listLpos(db: Client, orgId: string): Promise<LpoListRow[]> {
  const res = await db.execute({
    sql: `${LPO_LIST_SELECT} ORDER BY l.created_at DESC LIMIT 200`,
    args: [orgId],
  });
  return res.rows.map((r) => mapLpoRow(r as Record<string, unknown>));
}

export async function listLposForContractor(
  db: Client,
  orgId: string,
  contractorId: string,
): Promise<LpoListRow[]> {
  const res = await db.execute({
    sql: `${LPO_LIST_SELECT} AND l.contractor_id = ? ORDER BY l.created_at DESC LIMIT 200`,
    args: [orgId, contractorId],
  });
  return res.rows.map((r) => mapLpoRow(r as Record<string, unknown>));
}

export interface LpoWorkOrder {
  id: string;
  woNo: string;
  stationName: string;
  status: string;
}

export interface LpoClaim {
  id: string;
  status: string;
  distanceKm: number;
  ratePerKmMinor: number;
  amountMinor: number;
  currency: string;
  baseStationName: string | null;
  referencedStationName: string | null;
}

export interface LpoDetail {
  id: string;
  lpoNo: string;
  status: string;
  contractorId: string;
  contractorName: string;
  baseStationId: string | null;
  baseStationName: string | null;
  totalMinor: number;
  currency: string;
  createdAt: string;
  workOrders: LpoWorkOrder[];
  claim: LpoClaim | null;
}

export async function getLpoDetail(
  db: Client,
  orgId: string,
  lpoId: string,
): Promise<LpoDetail | null> {
  const head = await db.execute({
    sql: `SELECT l.id, l.lpo_no, l.status, l.contractor_id, l.base_station_id, l.total_minor,
                 l.currency, l.created_at, c.name AS contractor_name, s.name AS base_station_name
            FROM lpos l
            JOIN contractors c ON c.id = l.contractor_id
            LEFT JOIN stations s ON s.id = l.base_station_id
           WHERE l.id = ? AND l.org_id = ? LIMIT 1`,
    args: [lpoId, orgId],
  });
  const row = head.rows[0];
  if (!row) return null;

  const wos = await db.execute({
    sql: `SELECT wo.id, wo.wo_no, wo.status, st.name AS station_name
            FROM work_orders wo
            JOIN stations st ON st.id = wo.station_id
           WHERE wo.lpo_id = ? AND wo.org_id = ? AND wo.deleted_at IS NULL
        ORDER BY wo.created_at`,
    args: [lpoId, orgId],
  });

  const claimRes = await db.execute({
    sql: `SELECT m.id, m.status, m.distance_km, m.rate_per_km_minor, m.amount_minor, m.currency,
                 b.name AS base_name, r.name AS ref_name
            FROM mileage_claims m
            LEFT JOIN stations b ON b.id = m.base_station_id
            LEFT JOIN stations r ON r.id = m.referenced_to_station_id
           WHERE m.lpo_id = ? AND m.org_id = ?
        ORDER BY m.created_at DESC LIMIT 1`,
    args: [lpoId, orgId],
  });
  const claimRow = claimRes.rows[0];

  return {
    id: String(row.id),
    lpoNo: String(row.lpo_no),
    status: String(row.status),
    contractorId: String(row.contractor_id),
    contractorName: String(row.contractor_name),
    baseStationId: row.base_station_id == null ? null : String(row.base_station_id),
    baseStationName: row.base_station_name == null ? null : String(row.base_station_name),
    totalMinor: Number(row.total_minor ?? 0),
    currency: String(row.currency),
    createdAt: String(row.created_at),
    workOrders: wos.rows.map((w) => ({
      id: String(w.id),
      woNo: String(w.wo_no),
      stationName: String(w.station_name),
      status: String(w.status),
    })),
    claim: claimRow
      ? {
          id: String(claimRow.id),
          status: String(claimRow.status),
          distanceKm: Number(claimRow.distance_km),
          ratePerKmMinor: Number(claimRow.rate_per_km_minor),
          amountMinor: Number(claimRow.amount_minor),
          currency: String(claimRow.currency),
          baseStationName: claimRow.base_name == null ? null : String(claimRow.base_name),
          referencedStationName: claimRow.ref_name == null ? null : String(claimRow.ref_name),
        }
      : null,
  };
}

/** Existing work orders for the LPO's contractor that are not yet in any LPO. */
export async function listAttachableWorkOrders(
  db: Client,
  orgId: string,
  lpoId: string,
): Promise<LpoWorkOrder[]> {
  const lpo = await loadLpo(db, orgId, lpoId);
  if (!lpo) return [];
  const res = await db.execute({
    sql: `SELECT wo.id, wo.wo_no, wo.status, st.name AS station_name
            FROM work_orders wo
            JOIN stations st ON st.id = wo.station_id
           WHERE wo.org_id = ? AND wo.contractor_id = ? AND wo.lpo_id IS NULL
             AND wo.deleted_at IS NULL AND wo.status NOT IN ('CLOSED','CANCELLED')
        ORDER BY wo.created_at DESC LIMIT 100`,
    args: [orgId, lpo.contractorId],
  });
  return res.rows.map((w) => ({
    id: String(w.id),
    woNo: String(w.wo_no),
    stationName: String(w.station_name),
    status: String(w.status),
  }));
}
