/**
 * The scoped report aggregation, ported from the source getComprehensiveReportData.
 * It returns, for the acting organisation, the work papers (observations) and the
 * action plans joined with their affiliate and audit-area names and a derived
 * response status. The heavy filters (year, date range, affiliate, audit area and
 * work-paper status) are applied server-side, and the role scope is enforced here,
 * not in the UI: an all-observation or board role sees the organisation's data,
 * while a UNIT_MANAGER is limited to their own affiliate and to observations and
 * action plans assigned to them. Every query is scoped by organization_id, so it
 * never returns another organisation's data.
 *
 * Column names follow grc/docs/schema-assumptions.md.
 */
import type { Client } from '@libsql/client/web';
import type {
  ActionPlan,
  Observation,
  ReportDataset,
  ReportFilters,
} from '@grc/reports/reportTypes';
import { isUnitManagerScope } from '@grc/reports/reportModel';

export interface ReportViewer {
  userId: string;
  roleCode: string;
  isPlatformOwner: boolean;
}

const s = (v: unknown): string | null => (v == null ? null : String(v));
const n = (v: unknown): number | null => (v == null ? null : Number(v));

/**
 * The UNIT_MANAGER's own affiliate, read defensively: users.affiliate_code is a
 * documented assumption, so a schema without it simply yields null and the
 * manager is then scoped by assignment alone.
 */
export async function resolveUserAffiliate(
  db: Client,
  organizationId: string,
  userId: string,
): Promise<string | null> {
  try {
    const res = await db.execute({
      sql: `SELECT affiliate_code FROM users WHERE user_id = ? AND organization_id = ? LIMIT 1`,
      args: [userId, organizationId],
    });
    return s(res.rows[0]?.affiliate_code);
  } catch {
    return null;
  }
}

/** Derive the auditee response state shown against an observation. */
function responseStatus(status: string, managementResponse: string | null): string {
  if (status === 'Response Received' || status === 'Response Reviewed') return 'Responded';
  if (managementResponse && managementResponse.trim() !== '') return 'Responded';
  if (status === 'Sent to Auditee') return 'Awaiting response';
  return 'Not sent';
}

// Build the shared work-paper filter clause (on the `wp` alias) and its args.
function workPaperFilters(filters: ReportFilters): { clause: string; args: (string | number)[] } {
  const parts: string[] = [];
  const args: (string | number)[] = [];
  if (filters.year != null) {
    parts.push('wp.year = ?');
    args.push(filters.year);
  }
  parts.push('(wp.work_paper_date IS NULL OR date(wp.work_paper_date) BETWEEN ? AND ?)');
  args.push(filters.dateFrom, filters.dateTo);
  if (filters.affiliateCode) {
    parts.push('wp.affiliate_code = ?');
    args.push(filters.affiliateCode);
  }
  if (filters.auditAreaId) {
    parts.push('wp.audit_area_id = ?');
    args.push(filters.auditAreaId);
  }
  if (filters.statuses.length > 0) {
    parts.push(`wp.status IN (${filters.statuses.map(() => '?').join(', ')})`);
    args.push(...filters.statuses);
  } else {
    // No status selected means no observations.
    parts.push('1 = 0');
  }
  return { clause: parts.length ? ` AND ${parts.join(' AND ')}` : '', args };
}

/**
 * The scoped dataset for the report. `unitAffiliate` is the UNIT_MANAGER's own
 * affiliate (from resolveUserAffiliate); it is ignored for other roles.
 */
