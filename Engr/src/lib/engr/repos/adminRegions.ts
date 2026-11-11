/**
 * A region has two distinct associations:
 *   org_id            - the immutable data-owner/tenant boundary
 *   affiliate_org_id  - editable classification under that tenant's group
 *
 * Editing Coast's affiliate therefore does not move Coast or its stations out
 * of Hass's existing dataset. Group administrators can classify their group's
 * regions; ordinary affiliate users remain scoped to their own organisation.
 */
import type { Client } from '@libsql/client/web';
import { nextOrganisationCode } from './organisationCodes';

const newId = (): string => crypto.randomUUID().replace(/-/g, '');
const unique = (err: unknown): boolean =>
  /UNIQUE|SQLITE_CONSTRAINT/i.test(String(err instanceof Error ? err.message : err));

export type RegionResult =
  | { ok: true; id: string }
  | { ok: false; code: 'conflict' | 'invalid' | 'not_found'; message: string };

export interface RegionActor {
  orgId: string;
  homeOrgId: string;
  userId: string;
  isPlatformOwner: boolean;
  roles?: readonly string[];
}
export interface AffiliateOption {
  id: string;
  name: string;
}
export interface RegionRow {
  id: string;
  orgId: string;
  affiliateOrgId: string;
  name: string;
  code: string | null;
  affiliateName: string;
}
export type RegionDetail = RegionRow;
export interface RegionInput {
  name: string;
  affiliateOrgId: string;
}

/**
 * Only child organisations are affiliates. A root tenant is NEVER an affiliate
 * option. Group owners/admins may select active children of their current root.
 * Legacy child-scoped administrators can select their own affiliate only.
 */
export async function listRegionAffiliates(db: Client, actor: RegionActor): Promise<AffiliateOption[]> {
  const canManageGroup =
    actor.isPlatformOwner ||
    (actor.roles ?? []).includes('OWNER') ||
    (actor.roles ?? []).includes('ADMIN');
  const res = await db.execute({
    sql: `SELECT a.id, a.name
            FROM organisations a
            JOIN organisations current ON current.id = ?
           WHERE current.deleted_at IS NULL AND current.status = 'ACTIVE'
             AND a.deleted_at IS NULL AND a.status = 'ACTIVE'
             AND a.parent_org_id IS NOT NULL
             AND (
               (current.parent_org_id IS NULL AND ? = 1
                AND a.parent_org_id = current.id)
               OR (current.parent_org_id IS NOT NULL AND a.id = current.id)
             )
        ORDER BY a.name`,
    args: [actor.orgId, canManageGroup ? 1 : 0],
  });
  return res.rows.map((r) => ({ id: String(r.id), name: String(r.name) }));
}

/**
 * A platform owner acting as a group root can review regions owned by its
 * affiliates. Every other reader sees only its acting organisation.
 */
const GROUP_REGION_WHERE = `(
   r.org_id = ?
   OR (? = 1 AND EXISTS (
     SELECT 1 FROM organisations current
      WHERE current.id = ? AND current.parent_org_id IS NULL
   ) AND owner.parent_org_id = ?)
 )`;

export async function listRegionsAdmin(db: Client, actor: RegionActor): Promise<RegionRow[]> {
  const res = await db.execute({
    sql: `SELECT r.id, r.org_id, r.affiliate_org_id, r.name, r.code,
                 CASE
                   WHEN owner.parent_org_id IS NULL AND
                     (affiliate.parent_org_id IS NULL OR affiliate.parent_org_id <> owner.id)
                   THEN 'Unassigned'
                   ELSE COALESCE(affiliate.name, owner.name)
                 END AS affiliate_name
            FROM regions r
            JOIN organisations owner ON owner.id = r.org_id
            LEFT JOIN organisations affiliate
                   ON affiliate.id = r.affiliate_org_id
           WHERE ${GROUP_REGION_WHERE}
        ORDER BY COALESCE(affiliate.name, owner.name), r.name`,
    args: [actor.orgId, actor.isPlatformOwner ? 1 : 0, actor.orgId, actor.orgId],
  });
  return res.rows.map((r) => ({
    id: String(r.id),
    orgId: String(r.org_id),
    affiliateOrgId: r.affiliate_org_id == null ? String(r.org_id) : String(r.affiliate_org_id),
    name: String(r.name),
    code: r.code == null ? null : String(r.code),
    affiliateName: String(r.affiliate_name),
  }));
}

