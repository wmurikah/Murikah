/**
 * Stations are owned by the existing tenant (org_id). Their affiliate is a
 * separately editable classification, never a change of record ownership.
 * The station and any selected region must belong to the same tenant AND
 * affiliate. Codes are generated and immutable.
 */
import type { Client } from '@libsql/client/web';
import { nextOrganisationCode } from './organisationCodes';
import { listRegionAffiliates } from './adminRegions';

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
  affiliateName: string;
  name: string;
  regionName: string | null;
  managerName: string | null;
  isBase: boolean;
  status: string;
}

export interface StationDetail {
  id: string;
  code: string;
  affiliateOrgId: string;
  name: string;
  regionId: string | null;
  address: string | null;
  stationManagerId: string | null;
  isBase: boolean;
  status: string;
}

export interface StationInput {
  name: string;
  /** Current UI always supplies this; legacy internal callers may omit it. */
  affiliateOrgId?: string | null;
  regionId: string | null;
  address: string | null;
  stationManagerId: string | null;
  isBase: boolean;
  status: string;
}

export interface StationActor {
  orgId: string;
  userId: string;
  isPlatformOwner?: boolean;
  roles?: readonly string[];
}

export async function listStationsAdmin(db: Client, orgId: string): Promise<StationRow[]> {
  const res = await db.execute({
    sql: `SELECT s.id, s.code, s.name, s.is_base, s.status,
                 r.name AS region_name, u.full_name AS manager_name,
                 COALESCE(aff.name, owner.name) AS affiliate_name
            FROM stations s
            LEFT JOIN regions r ON r.id = s.region_id AND r.org_id = s.org_id
            LEFT JOIN users u ON u.id = s.station_manager_id
            JOIN organisations owner ON owner.id = s.org_id
            LEFT JOIN organisations aff ON aff.id = s.affiliate_org_id
           WHERE s.org_id = ? AND s.deleted_at IS NULL
        ORDER BY s.code`,
    args: [orgId],
  });
  return res.rows.map((r) => ({
    id: String(r.id),
    code: String(r.code),
    name: String(r.name),
    affiliateName: String(r.affiliate_name),
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
    sql: `SELECT id, code, name, COALESCE(affiliate_org_id, org_id) AS affiliate_org_id,
                   region_id, address, station_manager_id, is_base, status
            FROM stations WHERE id = ? AND org_id = ? AND deleted_at IS NULL LIMIT 1`,
    args: [id, orgId],
  });
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    code: String(row.code),
    name: String(row.name),
    affiliateOrgId: String(row.affiliate_org_id),
    regionId: row.region_id === null ? null : String(row.region_id),
    address: row.address === null ? null : String(row.address),
    stationManagerId: row.station_manager_id === null ? null : String(row.station_manager_id),
    isBase: Number(row.is_base) === 1,
    status: String(row.status),
  };
}

const STATUSES = new Set(['ACTIVE', 'INACTIVE']);

function validate(input: StationInput): string | null {
  if (!input.name) return 'A name is required.';
  if (!STATUSES.has(input.status)) return 'Choose a valid status.';
  return null;
}

async function referencesBelongToOrg(
  db: Client,
  orgId: string,
  input: StationInput,
  affiliateOrgId: string,
): Promise<boolean> {
  const result = await db.execute({
    sql: `SELECT
            (? IS NULL OR EXISTS(
              SELECT 1 FROM regions
               WHERE id = ? AND org_id = ?
                 AND COALESCE(affiliate_org_id, org_id) = ?
            )) AS region_ok,
            (? IS NULL OR EXISTS(
              SELECT 1 FROM users u
              JOIN user_roles ur ON ur.user_id = u.id
              JOIN roles r ON r.id = ur.role_id
               WHERE u.id = ? AND u.org_id = ? AND u.deleted_at IS NULL
                 AND u.status = 'ACTIVE' AND r.code = 'STATION_MANAGER'
                 AND (r.org_id IS NULL OR r.org_id = u.org_id)
            )) AS manager_ok`,
    args: [
      input.regionId,
      input.regionId,
      orgId,
      affiliateOrgId,
      input.stationManagerId,
      input.stationManagerId,
      orgId,
    ],
  });
  const row = result.rows[0];
  return Number(row?.region_ok ?? 0) === 1 && Number(row?.manager_ok ?? 0) === 1;
}

