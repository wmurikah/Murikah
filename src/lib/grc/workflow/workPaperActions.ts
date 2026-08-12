/**
 * The work-paper workflow action catalogue, pure so it can be unit tested and
 * reused. Its one import is the engine's status normaliser beside it, with an
 * explicit `.ts` specifier so node strips the types and runs this directly; the
 * comparison rule belongs to the engine, and a second copy of it here is the
 * kind of drift that lets two modules disagree about what "Draft" means.
 *
 * Validity is NOT decided here: which transitions exist, the `required_role` and
 * the `requires_comment` flag all come from `status_transitions` through the
 * foundation engine. This catalogue adds, per target status, the three things
 * the engine does not carry but the source's WorkPaperService does: the matrix
 * grant the action needs, the dated attribution field to stamp, and the email
 * template to enqueue. Both guards (this grant and the engine's required_role)
 * must pass, as section 5 requires. The grant is stated per `from -> to` move
 * where a status is reached by more than one person's work (`TRANSITION_GRANTS`,
 * Build Prompt 56), with the target's entry as the fallback.
 *
 * The status values and attribution/template names follow the hassaudit schema
 * and are documented in grc/docs/schema-assumptions.md; they are the single
 * place to reconcile if the live database differs. The lifecycle is Draft,
 * Submitted, Under Review, Approved, Sent to Auditee, Response Received,
 * Response Reviewed, with a Revision Required loop back to the auditor.
 */

import { normaliseStatus, sameStatus } from './transitionRules.ts';

export { normaliseStatus, sameStatus };

/**
 * The enum_type under which the work-paper statuses and transitions are stored.
 *
 * `status_transitions` holds every workflow in the product keyed by this column,
 * and more than one of them defines a `Draft -> Submitted`: this one, and the
 * auditee response's. So it is the scope of every lookup a work paper makes, and
 * it is resolved from the entity being moved rather than assumed (see
 * `enumTypeForEntity`). The live table spells it in lower case; the comparison
 * is case tolerant (workflow/transitions.ts), so this constant names the
 * workflow rather than a spelling of it.
 */
export const WORK_PAPER_ENUM_TYPE = 'work_paper_status';

/**
 * The workflow an entity's status belongs to (Build Prompt 61).
 *
 * One table, several workflows, and the same status names in more than one of
 * them: a move is only meaningful inside the workflow of the thing being moved.
 * Naming that here, rather than letting each caller reach for a constant, is
 * what stops a second module looking a work paper's move up under an auditee
 * response's rules.
 */
export function enumTypeForEntity(entityType: string): string | null {
  // Only the entity this module owns. Naming the action plan's workflow here
  // too would be a second spelling of a constant that already exists
  // (`actionPlanActions.ts`), which is the very drift being fixed: each workflow
  // module answers for its own entity and nobody keeps a copy of anybody else's.
  return entityType === 'work_paper' ? WORK_PAPER_ENUM_TYPE : null;
}

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
   * The matrix grant the actor must hold to reach this status, on top of the
   * engine's required_role, when no move into it says otherwise.
   *
   * A matrix cell, not a derived `WORK_PAPERS.*` string (Build Prompt 55). The
   * derived list is a second representation of the same grant, and a second
   * representation is a second thing that can be wrong: an auditor holding
   * `WORK_PAPER.update` could still fail a `perms.includes('WORK_PAPERS.submit')`
   * check, and nothing on the access-control screen would explain why. The
   * workflow now asks the matrix the administrator actually edits.
   *
   * A status can be reached by more than one move, and the moves need not belong
   * to the same person, so `TRANSITION_GRANTS` below states the grant per
   * `from -> to` pair and this is the fallback for the moves it does not name.
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

// Keyed by target status, and the grant here is the default for every move into
// it; `TRANSITION_GRANTS` below overrides it where a move belongs to somebody
// else. The permission mapping preserves the source: submit, review (and request
// revision), approve, send. The response cycle is a reviewer activity here (the
// auditee portal is a later prompt), so it also gates on review. Only
// `finding_shared` is a confirmed seeded template; the other template codes are
// documented assumptions and enqueue best-effort.
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

