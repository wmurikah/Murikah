/**
 * Asset categories admin. Org-scoped reads and writes; every write records an
 * audit_logs row. The code is user-supplied and unique per org, so a clash
 * returns a conflict rather than throwing. A category may nest under an optional
 * parent category.
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

export interface CategoryRow {
  id: string;
  code: string;
  name: string;
  parentName: string | null;
}

export interface CategoryDetail {
  id: string;
  code: string;
  name: string;
  parentId: string | null;
}

export interface CategoryInput {
  code: string;
  name: string;
  parentId: string | null;
}

export async function listCategoriesAdmin(db: Client, orgId: string): Promise<CategoryRow[]> {
  const res = await db.execute({
    sql: `SELECT c.id, c.code, c.name, p.name AS parent_name
            FROM asset_categories c
            LEFT JOIN asset_categories p ON p.id = c.parent_id
           WHERE c.org_id = ?
        ORDER BY c.code`,
    args: [orgId],
  });
  return res.rows.map((r) => ({
    id: String(r.id),
    code: String(r.code),
    name: String(r.name),
    parentName: r.parent_name === null ? null : String(r.parent_name),
  }));
}

export async function getCategory(
  db: Client,
  orgId: string,
  id: string,
): Promise<CategoryDetail | null> {
  const res = await db.execute({
    sql: `SELECT id, code, name, parent_id
            FROM asset_categories WHERE id = ? AND org_id = ? LIMIT 1`,
    args: [id, orgId],
  });
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    code: String(row.code),
    name: String(row.name),
    parentId: row.parent_id === null ? null : String(row.parent_id),
  };
}

function validate(input: CategoryInput): string | null {
  if (!input.code) return 'A code is required.';
  if (!input.name) return 'A name is required.';
  return null;
}

export async function createCategory(
  db: Client,
  ctx: { orgId: string; userId: string },
  input: CategoryInput,
): Promise<AdminResult> {
  const invalid = validate(input);
  if (invalid) return { ok: false, code: 'invalid', message: invalid };
  const id = newId();
  const tx = await db.transaction('write');
  try {
    await tx.execute({
      sql: `INSERT INTO asset_categories (id, org_id, parent_id, code, name)
            VALUES (?, ?, ?, ?, ?)`,
      args: [id, ctx.orgId, input.parentId, input.code, input.name],
    });
    await tx.execute({
      sql: `INSERT INTO audit_logs (org_id, actor_user_id, action, entity_type, entity_id, after_json)
            VALUES (?, ?, 'asset_category.create', 'asset_category', ?, ?)`,
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

export async function updateCategory(
  db: Client,
  ctx: { orgId: string; userId: string },
  id: string,
  input: CategoryInput,
): Promise<AdminResult> {
  const invalid = validate(input);
  if (invalid) return { ok: false, code: 'invalid', message: invalid };
  const tx = await db.transaction('write');
  try {
    const upd = await tx.execute({
      sql: `UPDATE asset_categories
               SET code = ?, name = ?, parent_id = ?
             WHERE id = ? AND org_id = ?`,
      args: [input.code, input.name, input.parentId, id, ctx.orgId],
    });
    if (upd.rowsAffected === 0) {
      await tx.rollback();
      return { ok: false, code: 'not_found', message: 'That category was not found.' };
    }
    await tx.execute({
      sql: `INSERT INTO audit_logs (org_id, actor_user_id, action, entity_type, entity_id, after_json)
            VALUES (?, ?, 'asset_category.update', 'asset_category', ?, ?)`,
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
