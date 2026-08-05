/**
 * Action plans: remediation and follow-up of findings, ported from the source
 * ActionPlanService. Every read and write is scoped by the acting
 * organization_id, and the list applies the source's role-based visibility.
 * Statuses are data-driven; this module stores fields and reads, never deciding
 * workflow validity (that is the engine's job in workflow/).
 *
 * Column names come from the typed schema layer (@grc/schema/columns).
 */
import type { Client, InArgs } from '@libsql/client/web';
import { C, cols } from '@grc/schema/columns';
import {
  PENDING_SET,
  IMPLEMENTED_SET,
  VERIFIED_SET,
  BOARD_VISIBLE_SET,
  OVERDUE_EXCLUDE_SET,
  AP_STATUS,
} from '@grc/workflow/actionPlanActions';

const AP = cols(C.action_plans);

// The form input and the priority vocabulary live in an import-free module so
// node can unit-test them; they are re-exported here so callers keep one import.
export {
  PRIORITIES,
  parseActionPlanInput,
  checkActionPlanInput,
  type ActionPlanInput,
} from '@grc/repos/actionPlanInput';
import type { ActionPlanInput } from '@grc/repos/actionPlanInput';

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
  targetDate: string | null;
  priority: string | null;
  affiliateCode: string | null;
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
  /** The audit area of the linked work paper, for the dashboard drill-through. */
  auditAreaId?: string;
  /** The year of the linked work paper, for the dashboard drill-through. */
  year?: string;
  /** The plan's own affiliate (a plan carries its affiliate_code). */
  affiliateCode?: string;
  priority?: string;
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
  // Area and year live on the linked work paper (a plan has neither of its own).
  if (filters.auditAreaId) {
    where += ' AND wp.audit_area_id = ?';
    args.push(filters.auditAreaId);
  }
  if (filters.year) {
    where += ' AND wp.year = ?';
    args.push(Number(filters.year));
  }
  if (filters.affiliateCode) {
    where += ` AND ap.${AP.affiliate_code} = ?`;
    args.push(filters.affiliateCode);
  }
  if (filters.priority) {
    where += ` AND ap.${AP.priority} = ?`;
    args.push(filters.priority);
  }

  const res = await db.execute({
    sql: `SELECT ap.${AP.action_plan_id} AS id, ap.${AP.action_number} AS action_number,
                 ap.${AP.action_description} AS description, ap.${AP.work_paper_id} AS work_paper_id,
                 wp.work_paper_ref AS wp_reference, wp.risk_rating AS risk_rating,
                 ap.${AP.owner_ids} AS owner_ids, ap.${AP.owner_names} AS owner_names,
                 ap.${AP.due_date} AS due_date, ap.${AP.target_date} AS target_date,
                 ap.${AP.priority} AS priority, ap.${AP.affiliate_code} AS affiliate_code,
                 ap.${AP.status} AS status,
                 ap.${AP.days_overdue} AS days_overdue, ap.${AP.auditee_proposed} AS auditee_proposed
            FROM action_plans ap
            LEFT JOIN work_papers wp ON wp.work_paper_id = ap.${AP.work_paper_id}
                 AND wp.organization_id = ap.${AP.organization_id}
           WHERE ${where}
        ORDER BY ap.${AP.due_date} IS NULL, ap.${AP.due_date} ASC, ap.${AP.action_number} ASC
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
    targetDate: s(r.target_date),
    priority: s(r.priority),
    affiliateCode: s(r.affiliate_code),
    status: String(r.status),
    daysOverdue: Number(r.days_overdue ?? 0),
    daysUntilDue: daysUntil(s(r.due_date)),
    auditeeProposed: Number(r.auditee_proposed ?? 0) === 1,
  }));
}

export interface OrphanActionPlan {
  id: string;
  actionNumber: string;
  description: string;
  status: string;
}

/**
 * Plans with no parent finding. The forms and endpoints now require the
 * linkage, so these are strays from before the rule; they are surfaced to
 * auditors so each can be linked through its edit screen rather than stranded
 * outside every drill-down and report.
 */
export async function listOrphanActionPlans(
  db: Client,
  organizationId: string,
): Promise<OrphanActionPlan[]> {
  const res = await db.execute({
    sql: `SELECT ${AP.action_plan_id} AS id, ${AP.action_number} AS action_number,
                 ${AP.action_description} AS description, ${AP.status} AS status
            FROM action_plans
           WHERE ${AP.organization_id} = ? AND ${AP.deleted_at} IS NULL
             AND (${AP.work_paper_id} IS NULL OR ${AP.work_paper_id} = '')
        ORDER BY ${AP.action_number} ASC
           LIMIT 100`,
    args: [organizationId],
  });
  return res.rows.map((r) => ({
    id: String(r.id),
    actionNumber: String(r.action_number ?? r.id),
    description: String(r.description ?? ''),
    status: String(r.status ?? ''),
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
    sql: `SELECT ap.*, wp.work_paper_ref AS wp_reference, wp.risk_rating AS risk_rating,
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
    sql: `SELECT work_paper_id AS id, work_paper_ref AS reference, observation_title AS title
            FROM work_papers WHERE organization_id = ?
        ORDER BY work_paper_ref DESC, observation_title
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
  // The human reference is action_ref; action_number is the sequential number.
  // We stamp the generated reference into both so it shows regardless of which
  // column the operator's schema populates, and reads COALESCE(action_ref,
  // action_number) elsewhere.
  const reference = `AP-${new Date().getUTCFullYear()}-${id.replace(/-/g, '').slice(0, 6).toUpperCase()}`;
  await db.execute({
    sql: `INSERT INTO action_plans
            (${AP.action_plan_id}, ${AP.organization_id}, ${AP.action_ref}, ${AP.action_number},
             ${AP.work_paper_id}, ${AP.action_description}, ${AP.target_date}, ${AP.due_date},
             ${AP.priority}, ${AP.implementation_notes}, ${AP.affiliate_code}, ${AP.status},
             ${AP.days_overdue}, ${AP.owner_ids}, ${AP.owner_names}, ${AP.auditee_proposed},
             ${AP.created_by}, ${AP.created_at}, ${AP.updated_at})
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                  (SELECT wp.affiliate_code FROM work_papers wp
                    WHERE wp.work_paper_id = ? AND wp.organization_id = ?),
                  ?, 0, '', '', ?, ?, ?, ?)`,
    args: [
      id,
      organizationId,
      reference,
      reference,
      input.workPaperId,
      input.actionDescription,
      input.targetDate,
      input.dueDate,
      input.priority,
      input.implementationNotes,
      // The plan inherits the finding's affiliate, so the affiliate filter and
      // the affiliate-scoped reports see it without a second write.
      input.workPaperId,
      organizationId,
      status,
      auditeeProposed ? 1 : 0,
      userId,
      now,
      now,
    ],
  });
  return id;
}

/** Edit the writable fields (owners are set through setOwners). */
export async function updateActionPlan(
  db: Client,
  organizationId: string,
  id: string,
  input: ActionPlanInput,
): Promise<void> {
  await db.execute({
    sql: `UPDATE action_plans
             SET ${AP.action_description} = ?, ${AP.target_date} = ?, ${AP.due_date} = ?,
                 ${AP.priority} = ?, ${AP.implementation_notes} = ?,
                 ${AP.work_paper_id} = ?, ${AP.updated_at} = ?
           WHERE ${AP.action_plan_id} = ? AND ${AP.organization_id} = ?`,
    args: [
      input.actionDescription,
      input.targetDate,
      input.dueDate,
      input.priority,
      input.implementationNotes,
      input.workPaperId,
      new Date().toISOString(),
      id,
      organizationId,
    ],
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
