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

/** A cell of the permission matrix: the module and the action on it. */
export interface Grant {
  module: string;
  action: string;
}

export interface WpActionMeta {
  /**
   * The matrix grant the actor must hold, on top of the engine's required_role.
   *
   * A matrix cell, not a derived `WORK_PAPERS.*` string (Build Prompt 55). The
   * derived list is a second representation of the same grant, and a second
   * representation is a second thing that can be wrong: an auditor holding
   * `WORK_PAPER.update` could still fail a `perms.includes('WORK_PAPERS.submit')`
   * check, and nothing on the access-control screen would explain why. The
   * workflow now asks the matrix the administrator actually edits.
   */
  grant: Grant;
  /** The dated attribution field to stamp, if the source stamps one on this move. */
  attribution?: Attribution;
  /** The email_templates code to enqueue a notification for, if this move notifies. */
  notifyTemplate?: string;
  /** A concise action label for the button. */
  label: string;
  /**
   * True when the action belongs to the person doing the work rather than the
   * person reviewing it. An authoring action is offered to the finding's own
   * auditor; a head of audit who is not its auditor is not asked to submit
   * somebody else's draft, they are notified that it arrived (Build Prompt 55).
   */
  authoring?: boolean;
}

// Keyed by target status. The permission mapping preserves the source: submit,
// review (and request revision), approve, send. The response cycle is a reviewer
// activity here (the auditee portal is a later prompt), so it also gates on
// review. Only `finding_shared` is a confirmed seeded template; the other
// template codes are documented assumptions and enqueue best-effort.
const ACTIONS: Record<string, WpActionMeta> = {
  [WP_STATUS.SUBMITTED]: {
    // Submitting is an authoring step: whoever may edit the draft may release it.
    grant: { module: 'WORK_PAPER', action: 'update' },
    authoring: true,
    attribution: { date: 'submitted_date' },
    notifyTemplate: 'finding_submitted',
    label: 'Submit for review',
  },
  [WP_STATUS.UNDER_REVIEW]: {
    grant: { module: 'WORK_PAPER', action: 'approve' },
    label: 'Start review',
  },
  [WP_STATUS.REVISION_REQUIRED]: {
    grant: { module: 'WORK_PAPER', action: 'approve' },
    attribution: {
      byId: 'reviewed_by_id',
      byName: 'reviewed_by_name',
      date: 'review_date',
      comments: 'review_comments',
    },
    label: 'Request revision',
  },
  [WP_STATUS.APPROVED]: {
    grant: { module: 'WORK_PAPER', action: 'approve' },
    attribution: { byId: 'approved_by_id', byName: 'approved_by_name', date: 'approved_date' },
    label: 'Approve',
  },
  [WP_STATUS.SENT_TO_AUDITEE]: {
    grant: { module: 'WORK_PAPER', action: 'approve' },
    attribution: { date: 'sent_to_auditee_date' },
    notifyTemplate: 'finding_shared',
    label: 'Send to auditee',
  },
  [WP_STATUS.RESPONSE_RECEIVED]: {
    grant: { module: 'WORK_PAPER', action: 'approve' },
    notifyTemplate: 'response_received',
    label: 'Record response received',
  },
  [WP_STATUS.RESPONSE_REVIEWED]: {
    grant: { module: 'WORK_PAPER', action: 'approve' },
    attribution: {
      byId: 'response_reviewed_by',
      date: 'response_review_date',
      comments: 'response_review_comments',
    },
    label: 'Mark response reviewed',
  },
  [WP_STATUS.DRAFT]: {
    grant: { module: 'WORK_PAPER', action: 'approve' },
    label: 'Return to draft',
  },
};

/**
 * The action metadata for a target status, or null when the target is unknown.
 *
 * The lookup tolerates the surrounding whitespace and casing a hand-edited
 * reference row can carry: `status_transitions` is operator-managed data, and a
 * trailing space in `to_status` is invisible on every screen that displays it
 * while silently matching nothing here (Build Prompt 55). The stored value is
 * still what gets written; only the comparison is forgiving.
 */
export function actionForTarget(target: string): WpActionMeta | null {
  const exact = ACTIONS[target];
  if (exact) return exact;
  const wanted = normaliseStatus(target);
  if (wanted === '') return null;
  for (const [status, meta] of Object.entries(ACTIONS)) {
    if (normaliseStatus(status) === wanted) return meta;
  }
  return null;
}

/** A status reduced to what it means, for comparison only, never for storage. */
export function normaliseStatus(status: string): string {
  return String(status ?? '')
    .trim()
    .toLowerCase();
}

/** Whether two stored statuses name the same state, whitespace and case aside. */
export function sameStatus(a: string, b: string): boolean {
  return normaliseStatus(a) === normaliseStatus(b);
}

/** The statuses in which the record's fields may be edited; every other status is read-only. */
export function editableStatuses(): readonly string[] {
  return [WP_STATUS.DRAFT, WP_STATUS.REVISION_REQUIRED];
}

/** Whether a work paper in this status may be edited (Draft or Revision Required). */
export function isEditable(status: string): boolean {
  return editableStatuses().includes(status);
}
