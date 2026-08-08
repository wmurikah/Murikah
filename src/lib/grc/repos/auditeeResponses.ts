/**
 * Auditee responses: how management answers a finding, and the auditor queue
 * that reviews those answers across rounds. Ported from the source
 * AuditeeResponse behaviour.
 *
 * Every read and write is scoped by the acting organization_id, and the auditee
 * side is scoped again to the signed-in user: an auditee sees only the findings
 * they are responsible for (or copied on), never the whole universe. Column
 * names come from the typed schema layer.
 *
 * This module stores and reads. It never decides whether the parent work paper
 * may move: that goes through the work-paper transition engine, so
 * `status_transitions` remains the authority.
 */
import type { Client, InStatement } from '@libsql/client/web';
import { C, cols } from '@grc/schema/columns';
import { RESPONSE_STATUS, RESPONSE_TYPE } from '@grc/workflow/responseRounds';
import { affiliatePredicate, UNCONFINED, type AffiliateScope } from '@grc/auth/affiliateScope';

const AR = cols(C.auditee_responses);
const WP = cols(C.work_papers);
const RESP = cols(C.work_paper_responsibles);
const CC = cols(C.work_paper_cc_recipients);

const s = (v: unknown): string | null => (v == null ? null : String(v));

/** A finding on the auditee's plate, with the round and deadline it carries. */
export interface AuditeeFinding {
  workPaperId: string;
  reference: string;
  observationTitle: string;
  riskRating: string | null;
  status: string;
  /** The date the finding was shared, which the deadline is measured from. */
  sentDate: string | null;
  /** The deadline stored on the finding, when the operator's flow sets one. */
  storedDeadline: string | null;
  round: number;
  responseStatus: string | null;
  /** Whether this user has already answered the current round. */
  answeredThisRound: boolean;
}

/**
 * The findings shared with this user: the ones they are responsible for or
 * copied on, that have reached the auditee. This is the auditee's whole
 * universe, so the visibility restriction is in the query itself rather than in
 * the page.
 */
export async function listAuditeeFindings(
  db: Client,
  organizationId: string,
  userId: string,
  statuses: string[],
  scope: AffiliateScope = UNCONFINED,
): Promise<AuditeeFinding[]> {
  if (statuses.length === 0) return [];
  const placeholders = statuses.map(() => '?').join(', ');
  // auditee_responses carries no affiliate of its own; the finding it hangs off
  // does, and that is what bounds it (Build Prompt 45).
  const confine = affiliatePredicate(scope, `wp.${WP.affiliate_code}`);
  const res = await db.execute({
    sql: `SELECT wp.${WP.work_paper_id} AS id, wp.${WP.work_paper_ref} AS reference,
                 wp.${WP.observation_title} AS observation_title,
                 wp.${WP.risk_rating} AS risk_rating, wp.${WP.status} AS status,
                 wp.${WP.sent_to_auditee_date} AS sent_date,
                 wp.${WP.response_deadline} AS response_deadline,
                 wp.${WP.response_round} AS response_round,
                 wp.${WP.response_status} AS response_status,
                 (SELECT COUNT(*) FROM auditee_responses ar
                   WHERE ar.${AR.work_paper_id} = wp.${WP.work_paper_id}
                     AND ar.${AR.organization_id} = wp.${WP.organization_id}
                     AND ar.${AR.deleted_at} IS NULL
                     AND ar.${AR.round_number} = COALESCE(wp.${WP.response_round}, 1)) AS answered
            FROM work_papers wp
           WHERE wp.${WP.organization_id} = ?
             AND wp.${WP.deleted_at} IS NULL
             AND wp.${WP.status} IN (${placeholders})
             AND (
               EXISTS (SELECT 1 FROM work_paper_responsibles r
                        WHERE r.${RESP.work_paper_id} = wp.${WP.work_paper_id}
                          AND r.${RESP.user_id} = ?)
               OR EXISTS (SELECT 1 FROM work_paper_cc_recipients c
                           WHERE c.${CC.work_paper_id} = wp.${WP.work_paper_id}
                             AND c.${CC.user_id} = ?)
             )${confine.clause}
        ORDER BY wp.${WP.sent_to_auditee_date} ASC, wp.${WP.work_paper_ref} ASC
           LIMIT 200`,
    args: [organizationId, ...statuses, userId, userId, ...confine.args],
  });
  return res.rows.map((r) => ({
    workPaperId: String(r.id),
    reference: String(r.reference ?? r.id),
    observationTitle: String(r.observation_title ?? ''),
    riskRating: s(r.risk_rating),
    status: String(r.status),
    sentDate: s(r.sent_date),
    storedDeadline: s(r.response_deadline),
    round: Number(r.response_round ?? 1) || 1,
    responseStatus: s(r.response_status),
    answeredThisRound: Number(r.answered ?? 0) > 0,
  }));
}

