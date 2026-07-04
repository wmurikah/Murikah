/**
 * Action plans: remediation and follow-up of findings, ported from the source
 * ActionPlanService. Every read and write is scoped by the acting
 * organization_id, and the list applies the source's role-based visibility.
 * Statuses are data-driven; this module stores fields and reads, never deciding
 * workflow validity (that is the engine's job in workflow/).
 *
 * Column names follow the operator's schema patch (grc/docs/schema-assumptions.md).
 */
import type { Client, InArgs } from '@libsql/client/web';
import {
  PENDING_SET,
  IMPLEMENTED_SET,
  VERIFIED_SET,
  BOARD_VISIBLE_SET,
  OVERDUE_EXCLUDE_SET,
  AP_STATUS,
} from '@grc/workflow/actionPlanActions';

export interface ActionPlanListRow {
  id: string;
  actionNumber: string;
  description: string;
  workPaperId: string | null;
  workPaperReference: string | null;
  riskRating: string | null;
  ownerIds: string | null;
  ownerNames: string | null;
  dueDate: string | null;
  status: string;
  daysOverdue: number;
  daysUntilDue: number | null;
  auditeeProposed: boolean;
}

export interface ActionPlanFilters {
  status?: string;
  ownerId?: string;
  overdueOnly?: boolean;
  q?: string;
}

/** The viewer, for the role-based list visibility. */
export interface Viewer {
  userId: string;
  roleCode: string;
  perms: string[];
  isPlatformOwner: boolean;
}

const s = (v: unknown): string | null => (v == null ? null : String(v));
const daysUntil = (due: string | null): number | null =>
  due ? Math.floor((Date.parse(due) - Date.now()) / 86400000) : null;

function isAuditorViewer(v: Viewer): boolean {
  return (
    v.isPlatformOwner ||
    v.perms.includes('ACTION_PLANS.verify') ||
    v.perms.includes('ACTION_PLANS.edit') ||
    v.perms.includes('ACTION_PLANS.close')
  );
}
function isBoardViewer(v: Viewer): boolean {
  return v.roleCode === 'BOARD_MEMBER' || v.roleCode === 'EXTERNAL_AUDITOR';
}

export async function listActionPlans(
  db: Client,
  organizationId: string,
  viewer: Viewer,
  filters: ActionPlanFilters = {},
): Promise<ActionPlanListRow[]> {
  const args: InArgs = [organizationId];
  let where = 'ap.organization_id = ?';

  // Role-based visibility: a board or external role sees only completed-side
  // plans; a non-auditor sees only plans they own; an auditor sees all.
  if (isBoardViewer(viewer)) {
    where += ` AND ap.status IN (${BOARD_VISIBLE_SET.map(() => '?').join(', ')})`;
    args.push(...BOARD_VISIBLE_SET);
  } else if (!isAuditorViewer(viewer)) {
    where += " AND (',' || ap.owner_ids || ',') LIKE ?";
    args.push(`%,${viewer.userId},%`);
  }

  if (filters.status) {
    where += ' AND ap.status = ?';
    args.push(filters.status);
  }
  if (filters.ownerId) {
    where += " AND (',' || ap.owner_ids || ',') LIKE ?";
    args.push(`%,${filters.ownerId},%`);
  }
  if (filters.overdueOnly) {
    where += ` AND ap.days_overdue > 0 AND ap.status NOT IN (${OVERDUE_EXCLUDE_SET.map(() => '?').join(', ')})`;
    args.push(...OVERDUE_EXCLUDE_SET);
  }
  if (filters.q && filters.q.trim() !== '') {
    where += ' AND (ap.action_description LIKE ? OR ap.implementation_notes LIKE ?)';
    const like = `%${filters.q.trim()}%`;
    args.push(like, like);
  }

  const res = await db.execute({
    sql: `SELECT ap.action_plan_id AS id, ap.action_number AS action_number,
                 ap.action_description AS description, ap.work_paper_id AS work_paper_id,
                 wp.reference AS wp_reference, wp.risk_rating AS risk_rating,
                 ap.owner_ids AS owner_ids, ap.owner_names AS owner_names,
                 ap.due_date AS due_date, ap.status AS status,
                 ap.days_overdue AS days_overdue, ap.auditee_proposed AS auditee_proposed
            FROM action_plans ap
            LEFT JOIN work_papers wp ON wp.work_paper_id = ap.work_paper_id
                 AND wp.organization_id = ap.organization_id
           WHERE ${where}
        ORDER BY ap.due_date IS NULL, ap.due_date ASC, ap.action_number ASC
           LIMIT 500`,
    args,
  });
  return res.rows.map((r) => ({
    id: String(r.id),
    actionNumber: String(r.action_number ?? r.id),
    description: String(r.description ?? ''),
    workPaperId: s(r.work_paper_id),
    workPaperReference: s(r.wp_reference),
    riskRating: s(r.risk_rating),
    ownerIds: s(r.owner_ids),
    ownerNames: s(r.owner_names),
    dueDate: s(r.due_date),
    status: String(r.status),
    daysOverdue: Number(r.days_overdue ?? 0),
    daysUntilDue: daysUntil(s(r.due_date)),
    auditeeProposed: Number(r.auditee_proposed ?? 0) === 1,
  }));
}

