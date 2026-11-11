/**
 * Controlled physical movements. The asset's official station is changed ONLY
 * when an independent receiving actor confirms physical receipt. All transfer
 * transitions, location updates, history and audit rows share a transaction.
 * Portal actors are additionally bound to the relevant station.
 */
import type { Client } from '@libsql/client/web';
import { actorDataScope } from '../auth/dataScope';
import { recordMovement } from './adminAssets';
import type { SqlExecutor } from '../notify';

export type TransferStatus =
  | 'REQUESTED' | 'APPROVED' | 'DISPATCHED'
  | 'RECEIVED' | 'REJECTED' | 'CANCELLED';
export interface TransferActor {
  orgId: string;
  userId: string;
  roles: readonly string[];
  perms: readonly string[];
}
export type TransferAction = 'approve' | 'reject' | 'dispatch' | 'receive' | 'cancel';
export type TransferResult =
  | { ok: true; id: string }
  | { ok: false; code: 'invalid' | 'not_found' | 'forbidden' | 'conflict'; message: string };

export interface TransferRow {
  id: string;
  assetId: string;
  assetTag: string;
  assetName: string;
  assetSerial: string | null;
  expectedSerial: string | null;
  fromStationId: string;
  fromStation: string;
  toStationId: string;
  toStation: string;
  fromManagerId: string | null;
  toManagerId: string | null;
  reason: string;
  status: TransferStatus;
  requestedBy: string;
  requestedName: string;
  approvedBy: string | null;
  dispatchedBy: string | null;
  receivedBy: string | null;
  requestedAt: string;
  approvedAt: string | null;
  dispatchedAt: string | null;
  receivedAt: string | null;
  dispatchedSerial: string | null;
  receivedSerial: string | null;
  dispatchCondition: string | null;
  receiptCondition: string | null;
  dispatchNote: string | null;
  receiptNote: string | null;
  resolutionReason: string | null;
}
export interface TransferAssetOption {
  id: string;
  tag: string;
  name: string;
  stationId: string;
  stationName: string;
}
export interface TransferStationOption {
  id: string;
  name: string;
}

const newId = (): string => crypto.randomUUID().replace(/-/g, '');
const permission = (actor: TransferActor, key: string) => actor.perms.includes(key);
const scope = (actor: TransferActor) => actorDataScope(actor.roles);
const owns = (actor: TransferActor, managerId: string | null) =>
  scope(actor) !== 'station' || managerId === actor.userId;
const canSee = (actor: TransferActor) =>
  ['assets.transfer.request','assets.transfer.approve','assets.transfer.dispatch','assets.transfer.receive']
    .some((key) => permission(actor, key));

const LIST_SELECT = `SELECT tr.*,
         a.tag AS asset_tag, a.name AS asset_name, a.serial_no AS asset_serial,
         fs.name AS from_station, ts.name AS to_station,
         fs.station_manager_id AS from_manager_id, ts.station_manager_id AS to_manager_id,
         COALESCE(u.full_name,'Former user') AS requested_name
    FROM asset_transfers tr
    JOIN assets a ON a.id = tr.asset_id AND a.org_id = tr.org_id
    JOIN stations fs ON fs.id = tr.from_station_id AND fs.org_id = tr.org_id
    JOIN stations ts ON ts.id = tr.to_station_id AND ts.org_id = tr.org_id
    LEFT JOIN users u ON u.id = tr.requested_by
   WHERE tr.org_id = ?`;

