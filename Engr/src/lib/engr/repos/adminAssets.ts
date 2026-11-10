/**
 * Assets admin. Org-scoped reads and writes; every write records an audit_logs
 * row. The tag is user-supplied and unique per org, so a clash returns a
 * conflict rather than throwing. Rows are soft-deletable, so reads and updates
 * skip anything already removed.
 */
import type { Client } from '@libsql/client/web';
import type { SqlExecutor } from '../notify';

const newId = (): string => crypto.randomUUID().replace(/-/g, '');

function isUniqueViolation(err: unknown): boolean {
  const text = String(err instanceof Error ? err.message : err);
  return text.includes('UNIQUE') || text.includes('SQLITE_CONSTRAINT');
}

export type AdminResult =
  | { ok: true; id?: string }
  | { ok: false; code: 'conflict' | 'invalid' | 'not_found'; message: string };

export interface AssetRow {
  id: string;
  tag: string;
  name: string;
  stationName: string;
  categoryName: string | null;
  manufacturer: string | null;
  model: string | null;
  serialNo: string | null;
  installDate: string | null;
  status: string;
}

export interface AssetDetail {
  id: string;
  tag: string;
  name: string;
  stationId: string;
  stationName: string;
  categoryId: string | null;
  manufacturer: string | null;
  model: string | null;
  serialNo: string | null;
  installDate: string | null;
  status: string;
}

export interface AssetInput {
  tag: string;
  name: string;
  stationId: string;
  categoryId: string | null;
  manufacturer: string | null;
  model: string | null;
  serialNo: string | null;
  installDate: string | null;
  status: string;
  movementReason?: string | null;
}

export interface AssetMovement {
  transferId: string | null;
  fromStation: string | null;
  fromRegion: string | null;
  toStation: string;
  toRegion: string | null;
  reason: string | null;
  movedBy: string | null;
  movedAt: string;
}

export async function listAssetMovements(
  db: Client,
  orgId: string,
  assetId: string,
): Promise<AssetMovement[]> {
  const res = await db.execute({
    sql: `SELECT m.from_station_name, m.from_region_name, m.to_station_name,
                 m.to_region_name, m.transfer_id, m.reason, m.moved_at, u.full_name AS moved_by
            FROM asset_movements m LEFT JOIN users u ON u.id = m.moved_by AND u.org_id = m.org_id
           WHERE m.org_id = ? AND m.asset_id = ? ORDER BY m.moved_at DESC LIMIT 200`,
    args: [orgId, assetId],
  });
  return res.rows.map((r) => ({
    transferId: r.transfer_id == null ? null : String(r.transfer_id),
    fromStation: r.from_station_name == null ? null : String(r.from_station_name),
    fromRegion: r.from_region_name == null ? null : String(r.from_region_name),
    toStation: String(r.to_station_name),
    toRegion: r.to_region_name == null ? null : String(r.to_region_name),
    reason: r.reason == null ? null : String(r.reason),
    movedBy: r.moved_by == null ? null : String(r.moved_by),
    movedAt: String(r.moved_at),
  }));
}