export interface ActionPlanStats {
  total: number;
  pending: number;
  overdue: number;
  implemented: number;
  verified: number;
}

/** Compute the stats bar from the visible rows, using the shared status sets. */
export function computeStats(rows: ActionPlanListRow[]): ActionPlanStats {
  const stats: ActionPlanStats = {
    total: rows.length,
    pending: 0,
    overdue: 0,
    implemented: 0,
    verified: 0,
  };
  for (const r of rows) {
    if (PENDING_SET.includes(r.status)) stats.pending++;
    if (r.daysOverdue > 0 && !OVERDUE_EXCLUDE_SET.includes(r.status)) stats.overdue++;
    if (IMPLEMENTED_SET.includes(r.status)) stats.implemented++;
    if (VERIFIED_SET.includes(r.status)) stats.verified++;
  }
  return stats;
}

export type ActionPlanDetail = Record<string, unknown> & {
  id: string;
  actionNumber: string;
  status: string;
  ownerIds: string | null;
};

export async function getActionPlan(
  db: Client,
  organizationId: string,
  id: string,
): Promise<ActionPlanDetail | null> {
  const res = await db.execute({
    sql: `SELECT ap.*, wp.reference AS wp_reference, wp.risk_rating AS risk_rating,
                 wp.observation_title AS observation_title, wp.affiliate_code AS affiliate_code,
                 wp.observation_description AS observation_description
            FROM action_plans ap
            LEFT JOIN work_papers wp ON wp.work_paper_id = ap.work_paper_id
                 AND wp.organization_id = ap.organization_id
           WHERE ap.action_plan_id = ? AND ap.organization_id = ?
           LIMIT 1`,
    args: [id, organizationId],
  });
  const row = res.rows[0];
  if (!row) return null;
  const detail = { ...row } as Record<string, unknown>;
  detail.id = String(row.action_plan_id);
  detail.actionNumber = String(row.action_number ?? row.action_plan_id);
  detail.status = String(row.status);
  detail.ownerIds = row.owner_ids == null ? null : String(row.owner_ids);
  detail.daysUntilDue = daysUntil(s(row.due_date));
  return detail as ActionPlanDetail;
}

/** Work papers, offered as the finding a plan attaches to (id and a readable label). */
export interface WorkPaperOption {
  id: string;
  label: string;
}

export async function listWorkPaperOptions(
  db: Client,
  organizationId: string,
): Promise<WorkPaperOption[]> {
  const res = await db.execute({
    sql: `SELECT work_paper_id AS id, reference, observation_title AS title
            FROM work_papers WHERE organization_id = ?
        ORDER BY reference DESC, observation_title
           LIMIT 500`,
    args: [organizationId],
  });
  return res.rows.map((r) => {
    const ref = r.reference == null ? '' : String(r.reference);
    const title = r.title == null ? '' : String(r.title);
    const label = [ref, title].filter(Boolean).join(' - ') || String(r.id);
    return { id: String(r.id), label };
  });
}

export interface ActionPlanInput {
  workPaperId: string | null;
  actionDescription: string;
  dueDate: string | null;
}

/** Create a plan, at Pending (or Not Due when the due date is still ahead). */
export async function createActionPlan(
  db: Client,
  organizationId: string,
  userId: string,
  input: ActionPlanInput,
  auditeeProposed: boolean,
): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const status =
    input.dueDate && Date.parse(input.dueDate) > Date.now() ? AP_STATUS.NOT_DUE : AP_STATUS.PENDING;
  const actionNumber = `AP-${new Date().getUTCFullYear()}-${id.replace(/-/g, '').slice(0, 6).toUpperCase()}`;
  await db.execute({
    sql: `INSERT INTO action_plans
            (action_plan_id, organization_id, action_number, work_paper_id, action_description,
             due_date, status, days_overdue, owner_ids, owner_names, auditee_proposed,
             created_by, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 0, '', '', ?, ?, ?, ?)`,
    args: [
      id,
      organizationId,
      actionNumber,
      input.workPaperId,
      input.actionDescription,
      input.dueDate,
      status,
      auditeeProposed ? 1 : 0,
      userId,
      now,
      now,
    ],
  });
  return id;
}

/** Edit the description and due date (owners are set through setOwners). */
export async function updateActionPlan(
  db: Client,
  organizationId: string,
  id: string,
  input: ActionPlanInput,
): Promise<void> {
  await db.execute({
    sql: `UPDATE action_plans SET action_description = ?, due_date = ?, updated_at = ?
           WHERE action_plan_id = ? AND organization_id = ?`,
    args: [input.actionDescription, input.dueDate, new Date().toISOString(), id, organizationId],
  });
}

export async function deleteActionPlan(
  db: Client,
  organizationId: string,
  id: string,
): Promise<void> {
  await db.execute({
    sql: `DELETE FROM action_plans WHERE action_plan_id = ? AND organization_id = ?`,
    args: [id, organizationId],
  });
}
