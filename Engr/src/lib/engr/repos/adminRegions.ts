/**
 * Regions belong to their actual affiliate organisation (regions.org_id).
 * Platform owners may choose a child of their home group; all other actors
 * are confined to the currently active organisation. Generated codes are
 * immutable, including when a region name changes.
 */
import type { Client } from '@libsql/client/web';
import { nextOrganisationCode } from './organisationCodes';

const newId = (): string => crypto.randomUUID().replace(/-/g, '');
const unique = (err: unknown) => /UNIQUE|SQLITE_CONSTRAINT/i.test(String(err instanceof Error ? err.message : err));

export type RegionResult =
  | { ok: true; id: string }
  | { ok: false; code: 'conflict' | 'invalid' | 'not_found'; message: string };

export interface RegionActor {
  orgId: string;
  homeOrgId: string;
  userId: string;
  isPlatformOwner: boolean;
}
export interface AffiliateOption {
  id: string;
  name: string;
}
export interface RegionRow {
  id: string;
  orgId: string;
  name: string;
  code: string | null;
  affiliateName: string;
}
export interface RegionDetail extends RegionRow {}
export interface RegionInput {
  name: string;
  affiliateOrgId: string;
}

export async function listRegionAffiliates(db: Client, actor: RegionActor): Promise<AffiliateOption[]> {
  const res = await db.execute({
    sql: actor.isPlatformOwner
      ? `SELECT id, name FROM organisations
             WHERE deleted_at IS NULL AND status = 'ACTIVE'
               AND (id = ? OR parent_org_id = ?)
          ORDER BY name`
      : `SELECT id, name FROM organisations
             WHERE id = ? AND deleted_at IS NULL AND status = 'ACTIVE'`,
    args: actor.isPlatformOwner
      ? [actor.homeOrgId, actor.homeOrgId]
      : [actor.orgId],
  });
  return res.rows.map((r) => ({ id: String(r.id), name: String(r.name) }));
}

export async function listRegionsAdmin(db: Client, actor: RegionActor): Promise<RegionRow[]> {
  const res = await db.execute({
    sql: `SELECT r.id, r.org_id, r.name, r.code, o.name AS affiliate_name
            FROM regions r
            JOIN organisations o ON o.id = r.org_id
           WHERE r.org_id = ?
              OR (? = 1 AND (r.org_id = ? OR o.parent_org_id = ?))
        ORDER BY o.name, r.name`,
    args: [actor.orgId, actor.isPlatformOwner ? 1 : 0, actor.homeOrgId, actor.homeOrgId],
  });
  return res.rows.map((r) => ({
    id: String(r.id),
    orgId: String(r.org_id),
    name: String(r.name),
    code: r.code == null ? null : String(r.code),
    affiliateName: String(r.affiliate_name),
  }));
}

export async function getRegion(db: Client, actor: RegionActor, id: string): Promise<RegionDetail | null> {
  const res = await db.execute({
    sql: `SELECT r.id, r.org_id, r.name, r.code, o.name AS affiliate_name
            FROM regions r
            JOIN organisations o ON o.id = r.org_id
           WHERE r.id = ? AND
                 (r.org_id = ? OR (? = 1 AND (r.org_id = ? OR o.parent_org_id = ?)))
           LIMIT 1`,
    args: [id, actor.orgId, actor.isPlatformOwner ? 1 : 0, actor.homeOrgId, actor.homeOrgId],
  });
  const r = res.rows[0];
  return r ? {
    id: String(r.id),
    orgId: String(r.org_id),
    name: String(r.name),
    code: r.code == null ? null : String(r.code),
    affiliateName: String(r.affiliate_name),
  } : null;
}

export async function createRegion(
  db: Client,
  actor: RegionActor,
  input: RegionInput,
): Promise<RegionResult> {
  if (!input.name.trim()) return { ok: false, code: 'invalid', message: 'Region name is required.' };
  // Server-side entitlement is authoritative: a forged affiliate id is refused.
  const permitted = await listRegionAffiliates(db, actor);
  if (!permitted.some((org) => org.id === input.affiliateOrgId))
    return { ok: false, code: 'invalid', message: 'Select an authorised affiliate.' };
  for (let attempt = 0; attempt < 8; attempt++) {
    const tx = await db.transaction('write');
    const id = newId();
    try {
      const code = await nextOrganisationCode(tx, input.affiliateOrgId, 'region');
      const inserted = await tx.execute({
        sql: `INSERT INTO regions (id, org_id, code, name, currency)
              SELECT ?, o.id, ?, ?, o.base_currency FROM organisations o
               WHERE o.id = ? AND o.deleted_at IS NULL AND o.status = 'ACTIVE'`,
        args: [id, code, input.name.trim(), input.affiliateOrgId],
      });
      if (inserted.rowsAffected !== 1) {
        await tx.rollback();
        return { ok: false, code: 'invalid', message: 'Affiliate is unavailable.' };
      }
      await tx.execute({
        sql: `INSERT INTO audit_logs (org_id, actor_user_id, action, entity_type, entity_id, after_json)
              VALUES (?, ?, 'regions.create', 'region', ?, ?)`,
        args: [input.affiliateOrgId, actor.userId, id, JSON.stringify({ code, name: input.name.trim(), affiliate: input.affiliateOrgId })],
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
  if (!input.name.trim()) return { ok: false, code: 'invalid', message: 'Region name is required.' };
  const current = await getRegion(db, actor, id);
  if (!current) return { ok: false, code: 'not_found', message: 'Region not found.' };
  // The current affiliate and generated code are deliberately never editable.
  const tx = await db.transaction('write');
  try {
    const result = await tx.execute({
      sql: `UPDATE regions SET name = ? WHERE id = ? AND org_id = ?`,
      args: [input.name.trim(), id, current.orgId],
    });
    if (result.rowsAffected !== 1) {
      await tx.rollback();
      return { ok: false, code: 'not_found', message: 'Region no longer exists.' };
    }
    await tx.execute({
      sql: `INSERT INTO audit_logs (org_id, actor_user_id, action, entity_type, entity_id, after_json)
            VALUES (?, ?, 'regions.update', 'region', ?, ?)`,
      args: [current.orgId, actor.userId, id, JSON.stringify({ code: current.code, name: input.name.trim() })],
    });
    await tx.commit();
    return { ok: true, id };
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}
