/**
 * Regions admin. Org-scoped reads and writes; every write records an audit_logs
 * row. The code is user-supplied and unique per org, so a clash returns a
 * conflict rather than throwing. Regions group stations for setup.
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

export interface RegionRow {
  id: string;
  name: string;
  code: string | null;
}

export interface RegionDetail {
  id: string;
  name: string;
  code: string | null;
}

export interface RegionInput {
  name: string;
  code: string | null;
}

export async function listRegionsAdmin(db: Client, orgId: string): Promise<RegionRow[]> {
  const res = await db.execute({
    sql: `SELECT id, name, code
            FROM regions
           WHERE org_id = ?
        ORDER BY name`,
    args: [orgId],
  });
  return res.rows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    code: r.code === null ? null : String(r.code),
  }));
}

export async function getRegion(
  db: Client,
  orgId: string,
  id: string,
): Promise<RegionDetail | null> {
  const res = await db.execute({
    sql: `SELECT id, name, code
            FROM regions WHERE id = ? AND org_id = ? LIMIT 1`,
    args: [id, orgId],
  });
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    name: String(row.name),
    code: row.code === null ? null : String(row.code),
  };
}

function validate(input: RegionInput): string | null {
  if (!input.name) return 'A name is required.';
  return null;
}

export async function createRegion(
  db: Client,
  ctx: { orgId: string; userId: string },
  input: RegionInput,
): Promise<AdminResult> {
  const invalid = validate(input);
  if (invalid) return { ok: false, code: 'invalid', message: invalid };
  const id = newId();
  const tx = await db.transaction('write');
  try {
    await tx.execute({
      sql: `INSERT INTO regions (id, org_id, name, code)
            VALUES (?, ?, ?, ?)`,
      args: [id, ctx.orgId, input.name, input.code],
    });
    await tx.execute({
      sql: `INSERT INTO audit_logs (org_id, actor_user_id, action, entity_type, entity_id, after_json)
            VALUES (?, ?, 'regions.create', 'region', ?, ?)`,
      args: [ctx.orgId, ctx.userId, id, JSON.stringify({ name: input.name, code: input.code })],
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

export async function updateRegion(
  db: Client,
  ctx: { orgId: string; userId: string },
  id: string,
  input: RegionInput,
): Promise<AdminResult> {
  const invalid = validate(input);
  if (invalid) return { ok: false, code: 'invalid', message: invalid };
  const tx = await db.transaction('write');
  try {
    const upd = await tx.execute({
      sql: `UPDATE regions
               SET name = ?, code = ?
             WHERE id = ? AND org_id = ?`,
      args: [input.name, input.code, id, ctx.orgId],
    });
    if (upd.rowsAffected === 0) {
      await tx.rollback();
      return { ok: false, code: 'not_found', message: 'That region was not found.' };
    }
    await tx.execute({
      sql: `INSERT INTO audit_logs (org_id, actor_user_id, action, entity_type, entity_id, after_json)
            VALUES (?, ?, 'regions.update', 'region', ?, ?)`,
      args: [ctx.orgId, ctx.userId, id, JSON.stringify({ name: input.name, code: input.code })],
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
