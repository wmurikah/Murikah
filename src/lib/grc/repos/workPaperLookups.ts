/**
 * Lookups for the work-paper form and filters, all scoped to the acting
 * organisation: audit areas, sub-areas (which carry the auto-populate template),
 * affiliates and the auditors a finding may be assigned to. The audit universe
 * (audit areas and sub-areas) and affiliates are per-organisation setup entities.
 *
 * These are the hottest reads in the product: every work-paper list, form and
 * report filter needs them, and they change only when someone edits the setup
 * screens. They are cache-aside (Build Prompt 42) under the acting
 * organisation's namespace, and the setup mutations in auditUniverse.ts and
 * affiliatesAdmin.ts clear this namespace as well as their own.
 *
 * The auditor list is deliberately left uncached: it is derived from the users
 * table, where a status change should be visible at once.
 */
import type { Client } from '@libsql/client/web';
import { CACHE_TTL, cacheKeys, cached } from '@grc/cache';

export interface Option {
  id: string;
  label: string;
}

export interface SubAreaTemplate {
  id: string;
  auditAreaId: string;
  label: string;
  controlObjectives: string | null;
  riskDescription: string | null;
  testObjective: string | null;
  testingSteps: string | null;
}

export async function listAuditAreas(db: Client, organizationId: string): Promise<Option[]> {
  return cached(db, cacheKeys.lookupAuditAreas(organizationId), CACHE_TTL.reference, async () => {
    const res = await db.execute({
      sql: `SELECT audit_area_id AS id, area_name AS name FROM audit_areas
           WHERE organization_id = ? AND (is_active IS NULL OR is_active = 1)
        ORDER BY area_name`,
      args: [organizationId],
    });
    return res.rows.map((r) => ({ id: String(r.id), label: String(r.name) }));
  });
}

export async function listAffiliates(db: Client, organizationId: string): Promise<Option[]> {
  return cached(db, cacheKeys.lookupAffiliates(organizationId), CACHE_TTL.reference, async () => {
    const res = await db.execute({
      sql: `SELECT affiliate_code AS id, affiliate_name AS name FROM affiliates
           WHERE organization_id = ? AND (is_active IS NULL OR is_active = 1)
        ORDER BY affiliate_name`,
      args: [organizationId],
    });
    return res.rows.map((r) => ({ id: String(r.id), label: String(r.name) }));
  });
}

/** Active users in the organisation, offered as assignable auditors. */
export async function listAuditors(db: Client, organizationId: string): Promise<Option[]> {
  const res = await db.execute({
    sql: `SELECT user_id AS id, full_name AS name FROM users
           WHERE organization_id = ? AND (status IS NULL OR UPPER(status) NOT IN ('INACTIVE','DISABLED','SUSPENDED','ARCHIVED','DELETED'))
        ORDER BY full_name`,
    args: [organizationId],
  });
  return res.rows.map((r) => ({ id: String(r.id), label: String(r.name ?? r.id) }));
}

/** Sub-areas for an organisation (optionally within one audit area), with their template fields. */
export async function listSubAreas(
  db: Client,
  organizationId: string,
  auditAreaId?: string,
): Promise<SubAreaTemplate[]> {
  const key = cacheKeys.lookupSubAreas(organizationId, auditAreaId);
  return cached(db, key, CACHE_TTL.reference, async () => {
    const args: (string | number)[] = [organizationId];
    let where = 'organization_id = ? AND (is_active IS NULL OR is_active = 1)';
    if (auditAreaId) {
      where += ' AND audit_area_id = ?';
      args.push(auditAreaId);
    }
    const res = await db.execute({
      sql: `SELECT sub_area_id AS id, audit_area_id, sub_area_name AS name, control_objectives,
                 risk_description, test_objective, testing_steps
            FROM sub_areas WHERE ${where}
        ORDER BY sub_area_name`,
      args,
    });
    return res.rows.map((r) => ({
      id: String(r.id),
      auditAreaId: String(r.audit_area_id ?? ''),
      label: String(r.name ?? ''),
      controlObjectives: r.control_objectives == null ? null : String(r.control_objectives),
      riskDescription: r.risk_description == null ? null : String(r.risk_description),
      testObjective: r.test_objective == null ? null : String(r.test_objective),
      testingSteps: r.testing_steps == null ? null : String(r.testing_steps),
    }));
  });
}

/** One sub-area's template, for the auto-populate on selection. */
export async function getSubAreaTemplate(
  db: Client,
  organizationId: string,
  subAreaId: string,
): Promise<SubAreaTemplate | null> {
  const all = await listSubAreas(db, organizationId);
  return all.find((sa) => sa.id === subAreaId) ?? null;
}
