/**
 * Work papers: the core repository, ported from the source WorkPaperService.
 * Every read and write is scoped by the acting organization_id. Statuses are the
 * data-driven enum values; this module never decides workflow validity (that is
 * the engine's job in workflow/) and only stores the writable fields.
 *
 * The external-content full-text index `work_papers_fts` over observation_title,
 * observation_description and recommendation is maintained here on create, edit
 * and delete, and drives the list search. Column names follow the hassaudit
 * schema (grc/docs/schema-assumptions.md).
 *
 * The list reads are not cached: a work paper is exactly the kind of row a user
 * acts on, and its state must be current. Only the counts derived from it are,
 * on a short window, so each mutation here clears the organisation's dashboard
 * aggregations before it returns (Build Prompt 42).
 */
import type { Client, InArgs } from '@libsql/client/web';
import { invalidateDashboard } from '@grc/cache/invalidate';
import {
  restrictToOwnFindings,
  seesForeignDrafts,
  type WorkPaperViewer,
} from './workPaperVisibility';
import { WP_STATUS } from '../workflow/workPaperActions';
import {
  affiliatePredicate,
  affiliateVisible,
  UNCONFINED,
  type AffiliateScope,
} from '@grc/auth/affiliateScope';
import { C, cols } from '@grc/schema/columns';

const WPC = cols(C.work_papers);

export interface WorkPaperListRow {
  id: string;
  reference: string;
  observationTitle: string;
  affiliateCode: string | null;
  affiliateName: string | null;
  auditAreaId: string | null;
  auditAreaName: string | null;
  riskRating: string | null;
  assignedAuditorId: string | null;
  assignedAuditorName: string | null;
  status: string;
  year: number | null;
  updatedAt: string | null;
}

export interface WorkPaperFilters {
  status?: string;
  auditAreaId?: string;
  affiliateCode?: string;
  assignedAuditorId?: string;
  year?: string;
  riskRating?: string;
  /** Full-text query over the observation and recommendation. */
  q?: string;
}

// The writable fields captured by the create/edit form (section 1). Attribution,
// status and revision_count are managed by the workflow, not the form.
export interface WorkPaperInput {
  year: number | null;
  affiliateCode: string | null;
  auditAreaId: string | null;
  subAreaId: string | null;
  workPaperDate: string | null;
  auditPeriodFrom: string | null;
  auditPeriodTo: string | null;
  controlObjectives: string | null;
  classification: string | null;
  controlType: string | null;
  controlFrequency: string | null;
  standards: string | null;
  riskDescription: string | null;
  testObjective: string | null;
  testingSteps: string | null;
  observationTitle: string;
  observationDescription: string | null;
  riskRating: string | null;
  riskSummary: string | null;
  recommendation: string | null;
  managementResponse: string | null;
  assignedAuditorId: string | null;
}

// The column list for the writable fields, paired with an input key, so create
// and update share one source of truth.
const FIELDS: { col: string; key: keyof WorkPaperInput }[] = [
  { col: 'year', key: 'year' },
  { col: 'affiliate_code', key: 'affiliateCode' },
  { col: 'audit_area_id', key: 'auditAreaId' },
  { col: 'sub_area_id', key: 'subAreaId' },
  { col: 'work_paper_date', key: 'workPaperDate' },
  { col: 'audit_period_from', key: 'auditPeriodFrom' },
  { col: 'audit_period_to', key: 'auditPeriodTo' },
  { col: 'control_objectives', key: 'controlObjectives' },
  { col: 'control_classification', key: 'classification' },
  { col: 'control_type', key: 'controlType' },
  { col: 'control_frequency', key: 'controlFrequency' },
  { col: 'control_standards', key: 'standards' },
  { col: 'risk_description', key: 'riskDescription' },
  { col: 'test_objective', key: 'testObjective' },
  { col: 'testing_steps', key: 'testingSteps' },
  { col: 'observation_title', key: 'observationTitle' },
  { col: 'observation_description', key: 'observationDescription' },
  { col: 'risk_rating', key: 'riskRating' },
  { col: 'risk_summary', key: 'riskSummary' },
  { col: 'recommendation', key: 'recommendation' },
  { col: 'management_response', key: 'managementResponse' },
  { col: 'assigned_auditor_id', key: 'assignedAuditorId' },
];

const s = (v: unknown): string | null => (v == null ? null : String(v));
const n = (v: unknown): number | null => (v == null ? null : Number(v));