export async function getComprehensiveReportData(
  db: Client,
  organizationId: string,
  viewer: ReportViewer,
  filters: ReportFilters,
  unitAffiliate: string | null,
): Promise<ReportDataset> {
  const unitScope = isUnitManagerScope(viewer.roleCode, viewer.isPlatformOwner);
  const wp = workPaperFilters(filters);

  // ---- Observations ----
  const obsArgs: (string | number)[] = [organizationId, ...wp.args];
  let obsWhere = 'wp.organization_id = ?' + wp.clause;
  if (unitScope) {
    obsWhere +=
      ' AND (wp.assigned_auditor_id = ? OR EXISTS (SELECT 1 FROM work_paper_responsibles r' +
      ' WHERE r.work_paper_id = wp.work_paper_id AND r.user_id = ?))';
    obsArgs.push(viewer.userId, viewer.userId);
    if (unitAffiliate) {
      obsWhere += ' AND wp.affiliate_code = ?';
      obsArgs.push(unitAffiliate);
    }
  }

  const obsRes = await db.execute({
    sql: `SELECT wp.work_paper_id AS id, wp.work_paper_ref AS reference, wp.risk_rating AS risk_rating,
                 wp.observation_title AS title, wp.observation_description AS description,
                 wp.affiliate_code AS affiliate_code, aff.affiliate_name AS affiliate_name,
                 aa.area_name AS audit_area_name, wp.status AS status, wp.recommendation AS recommendation,
                 wp.management_response AS management_response, wp.work_paper_date AS work_paper_date,
                 wp.year AS year
            FROM work_papers wp
            LEFT JOIN affiliates aff ON aff.affiliate_code = wp.affiliate_code
                 AND aff.organization_id = wp.organization_id
            LEFT JOIN audit_areas aa ON aa.audit_area_id = wp.audit_area_id
           WHERE ${obsWhere}
        ORDER BY wp.work_paper_date DESC, wp.work_paper_ref DESC
           LIMIT 2000`,
    args: obsArgs,
  });
  const observations: Observation[] = obsRes.rows.map((r) => {
    const status = String(r.status);
    return {
      id: String(r.id),
      reference: String(r.reference ?? r.id),
      riskRating: s(r.risk_rating),
      observationTitle: String(r.title ?? ''),
      observationDescription: s(r.description),
      affiliateCode: s(r.affiliate_code),
      affiliateName: s(r.affiliate_name),
      auditAreaName: s(r.audit_area_name),
      status,
      responseStatus: responseStatus(status, s(r.management_response)),
      recommendation: s(r.recommendation),
      workPaperDate: s(r.work_paper_date),
      year: n(r.year),
    };
  });

  // ---- Action plans (joined to their observation for context) ----
  const apArgs: (string | number)[] = [organizationId, ...wp.args];
  let apWhere = 'ap.organization_id = ?' + wp.clause;
  if (unitScope) {
    apWhere += " AND (',' || IFNULL(ap.owner_ids, '') || ',') LIKE ?";
    apArgs.push(`%,${viewer.userId},%`);
    if (unitAffiliate) {
      apWhere += ' AND wp.affiliate_code = ?';
      apArgs.push(unitAffiliate);
    }
  }

  const apRes = await db.execute({
    sql: `SELECT ap.action_plan_id AS id, ap.action_number AS action_number,
                 ap.work_paper_id AS work_paper_id, ap.action_description AS description,
                 ap.owner_names AS owner_names, ap.due_date AS due_date, ap.status AS status,
                 ap.implementation_notes AS implementation_notes,
                 wp.observation_title AS obs_title, wp.work_paper_ref AS obs_reference,
                 wp.risk_rating AS obs_risk, wp.status AS obs_status,
                 aff.affiliate_name AS obs_affiliate, aa.area_name AS obs_audit_area
            FROM action_plans ap
            JOIN work_papers wp ON wp.work_paper_id = ap.work_paper_id
                 AND wp.organization_id = ap.organization_id
            LEFT JOIN affiliates aff ON aff.affiliate_code = wp.affiliate_code
                 AND aff.organization_id = wp.organization_id
            LEFT JOIN audit_areas aa ON aa.audit_area_id = wp.audit_area_id
           WHERE ${apWhere}
        ORDER BY ap.due_date IS NULL, ap.due_date ASC
           LIMIT 4000`,
    args: apArgs,
  });
  const actionPlans: ActionPlan[] = apRes.rows.map((r) => ({
    id: String(r.id),
    actionNumber: String(r.action_number ?? r.id),
    workPaperId: s(r.work_paper_id),
    description: String(r.description ?? ''),
    ownerNames: s(r.owner_names),
    dueDate: s(r.due_date),
    status: String(r.status),
    implementationNotes: s(r.implementation_notes),
    observationTitle: s(r.obs_title),
    observationReference: s(r.obs_reference),
    observationRisk: s(r.obs_risk),
    observationAffiliate: s(r.obs_affiliate),
    observationAuditArea: s(r.obs_audit_area),
    observationStatus: s(r.obs_status),
  }));

  return { observations, actionPlans };
}
