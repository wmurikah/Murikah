/**
 * The audit universe for the Setup module: audit areas and, nested under each,
 * sub-areas that carry the template fields the work-paper form auto-populates.
 * Every read and write is scoped to the acting organization_id; column names come
 * from the typed schema layer. Areas and sub-areas soft-delete via deleted_at,
 * and deletion is guarded: an area with sub-areas or referencing work papers, and
 * a sub-area referenced by a work paper, cannot be deleted (deactivate instead).
 */
import type { Client } from '@libsql/client/web';
import { C, cols } from '@grc/schema/columns';

const AA = cols(C.audit_areas);
const SA = cols(C.sub_areas);
const WP = cols(C.work_papers);

const s = (v: unknown): string | null => (v == null ? null : String(v));

export interface AuditArea {
  id: string;
  code: string | null;
  name: string;
  description: string | null;
  isActive: boolean;
  subAreaCount: number;
}

export interface AuditAreaInput {
  code: string | null;
  name: string;
  description: string | null;
}

export interface SubArea {
  id: string;
  auditAreaId: string;
  name: string;
  controlObjectives: string | null;
  riskDescription: string | null;
  testObjective: string | null;
  testingSteps: string | null;
  isActive: boolean;
}

export interface SubAreaInput {
  name: string;
  controlObjectives: string | null;
  riskDescription: string | null;
  testObjective: string | null;
  testingSteps: string | null;
}

// ---- Audit areas -----------------------------------------------------------

export async function listAuditAreas(db: Client, organizationId: string): Promise<AuditArea[]> {
  const res = await db.execute({
    sql: `SELECT aa.${C.audit_areas.audit_area_id} AS id, aa.${C.audit_areas.area_code} AS code,
                 aa.${C.audit_areas.area_name} AS name, aa.${C.audit_areas.description} AS description,
                 aa.${C.audit_areas.is_active} AS is_active,
                 (SELECT COUNT(*) FROM sub_areas sa
                   WHERE sa.${C.sub_areas.audit_area_id} = aa.${C.audit_areas.audit_area_id}
                     AND sa.${C.sub_areas.deleted_at} IS NULL) AS sub_count
            FROM audit_areas aa
           WHERE aa.${C.audit_areas.organization_id} = ? AND aa.${C.audit_areas.deleted_at} IS NULL
        ORDER BY aa.${C.audit_areas.is_active} DESC, aa.${C.audit_areas.area_name}`,
    args: [organizationId],
  });
  return res.rows.map((r) => ({
    id: String(r.id),
    code: s(r.code),
    name: String(r.name ?? r.id),
    description: s(r.description),
    isActive: Number(r.is_active ?? 0) === 1,
    subAreaCount: Number(r.sub_count ?? 0),
  }));
}