export async function recordMovement(
  tx: SqlExecutor,
  ctx: { orgId: string; userId: string },
  assetId: string,
  fromStationId: string | null,
  toStationId: string,
  reason: string | null,
  transferId: string | null = null,
): Promise<void> {
  const result = await tx.execute({
    sql: `SELECT s.id, s.name AS station_name, s.region_id, r.name AS region_name
            FROM stations s LEFT JOIN regions r ON r.id = s.region_id AND r.org_id = s.org_id
           WHERE s.org_id = ? AND s.id IN (?, ?)`,
    args: [ctx.orgId, fromStationId ?? toStationId, toStationId],
  });
  const from = fromStationId ? result.rows.find((r) => String(r.id) === fromStationId) : null;
  const to = result.rows.find((r) => String(r.id) === toStationId);
  if (!to || (fromStationId && !from)) throw new Error('Asset station is unavailable.');
  await tx.execute({
    sql: `INSERT INTO asset_movements
      (id, org_id, asset_id, from_station_id, from_station_name, from_region_id, from_region_name,
       to_station_id, to_station_name, to_region_id, to_region_name, reason, moved_by, transfer_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      newId(),
      ctx.orgId,
      assetId,
      fromStationId,
      from?.station_name ?? null,
      from?.region_id ?? null,
      from?.region_name ?? null,
      toStationId,
      to.station_name,
      to.region_id,
      to.region_name,
      reason,
      ctx.userId,
      transferId,
    ],
  });
}

export async function listAssetsAdmin(db: Client, orgId: string): Promise<AssetRow[]> {
  const res = await db.execute({
    sql: `SELECT a.id, a.tag, a.name, a.status,
                 a.manufacturer, a.model, a.serial_no, a.install_date,
                 s.name AS station_name, c.name AS category_name
            FROM assets a
            JOIN stations s ON s.id = a.station_id
            LEFT JOIN asset_categories c ON c.id = a.category_id
           WHERE a.org_id = ? AND a.deleted_at IS NULL
        ORDER BY a.tag`,
    args: [orgId],
  });
  return res.rows.map((r) => ({
    id: String(r.id),
    tag: String(r.tag),
    name: String(r.name),
    stationName: r.station_name === null ? '' : String(r.station_name),
    categoryName: r.category_name === null ? null : String(r.category_name),
    manufacturer: r.manufacturer === null ? null : String(r.manufacturer),
    model: r.model === null ? null : String(r.model),
    serialNo: r.serial_no === null ? null : String(r.serial_no),
    installDate: r.install_date === null ? null : String(r.install_date),
    status: String(r.status),
  }));
}

export async function getAsset(db: Client, orgId: string, id: string): Promise<AssetDetail | null> {
  const res = await db.execute({
    sql: `SELECT a.id, a.tag, a.name, a.station_id, s.name AS station_name,
                 a.category_id, a.manufacturer, a.model, a.serial_no, a.install_date, a.status
            FROM assets a JOIN stations s ON s.id = a.station_id AND s.org_id = a.org_id
           WHERE a.id = ? AND a.org_id = ? AND a.deleted_at IS NULL LIMIT 1`,
    args: [id, orgId],
  });
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    tag: String(row.tag),
    name: String(row.name),
    stationId: String(row.station_id),
    stationName: String(row.station_name),
    categoryId: row.category_id === null ? null : String(row.category_id),
    manufacturer: row.manufacturer === null ? null : String(row.manufacturer),
    model: row.model === null ? null : String(row.model),
    serialNo: row.serial_no === null ? null : String(row.serial_no),
    installDate: row.install_date === null ? null : String(row.install_date),
    status: String(row.status),
  };
}

const STATUSES = new Set(['IN_SERVICE', 'FAULTY', 'DECOMMISSIONED']);

function validate(input: AssetInput): string | null {
  if (!input.tag) return 'A tag is required.';
  if (!input.name) return 'A name is required.';
  if (!input.stationId) return 'A station is required.';
  if (!STATUSES.has(input.status)) return 'Choose a valid status.';
  return null;
}

async function referencesBelongToOrg(
  db: Client,
  orgId: string,
  input: AssetInput,
  requireActiveStation = false,
): Promise<boolean> {
  const result = await db.execute({
    sql: `SELECT
            EXISTS(
              SELECT 1 FROM stations
               WHERE id = ? AND org_id = ? AND deleted_at IS NULL
                 AND (? = 0 OR status = 'ACTIVE')
            ) AS station_ok,
            (? IS NULL OR EXISTS(
              SELECT 1 FROM asset_categories WHERE id = ? AND org_id = ?
            )) AS category_ok`,
    args: [input.stationId, orgId, requireActiveStation ? 1 : 0, input.categoryId, input.categoryId, orgId],
  });
  const row = result.rows[0];
  return Number(row?.station_ok ?? 0) === 1 && Number(row?.category_ok ?? 0) === 1;
}

export async function createAsset(
  db: Client,
  ctx: { orgId: string; userId: string },
  input: AssetInput,
): Promise<AdminResult> {
  const invalid = validate(input);
  if (invalid) return { ok: false, code: 'invalid', message: invalid };
  if (!(await referencesBelongToOrg(db, ctx.orgId, input, true))) {
    return {
      ok: false,
      code: 'invalid',
      message: 'Choose a station and category from this organisation.',
    };
  }
  const id = newId();
  const tx = await db.transaction('write');
  try {
    await tx.execute({
      sql: `INSERT INTO assets (id, org_id, station_id, category_id, tag, name, manufacturer, model, serial_no, install_date, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        ctx.orgId,
        input.stationId,
        input.categoryId,
        input.tag,
        input.name,
        input.manufacturer,
        input.model,
        input.serialNo,
        input.installDate,
        input.status,
      ],
    });
    await tx.execute({
      sql: `INSERT INTO audit_logs (org_id, actor_user_id, action, entity_type, entity_id, after_json)
            VALUES (?, ?, 'assets.create', 'asset', ?, ?)`,
      args: [ctx.orgId, ctx.userId, id, JSON.stringify({ tag: input.tag, name: input.name })],
    });
    await recordMovement(tx, ctx, id, null, input.stationId, 'Initial placement');
    await tx.commit();
    return { ok: true, id };
  } catch (err) {
    await tx.rollback();
    if (isUniqueViolation(err))
      return { ok: false, code: 'conflict', message: 'That tag is already used.' };
    throw err;
  }
}

