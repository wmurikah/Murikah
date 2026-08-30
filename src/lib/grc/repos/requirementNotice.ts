/**
 * The facts a requirement notification carries, read once (Build Prompt 58).
 *
 * The three events (asked, provided, asked again) all need the same handful of
 * details: which finding this is about, what was asked for, when it is wanted,
 * and who to tell on the audit side. Reading them in one place keeps the three
 * endpoints free of the same join written three ways.
 *
 * WHO AUDIT IS. A requirement carries no requester of its own, so the auditor
 * told about an answer is the linked finding's assigned auditor: the person
 * whose work paper the information was requested for is the person who has to
 * read it.
 *
 * A requirement raised without a finding has no such auditor, and that is the
 * ordinary case now (Build Prompt 69). The answer goes to the organisation's
 * head of audit instead, because information provided that nobody is told about
 * is information nobody reviews, and "it is on the list under Awaiting review"
 * is only true for somebody who thinks to look. When neither resolves, the
 * submission still lands and still shows on that filter.
 */
import type { Client } from '@libsql/client/web';
import { C, cols } from '@grc/schema/columns';
import type { RequirementNotice } from '@grc/notify/requirements';
import { listHoaRecipients } from '@grc/notify/recipients';

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
                 r.${R.status} AS status,
                 wp.${WP.work_paper_ref} AS reference,
                 wp.${WP.assigned_auditor_id} AS assigned_auditor_id
            FROM work_paper_requirements r
            LEFT JOIN work_papers wp
              ON wp.${WP.work_paper_id} =
                 COALESCE(NULLIF(TRIM(r.${R.linked_work_paper_id}), ''),
                          NULLIF(TRIM(r.${R.work_paper_id}), ''))
           WHERE r.${R.requirement_id} = ? AND r.${R.organization_id} = ? LIMIT 1`,
    args: [requirementId, organizationId],
  });
  const row = res.rows[0];
  if (!row) return null;
  const auditor = row.assigned_auditor_id == null ? '' : String(row.assigned_auditor_id).trim();
  // Unlinked, so there is no finding and no auditor on it: the head of audit is
  // who reads what comes back until somebody links it to their work.
  const auditorIds =
    auditor !== ''
      ? [auditor]
      : (await listHoaRecipients(db, organizationId, actorUserId)).map((r) => r.userId);
  return {
    requirementId,
    reference: String(row.reference ?? ''),
    description: String(row.description ?? ''),
    dueDate: row.due_date == null ? null : String(row.due_date),
    status: row.status == null ? null : String(row.status),
    actorUserId,
    auditorIds,
  };
}