export async function createAuditArea(
  db: Client,
  organizationId: string,
  input: AuditAreaInput,
): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.execute({
    sql: `INSERT INTO audit_areas
            (${AA.audit_area_id}, ${AA.organization_id}, ${AA.area_code}, ${AA.area_name},
             ${AA.description}, ${AA.is_active}, ${AA.created_at}, ${AA.updated_at})
          VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
    args: [id, organizationId, input.code, input.name, input.description, now, now],
  });
  return id;
}

export async function updateAuditArea(
  db: Client,
  organizationId: string,
  id: string,
  input: AuditAreaInput,
): Promise<void> {
  await db.execute({
    sql: `UPDATE audit_areas
             SET ${AA.area_code} = ?, ${AA.area_name} = ?, ${AA.description} = ?, ${AA.updated_at} = ?
           WHERE ${AA.organization_id} = ? AND ${AA.audit_area_id} = ?`,
    args: [input.code, input.name, input.description, new Date().toISOString(), organizationId, id],
  });
}

export async function setAuditAreaActive(
  db: Client,
  organizationId: string,
  id: string,
  active: boolean,
): Promise<void> {
  await db.execute({
    sql: `UPDATE audit_areas SET ${AA.is_active} = ?, ${AA.updated_at} = ?
           WHERE ${AA.organization_id} = ? AND ${AA.audit_area_id} = ?`,
    args: [active ? 1 : 0, new Date().toISOString(), organizationId, id],
  });
}

/** Whether an area still has sub-areas, or is referenced by a work paper. */
export async function auditAreaBlockers(
  db: Client,
  organizationId: string,
  id: string,
): Promise<{ hasSubAreas: boolean; inUse: boolean }> {
  const [subs, wps] = await Promise.all([
    db.execute({
      sql: `SELECT 1 FROM sub_areas
             WHERE ${SA.organization_id} = ? AND ${SA.audit_area_id} = ? AND ${SA.deleted_at} IS NULL LIMIT 1`,
      args: [organizationId, id],
    }),
    db.execute({
      sql: `SELECT 1 FROM work_papers
             WHERE ${WP.organization_id} = ? AND ${WP.audit_area_id} = ? AND ${WP.deleted_at} IS NULL LIMIT 1`,
      args: [organizationId, id],
    }),
  ]);
  return { hasSubAreas: subs.rows.length > 0, inUse: wps.rows.length > 0 };
}

export async function deleteAuditArea(
  db: Client,
  organizationId: string,
  id: string,
): Promise<void> {
  const now = new Date().toISOString();
  await db.execute({
    sql: `UPDATE audit_areas SET ${AA.deleted_at} = ?, ${AA.is_active} = 0, ${AA.updated_at} = ?
           WHERE ${AA.organization_id} = ? AND ${AA.audit_area_id} = ?`,
    args: [now, now, organizationId, id],
  });
}

// ---- Sub-areas -------------------------------------------------------------

export async function listSubAreas(
  db: Client,
  organizationId: string,
  auditAreaId: string,
): Promise<SubArea[]> {
  const res = await db.execute({
    sql: `SELECT ${SA.sub_area_id} AS id, ${SA.audit_area_id} AS audit_area_id,
                 ${SA.sub_area_name} AS name, ${SA.control_objectives} AS control_objectives,
                 ${SA.risk_description} AS risk_description, ${SA.test_objective} AS test_objective,
                 ${SA.testing_steps} AS testing_steps, ${SA.is_active} AS is_active
            FROM sub_areas
           WHERE ${SA.organization_id} = ? AND ${SA.audit_area_id} = ? AND ${SA.deleted_at} IS NULL
        ORDER BY ${SA.is_active} DESC, ${SA.sub_area_name}`,
    args: [organizationId, auditAreaId],
  });
  return res.rows.map((r) => ({
    id: String(r.id),
    auditAreaId: String(r.audit_area_id),
    name: String(r.name ?? r.id),
    controlObjectives: s(r.control_objectives),
    riskDescription: s(r.risk_description),
    testObjective: s(r.test_objective),
    testingSteps: s(r.testing_steps),
    isActive: Number(r.is_active ?? 0) === 1,
  }));
}

export async function createSubArea(
  db: Client,
  organizationId: string,
  auditAreaId: string,
  input: SubAreaInput,
): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.execute({
    sql: `INSERT INTO sub_areas
            (${SA.sub_area_id}, ${SA.audit_area_id}, ${SA.organization_id}, ${SA.sub_area_name},
             ${SA.control_objectives}, ${SA.risk_description}, ${SA.test_objective}, ${SA.testing_steps},
             ${SA.is_active}, ${SA.created_at}, ${SA.updated_at})
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    args: [
      id,
      auditAreaId,
      organizationId,
      input.name,
      input.controlObjectives,
      input.riskDescription,
      input.testObjective,
      input.testingSteps,
      now,
      now,
    ],
  });
  return id;
}

export async function updateSubArea(
  db: Client,
  organizationId: string,
  id: string,
  input: SubAreaInput,
): Promise<void> {
  await db.execute({
    sql: `UPDATE sub_areas
             SET ${SA.sub_area_name} = ?, ${SA.control_objectives} = ?, ${SA.risk_description} = ?,
                 ${SA.test_objective} = ?, ${SA.testing_steps} = ?, ${SA.updated_at} = ?
           WHERE ${SA.organization_id} = ? AND ${SA.sub_area_id} = ?`,
    args: [
      input.name,
      input.controlObjectives,
      input.riskDescription,
      input.testObjective,
      input.testingSteps,
      new Date().toISOString(),
      organizationId,
      id,
    ],
  });
}

export async function setSubAreaActive(
  db: Client,
  organizationId: string,
  id: string,
  active: boolean,
): Promise<void> {
  await db.execute({
    sql: `UPDATE sub_areas SET ${SA.is_active} = ?, ${SA.updated_at} = ?
           WHERE ${SA.organization_id} = ? AND ${SA.sub_area_id} = ?`,
    args: [active ? 1 : 0, new Date().toISOString(), organizationId, id],
  });
}

export async function subAreaInUse(
  db: Client,
  organizationId: string,
  id: string,
): Promise<boolean> {
  const res = await db.execute({
    sql: `SELECT 1 FROM work_papers
           WHERE ${WP.organization_id} = ? AND ${WP.sub_area_id} = ? AND ${WP.deleted_at} IS NULL LIMIT 1`,
    args: [organizationId, id],
  });
  return res.rows.length > 0;
}

export async function deleteSubArea(db: Client, organizationId: string, id: string): Promise<void> {
  const now = new Date().toISOString();
  await db.execute({
    sql: `UPDATE sub_areas SET ${SA.deleted_at} = ?, ${SA.is_active} = 0, ${SA.updated_at} = ?
           WHERE ${SA.organization_id} = ? AND ${SA.sub_area_id} = ?`,
    args: [now, now, organizationId, id],
  });
}