function mapTransfer(r: Record<string, unknown>): TransferRow {
  const optional = (v: unknown) => v == null ? null : String(v);
  return {
    id: String(r.id),
    assetId: String(r.asset_id),
    assetTag: String(r.asset_tag),
    assetName: String(r.asset_name),
    assetSerial: optional(r.asset_serial),
    expectedSerial: optional(r.expected_serial),
    fromStationId: String(r.from_station_id),
    fromStation: String(r.from_station),
    toStationId: String(r.to_station_id),
    toStation: String(r.to_station),
    fromManagerId: optional(r.from_manager_id),
    toManagerId: optional(r.to_manager_id),
    reason: String(r.reason),
    status: String(r.status) as TransferStatus,
    requestedBy: String(r.requested_by),
    requestedName: String(r.requested_name),
    approvedBy: optional(r.approved_by),
    dispatchedBy: optional(r.dispatched_by),
    receivedBy: optional(r.received_by),
    requestedAt: String(r.requested_at),
    approvedAt: optional(r.approved_at),
    dispatchedAt: optional(r.dispatched_at),
    receivedAt: optional(r.received_at),
    dispatchedSerial: optional(r.dispatched_serial),
    receivedSerial: optional(r.received_serial),
    dispatchCondition: optional(r.dispatch_condition),
    receiptCondition: optional(r.receipt_condition),
    dispatchNote: optional(r.dispatch_note),
    receiptNote: optional(r.receipt_note),
    resolutionReason: optional(r.resolution_reason),
  };
}
function visibleClause(actor: TransferActor) {
  return scope(actor) === 'station'
    ? ' AND (fs.station_manager_id = ? OR ts.station_manager_id = ?)'
    : '';
}
function visibleArgs(actor: TransferActor): string[] {
  return scope(actor) === 'station' ? [actor.userId, actor.userId] : [];
}

export async function listTransfers(db: Client, actor: TransferActor): Promise<TransferRow[]> {
  if (!canSee(actor)) return [];
  const result = await db.execute({
    sql: LIST_SELECT + visibleClause(actor) + ' ORDER BY tr.requested_at DESC, tr.id DESC LIMIT 200',
    args: [actor.orgId, ...visibleArgs(actor)],
  });
  return result.rows.map((r) => mapTransfer(r as Record<string, unknown>));
}

export async function getTransfer(db: Client, actor: TransferActor, id: string): Promise<TransferRow | null> {
  if (!canSee(actor)) return null;
  const result = await db.execute({
    sql: LIST_SELECT + visibleClause(actor) + ' AND tr.id = ? LIMIT 1',
    args: [actor.orgId, ...visibleArgs(actor), id],
  });
  return result.rows[0] ? mapTransfer(result.rows[0] as Record<string, unknown>) : null;
}

export async function listTransferAssets(db: Client, actor: TransferActor): Promise<TransferAssetOption[]> {
  if (!permission(actor, 'assets.transfer.request')) return [];
  const result = await db.execute({
    sql: `SELECT a.id, a.tag, a.name, a.station_id, s.name AS station_name
            FROM assets a JOIN stations s ON s.id = a.station_id AND s.org_id = a.org_id
           WHERE a.org_id = ? AND a.deleted_at IS NULL
             AND (? = 0 OR s.station_manager_id = ?)
        ORDER BY s.name, a.tag`,
    args: [actor.orgId, scope(actor) === 'station' ? 1 : 0, actor.userId],
  });
  return result.rows.map((r) => ({
    id: String(r.id), tag: String(r.tag), name: String(r.name),
    stationId: String(r.station_id), stationName: String(r.station_name),
  }));
}
export async function listTransferDestinations(db: Client, actor: TransferActor): Promise<TransferStationOption[]> {
  if (!permission(actor, 'assets.transfer.request')) return [];
  const result = await db.execute({
    sql: `SELECT id, name FROM stations
             WHERE org_id = ? AND deleted_at IS NULL AND status = 'ACTIVE'
          ORDER BY name`,
    args: [actor.orgId],
  });
  return result.rows.map((r) => ({ id: String(r.id), name: String(r.name) }));
}