/** Parse a submitted form into a WorkPaperInput, trimming and nulling blanks. */
export function parseWorkPaperInput(form: FormData): WorkPaperInput {
  const t = (key: string): string | null => {
    const raw = form.get(key);
    if (raw == null) return null;
    const str = String(raw).trim();
    return str === '' ? null : str;
  };
  const yr = t('year');
  return {
    year: yr == null ? null : Number(yr),
    affiliateCode: t('affiliate_code'),
    auditAreaId: t('audit_area_id'),
    subAreaId: t('sub_area_id'),
    workPaperDate: t('work_paper_date'),
    auditPeriodFrom: t('audit_period_from'),
    auditPeriodTo: t('audit_period_to'),
    controlObjectives: t('control_objectives'),
    classification: t('classification'),
    controlType: t('control_type'),
    controlFrequency: t('control_frequency'),
    standards: t('standards'),
    riskDescription: t('risk_description'),
    testObjective: t('test_objective'),
    testingSteps: t('testing_steps'),
    observationTitle: t('observation_title') ?? '',
    observationDescription: t('observation_description'),
    riskRating: t('risk_rating'),
    riskSummary: t('risk_summary'),
    recommendation: t('recommendation'),
    managementResponse: t('management_response'),
    assignedAuditorId: t('assigned_auditor'),
  };
}

/**
 * List work papers for the organisation, newest first, with optional filters and
 * a full-text search. Labels for affiliate, audit area and auditor are joined so
 * the dense list needs no second round trip.
 *
 * Row scope follows the viewer (workPaperVisibility.ts): auditee-side viewers
 * see only findings they are assigned to or named responsible for, and Draft
 * rows show only to their authors, mirroring the action-plan list.
 */
export async function listWorkPapers(
  db: Client,
  organizationId: string,
  viewer: WorkPaperViewer,
  filters: WorkPaperFilters = {},
): Promise<WorkPaperListRow[]> {
  const args: InArgs = [organizationId];
  let where = 'wp.organization_id = ?';
  let ftsJoin = '';

  if (restrictToOwnFindings(viewer)) {
    where +=
      ' AND (wp.assigned_auditor_id = ? OR EXISTS (SELECT 1 FROM work_paper_responsibles r' +
      ' WHERE r.work_paper_id = wp.work_paper_id AND r.user_id = ?))';
    args.push(viewer.userId, viewer.userId);
  }
  if (!seesForeignDrafts(viewer)) {
    where +=
      ' AND (wp.status <> ? OR wp.created_by = ? OR wp.prepared_by_id = ?' +
      ' OR wp.assigned_auditor_id = ?)';
    args.push(WP_STATUS.DRAFT, viewer.userId, viewer.userId, viewer.userId);
  }

  if (filters.q && filters.q.trim() !== '') {
    ftsJoin = 'JOIN work_papers_fts fts ON fts.rowid = wp.rowid';
    where += ' AND work_papers_fts MATCH ?';
    args.push(ftsQuery(filters.q));
  }
  if (filters.status) {
    where += ' AND wp.status = ?';
    args.push(filters.status);
  }
  if (filters.auditAreaId) {
    where += ' AND wp.audit_area_id = ?';
    args.push(filters.auditAreaId);
  }
  if (filters.affiliateCode) {
    where += ' AND wp.affiliate_code = ?';
    args.push(filters.affiliateCode);
  }
  if (filters.assignedAuditorId) {
    where += ' AND wp.assigned_auditor_id = ?';
    args.push(filters.assignedAuditorId);
  }
  if (filters.year) {
    where += ' AND wp.year = ?';
    args.push(Number(filters.year));
  }
  if (filters.riskRating) {
    where += ' AND wp.risk_rating = ?';
    args.push(filters.riskRating);
  }

  // Affiliate confinement (Build Prompt 45). This is a boundary, not the
  // user-chosen affiliate filter above it: both may apply at once, and a
  // confined viewer who filters to another affiliate simply sees nothing.
  const confine = affiliatePredicate(viewer.affiliateScope, `wp.${WPC.affiliate_code}`);
  where += confine.clause;
  args.push(...confine.args);

  const res = await db.execute({
    sql: `SELECT wp.work_paper_id AS id, wp.work_paper_ref AS reference,
                 wp.observation_title AS observation_title, wp.affiliate_code AS affiliate_code,
                 aff.affiliate_name AS affiliate_name, wp.audit_area_id AS audit_area_id,
                 aa.area_name AS audit_area_name, wp.risk_rating AS risk_rating,
                 wp.assigned_auditor_id AS assigned_auditor, u.full_name AS auditor_name,
                 wp.status AS status, wp.year AS year, wp.updated_at AS updated_at
            FROM work_papers wp
            ${ftsJoin}
            LEFT JOIN affiliates aff ON aff.affiliate_code = wp.affiliate_code
                 AND aff.organization_id = wp.organization_id
            LEFT JOIN audit_areas aa ON aa.audit_area_id = wp.audit_area_id
            LEFT JOIN users u ON u.user_id = wp.assigned_auditor_id
           WHERE ${where}
        ORDER BY wp.updated_at DESC, wp.work_paper_ref DESC
           LIMIT 500`,
    args,
  });
  return res.rows.map((r) => ({
    id: String(r.id),
    reference: String(r.reference ?? r.id),
    observationTitle: String(r.observation_title ?? ''),
    affiliateCode: s(r.affiliate_code),
    affiliateName: s(r.affiliate_name),
    auditAreaId: s(r.audit_area_id),
    auditAreaName: s(r.audit_area_name),
    riskRating: s(r.risk_rating),
    assignedAuditorId: s(r.assigned_auditor),
    assignedAuditorName: s(r.auditor_name),
    status: String(r.status),
    year: n(r.year),
    updatedAt: s(r.updated_at),
  }));
}

