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

export const WP_STATUS = {
  DRAFT: 'DRAFT',
  SUBMITTED: 'SUBMITTED',
  UNDER_REVIEW: 'UNDER_REVIEW',
  APPROVED: 'APPROVED',
  SENT_TO_AUDITEE: 'SENT_TO_AUDITEE',
  RESPONSE_RECEIVED: 'RESPONSE_RECEIVED',
  RESPONSE_REVIEWED: 'RESPONSE_REVIEWED',
  REVISION_REQUIRED: 'REVISION_REQUIRED',
} as const;

/** The dated attribution to stamp on a transition: a "by" and an "at" column, and optionally a comments column. */
export interface Attribution {
  by: string;
  at: string;
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
    attribution: { by: 'submitted_by', at: 'submitted_at' },
    notifyTemplate: 'finding_submitted',
    label: 'Submit for review',
  },
  [WP_STATUS.UNDER_REVIEW]: {
    permission: 'WORK_PAPERS.review',
    label: 'Start review',
  },
  [WP_STATUS.REVISION_REQUIRED]: {
    permission: 'WORK_PAPERS.review',
    attribution: { by: 'reviewed_by', at: 'reviewed_at', comments: 'review_comments' },
    label: 'Request revision',
  },
  [WP_STATUS.APPROVED]: {
    permission: 'WORK_PAPERS.approve',
    attribution: { by: 'approved_by', at: 'approved_at' },
    label: 'Approve',
  },
  [WP_STATUS.SENT_TO_AUDITEE]: {
    permission: 'WORK_PAPERS.send',
    attribution: { by: 'sent_to_auditee_by', at: 'sent_to_auditee_at' },
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
    attribution: { by: 'reviewed_by', at: 'reviewed_at', comments: 'review_comments' },
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