/** A submitted response awaiting (or carrying) a reviewer's decision. */
export interface ResponseRow {
  responseId: string;
  workPaperId: string;
  reference: string;
  observationTitle: string;
  riskRating: string | null;
  workPaperStatus: string;
  round: number;
  responseType: string | null;
  managementResponse: string;
  status: string;
  submittedById: string | null;
  submittedByName: string | null;
  submittedDate: string | null;
  reviewedByName: string | null;
  reviewDate: string | null;
  reviewComments: string | null;
  actionPlanIds: string | null;
}

const RESPONSE_SELECT = `SELECT ar.${AR.response_id} AS response_id, ar.${AR.work_paper_id} AS work_paper_id,
                 wp.${WP.work_paper_ref} AS reference, wp.${WP.observation_title} AS observation_title,
                 wp.${WP.risk_rating} AS risk_rating, wp.${WP.status} AS wp_status,
                 ar.${AR.round_number} AS round_number, ar.${AR.response_type} AS response_type,
                 ar.${AR.management_response} AS management_response, ar.${AR.status} AS status,
                 ar.${AR.submitted_by_id} AS submitted_by_id,
                 ar.${AR.submitted_by_name} AS submitted_by_name,
                 ar.${AR.submitted_date} AS submitted_date,
                 ar.${AR.reviewed_by_name} AS reviewed_by_name, ar.${AR.review_date} AS review_date,
                 ar.${AR.review_comments} AS review_comments,
                 ar.${AR.action_plan_ids} AS action_plan_ids
            FROM auditee_responses ar
            JOIN work_papers wp ON wp.${WP.work_paper_id} = ar.${AR.work_paper_id}
                 AND wp.${WP.organization_id} = ar.${AR.organization_id}`;

function toResponseRow(r: Record<string, unknown>): ResponseRow {
  return {
    responseId: String(r.response_id),
    workPaperId: String(r.work_paper_id),
    reference: String(r.reference ?? r.work_paper_id),
    observationTitle: String(r.observation_title ?? ''),
    riskRating: s(r.risk_rating),
    workPaperStatus: String(r.wp_status ?? ''),
    round: Number(r.round_number ?? 1) || 1,
    responseType: s(r.response_type),
    managementResponse: String(r.management_response ?? ''),
    status: String(r.status ?? RESPONSE_STATUS.SUBMITTED),
    submittedById: s(r.submitted_by_id),
    submittedByName: s(r.submitted_by_name),
    submittedDate: s(r.submitted_date),
    reviewedByName: s(r.reviewed_by_name),
    reviewDate: s(r.review_date),
    reviewComments: s(r.review_comments),
    actionPlanIds: s(r.action_plan_ids),
  };
}

/** The reviewer's queue: responses submitted and not yet decided, oldest first. */
export async function listReviewQueue(
  db: Client,
  organizationId: string,
  limit = 200,
  scope: AffiliateScope = UNCONFINED,
): Promise<ResponseRow[]> {
  const confine = affiliatePredicate(scope, `wp.${WP.affiliate_code}`);
  const res = await db.execute({
    sql: `${RESPONSE_SELECT}
           WHERE ar.${AR.organization_id} = ? AND ar.${AR.deleted_at} IS NULL
             AND ar.${AR.status} = ?${confine.clause}
        ORDER BY ar.${AR.submitted_date} ASC
           LIMIT ${Math.max(1, Math.min(limit, 500))}`,
    args: [organizationId, RESPONSE_STATUS.SUBMITTED, ...confine.args],
  });
  return res.rows.map((r) => toResponseRow(r as Record<string, unknown>));
}

/** Every round recorded against a finding, newest first, for the thread on both sides. */
export async function listRounds(
  db: Client,
  organizationId: string,
  workPaperId: string,
): Promise<ResponseRow[]> {
  const res = await db.execute({
    sql: `${RESPONSE_SELECT}
           WHERE ar.${AR.organization_id} = ? AND ar.${AR.work_paper_id} = ?
             AND ar.${AR.deleted_at} IS NULL
        ORDER BY ar.${AR.round_number} DESC, ar.${AR.submitted_date} DESC`,
    args: [organizationId, workPaperId],
  });
  return res.rows.map((r) => toResponseRow(r as Record<string, unknown>));
}

/** One response by id, scoped to the organisation. */
export async function getResponse(
  db: Client,
  organizationId: string,
  responseId: string,
): Promise<ResponseRow | null> {
  const res = await db.execute({
    sql: `${RESPONSE_SELECT}
           WHERE ar.${AR.organization_id} = ? AND ar.${AR.response_id} = ?
             AND ar.${AR.deleted_at} IS NULL
           LIMIT 1`,
    args: [organizationId, responseId],
  });
  const row = res.rows[0];
  return row ? toResponseRow(row as Record<string, unknown>) : null;
}