export type WorkPaperDetail = Record<string, unknown> & {
  id: string;
  reference: string;
  status: string;
  revisionCount: number;
};

/**
 * The full work paper, scoped to the organisation, or null when not found.
 *
 * `scope` confines it to the viewer's affiliate when their role is confined
 * (Build Prompt 45). A list predicate alone would not be a boundary: the detail
 * route takes an id from the URL, so without this a confined viewer could open
 * any finding in the organisation by guessing or being sent a link. Absent
 * scope means unconfined, which is what every internal caller that has no viewer
 * (the workflow engine, the notification builders) legitimately needs.
 */
export async function getWorkPaper(
  db: Client,
  organizationId: string,
  id: string,
  scope: AffiliateScope = UNCONFINED,
): Promise<WorkPaperDetail | null> {
  const res = await db.execute({
    sql: `SELECT wp.*, aff.affiliate_name AS affiliate_name, aa.area_name AS audit_area_name,
                 sa.sub_area_name AS sub_area_name, u.full_name AS assigned_auditor_name
            FROM work_papers wp
            LEFT JOIN affiliates aff ON aff.affiliate_code = wp.affiliate_code
                 AND aff.organization_id = wp.organization_id
            LEFT JOIN audit_areas aa ON aa.audit_area_id = wp.audit_area_id
            LEFT JOIN sub_areas sa ON sa.sub_area_id = wp.sub_area_id
            LEFT JOIN users u ON u.user_id = wp.assigned_auditor_id
           WHERE wp.work_paper_id = ? AND wp.organization_id = ?
           LIMIT 1`,
    args: [id, organizationId],
  });
  const row = res.rows[0];
  if (!row) return null;
  // Outside the viewer's affiliate reads as "not found", never as "forbidden":
  // a distinguishable refusal would confirm the finding exists.
  if (!affiliateVisible(scope, row.affiliate_code == null ? null : String(row.affiliate_code))) {
    return null;
  }
  const detail = { ...row } as Record<string, unknown>;
  detail.id = String(row.work_paper_id);
  detail.reference = String(row.work_paper_ref ?? row.work_paper_id);
  detail.status = String(row.status);
  detail.revisionCount = Number(row.revision_count ?? 0);
  return detail as WorkPaperDetail;
}

/**
 * Create a draft work paper. Generates the id and reference, stamps prepared_by,
 * inserts the writable fields at status DRAFT with revision_count 0, and syncs
 * the FTS row. Returns the new id.
 */
export async function createWorkPaper(
  db: Client,
  organizationId: string,
  userId: string,
  draftStatus: string,
  input: WorkPaperInput,
): Promise<string> {
  const id = crypto.randomUUID();
  const reference = buildReference(input.year);
  const now = new Date().toISOString();

  const cols = ['work_paper_id', 'organization_id', 'work_paper_ref', 'status', 'revision_count'];
  const placeholders = ['?', '?', '?', '?', '0'];
  const args: InArgs = [id, organizationId, reference, draftStatus];
  for (const f of FIELDS) {
    cols.push(f.col);
    placeholders.push('?');
    args.push(inputValue(input, f.key));
  }
  cols.push('prepared_by_id', 'prepared_date', 'created_by', 'created_at', 'updated_at');
  placeholders.push('?', '?', '?', '?', '?');
  args.push(userId, now, userId, now, now);

  await db.execute({
    sql: `INSERT INTO work_papers (${cols.join(', ')}) VALUES (${placeholders.join(', ')})`,
    args,
  });
  await syncFtsInsert(
    db,
    id,
    input.observationTitle,
    input.observationDescription,
    input.recommendation,
  );
  await invalidateDashboard(db, organizationId);
  return id;
}