async function hasOpenWork(db: SqlExecutor, orgId: string, assetId: string): Promise<boolean> {
  const result = await db.execute({
    sql: `SELECT
       (SELECT COUNT(*) FROM service_requests sr
         WHERE sr.org_id = ? AND sr.asset_id = ? AND sr.deleted_at IS NULL
           AND sr.status IN ('OPEN','ACCEPTED','RFQ','ASSIGNED','IN_PROGRESS'))
       + (SELECT COUNT(*) FROM work_orders wo
          LEFT JOIN service_requests sr ON sr.id = wo.request_id AND sr.org_id = wo.org_id
         WHERE wo.org_id = ? AND (wo.asset_id = ? OR sr.asset_id = ?)
           AND wo.deleted_at IS NULL AND wo.status NOT IN ('CLOSED','CANCELLED')) AS n`,
    args: [orgId, assetId, orgId, assetId, assetId],
  });
  return Number(result.rows[0]?.n ?? 0) > 0;
}

async function audit(
  tx: SqlExecutor,
  actor: TransferActor,
  id: string,
  event: string,
  details: Record<string, unknown>,
): Promise<void> {
  await tx.execute({
    sql: `INSERT INTO audit_logs (org_id, actor_user_id, action, entity_type, entity_id, after_json)
          VALUES (?, ?, ?, 'asset_transfer', ?, ?)`,
    args: [actor.orgId, actor.userId, event, id, JSON.stringify(details)],
  });
}

export async function requestTransfer(
  db: Client,
  actor: TransferActor,
  input: { assetId: string; toStationId: string; reason: string },
): Promise<TransferResult> {
  if (!permission(actor, 'assets.transfer.request'))
    return { ok: false, code: 'forbidden', message: 'You cannot request asset movements.' };
  if (!input.reason.trim() || input.reason.trim().length > 500)
    return { ok: false, code: 'invalid', message: 'Provide a reason (maximum 500 characters).' };
  const details = await db.execute({
    sql: `SELECT a.station_id, a.serial_no, s.station_manager_id,
                 COALESCE(s.affiliate_org_id, s.org_id) AS affiliate_org_id
            FROM assets a JOIN stations s ON s.id = a.station_id AND s.org_id = a.org_id
           WHERE a.org_id = ? AND a.id = ? AND a.deleted_at IS NULL LIMIT 1`,
    args: [actor.orgId, input.assetId],
  });
  const asset = details.rows[0];
  if (!asset) return { ok: false, code: 'not_found', message: 'Asset not found.' };
  const fromStationId = String(asset.station_id);
  if (!owns(actor, asset.station_manager_id == null ? null : String(asset.station_manager_id)))
    return { ok: false, code: 'forbidden', message: 'Only the sending location can request this movement.' };
  if (fromStationId === input.toStationId)
    return { ok: false, code: 'invalid', message: 'Destination must differ from the current location.' };
  const target = await db.execute({
    sql: `SELECT id FROM stations WHERE id = ? AND org_id = ?
             AND COALESCE(affiliate_org_id, org_id) = ?
             AND status = 'ACTIVE' AND deleted_at IS NULL LIMIT 1`,
    args: [input.toStationId, actor.orgId, String(asset.affiliate_org_id)],
  });
  if (!target.rows.length)
    return { ok: false, code: 'invalid', message: 'Select an active destination in the same affiliate.' };
  if (await hasOpenWork(db, actor.orgId, input.assetId))
    return { ok: false, code: 'conflict', message: 'Complete or cancel open repair work before requesting a transfer.' };
  const id = newId();
  const tx = await db.transaction('write');
  try {
    const inserted = await tx.execute({
      sql: `INSERT INTO asset_transfers
        (id, org_id, asset_id, from_station_id, to_station_id, reason, requested_by, expected_serial)
        SELECT ?, ?, a.id, a.station_id, ?, ?, ?, a.serial_no
          FROM assets a WHERE a.id = ? AND a.org_id = ? AND a.station_id = ? AND a.deleted_at IS NULL`,
      args: [id, actor.orgId, input.toStationId, input.reason.trim(), actor.userId, input.assetId, actor.orgId, fromStationId],
    });
    if (inserted.rowsAffected !== 1) {
      await tx.rollback();
      return { ok: false, code: 'conflict', message: 'Asset moved while the request was being created.' };
    }
    await audit(tx, actor, id, 'assets.transfer.request', { assetId: input.assetId, fromStationId, toStationId: input.toStationId });
    await tx.commit();
    return { ok: true, id };
  } catch (err) {
    await tx.rollback();
    if (/UNIQUE|SQLITE_CONSTRAINT/i.test(String(err)))
      return { ok: false, code: 'conflict', message: 'This asset already has an active transfer.' };
    throw err;
  }
}