const UPDATE_GRANT: Grant = { module: 'WORK_PAPER', action: 'update' };
const APPROVE_GRANT: Grant = { module: 'WORK_PAPER', action: 'approve' };

/**
 * The matrix grant a single move requires, stated per `from -> to` pair.
 *
 * The grant belongs to the move, not to the status it lands on, because the
 * same status is reached by two different people's work (Build Prompt 56). A
 * finding arrives at Submitted only by its auditor releasing it, from Draft or
 * from Revision Required, and an auditor holds `update`, never `approve`;
 * gating every move on one blanket permission refused the auditor the one
 * action that is theirs, with the engine's own "not permitted" wording, while
 * the transition row allowed it all along.
 *
 * Only the moves whose grant differs from their target's default are named
 * here; every other move falls back to the catalogue entry for the status it
 * reaches, so a workflow row this list does not mention is still gated.
 */
const TRANSITION_GRANTS: ReadonlyArray<{ from: string; to: string; grant: Grant }> = [
  // The auditor's own moves: releasing a draft, and releasing it again after a
  // reviewer has sent it back.
  { from: WP_STATUS.DRAFT, to: WP_STATUS.SUBMITTED, grant: UPDATE_GRANT },
  { from: WP_STATUS.REVISION_REQUIRED, to: WP_STATUS.SUBMITTED, grant: UPDATE_GRANT },
  // The head of audit's moves: the verdict on a review, and the release to the
  // auditee.
  { from: WP_STATUS.UNDER_REVIEW, to: WP_STATUS.APPROVED, grant: APPROVE_GRANT },
  { from: WP_STATUS.UNDER_REVIEW, to: WP_STATUS.REVISION_REQUIRED, grant: APPROVE_GRANT },
  { from: WP_STATUS.APPROVED, to: WP_STATUS.SENT_TO_AUDITEE, grant: APPROVE_GRANT },
];

/**
 * The matrix grant a move requires, or null when the target is not an action
 * this application knows how to perform.
 *
 * This is the single mapping both paths ask: the detail's offer and its single
 * Submit, and the list's tick boxes and its batch release. The batch is many
 * submissions, not a different kind of submission, so it may not hold a second
 * copy of the answer.
 *
 * Comparison is whitespace and case tolerant for the same reason
 * `actionForTarget` is: `status_transitions` is operator-managed data.
 */
export function grantForTransition(fromStatus: string, toStatus: string): Grant | null {
  const from = normaliseStatus(fromStatus);
  const to = normaliseStatus(toStatus);
  const named = TRANSITION_GRANTS.find(
    (t) => normaliseStatus(t.from) === from && normaliseStatus(t.to) === to,
  );
  if (named) return named.grant;
  return actionForTarget(toStatus)?.grant ?? null;
}

/**
 * The catalogue's own spelling of a target status, or null when it names no
 * action this application performs.
 *
 * What a transition row spells is what an operator typed; what the application
 * stores has to be the one value every query, filter and label already uses. So
 * a move offered from a row reading `submitted ` is performed as `Submitted`
 * (Build Prompt 57). Without this, tolerating the row's spelling on the way in
 * would write it straight into `work_papers.status` on the way out, and a
 * status nothing else matches is a worse fault than the one being fixed.
 */
export function canonicalTarget(target: string): string | null {
  if (ACTIONS[target]) return target;
  const wanted = normaliseStatus(target);
  if (wanted === '') return null;
  for (const status of Object.keys(ACTIONS)) {
    if (normaliseStatus(status) === wanted) return status;
  }
  return null;
}

/** The statuses in which the record's fields may be edited; every other status is read-only. */
export function editableStatuses(): readonly string[] {
  return [WP_STATUS.DRAFT, WP_STATUS.REVISION_REQUIRED];
}

/** Whether a work paper in this status may be edited (Draft or Revision Required). */
export function isEditable(status: string): boolean {
  return editableStatuses().includes(status);
}