export async function updateAsset(
  db: Client,
  ctx: { orgId: string; userId: string },
  id: string,
  input: AssetInput,
): Promise<AdminResult> {
  const invalid = validate(input);
  if (invalid) return { ok: false, code: 'invalid', message: invalid };
  if (!(await referencesBelongToOrg(db, ctx.orgId, input))) {
    return {
      ok: false,
      code: 'invalid',
      message: 'Choose a station and category from this organisation.',
    };
  }
  const tx = await db.transaction('write');
  try {
    const current = await tx.execute({
      sql: `SELECT station_id FROM assets WHERE id = ? AND org_id = ? AND deleted_at IS NULL LIMIT 1`,
      args: [id, ctx.orgId],
    });
    const oldStationId =
      current.rows[0]?.station_id == null ? null : String(current.rows[0].station_id);
    if (!oldStationId) {
      await tx.rollback();
      return { ok: false, code: 'not_found', message: 'That asset was not found.' };
    }
    const inTransit = await tx.execute({
      sql: `SELECT 1 FROM asset_transfers WHERE org_id = ? AND asset_id = ?
             AND status IN ('REQUESTED','APPROVED','DISPATCHED') LIMIT 1`,
      args: [ctx.orgId, id],
    });
    if (inTransit.rows.length) {
      await tx.rollback();
      return { ok: false, code: 'conflict', message: 'Asset has an active transfer. Complete it before editing.' };
    }
    if (oldStationId !== input.stationId) {
      await tx.rollback();
      return { ok: false, code: 'invalid', message: 'Station changes require the asset transfer workflow.' };
    }
    const upd = await tx.execute({
      sql: `UPDATE assets
               SET station_id = ?, category_id = ?, tag = ?, name = ?, manufacturer = ?, model = ?, serial_no = ?, install_date = ?, status = ?
             WHERE id = ? AND org_id = ? AND station_id = ? AND deleted_at IS NULL`,
      args: [
        input.stationId,
        input.categoryId,
        input.tag,
        input.name,
        input.manufacturer,
        input.model,
        input.serialNo,
        input.installDate,
        input.status,
        id,
        ctx.orgId,
        oldStationId,
      ],
    });
    if (upd.rowsAffected === 0) {
      await tx.rollback();
      return {
        ok: false,
        code: 'conflict',
        message: 'Asset location changed. Reload and try again.',
      };
    }
    await tx.execute({
      sql: `INSERT INTO audit_logs (org_id, actor_user_id, action, entity_type, entity_id, after_json)
            VALUES (?, ?, 'assets.update', 'asset', ?, ?)`,
      args: [ctx.orgId, ctx.userId, id, JSON.stringify({ tag: input.tag, name: input.name })],
    });
    await tx.commit();
    return { ok: true, id };
  } catch (err) {
    await tx.rollback();
    if (isUniqueViolation(err))
      return { ok: false, code: 'conflict', message: 'That tag is already used.' };
    throw err;
  }
}