/** Matches the UI and backend action gates; never rely on a form button alone. */
export function availableTransferActions(actor: TransferActor, tr: TransferRow): TransferAction[] {
  const actions: TransferAction[] = [];
  if (tr.status === 'REQUESTED') {
    if (permission(actor, 'assets.transfer.approve') && tr.requestedBy !== actor.userId) {
      actions.push('approve', 'reject');
    }
    if (permission(actor, 'assets.transfer.request') && tr.requestedBy === actor.userId)
      actions.push('cancel');
  }
  if (tr.status === 'APPROVED' && permission(actor, 'assets.transfer.dispatch') && owns(actor, tr.fromManagerId))
    actions.push('dispatch');
  if (tr.status === 'DISPATCHED' && permission(actor, 'assets.transfer.receive') &&
      owns(actor, tr.toManagerId) && tr.dispatchedBy !== actor.userId)
    actions.push('receive');
  return actions;
}

export async function transitionTransfer(
  db: Client,
  actor: TransferActor,
  id: string,
  action: TransferAction,
  input: { serial?: string; condition?: string; note?: string } = {},
): Promise<TransferResult> {
  const tr = await getTransfer(db, actor, id);
  if (!tr) return { ok: false, code: 'not_found', message: 'Transfer not found.' };
  if (!availableTransferActions(actor, tr).includes(action))
    return { ok: false, code: 'forbidden', message: 'You cannot perform this transfer step.' };
  const serial = (input.serial ?? '').trim();
  const condition = (input.condition ?? '').trim();
  const note = (input.note ?? '').trim();
  if ((action === 'dispatch' || action === 'receive') && (!condition || condition.length > 500))
    return { ok: false, code: 'invalid', message: 'Record the physical condition (maximum 500 characters).' };
  if ((action === 'dispatch' || action === 'receive') && tr.expectedSerial &&
      serial.toLocaleLowerCase() !== tr.expectedSerial.toLocaleLowerCase())
    return { ok: false, code: 'invalid', message: 'The physical serial number does not match the asset register.' };
  if (action === 'reject' && !note) return { ok: false, code: 'invalid', message: 'Record a rejection reason.' };
  if (note.length > 500)
    return { ok: false, code: 'invalid', message: 'Notes cannot exceed 500 characters.' };
  if (action === 'dispatch' || action === 'receive') {
    if (await hasOpenWork(db, actor.orgId, tr.assetId))
      return { ok: false, code: 'conflict', message: 'Open repair work must be resolved before movement.' };
  }
  const next: TransferStatus =
    action === 'approve' ? 'APPROVED' :
    action === 'reject' ? 'REJECTED' :
    action === 'dispatch' ? 'DISPATCHED' :
    action === 'receive' ? 'RECEIVED' : 'CANCELLED';
  const now = new Date().toISOString();
  const tx = await db.transaction('write');
  try {
    // Single status gate also prevents a second simultaneous approval/receipt.
    const changed = await tx.execute({
      sql: `UPDATE asset_transfers SET
        status = ?, approved_by = CASE WHEN ? = 'approve' THEN ? ELSE approved_by END,
        approved_at = CASE WHEN ? = 'approve' THEN ? ELSE approved_at END,
        dispatched_by = CASE WHEN ? = 'dispatch' THEN ? ELSE dispatched_by END,
        dispatched_at = CASE WHEN ? = 'dispatch' THEN ? ELSE dispatched_at END,
        received_by = CASE WHEN ? = 'receive' THEN ? ELSE received_by END,
        received_at = CASE WHEN ? = 'receive' THEN ? ELSE received_at END,
        resolved_at = CASE WHEN ? IN ('reject','cancel') THEN ? ELSE resolved_at END,
        dispatched_serial = CASE WHEN ? = 'dispatch' THEN ? ELSE dispatched_serial END,
        received_serial = CASE WHEN ? = 'receive' THEN ? ELSE received_serial END,
        dispatch_condition = CASE WHEN ? = 'dispatch' THEN ? ELSE dispatch_condition END,
        receipt_condition = CASE WHEN ? = 'receive' THEN ? ELSE receipt_condition END,
        dispatch_note = CASE WHEN ? = 'dispatch' THEN ? ELSE dispatch_note END,
        receipt_note = CASE WHEN ? = 'receive' THEN ? ELSE receipt_note END,
        resolution_reason = CASE WHEN ? IN ('reject','cancel') THEN ? ELSE resolution_reason END
        WHERE id = ? AND org_id = ? AND status = ?`,
      args: [
        next, action, actor.userId, action, now, action, actor.userId, action, now,
        action, actor.userId, action, now, action, now,
        action, serial || null, action, serial || null,
        action, condition || null, action, condition || null,
        action, note || null, action, note || null,
        action, note || null,
        id, actor.orgId, tr.status,
      ],
    });
    if (changed.rowsAffected !== 1) {
      await tx.rollback();
      return { ok: false, code: 'conflict', message: 'Transfer changed. Refresh and try again.' };
    }
    let schedulesPaused = 0;
    if (action === 'receive') {
      const target = await tx.execute({
        sql: `SELECT 1 FROM stations WHERE org_id = ? AND id = ?
                AND deleted_at IS NULL AND status = 'ACTIVE' LIMIT 1`,
        args: [actor.orgId, tr.toStationId],
      });
      if (!target.rows.length) {
        await tx.rollback();
        return { ok: false, code: 'conflict', message: 'The receiving location is no longer active.' };
      }
      // A late work request cannot silently pass the physical handover.
      if (await hasOpenWork(tx, actor.orgId, tr.assetId)) {
        await tx.rollback();
        return { ok: false, code: 'conflict', message: 'Open repair work appeared before receipt.' };
      }
      const moved = await tx.execute({
        sql: `UPDATE assets SET station_id = ? WHERE id = ? AND org_id = ?
               AND station_id = ? AND deleted_at IS NULL`,
        args: [tr.toStationId, tr.assetId, actor.orgId, tr.fromStationId],
      });
      if (moved.rowsAffected !== 1) {
        await tx.rollback();
        return { ok: false, code: 'conflict', message: 'Asset location changed during the transfer.' };
      }
      await recordMovement(tx, { orgId: actor.orgId, userId: actor.userId },
        tr.assetId, tr.fromStationId, tr.toStationId, tr.reason, tr.id);
      // Pausing, rather than silently relocating, makes affected PM schedules
      // require review and protects existing maintenance history.
      const paused = await tx.execute({
        sql: `UPDATE pm_schedules SET status = 'PAUSED', updated_at = ?
               WHERE org_id = ? AND asset_id = ? AND status = 'ACTIVE'`,
        args: [now, actor.orgId, tr.assetId],
      });
      schedulesPaused = paused.rowsAffected;
    }
    await audit(tx, actor, id, 'assets.transfer.' + action, {
      assetId: tr.assetId, fromStationId: tr.fromStationId,
      toStationId: tr.toStationId, status: next, schedulesPaused,
    });
    await tx.commit();
    return { ok: true, id };
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}
