/**
 * Stations admin. Org-scoped reads and writes; every write records an audit_logs
 * row. The code is user-supplied and unique per org, so a clash returns a
 * conflict rather than throwing. This is the entity that unblocks "Raise a
 * request".
 */
import type { Client } from '@libsql/client/web';

const newId = (): string => crypto.randomUUID().replace(/-/g, '');

function isUniqueViolation(err: unknown): boolean {
  const text = String(err instanceof Error ? err.message : err);
  return text.includes('UNIQUE') || text.includes('SQLITE_CONSTRAINT');
}

export type AdminResult =
  | { ok: true; id?: string }
  | { ok: false; code: 'conflict' | 'invalid' | 'not_found'; message: string };

export interface StationRow {
  id: string;
  code: string;
  name: string;
  regionName: string | null;
  managerName: string | null;
  isBase: boolean;
  status: string;
}

export interface StationDetail {
  id: string;
  code: string;
  name: string;
  regionId: string | null;
  address: string | null;
  stationManagerId: string | null;
  isBase: boolean;
  status: string;
}

export interface StationInput {
  code: string;
  name: string;
  regionId: string | null;
  address: string | null;
  stationManagerId: string | null;
  isBase: boolean;
  status: string;
}

export async function listStationsAdmin(db: Client, orgId: string): Promise<StationRow[]> {
  const res = await db.execute({
    sql: `SELECT s.id, s.code, s.name, s.is_base, s.status,
                 r.name AS region_name, u.full_name AS manager_name
            FROM stations s
            LEFT JOIN regions r ON r.id = s.region_id
            LEFT JOIN users u ON u.id = s.station_manager_id
           WHERE s.org_id = ? AND s.deleted_at IS NULL
        ORDER BY s.code`,
    args: [orgId],
  });
  return res.rows.map((r) => ({
    id: String(r.id),
    code: String(r.code),
    name: String(r.name),
    regionName: r.region_name === null ? null : String(r.region_name),
    managerName: r.manager_name === null ? null : String(r.manager_name),
    isBase: Number(r.is_base) === 1,
    status: String(r.status),
  }));
}

export async function getStation(
  db: Client,
  orgId: string,
  id: string,
): Promise<StationDetail | null> {
  const res = await db.execute({
    sql: `SELECT id, code, name, region_id, address, station_manager_id, is_base, status
            FROM stations WHERE id = ? AND org_id = ? AND deleted_at IS NULL LIMIT 1`,
    args: [id, orgId],
  });
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    code: String(row.code),
    name: String(row.name),
    regionId: row.region_id === null ? null : String(row.region_id),
    address: row.address === null ? null : String(row.address),
    stationManagerId: row.station_manager_id === null ? null : String(row.station_manager_id),
    isBase: Number(row.is_base) === 1,
    status: String(row.status),
  };
}

const STATUSES = new Set(['ACTIVE', 'INACTIVE']);

function validate(input: StationInput): string | null {
  if (!input.code) return 'A code is required.';
  if (!input.name) return 'A name is required.';
  if (!STATUSES.has(input.status)) return 'Choose a valid status.';
  return null;
}

export async function createStation(
  db: Client,
  ctx: { orgId: string; userId: string },
  input: StationInput,
): Promise<AdminResult> {
  const invalid = validate(input);
  if (invalid) return { ok: false, code: 'invalid', message: invalid };
  const id = newId();
  const tx = await db.transaction('write');
  try {
    await tx.execute({
      sql: `INSERT INTO stations (id, org_id, code, name, region_id, address, station_manager_id, is_base, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        ctx.orgId,
        input.code,
        input.name,
        input.regionId,
        input.address,
        input.stationManagerId,
        input.isBase ? 1 : 0,
        input.status,
      ],
    });
    await tx.execute({
      sql: `INSERT INTO audit_logs (org_id, actor_user_id, action, entity_type, entity_id, after_json)
            VALUES (?, ?, 'stations.create', 'station', ?, ?)`,
      args: [ctx.orgId, ctx.userId, id, JSON.stringify({ code: input.code, name: input.name })],
    });
    await tx.commit();
    return { ok: true, id };
  } catch (err) {
    await tx.rollback();
    if (isUniqueViolation(err))
      return { ok: false, code: 'conflict', message: 'That code is already used.' };
    throw err;
  }
}

export async function updateStation(
  db: Client,
  ctx: { orgId: string; userId: string },
  id: string,
  input: StationInput,
): Promise<AdminResult> {
  const invalid = validate(input);
  if (invalid) return { ok: false, code: 'invalid', message: invalid };
  const tx = await db.transaction('write');
  try {
    const upd = await tx.execute({
      sql: `UPDATE stations
               SET code = ?, name = ?, region_id = ?, address = ?, station_manager_id = ?, is_base = ?, status = ?
             WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
      args: [
        input.code,
        input.name,
        input.regionId,
        input.address,
        input.stationManagerId,
        input.isBase ? 1 : 0,
        input.status,
        id,
        ctx.orgId,
      ],
    });
    if (upd.rowsAffected === 0) {
      await tx.rollback();
      return { ok: false, code: 'not_found', message: 'That station was not found.' };
    }
    await tx.execute({
      sql: `INSERT INTO audit_logs (org_id, actor_user_id, action, entity_type, entity_id, after_json)
            VALUES (?, ?, 'stations.update', 'station', ?, ?)`,
      args: [ctx.orgId, ctx.userId, id, JSON.stringify({ code: input.code, name: input.name })],
    });
    await tx.commit();
    return { ok: true, id };
  } catch (err) {
    await tx.rollback();
    if (isUniqueViolation(err))
      return { ok: false, code: 'conflict', message: 'That code is already used.' };
    throw err;
  }
}