export async function getRegion(db: Client, actor: RegionActor, id: string): Promise<RegionDetail | null> {
  const res = await db.execute({
    sql: `SELECT r.id, r.org_id, r.affiliate_org_id, r.name, r.code,
                 CASE
                   WHEN owner.parent_org_id IS NULL AND
                     (affiliate.parent_org_id IS NULL OR affiliate.parent_org_id <> owner.id)
                   THEN 'Unassigned'
                   ELSE COALESCE(affiliate.name, owner.name)
                 END AS affiliate_name
            FROM regions r
            JOIN organisations owner ON owner.id = r.org_id
            LEFT JOIN organisations affiliate
                   ON affiliate.id = r.affiliate_org_id
           WHERE r.id = ? AND ${GROUP_REGION_WHERE}
           LIMIT 1`,
    args: [id, actor.orgId, actor.isPlatformOwner ? 1 : 0, actor.orgId, actor.orgId],
  });
  const r = res.rows[0];
  return r ? {
    id: String(r.id),
    orgId: String(r.org_id),
    affiliateOrgId: r.affiliate_org_id == null ? String(r.org_id) : String(r.affiliate_org_id),
    name: String(r.name),
    code: r.code == null ? null : String(r.code),
    affiliateName: String(r.affiliate_name),
  } : null;
}

async function canClassify(db: Client, actor: RegionActor, affiliateOrgId: string): Promise<boolean> {
  if (!affiliateOrgId) return false;
  const options = await listRegionAffiliates(db, actor);
  return options.some((option) => option.id === affiliateOrgId);
}

export async function createRegion(
  db: Client,
  actor: RegionActor,
  input: RegionInput,
): Promise<RegionResult> {
  const name = input.name.trim();
  if (!name || name.length > 120)
    return { ok: false, code: 'invalid', message: 'A name of up to 120 characters is required.' };
  if (!(await canClassify(db, actor, input.affiliateOrgId)))
    return { ok: false, code: 'invalid', message: 'Choose an affiliate in the current group.' };

  for (let attempt = 0; attempt < 8; attempt++) {
    const tx = await db.transaction('write');
    const id = newId();
    try {
      // The owner is ALWAYS the acting org. Affiliate selection is a label,
      // never an implicit change of tenant or station ownership.
      const code = await nextOrganisationCode(tx, actor.orgId, 'region');
      const inserted = await tx.execute({
        sql: `INSERT INTO regions (id, org_id, affiliate_org_id, code, name, currency)
              SELECT ?, o.id, ?, ?, ?, o.base_currency
                FROM organisations o
               WHERE o.id = ? AND o.deleted_at IS NULL AND o.status = 'ACTIVE'`,
        args: [id, input.affiliateOrgId, code, name, actor.orgId],
      });
      if (inserted.rowsAffected !== 1) {
        await tx.rollback();
        return { ok: false, code: 'invalid', message: 'The acting organisation is unavailable.' };
      }
      await tx.execute({
        sql: `INSERT INTO audit_logs (org_id, actor_user_id, action, entity_type, entity_id, after_json)
              VALUES (?, ?, 'regions.create', 'region', ?, ?)`,
        args: [actor.orgId, actor.userId, id,
          JSON.stringify({ code, name, affiliateOrgId: input.affiliateOrgId })],
      });
      await tx.commit();
      return { ok: true, id };
    } catch (error) {
      await tx.rollback();
      if (unique(error)) continue;
      throw error;
    }
  }
  return { ok: false, code: 'conflict', message: 'Region code could not be reserved. Try again.' };
}

