/**
 * Affiliates administration for the Setup module. An affiliate is a business unit
 * of the organisation that a work paper or action plan can be scoped to. Every
 * read and write is scoped to the acting organization_id; column names come from
 * the typed schema layer (@grc/schema/columns). The code is the natural key and
 * is immutable once created; deletion is blocked while any work paper or action
 * plan references the affiliate (deactivate instead), and is otherwise a
 * soft-delete via deleted_at.
 */
import type { Client } from '@libsql/client/web';
import { C, cols } from '@grc/schema/columns';

const AFF = cols(C.affiliates);
const WP = cols(C.work_papers);
const AP = cols(C.action_plans);

export interface Affiliate {
  code: string;
  name: string;
  country: string | null;
  region: string | null;
  isActive: boolean;
}

export interface AffiliateInput {
  name: string;
  country: string | null;
  region: string | null;
}

const s = (v: unknown): string | null => (v == null ? null : String(v));

/** All non-deleted affiliates for the organisation, active first then by name. */
export async function listAffiliates(db: Client, organizationId: string): Promise<Affiliate[]> {
  const res = await db.execute({
    sql: `SELECT ${AFF.affiliate_code} AS code, ${AFF.affiliate_name} AS name,
                 ${AFF.country} AS country, ${AFF.region} AS region, ${AFF.is_active} AS is_active
            FROM affiliates
           WHERE ${AFF.organization_id} = ? AND ${AFF.deleted_at} IS NULL
        ORDER BY ${AFF.is_active} DESC, ${AFF.affiliate_name}`,
    args: [organizationId],
  });
  return res.rows.map((r) => ({
    code: String(r.code),
    name: String(r.name ?? r.code),
    country: s(r.country),
    region: s(r.region),
    isActive: Number(r.is_active ?? 0) === 1,
  }));
}

/** Whether an affiliate code already exists (any state) for the organisation. */
export async function affiliateExists(
  db: Client,
  organizationId: string,
  code: string,
): Promise<boolean> {
  const res = await db.execute({
    sql: `SELECT 1 FROM affiliates
           WHERE ${AFF.organization_id} = ? AND ${AFF.affiliate_code} = ? LIMIT 1`,
    args: [organizationId, code],
  });
  return res.rows.length > 0;
}

/** Create an affiliate. The caller validates the code is unique and well-formed. */
export async function createAffiliate(
  db: Client,
  organizationId: string,
  code: string,
  input: AffiliateInput,
): Promise<void> {
  const now = new Date().toISOString();
  await db.execute({
    sql: `INSERT INTO affiliates
            (${AFF.affiliate_code}, ${AFF.organization_id}, ${AFF.affiliate_name}, ${AFF.country},
             ${AFF.region}, ${AFF.is_active}, ${AFF.created_at}, ${AFF.updated_at})
          VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
    args: [code, organizationId, input.name, input.country, input.region, now, now],
  });
}

/** Update an affiliate's editable fields (the code is immutable). */
export async function updateAffiliate(
  db: Client,
  organizationId: string,
  code: string,
  input: AffiliateInput,
): Promise<void> {
  await db.execute({
    sql: `UPDATE affiliates
             SET ${AFF.affiliate_name} = ?, ${AFF.country} = ?, ${AFF.region} = ?, ${AFF.updated_at} = ?
           WHERE ${AFF.organization_id} = ? AND ${AFF.affiliate_code} = ?`,
    args: [input.name, input.country, input.region, new Date().toISOString(), organizationId, code],
  });
}

/** Activate or deactivate an affiliate. */
export async function setAffiliateActive(
  db: Client,
  organizationId: string,
  code: string,
  active: boolean,
): Promise<void> {
  await db.execute({
    sql: `UPDATE affiliates SET ${AFF.is_active} = ?, ${AFF.updated_at} = ?
           WHERE ${AFF.organization_id} = ? AND ${AFF.affiliate_code} = ?`,
    args: [active ? 1 : 0, new Date().toISOString(), organizationId, code],
  });
}

/** Whether any work paper or action plan in the organisation references the code. */
export async function affiliateInUse(
  db: Client,
  organizationId: string,
  code: string,
): Promise<boolean> {
  const res = await db.execute({
    sql: `SELECT 1 FROM work_papers
           WHERE ${WP.organization_id} = ? AND ${WP.affiliate_code} = ? AND ${WP.deleted_at} IS NULL
           UNION ALL
          SELECT 1 FROM action_plans
           WHERE ${AP.organization_id} = ? AND ${AP.affiliate_code} = ? AND ${AP.deleted_at} IS NULL
           LIMIT 1`,
    args: [organizationId, code, organizationId, code],
  });
  return res.rows.length > 0;
}

/** Soft-delete an affiliate. The caller must have confirmed it is not in use. */
export async function deleteAffiliate(
  db: Client,
  organizationId: string,
  code: string,
): Promise<void> {
  await db.execute({
    sql: `UPDATE affiliates SET ${AFF.deleted_at} = ?, ${AFF.is_active} = 0, ${AFF.updated_at} = ?
           WHERE ${AFF.organization_id} = ? AND ${AFF.affiliate_code} = ?`,
    args: [new Date().toISOString(), new Date().toISOString(), organizationId, code],
  });
}