/** Update a work paper's writable fields (the caller enforces the editable state) and re-sync the FTS. */
export async function updateWorkPaper(
  db: Client,
  organizationId: string,
  id: string,
  input: WorkPaperInput,
): Promise<void> {
  const sets = FIELDS.map((f) => `${f.col} = ?`);
  const args: InArgs = FIELDS.map((f) => inputValue(input, f.key));
  sets.push('updated_at = ?');
  args.push(new Date().toISOString());
  args.push(id, organizationId);
  await db.execute({
    sql: `UPDATE work_papers SET ${sets.join(', ')} WHERE work_paper_id = ? AND organization_id = ?`,
    args,
  });
  await syncFtsUpdate(
    db,
    id,
    input.observationTitle,
    input.observationDescription,
    input.recommendation,
  );
  await invalidateDashboard(db, organizationId);
}

/** Hard-delete a work paper and its FTS row (the caller checks the permission and state). */
export async function deleteWorkPaper(
  db: Client,
  organizationId: string,
  id: string,
): Promise<void> {
  await syncFtsDelete(db, id);
  await db.execute({
    sql: `DELETE FROM work_papers WHERE work_paper_id = ? AND organization_id = ?`,
    args: [id, organizationId],
  });
  await invalidateDashboard(db, organizationId);
}

// ---- helpers ---------------------------------------------------------------

function inputValue(input: WorkPaperInput, key: keyof WorkPaperInput): string | number | null {
  const v = input[key];
  return v == null ? null : v;
}

// A reference like WP-2026-XXXXXX. The source generates a per-organisation
// reference; the exact scheme lives in the schema, so this uses a collision-free
// random suffix and is documented as an assumption.
function buildReference(year: number | null): string {
  const y = year ?? new Date().getUTCFullYear();
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();
  return `WP-${y}-${suffix}`;
}

// Turn a user query into a safe FTS5 MATCH: split on whitespace, drop FTS
// syntax, and OR the terms with a prefix match, so a partial word still hits.
function ftsQuery(raw: string): string {
  const terms = raw
    .replace(/["*()^:-]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 6)
    .map((t) => `${t}*`);
  return terms.length ? terms.join(' OR ') : '""';
}

// External-content FTS5 is maintained by hand. The rowid is the content table's
// rowid, looked up from the natural key. These are best-effort: a create or edit
// must never fail because the FTS shape differs, so a sync error is swallowed and
// the primary write stands (search may then lag until reconciled). See
// grc/docs/schema-assumptions.md.
async function rowidFor(db: Client, id: string): Promise<number | null> {
  try {
    const res = await db.execute({
      sql: `SELECT rowid FROM work_papers WHERE work_paper_id = ? LIMIT 1`,
      args: [id],
    });
    const rid = res.rows[0]?.rowid;
    return rid == null ? null : Number(rid);
  } catch {
    return null;
  }
}

async function syncFtsInsert(
  db: Client,
  id: string,
  title: string,
  description: string | null,
  recommendation: string | null,
): Promise<void> {
  const rowid = await rowidFor(db, id);
  if (rowid == null) return;
  try {
    await db.execute({
      sql: `INSERT INTO work_papers_fts (rowid, observation_title, observation_description, recommendation)
            VALUES (?, ?, ?, ?)`,
      args: [rowid, title, description ?? '', recommendation ?? ''],
    });
  } catch {
    // best-effort: search stays reconcilable, the write is authoritative.
  }
}

async function syncFtsUpdate(
  db: Client,
  id: string,
  title: string,
  description: string | null,
  recommendation: string | null,
): Promise<void> {
  const rowid = await rowidFor(db, id);
  if (rowid == null) return;
  try {
    // External-content delete then insert, per the FTS5 contract.
    await db.execute({
      sql: `INSERT INTO work_papers_fts (work_papers_fts, rowid, observation_title, observation_description, recommendation)
            VALUES ('delete', ?, ?, ?, ?)`,
      args: [rowid, title, description ?? '', recommendation ?? ''],
    });
  } catch {
    // ignore; the insert below refreshes the index either way.
  }
  try {
    await db.execute({
      sql: `INSERT INTO work_papers_fts (rowid, observation_title, observation_description, recommendation)
            VALUES (?, ?, ?, ?)`,
      args: [rowid, title, description ?? '', recommendation ?? ''],
    });
  } catch {
    // best-effort.
  }
}

async function syncFtsDelete(db: Client, id: string): Promise<void> {
  const rowid = await rowidFor(db, id);
  if (rowid == null) return;
  try {
    await db.execute({
      sql: `INSERT INTO work_papers_fts (work_papers_fts, rowid) VALUES ('delete', ?)`,
      args: [rowid],
    });
  } catch {
    // best-effort.
  }
}