export async function updateRegion(
  db: Client,
  actor: RegionActor,
  id: string,
  input: RegionInput,
): Promise<RegionResult> {
  const name = input.name.trim();
  if (!name || name.length > 120)
    return { ok: false, code: 'invalid', message: 'A name of up to 120 characters is required.' };
  const current = await getRegion(db, actor, id);
  if (!current) return { ok: false, code: 'not_found', message: 'Region not found.' };
  // A root tenant is never an affiliate, including on legacy edits.
  // Previously unclassified regions must select a valid child affiliate.
  if (!(await canClassify(db, actor, input.affiliateOrgId)))
    return { ok: false, code: 'invalid', message: 'Choose an active affiliate in the current group.' };

  // Regions owned by an individual affiliate must remain classified to that
  // affiliate. Only group-owned regions can be assigned among group children.
  const owner = await db.execute({
    sql: 'SELECT parent_org_id FROM organisations WHERE id = ? LIMIT 1',
    args: [current.orgId],
  });
  if (owner.rows[0]?.parent_org_id !== null && input.affiliateOrgId !== current.orgId)
    return { ok: false, code: 'invalid', message: 'A region owned by an affiliate cannot be reassigned outside it.' };

  const tx = await db.transaction('write');
  try {
    const updated = await tx.execute({
      // Compare the existing affiliate so concurrent edits cannot silently
      // overwrite a new assignment made since the form was loaded.
      sql: `UPDATE regions
               SET name = ?, affiliate_org_id = ?
             WHERE id = ? AND org_id = ?
               AND COALESCE(affiliate_org_id, org_id) = ?`,
      args: [name, input.affiliateOrgId, id, current.orgId, current.affiliateOrgId],
    });
    if (updated.rowsAffected !== 1) {
      await tx.rollback();
      return { ok: false, code: 'conflict', message: 'Region changed. Reload and review its affiliate.' };
    }
    if (current.affiliateOrgId !== input.affiliateOrgId) {
      const pending = await tx.execute({
        sql: `SELECT 1 FROM asset_transfers t
               JOIN stations s ON s.id IN (t.from_station_id, t.to_station_id)
                              AND s.org_id = t.org_id
              WHERE t.org_id = ? AND s.region_id = ?
                AND t.status IN ('REQUESTED','APPROVED','DISPATCHED')
              LIMIT 1`,
        args: [current.orgId, id],
      });
      if (pending.rows.length) {
        await tx.rollback();
        return { ok: false, code: 'conflict', message: 'Finish pending asset transfers before changing the region affiliate.' };
      }
      // Reclassify linked stations atomically with the region. Their tenant
      // org_id, region_id, station codes and history remain unchanged.
      await tx.execute({
        sql: `INSERT INTO audit_logs
                (org_id, actor_user_id, action, entity_type, entity_id, before_json, after_json)
              SELECT s.org_id, ?, 'stations.affiliate_reassigned', 'station', s.id,
                     json_object('regionId', s.region_id,
                                 'affiliateOrgId', COALESCE(s.affiliate_org_id, s.org_id)),
                     json_object('regionId', s.region_id, 'affiliateOrgId', ?)
                FROM stations s
               WHERE s.org_id = ? AND s.region_id = ?`,
        args: [actor.userId, input.affiliateOrgId, current.orgId, id],
      });
      await tx.execute({
        sql: `UPDATE stations SET affiliate_org_id = ?
               WHERE org_id = ? AND region_id = ?`,
        args: [input.affiliateOrgId, current.orgId, id],
      });
    }
    await tx.execute({
      sql: `INSERT INTO audit_logs
              (org_id, actor_user_id, action, entity_type, entity_id, before_json, after_json)
            VALUES (?, ?, 'regions.update', 'region', ?, ?, ?)`,
      args: [
        current.orgId,
        actor.userId,
        id,
        JSON.stringify({ name: current.name, code: current.code, affiliateOrgId: current.affiliateOrgId }),
        JSON.stringify({ name, code: current.code, affiliateOrgId: input.affiliateOrgId }),
      ],
    });
    await tx.commit();
    return { ok: true, id };
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}
