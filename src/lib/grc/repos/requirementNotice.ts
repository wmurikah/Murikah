/**
 * The facts a requirement notification carries, read once (Build Prompt 58).
 *
 * The three events (asked, provided, asked again) all need the same handful of
 * details: which finding this is about, what was asked for, when it is wanted,
 * and who to tell on the audit side. Reading them in one place keeps the three
 * endpoints free of the same join written three ways.
 *
 * WHO AUDIT IS. A requirement carries no requester of its own, so the auditor
 * told about an answer is the finding's assigned auditor: the person whose work
 * paper the information was requested for is the person who has to read it. When
 * a finding has no auditor yet, nobody on the audit side is named, and the
 * submission still lands, visible on the requirements list where it is picked up
 * from the Awaiting review filter.
 */
import type { Client } from '@libsql/client/web';
import { C, cols } from '@grc/schema/columns';
import type { RequirementNotice } from '@grc/notify/requirements';

const R = cols(C.work_paper_requirements);
const WP = cols(C.work_papers);

export interface RequirementNoticeContext extends RequirementNotice {
  /** The auditor to tell when an owner answers, if the finding names one. */
  auditorIds: string[];
}

/** The notification facts for a requirement, or null when it is not this organisation's. */
export async function requirementNotice(
  db: Client,
  organizationId: string,
  requirementId: string,
  actorUserId: string,
): Promise<RequirementNoticeContext | null> {
  const res = await db.execute({
    sql: `SELECT r.${R.description} AS description, r.${R.due_date} AS due_date,
                 wp.${WP.work_paper_ref} AS reference,
                 wp.${WP.assigned_auditor_id} AS assigned_auditor_id
            FROM work_paper_requirements r
            LEFT JOIN work_papers wp ON wp.${WP.work_paper_id} = r.${R.work_paper_id}
           WHERE r.${R.requirement_id} = ? AND r.${R.organization_id} = ? LIMIT 1`,
    args: [requirementId, organizationId],
  });
  const row = res.rows[0];
  if (!row) return null;
  const auditor = row.assigned_auditor_id == null ? '' : String(row.assigned_auditor_id).trim();
  return {
    requirementId,
    reference: String(row.reference ?? ''),
    description: String(row.description ?? ''),
    dueDate: row.due_date == null ? null : String(row.due_date),
    actorUserId,
    auditorIds: auditor === '' ? [] : [auditor],
  };
}
