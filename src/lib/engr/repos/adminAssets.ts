/**
 * Assets admin. Org-scoped reads and writes; every write records an audit_logs
 * row. The tag is user-supplied and unique per org, so a clash returns a
 * conflict rather than throwing. Rows are soft-deletable, so reads and updates
 * skip anything already removed.
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

export interface AssetRow {
  id: string;
  tag: string;
  name: string;
  stationName: string;
  categoryName: string | null;
  status: string;
}

export interface AssetDetail {
  id: string;
  tag: string;
  name: string;
  stationId: string;
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
}

export async function listAssetsAdmin(db: Client, orgId: string): Promise<AssetRow[]> {
  const res = await db.execute({
    sql: `SELECT a.id, a.tag, a.name, a.status,
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
    status: String(r.status),
  }));
}

export async function getAsset(db: Client, orgId: string, id: string): Promise<AssetDetail | null> {
  const res = await db.execute({
    sql: `SELECT id, tag, name, station_id, category_id, manufacturer, model, serial_no, install_date, status
            FROM assets WHERE id = ? AND org_id = ? AND deleted_at IS NULL LIMIT 1`,
    args: [id, orgId],
  });
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    tag: String(row.tag),
    name: String(row.name),
    stationId: String(row.station_id),
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

export async function createAsset(
  db: Client,
  ctx: { orgId: string; userId: string },
  input: AssetInput,
): Promise<AdminResult> {
  const invalid = validate(input);
  if (invalid) return { ok: false, code: 'invalid', message: invalid };
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
  const tx = await db.transaction('write');
  try {
    const upd = await tx.execute({
      sql: `UPDATE assets
               SET station_id = ?, category_id = ?, tag = ?, name = ?, manufacturer = ?, model = ?, serial_no = ?, install_date = ?, status = ?
             WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
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
      ],
    });
    if (upd.rowsAffected === 0) {
      await tx.rollback();
      return { ok: false, code: 'not_found', message: 'That asset was not found.' };
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
