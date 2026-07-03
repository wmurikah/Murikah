/**
 * Contractors admin. Org-scoped reads and writes; every write records an
 * audit_logs row. A contractor covers a set of stations and asset categories,
 * held in two junction tables that are rewritten on each save. Soft-deletable.
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

export interface ContractorRow {
  id: string;
  name: string;
  baseStationName: string | null;
  isPrequalified: boolean;
  status: string;
}

export interface ContractorDetail {
  id: string;
  name: string;
  contactPerson: string | null;
  email: string | null;
  phone: string | null;
  baseStationId: string | null;
  isPrequalified: boolean;
  status: string;
  stationIds: string[];
  categoryIds: string[];
}

export interface ContractorInput {
  name: string;
  contactPerson: string | null;
  email: string | null;
  phone: string | null;
  baseStationId: string | null;
  isPrequalified: boolean;
  status: string;
  stationIds: string[];
  categoryIds: string[];
}

export async function listContractorsAdmin(db: Client, orgId: string): Promise<ContractorRow[]> {
  const res = await db.execute({
    sql: `SELECT c.id, c.name, c.is_prequalified, c.status,
                 s.name AS base_station_name
            FROM contractors c
            LEFT JOIN stations s ON s.id = c.base_station_id
           WHERE c.org_id = ? AND c.deleted_at IS NULL
        ORDER BY c.name`,
    args: [orgId],
  });
  return res.rows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    baseStationName: r.base_station_name === null ? null : String(r.base_station_name),
    isPrequalified: Number(r.is_prequalified) === 1,
    status: String(r.status),
  }));
}

export async function getContractor(
  db: Client,
  orgId: string,
  id: string,
): Promise<ContractorDetail | null> {
  const res = await db.execute({
    sql: `SELECT id, name, contact_person, email, phone, base_station_id, is_prequalified, status
            FROM contractors WHERE id = ? AND org_id = ? AND deleted_at IS NULL LIMIT 1`,
    args: [id, orgId],
  });
  const row = res.rows[0];
  if (!row) return null;
  const stationRes = await db.execute({
    sql: `SELECT station_id FROM contractor_stations WHERE contractor_id = ? AND org_id = ?`,
    args: [id, orgId],
  });
  const categoryRes = await db.execute({
    sql: `SELECT category_id FROM contractor_categories WHERE contractor_id = ? AND org_id = ?`,
    args: [id, orgId],
  });
  return {
    id: String(row.id),
    name: String(row.name),
    contactPerson: row.contact_person === null ? null : String(row.contact_person),
    email: row.email === null ? null : String(row.email),
    phone: row.phone === null ? null : String(row.phone),
    baseStationId: row.base_station_id === null ? null : String(row.base_station_id),
    isPrequalified: Number(row.is_prequalified) === 1,
    status: String(row.status),
    stationIds: stationRes.rows.map((r) => String(r.station_id)),
    categoryIds: categoryRes.rows.map((r) => String(r.category_id)),
  };
}

const STATUSES = new Set(['ACTIVE', 'SUSPENDED', 'BLACKLISTED']);

function validate(input: ContractorInput): string | null {
  if (!input.name) return 'A name is required.';
  if (!STATUSES.has(input.status)) return 'Choose a valid status.';
  return null;
}

export async function createContractor(
  db: Client,
  ctx: { orgId: string; userId: string },
  input: ContractorInput,
): Promise<AdminResult> {
  const invalid = validate(input);
  if (invalid) return { ok: false, code: 'invalid', message: invalid };
  const id = newId();
  const tx = await db.transaction('write');
  try {
    await tx.execute({
      sql: `INSERT INTO contractors (id, org_id, name, contact_person, email, phone, base_station_id, is_prequalified, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        ctx.orgId,
        input.name,
        input.contactPerson,
        input.email,
        input.phone,
        input.baseStationId,
        input.isPrequalified ? 1 : 0,
        input.status,
      ],
    });
    for (const stationId of input.stationIds) {
      await tx.execute({
        sql: `INSERT INTO contractor_stations (org_id, contractor_id, station_id) VALUES (?, ?, ?)`,
        args: [ctx.orgId, id, stationId],
      });
    }
    for (const categoryId of input.categoryIds) {
      await tx.execute({
        sql: `INSERT INTO contractor_categories (org_id, contractor_id, category_id) VALUES (?, ?, ?)`,
        args: [ctx.orgId, id, categoryId],
      });
    }
    await tx.execute({
      sql: `INSERT INTO audit_logs (org_id, actor_user_id, action, entity_type, entity_id, after_json)
            VALUES (?, ?, 'contractors.create', 'contractor', ?, ?)`,
      args: [ctx.orgId, ctx.userId, id, JSON.stringify({ name: input.name, status: input.status })],
    });
    await tx.commit();
    return { ok: true, id };
  } catch (err) {
    await tx.rollback();
    if (isUniqueViolation(err))
      return { ok: false, code: 'conflict', message: 'That contractor already exists.' };
    throw err;
  }
}

export async function updateContractor(
  db: Client,
  ctx: { orgId: string; userId: string },
  id: string,
  input: ContractorInput,
): Promise<AdminResult> {
  const invalid = validate(input);
  if (invalid) return { ok: false, code: 'invalid', message: invalid };
  const tx = await db.transaction('write');
  try {
    const upd = await tx.execute({
      sql: `UPDATE contractors
               SET name = ?, contact_person = ?, email = ?, phone = ?, base_station_id = ?, is_prequalified = ?, status = ?
             WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
      args: [
        input.name,
        input.contactPerson,
        input.email,
        input.phone,
        input.baseStationId,
        input.isPrequalified ? 1 : 0,
        input.status,
        id,
        ctx.orgId,
      ],
    });
    if (upd.rowsAffected === 0) {
      await tx.rollback();
      return { ok: false, code: 'not_found', message: 'That contractor was not found.' };
    }
    await tx.execute({
      sql: `DELETE FROM contractor_stations WHERE contractor_id = ? AND org_id = ?`,
      args: [id, ctx.orgId],
    });
    await tx.execute({
      sql: `DELETE FROM contractor_categories WHERE contractor_id = ? AND org_id = ?`,
      args: [id, ctx.orgId],
    });
    for (const stationId of input.stationIds) {
      await tx.execute({
        sql: `INSERT INTO contractor_stations (org_id, contractor_id, station_id) VALUES (?, ?, ?)`,
        args: [ctx.orgId, id, stationId],
      });
    }
    for (const categoryId of input.categoryIds) {
      await tx.execute({
        sql: `INSERT INTO contractor_categories (org_id, contractor_id, category_id) VALUES (?, ?, ?)`,
        args: [ctx.orgId, id, categoryId],
      });
    }
    await tx.execute({
      sql: `INSERT INTO audit_logs (org_id, actor_user_id, action, entity_type, entity_id, after_json)
            VALUES (?, ?, 'contractors.update', 'contractor', ?, ?)`,
      args: [ctx.orgId, ctx.userId, id, JSON.stringify({ name: input.name, status: input.status })],
    });
    await tx.commit();
    return { ok: true, id };
  } catch (err) {
    await tx.rollback();
    if (isUniqueViolation(err))
      return { ok: false, code: 'conflict', message: 'That contractor already exists.' };
    throw err;
  }
}
