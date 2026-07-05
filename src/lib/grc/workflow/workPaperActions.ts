/**
 * The work-paper workflow action catalogue, pure and import-free so it can be
 * unit tested and reused.
 *
 * Validity is NOT decided here: which transitions exist, the `required_role` and
 * the `requires_comment` flag all come from `status_transitions` through the
 * foundation engine. This catalogue adds, per target status, the three things
 * the engine does not carry but the source's WorkPaperService does: the
 * WORK_PAPERS.* permission the action needs, the dated attribution field to
 * stamp, and the email template to enqueue. Both guards (this permission and the
 * engine's required_role) must pass, as section 5 requires.
 *
 * The status values and attribution/template names follow the hassaudit schema
 * and are documented in grc/docs/schema-assumptions.md; they are the single
 * place to reconcile if the live database differs. The lifecycle is Draft,
 * Submitted, Under Review, Approved, Sent to Auditee, Response Received,
 * Response Reviewed, with a Revision Required loop back to the auditor.
 */

/** The enum_type under which the work-paper statuses and transitions are stored. */
export const WORK_PAPER_ENUM_TYPE = 'WORK_PAPER_STATUS';

// Statuses are the human-readable strings the hassaudit schema stores in
// work_papers.status and keys status_transitions by (Build Prompt 16); they are
// not short codes. The lifecycle labels below are the single source both the
// workflow and the queries use, so the two never diverge from the database.
export const WP_STATUS = {
  DRAFT: 'Draft',
  SUBMITTED: 'Submitted',
  UNDER_REVIEW: 'Under Review',
  APPROVED: 'Approved',
  SENT_TO_AUDITEE: 'Sent to Auditee',
  RESPONSE_RECEIVED: 'Response Received',
  RESPONSE_REVIEWED: 'Response Reviewed',
  REVISION_REQUIRED: 'Revision Required',
} as const;

/**
 * The dated attribution to stamp on a transition. The hassaudit schema records
 * who and when as a `_by_id`/`_by_name`/`_date` triple (Build Prompt 16); some
 * steps carry only a date. Only the columns that exist for a step are set.
 */
export interface Attribution {
  /** The user-id column to stamp with the actor, when the step records who. */
  byId?: string;
  /** The user-name column to stamp with the actor's name, when the step records it. */
  byName?: string;
  /** The date column to stamp; every attributed step has one. */
  date: string;
  /** The comments column to stamp when the transition carries a comment. */
  comments?: string;
}

export interface WpActionMeta {
  /** The WORK_PAPERS.* permission the actor must hold, on top of the engine's required_role. */
  permission: string;
  /** The dated attribution field to stamp, if the source stamps one on this move. */
  attribution?: Attribution;
  /** The email_templates code to enqueue a notification for, if this move notifies. */
  notifyTemplate?: string;
  /** A concise action label for the button. */
  label: string;
}

// Keyed by target status. The permission mapping preserves the source: submit,
// review (and request revision), approve, send. The response cycle is a reviewer
// activity here (the auditee portal is a later prompt), so it also gates on
// review. Only `finding_shared` is a confirmed seeded template; the other
// template codes are documented assumptions and enqueue best-effort.
const ACTIONS: Record<string, WpActionMeta> = {
  [WP_STATUS.SUBMITTED]: {
    permission: 'WORK_PAPERS.submit',
    attribution: { date: 'submitted_date' },
    notifyTemplate: 'finding_submitted',
    label: 'Submit for review',
  },
  [WP_STATUS.UNDER_REVIEW]: {
    permission: 'WORK_PAPERS.review',
    label: 'Start review',
  },
  [WP_STATUS.REVISION_REQUIRED]: {
    permission: 'WORK_PAPERS.review',
    attribution: {
      byId: 'reviewed_by_id',
      byName: 'reviewed_by_name',
      date: 'review_date',
      comments: 'review_comments',
    },
    label: 'Request revision',
  },
  [WP_STATUS.APPROVED]: {
    permission: 'WORK_PAPERS.approve',
    attribution: { byId: 'approved_by_id', byName: 'approved_by_name', date: 'approved_date' },
    label: 'Approve',
  },
  [WP_STATUS.SENT_TO_AUDITEE]: {
    permission: 'WORK_PAPERS.send',
    attribution: { date: 'sent_to_auditee_date' },
    notifyTemplate: 'finding_shared',
    label: 'Send to auditee',
  },
  [WP_STATUS.RESPONSE_RECEIVED]: {
    permission: 'WORK_PAPERS.review',
    notifyTemplate: 'response_received',
    label: 'Record response received',
  },
  [WP_STATUS.RESPONSE_REVIEWED]: {
    permission: 'WORK_PAPERS.review',
    attribution: {
      byId: 'response_reviewed_by',
      date: 'response_review_date',
      comments: 'response_review_comments',
    },
    label: 'Mark response reviewed',
  },
  [WP_STATUS.DRAFT]: {
    permission: 'WORK_PAPERS.review',
    label: 'Return to draft',
  },
};

/** The action metadata for a target status, or null when the target is unknown. */
export function actionForTarget(target: string): WpActionMeta | null {
  return ACTIONS[target] ?? null;
}

/** The statuses in which the record's fields may be edited; every other status is read-only. */
export function editableStatuses(): readonly string[] {
  return [WP_STATUS.DRAFT, WP_STATUS.REVISION_REQUIRED];
}

/** Whether a work paper in this status may be edited (Draft or Revision Required). */
export function isEditable(status: string): boolean {
  return editableStatuses().includes(status);
}
