/**
 * Affiliate management for a group. An affiliate is its own organisation whose
 * parent_org_id is the parent. Only a platform owner reaches these, and every
 * read and write is scoped to that parent (children by parent_org_id), so one
 * parent's affiliates can never be seen or touched under another. Creating an affiliate
 * also opens a TRIALING subscription on the TRIAL plan. The slug is set once from
 * the code and never changed here (logins depend on it).
 */
import type { Client } from '@libsql/client/web';

const newId = (): string => crypto.randomUUID().replace(/-/g, '');

function isUniqueViolation(err: unknown): boolean {
  const text = String(err instanceof Error ? err.message : err);
  return text.includes('UNIQUE') || text.includes('SQLITE_CONSTRAINT');
}

export type AffiliateResult =
  | { ok: true; id?: string }
  | { ok: false; code: 'conflict' | 'invalid' | 'not_found'; message: string };

export interface AffiliateRow {
  id: string;
  name: string;
  slug: string;
  country: string;
  baseCurrency: string;
  status: string;
  stationCount: number;
}

export interface AffiliateDetail {
  id: string;
  name: string;
  slug: string;
  country: string;
  baseCurrency: string;
  status: string;
}

export interface AffiliateCreateInput {
  code: string;
  name: string;
  country: string;
  baseCurrency: string;
}

export interface AffiliateUpdateInput {
  name: string;
  country: string;
  baseCurrency: string;
  status: string;
}

const STATUSES = new Set(['ACTIVE', 'SUSPENDED']);

export async function listAffiliates(db: Client, groupId: string): Promise<AffiliateRow[]> {
  const res = await db.execute({
    sql: `SELECT o.id, o.name, o.slug, o.country, o.base_currency, o.status,
                 (SELECT COUNT(*) FROM stations s WHERE s.org_id = o.id AND s.deleted_at IS NULL) AS station_count
            FROM organisations o
           WHERE o.parent_org_id = ? AND o.deleted_at IS NULL
        ORDER BY o.name`,
    args: [groupId],
  });
  return res.rows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    slug: String(r.slug),
    country: String(r.country),
    baseCurrency: String(r.base_currency),
    status: String(r.status),
    stationCount: Number(r.station_count ?? 0),
  }));
}

export async function getAffiliate(
  db: Client,
  groupId: string,
  id: string,
): Promise<AffiliateDetail | null> {
  const res = await db.execute({
    sql: `SELECT id, name, slug, country, base_currency, status
            FROM organisations
           WHERE id = ? AND parent_org_id = ? AND deleted_at IS NULL LIMIT 1`,
    args: [id, groupId],
  });
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    name: String(row.name),
    slug: String(row.slug),
    country: String(row.country),
    baseCurrency: String(row.base_currency),
    status: String(row.status),
  };
}

export async function createAffiliate(
  db: Client,
  ctx: { groupId: string; userId: string },
  input: AffiliateCreateInput,
): Promise<AffiliateResult> {
  const code = input.code.trim();
  const name = input.name.trim();
  const country = input.country.trim().toUpperCase();
  const currency = input.baseCurrency.trim().toUpperCase();
  if (!code) return { ok: false, code: 'invalid', message: 'A code is required.' };
  if (!name) return { ok: false, code: 'invalid', message: 'A name is required.' };
  if (!country) return { ok: false, code: 'invalid', message: 'A country is required.' };
  if (!currency) return { ok: false, code: 'invalid', message: 'A base currency is required.' };
  const slug = code.toLowerCase();

  // The TRIAL plan every tenant shares (read before the write).
  const planRes = await db.execute({
    sql: `SELECT id FROM plans WHERE code = 'TRIAL' LIMIT 1`,
    args: [],
  });
  const planId = planRes.rows[0] ? String(planRes.rows[0].id) : null;

  const id = newId();
  const tx = await db.transaction('write');
  try {
    await tx.execute({
      sql: `INSERT INTO organisations (id, name, slug, country, base_currency, status, parent_org_id)
            VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?)`,
      args: [id, name, slug, country, currency, ctx.groupId],
    });
    if (planId) {
      await tx.execute({
        sql: `INSERT INTO subscriptions (id, org_id, plan_id, status) VALUES (?, ?, ?, 'TRIALING')`,
        args: [newId(), id, planId],
      });
    }
    await tx.execute({
      sql: `INSERT INTO audit_logs (org_id, actor_user_id, action, entity_type, entity_id, after_json)
            VALUES (?, ?, 'affiliate.create', 'organisation', ?, ?)`,
      args: [ctx.groupId, ctx.userId, id, JSON.stringify({ slug, name })],
    });
    await tx.commit();
    return { ok: true, id };
  } catch (err) {
    await tx.rollback();
    if (isUniqueViolation(err))
      return {
        ok: false,
        code: 'conflict',
        message: 'That code is already used by an organisation.',
      };
    throw err;
  }
}

export async function updateAffiliate(
  db: Client,
  ctx: { groupId: string; userId: string },
  id: string,
  input: AffiliateUpdateInput,
): Promise<AffiliateResult> {
  const name = input.name.trim();
  const country = input.country.trim().toUpperCase();
  const currency = input.baseCurrency.trim().toUpperCase();
  const status = input.status.trim().toUpperCase();
  if (!name) return { ok: false, code: 'invalid', message: 'A name is required.' };
  if (!country) return { ok: false, code: 'invalid', message: 'A country is required.' };
  if (!currency) return { ok: false, code: 'invalid', message: 'A base currency is required.' };
  if (!STATUSES.has(status))
    return { ok: false, code: 'invalid', message: 'Status must be active or suspended.' };

  const tx = await db.transaction('write');
  try {
    // The parent_org_id guard means a group can only edit its own affiliates,
    // and the slug and parent are deliberately left unchanged.
    const upd = await tx.execute({
      sql: `UPDATE organisations SET name = ?, country = ?, base_currency = ?, status = ?
             WHERE id = ? AND parent_org_id = ? AND deleted_at IS NULL`,
      args: [name, country, currency, status, id, ctx.groupId],
    });
    if (upd.rowsAffected === 0) {
      await tx.rollback();
      return { ok: false, code: 'not_found', message: 'That affiliate was not found.' };
    }
    await tx.execute({
      sql: `INSERT INTO audit_logs (org_id, actor_user_id, action, entity_type, entity_id, after_json)
            VALUES (?, ?, 'affiliate.update', 'organisation', ?, ?)`,
      args: [ctx.groupId, ctx.userId, id, JSON.stringify({ name, status })],
    });
    await tx.commit();
    return { ok: true, id };
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}