/** Whether this user may answer for this finding (responsible or copied in). */
export async function isAssignedAuditee(
  db: Client,
  organizationId: string,
  workPaperId: string,
  userId: string,
): Promise<boolean> {
  const res = await db.execute({
    sql: `SELECT 1 AS ok FROM work_papers wp
           WHERE wp.${WP.work_paper_id} = ? AND wp.${WP.organization_id} = ?
             AND (
               EXISTS (SELECT 1 FROM work_paper_responsibles r
                        WHERE r.${RESP.work_paper_id} = wp.${WP.work_paper_id}
                          AND r.${RESP.user_id} = ?)
               OR EXISTS (SELECT 1 FROM work_paper_cc_recipients c
                           WHERE c.${CC.work_paper_id} = wp.${WP.work_paper_id}
                             AND c.${CC.user_id} = ?)
             )
           LIMIT 1`,
    args: [workPaperId, organizationId, userId, userId],
  });
  return res.rows.length > 0;
}

export interface SubmitResponseInput {
  workPaperId: string;
  round: number;
  managementResponse: string;
  submittedById: string;
  submittedByName: string;
  /** The plans the auditee proposed alongside this response, comma separated. */
  actionPlanIds: string | null;
}

/**
 * The insert for one response round, as a batchable statement so the caller can
 * write it atomically with the parent work paper's own update.
 */
export function insertResponseStatement(
  organizationId: string,
  responseId: string,
  input: SubmitResponseInput,
  now: string,
): InStatement {
  return {
    sql: `INSERT INTO auditee_responses
            (${AR.response_id}, ${AR.organization_id}, ${AR.work_paper_id}, ${AR.response_round},
             ${AR.round_number}, ${AR.response_type}, ${AR.response_text}, ${AR.management_response},
             ${AR.status}, ${AR.submitted_by}, ${AR.submitted_by_id}, ${AR.submitted_by_name},
             ${AR.submitted_date}, ${AR.action_plan_ids}, ${AR.created_at}, ${AR.updated_at})
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      responseId,
      organizationId,
      input.workPaperId,
      input.round,
      input.round,
      RESPONSE_TYPE.MANAGEMENT_RESPONSE,
      input.managementResponse,
      input.managementResponse,
      RESPONSE_STATUS.SUBMITTED,
      input.submittedById,
      input.submittedById,
      input.submittedByName,
      now,
      input.actionPlanIds,
      now,
      now,
    ],
  };
}

/**
 * Mirror the submitted round onto the parent finding, so the list and the
 * reviewer queue can be read without joining every round.
 */
export function stampWorkPaperSubmissionStatement(
  organizationId: string,
  workPaperId: string,
  input: SubmitResponseInput,
  now: string,
): InStatement {
  return {
    sql: `UPDATE work_papers
             SET ${WP.response_status} = ?, ${WP.response_round} = ?,
                 ${WP.response_submitted_by} = ?, ${WP.response_submitted_date} = ?,
                 ${WP.management_response} = ?, ${WP.updated_at} = ?
           WHERE ${WP.work_paper_id} = ? AND ${WP.organization_id} = ?`,
    args: [
      RESPONSE_STATUS.SUBMITTED,
      input.round,
      input.submittedById,
      now,
      input.managementResponse,
      now,
      workPaperId,
      organizationId,
    ],
  };
}

/** Record the reviewer's decision on the round they judged. */
export function reviewResponseStatement(
  organizationId: string,
  responseId: string,
  status: string,
  reviewer: { userId: string; userName: string },
  comments: string | null,
  now: string,
): InStatement {
  return {
    sql: `UPDATE auditee_responses
             SET ${AR.status} = ?, ${AR.reviewed_by} = ?, ${AR.reviewed_by_id} = ?,
                 ${AR.reviewed_by_name} = ?, ${AR.review_date} = ?, ${AR.review_comments} = ?,
                 ${AR.updated_at} = ?
           WHERE ${AR.response_id} = ? AND ${AR.organization_id} = ?`,
    args: [
      status,
      reviewer.userId,
      reviewer.userId,
      reviewer.userName,
      now,
      comments,
      now,
      responseId,
      organizationId,
    ],
  };
}

/**
 * Mirror the decision onto the finding: the response status, and the round the
 * auditee is now on (unchanged on acceptance, advanced when changes are asked
 * for). The finding's own status moves through the transition engine, not here.
 */
export function stampWorkPaperReviewStatement(
  organizationId: string,
  workPaperId: string,
  responseStatus: string,
  round: number,
  now: string,
): InStatement {
  return {
    sql: `UPDATE work_papers
             SET ${WP.response_status} = ?, ${WP.response_round} = ?, ${WP.updated_at} = ?
           WHERE ${WP.work_paper_id} = ? AND ${WP.organization_id} = ?`,
    args: [responseStatus, round, now, workPaperId, organizationId],
  };
}

/** Set the finding's response deadline, when the flow computes one on sending. */
export async function setResponseDeadline(
  db: Client,
  organizationId: string,
  workPaperId: string,
  deadline: string | null,
): Promise<void> {
  await db.execute({
    sql: `UPDATE work_papers SET ${WP.response_deadline} = ?, ${WP.updated_at} = ?
           WHERE ${WP.work_paper_id} = ? AND ${WP.organization_id} = ?`,
    args: [deadline, new Date().toISOString(), workPaperId, organizationId],
  });
}