async function affiliateAllowed(
  db: Client,
  ctx: StationActor,
  affiliateOrgId: string,
): Promise<boolean> {
  if (!affiliateOrgId) return false;
  const options = await listRegionAffiliates(db, {
    orgId: ctx.orgId, homeOrgId: ctx.orgId, userId: ctx.userId,
    isPlatformOwner: ctx.isPlatformOwner === true, roles: ctx.roles ?? [],
  });
  return options.some((option) => option.id === affiliateOrgId);
}

export async function createStation(
  db: Client,
  ctx: StationActor,
  input: StationInput,
): Promise<AdminResult> {
  const invalid = validate(input);
  if (invalid) return { ok: false, code: 'invalid', message: invalid };
  const affiliateOrgId = input.affiliateOrgId ?? ctx.orgId;
  if (!(await affiliateAllowed(db, ctx, affiliateOrgId)) ||
      !(await referencesBelongToOrg(db, ctx.orgId, input, affiliateOrgId))) {
    return { ok: false, code: 'invalid', message: 'Choose a permitted affiliate, its region, and a valid manager.' };
  }
  for (let attempt = 0; attempt < 8; attempt++) {
    const id = newId();
    const tx = await db.transaction('write');
    try {
      const code = await nextOrganisationCode(tx, ctx.orgId, 'station');
      await tx.execute({
        sql: `INSERT INTO stations (id, org_id, affiliate_org_id, code, name, region_id, address, station_manager_id, is_base, status)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [id, ctx.orgId, affiliateOrgId, code, input.name, input.regionId, input.address, input.stationManagerId, input.isBase ? 1 : 0, input.status],
      });
      await tx.execute({
        sql: `INSERT INTO audit_logs (org_id, actor_user_id, action, entity_type, entity_id, after_json)
              VALUES (?, ?, 'stations.create', 'station', ?, ?)`,
        args: [ctx.orgId, ctx.userId, id, JSON.stringify({ code, name: input.name, affiliateOrgId })],
      });
      await tx.commit();
      return { ok: true, id };
    } catch (err) {
      await tx.rollback();
      if (isUniqueViolation(err)) continue;
      throw err;
    }
  }
  return { ok: false, code: 'conflict', message: 'A station code could not be reserved. Try again.' };
}

export async function updateStation(
  db: Client,
  ctx: StationActor,
  id: string,
  input: StationInput,
): Promise<AdminResult> {
  const invalid = validate(input);
  if (invalid) return { ok: false, code: 'invalid', message: invalid };
  const current = await getStation(db, ctx.orgId, id);
  if (!current) return { ok: false, code: 'not_found', message: 'That station was not found.' };
  const affiliateOrgId = input.affiliateOrgId ?? current.affiliateOrgId;
  if ((affiliateOrgId !== current.affiliateOrgId && !(await affiliateAllowed(db, ctx, affiliateOrgId))) ||
      !(await referencesBelongToOrg(db, ctx.orgId, input, affiliateOrgId))) {
    return { ok: false, code: 'invalid', message: 'Choose a permitted affiliate and a region in that affiliate.' };
  }
  const tx = await db.transaction('write');
  try {
    const upd = await tx.execute({
      sql: `UPDATE stations
               SET name = ?, affiliate_org_id = ?, region_id = ?, address = ?, station_manager_id = ?, is_base = ?, status = ?
             WHERE id = ? AND org_id = ? AND deleted_at IS NULL
               AND COALESCE(affiliate_org_id, org_id) = ?`,
      args: [input.name, affiliateOrgId, input.regionId, input.address, input.stationManagerId, input.isBase ? 1 : 0, input.status, id, ctx.orgId, current.affiliateOrgId],
    });
    if (upd.rowsAffected === 0) {
      await tx.rollback();
      return { ok: false, code: 'conflict', message: 'Station changed. Reload and review its affiliate.' };
    }
    await tx.execute({
      sql: `INSERT INTO audit_logs (org_id, actor_user_id, action, entity_type, entity_id, before_json, after_json)
            VALUES (?, ?, 'stations.update', 'station', ?, ?, ?)`,
      args: [ctx.orgId, ctx.userId, id,
        JSON.stringify({ name: current.name, affiliateOrgId: current.affiliateOrgId, regionId: current.regionId }),
        JSON.stringify({ name: input.name, affiliateOrgId, regionId: input.regionId })],
    });
    await tx.commit();
    return { ok: true, id };
  } catch (err) {
    await tx.rollback();
    if (isUniqueViolation(err)) return { ok: false, code: 'conflict', message: 'Unable to save the station.' };
    throw err;
  }
}
