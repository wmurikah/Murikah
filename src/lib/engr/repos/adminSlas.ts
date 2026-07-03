/**
 * SLAs admin. Org-scoped reads and writes; every write records an audit_logs
 * row. The name is user-supplied and unique per org, so a clash returns a
 * conflict rather than throwing. An SLA sets response and resolution targets.
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

export interface SlaRow {
  id: string;
  name: string;
  responseHours: number | null;
  resolutionHours: number | null;
  isDefault: boolean;
}

export interface SlaDetail {
  id: string;
  name: string;
  responseHours: number | null;
  resolutionHours: number | null;
  isDefault: boolean;
}

export interface SlaInput {
  name: string;
  responseHours: number | null;
  resolutionHours: number | null;
  isDefault: boolean;
}

export async function listSlasAdmin(db: Client, orgId: string): Promise<SlaRow[]> {
  const res = await db.execute({
    sql: `SELECT id, name, response_hours, resolution_hours, is_default
            FROM slas
           WHERE org_id = ?
        ORDER BY name`,
    args: [orgId],
  });
  return res.rows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    responseHours: r.response_hours === null ? null : Number(r.response_hours),
    resolutionHours: r.resolution_hours === null ? null : Number(r.resolution_hours),
    isDefault: Number(r.is_default) === 1,
  }));
}

export async function getSla(db: Client, orgId: string, id: string): Promise<SlaDetail | null> {
  const res = await db.execute({
    sql: `SELECT id, name, response_hours, resolution_hours, is_default
            FROM slas WHERE id = ? AND org_id = ? LIMIT 1`,
    args: [id, orgId],
  });
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    name: String(row.name),
    responseHours: row.response_hours === null ? null : Number(row.response_hours),
    resolutionHours: row.resolution_hours === null ? null : Number(row.resolution_hours),
    isDefault: Number(row.is_default) === 1,
  };
}

function validHours(value: number | null): boolean {
  return value === null || (Number.isFinite(value) && value >= 0);
}

function validate(input: SlaInput): string | null {
  if (!input.name) return 'A name is required.';
  if (!validHours(input.responseHours)) return 'Response hours must be zero or more.';
  if (!validHours(input.resolutionHours)) return 'Resolution hours must be zero or more.';
  return null;
}

export async function createSla(
  db: Client,
  ctx: { orgId: string; userId: string },
  input: SlaInput,
): Promise<AdminResult> {
  const invalid = validate(input);
  if (invalid) return { ok: false, code: 'invalid', message: invalid };
  const id = newId();
  const tx = await db.transaction('write');
  try {
    await tx.execute({
      sql: `INSERT INTO slas (id, org_id, name, response_hours, resolution_hours, is_default)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        ctx.orgId,
        input.name,
        input.responseHours,
        input.resolutionHours,
        input.isDefault ? 1 : 0,
      ],
    });
    await tx.execute({
      sql: `INSERT INTO audit_logs (org_id, actor_user_id, action, entity_type, entity_id, after_json)
            VALUES (?, ?, 'slas.create', 'sla', ?, ?)`,
      args: [
        ctx.orgId,
        ctx.userId,
        id,
        JSON.stringify({ name: input.name, isDefault: input.isDefault }),
      ],
    });
    await tx.commit();
    return { ok: true, id };
  } catch (err) {
    await tx.rollback();
    if (isUniqueViolation(err))
      return { ok: false, code: 'conflict', message: 'That name is already used.' };
    throw err;
  }
}

export async function updateSla(
  db: Client,
  ctx: { orgId: string; userId: string },
  id: string,
  input: SlaInput,
): Promise<AdminResult> {
  const invalid = validate(input);
  if (invalid) return { ok: false, code: 'invalid', message: invalid };
  const tx = await db.transaction('write');
  try {
    const upd = await tx.execute({
      sql: `UPDATE slas
               SET name = ?, response_hours = ?, resolution_hours = ?, is_default = ?
             WHERE id = ? AND org_id = ?`,
      args: [
        input.name,
        input.responseHours,
        input.resolutionHours,
        input.isDefault ? 1 : 0,
        id,
        ctx.orgId,
      ],
    });
    if (upd.rowsAffected === 0) {
      await tx.rollback();
      return { ok: false, code: 'not_found', message: 'That SLA was not found.' };
    }
    await tx.execute({
      sql: `INSERT INTO audit_logs (org_id, actor_user_id, action, entity_type, entity_id, after_json)
            VALUES (?, ?, 'slas.update', 'sla', ?, ?)`,
      args: [
        ctx.orgId,
        ctx.userId,
        id,
        JSON.stringify({ name: input.name, isDefault: input.isDefault }),
      ],
    });
    await tx.commit();
    return { ok: true, id };
  } catch (err) {
    await tx.rollback();
    if (isUniqueViolation(err))
      return { ok: false, code: 'conflict', message: 'That name is already used.' };
    throw err;
  }
}
