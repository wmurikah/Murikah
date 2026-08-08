/**
 * Affiliates administration for the Setup module. An affiliate is a business unit
 * of the organisation that a work paper or action plan can be scoped to. Every
 * read and write is scoped to the acting organization_id; column names come from
 * the typed schema layer (@grc/schema/columns). The code is the natural key and
 * is immutable once created; deletion is blocked while any work paper or action
 * plan references the affiliate (deactivate instead), and is otherwise a
 * soft-delete via deleted_at.
 *
 * The list read is cache-aside (Build Prompt 42), namespaced under the acting
 * organisation, and every mutation invalidates that namespace before returning,
 * so the setup screen never shows a stale roster.
 */
import type { Client } from '@libsql/client/web';
import { C, cols } from '@grc/schema/columns';
import { CACHE_TTL, cacheKeys, cached } from '@grc/cache';
import { invalidateAffiliates } from '@grc/cache/invalidate';

const AFF = cols(C.affiliates);
const WP = cols(C.work_papers);
const AP = cols(C.action_plans);

export interface Affiliate {
  code: string;
  name: string;
  country: string | null;
  region: string | null;
  isActive: boolean;
  /**
   * `affiliates.is_group`: this is the organisation's Group or HQ unit, and a
   * user posted to it is exempt from affiliate confinement (Build Prompt 48).
   */
  isGroup: boolean;
}

export interface AffiliateInput {
  name: string;
  country: string | null;
  region: string | null;
  isGroup: boolean;
}

const s = (v: unknown): string | null => (v == null ? null : String(v));

/** All non-deleted affiliates for the organisation, active first then by name. */
export async function listAffiliates(db: Client, organizationId: string): Promise<Affiliate[]> {
  return cached(db, cacheKeys.affiliates(organizationId), CACHE_TTL.reference, async () => {
    const res = await db.execute({
      sql: `SELECT ${AFF.affiliate_code} AS code, ${AFF.affiliate_name} AS name,
                 ${AFF.country} AS country, ${AFF.region} AS region, ${AFF.is_active} AS is_active,
                 ${AFF.is_group} AS is_group
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
      isGroup: Number(r.is_group ?? 0) === 1,
    }));
  });
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
             ${AFF.region}, ${AFF.is_active}, ${AFF.is_group}, ${AFF.created_at}, ${AFF.updated_at})
          VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    args: [
      code,
      organizationId,
      input.name,
      input.country,
      input.region,
      input.isGroup ? 1 : 0,
      now,
      now,
    ],
  });
  await invalidateAffiliates(db, organizationId);
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
             SET ${AFF.affiliate_name} = ?, ${AFF.country} = ?, ${AFF.region} = ?,
                 ${AFF.is_group} = ?, ${AFF.updated_at} = ?
           WHERE ${AFF.organization_id} = ? AND ${AFF.affiliate_code} = ?`,
    args: [
      input.name,
      input.country,
      input.region,
      input.isGroup ? 1 : 0,
      new Date().toISOString(),
      organizationId,
      code,
    ],
  });
  await invalidateAffiliates(db, organizationId);
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
  await invalidateAffiliates(db, organizationId);
}

/**
 * Whether the viewer's own affiliate is the organisation's Group unit, and so
 * exempt from affiliate confinement (Build Prompt 48).
 *
 * Read fresh, never through the affiliates cache, and for the same reason the
 * permission matrix is not cached (Build Prompt 43): this is an access decision.
 * A cached answer would keep a user seeing every affiliate for the rest of the
 * entry's lifetime after an administrator un-marked their unit, and "the access
 * change applies on the very next request" is the guarantee the rest of this
 * subsystem already makes. It is one indexed lookup on a small table, and the
 * middleware only asks when the role is confined and the user has an affiliate,
 * so an unconfined request pays nothing at all.
 *
 * A deleted or inactive affiliate does not confer the exemption: `deleted_at` is
 * excluded so a removed unit stops widening access immediately. Any failure is
 * treated as "not a group", so the confinement stands: the fail-closed direction.
 */
export async function isGroupAffiliate(
  db: Client,
  organizationId: string,
  affiliateCode: string,
): Promise<boolean> {
  if (affiliateCode === '') return false;
  try {
    const res = await db.execute({
      sql: `SELECT ${AFF.is_group} AS is_group FROM affiliates
             WHERE ${AFF.organization_id} = ? AND ${AFF.affiliate_code} = ?
               AND ${AFF.deleted_at} IS NULL
             LIMIT 1`,
      args: [organizationId, affiliateCode],
    });
    return Number(res.rows[0]?.is_group ?? 0) === 1;
  } catch (err) {
    console.error('[grc.affiliates] the group flag could not be read; confinement stands', err);
    return false;
  }
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
  await invalidateAffiliates(db, organizationId);
}
