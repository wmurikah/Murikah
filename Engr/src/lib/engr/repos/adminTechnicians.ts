/**
 * Technicians admin. Org-scoped reads and writes; every write records an
 * audit_logs row. A technician always belongs to a contractor. Soft-deletable.
 */
import type { Client } from '@libsql/client/web';

const newId = (): string => crypto.randomUUID().replace(/-/g, '');

function isUniqueViolation(err: unknown): boolean {
  const text = String(err instanceof Error ? err.message : err);
  return text.includes('UNIQUE') || text.includes('SQLITE_CONSTRAINT');
}

export type AdminResult =
  | { ok: true; id?: string }
  | { ok: false; code: 'conflict' | 'invalid' | 'not_found' | 'forbidden'; message: string };

export interface TechnicianAdminCtx {
  orgId: string;
  userId: string;
  /** Present for a contractor portal actor; absent for organisation staff. */
  contractorId?: string;
}

export interface TechnicianRow {
  id: string;
  fullName: string;
  contractorName: string;
  phone: string | null;
  status: string;
}

export interface TechnicianDetail {
  id: string;
  contractorId: string;
  fullName: string;
  phone: string | null;
  email: string | null;
  status: string;
}

export interface TechnicianInput {
  contractorId: string;
  fullName: string;
  phone: string | null;
  email: string | null;
  status: string;
}

export async function listTechniciansAdmin(
  db: Client,
  orgId: string,
  contractorId?: string,
): Promise<TechnicianRow[]> {
  const res = await db.execute({
    sql: `SELECT t.id, t.full_name, t.phone, t.status,
                 c.name AS contractor_name
            FROM technicians t
            JOIN contractors c ON c.id = t.contractor_id
           WHERE t.org_id = ? AND t.deleted_at IS NULL
             AND (? IS NULL OR t.contractor_id = ?)
        ORDER BY t.full_name`,
    args: [orgId, contractorId ?? null, contractorId ?? null],
  });
  return res.rows.map((r) => ({
    id: String(r.id),
    fullName: String(r.full_name),
    contractorName: String(r.contractor_name),
    phone: r.phone === null ? null : String(r.phone),
    status: String(r.status),
  }));
}

export async function getTechnician(
  db: Client,
  orgId: string,
  id: string,
  contractorId?: string,
): Promise<TechnicianDetail | null> {
  const res = await db.execute({
    sql: `SELECT id, contractor_id, full_name, phone, email, status
            FROM technicians
           WHERE id = ? AND org_id = ? AND deleted_at IS NULL
             AND (? IS NULL OR contractor_id = ?)
           LIMIT 1`,
    args: [id, orgId, contractorId ?? null, contractorId ?? null],
  });
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    contractorId: String(row.contractor_id),
    fullName: String(row.full_name),
    phone: row.phone === null ? null : String(row.phone),
    email: row.email === null ? null : String(row.email),
    status: String(row.status),
  };
}

const STATUSES = new Set(['ACTIVE', 'INACTIVE']);

function validate(input: TechnicianInput): string | null {
  if (!input.contractorId) return 'A contractor is required.';
  if (!input.fullName) return 'A name is required.';
  if (!STATUSES.has(input.status)) return 'Choose a valid status.';
  return null;
}

export async function createTechnician(
  db: Client,
  ctx: TechnicianAdminCtx,
  input: TechnicianInput,
): Promise<AdminResult> {
  const invalid = validate(input);
  if (invalid) return { ok: false, code: 'invalid', message: invalid };
  if (ctx.contractorId && input.contractorId !== ctx.contractorId) {
    return { ok: false, code: 'forbidden', message: 'Technicians must belong to your contractor.' };
  }
  const id = newId();
  const tx = await db.transaction('write');
  try {
    await tx.execute({
      sql: `INSERT INTO technicians (id, org_id, contractor_id, full_name, phone, email, status)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        ctx.orgId,
        input.contractorId,
        input.fullName,
        input.phone,
        input.email,
        input.status,
      ],
    });
    await tx.execute({
      sql: `INSERT INTO audit_logs (org_id, actor_user_id, action, entity_type, entity_id, after_json)
            VALUES (?, ?, 'technicians.create', 'technician', ?, ?)`,
      args: [
        ctx.orgId,
        ctx.userId,
        id,
        JSON.stringify({ full_name: input.fullName, status: input.status }),
      ],
    });
    await tx.commit();
    return { ok: true, id };
  } catch (err) {
    await tx.rollback();
    if (isUniqueViolation(err))
      return { ok: false, code: 'conflict', message: 'That technician already exists.' };
    throw err;
  }
}

export async function updateTechnician(
  db: Client,
  ctx: TechnicianAdminCtx,
  id: string,
  input: TechnicianInput,
): Promise<AdminResult> {
  const invalid = validate(input);
  if (invalid) return { ok: false, code: 'invalid', message: invalid };
  if (ctx.contractorId && input.contractorId !== ctx.contractorId) {
    return { ok: false, code: 'forbidden', message: 'Technicians must belong to your contractor.' };
  }
  const tx = await db.transaction('write');
  try {
    const upd = await tx.execute({
      sql: `UPDATE technicians
               SET contractor_id = ?, full_name = ?, phone = ?, email = ?, status = ?
             WHERE id = ? AND org_id = ? AND deleted_at IS NULL
               AND (? IS NULL OR contractor_id = ?)`,
      args: [
        input.contractorId,
        input.fullName,
        input.phone,
        input.email,
        input.status,
        id,
        ctx.orgId,
        ctx.contractorId ?? null,
        ctx.contractorId ?? null,
      ],
    });
    if (upd.rowsAffected === 0) {
      await tx.rollback();
      return { ok: false, code: 'not_found', message: 'That technician was not found.' };
    }
    await tx.execute({
      sql: `INSERT INTO audit_logs (org_id, actor_user_id, action, entity_type, entity_id, after_json)
            VALUES (?, ?, 'technicians.update', 'technician', ?, ?)`,
      args: [
        ctx.orgId,
        ctx.userId,
        id,
        JSON.stringify({ full_name: input.fullName, status: input.status }),
      ],
    });
    await tx.commit();
    return { ok: true, id };
  } catch (err) {
    await tx.rollback();
    if (isUniqueViolation(err))
      return { ok: false, code: 'conflict', message: 'That technician already exists.' };
    throw err;
  }
}
