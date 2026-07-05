/**
 * The action-plan workflow catalogue, pure and import-free so it can be unit
 * tested and reused. As with work papers, validity is decided by the engine
 * (status_transitions, required_role, requires_comment); this carries what the
 * engine does not: per transition, the WORK_PLANS permission (when the action is
 * an auditor or Head-of-Audit one), whether it is an owner action, whether it
 * needs evidence, the side effect to apply, and the notification to enqueue.
 *
 * The lifecycle is Not Due, Pending, In Progress, Overdue, Implemented, Pending
 * Verification, Verified, Closed, with Rejected and a Return-for-Rework path.
 * Status values and column names follow the operator's schema patch and are
 * documented in grc/docs/schema-assumptions.md.
 */

export const ACTION_PLAN_ENUM_TYPE = 'ACTION_PLAN_STATUS';

// Statuses are the human-readable strings the hassaudit schema stores in
// action_plans.status and keys status_transitions by (Build Prompt 16); they are
// not short codes. These labels are the single source the workflow, the stats
// bar and the queries share, so none of them drift from the database.
export const AP_STATUS = {
  NOT_DUE: 'Not Due',
  PENDING: 'Pending',
  IN_PROGRESS: 'In Progress',
  OVERDUE: 'Overdue',
  IMPLEMENTED: 'Implemented',
  PENDING_VERIFICATION: 'Pending Verification',
  VERIFIED: 'Verified',
  CLOSED: 'Closed',
  REJECTED: 'Rejected',
} as const;

/** The side effect a transition applies beyond setting the status. */
export type EffectKind = 'none' | 'implement' | 'auditor_review' | 'hoa_review';

export interface ApActionMeta {
  /** The permission an auditor or HOA action requires; null for an owner action gated only by the engine role and ownership. */
  permission: string | null;
  /** True when only an owner of the plan (or a platform owner) may perform it. */
  ownerAction: boolean;
  /** True when the plan must carry evidence first (mark as implemented). */
  requiresEvidence: boolean;
  effect: EffectKind;
  /** The email_templates code to enqueue, if any. */
  notifyTemplate?: string;
  label: string;
}

const key = (from: string, to: string): string => `${from}>${to}`;

// Keyed by (from -> to). Mark-as-implemented is reachable from several states;
// return-for-rework and HOA-reject both target In Progress but differ in
// permission and effect, which is why the map is keyed by the pair, not the
// target alone.
const ACTIONS: Record<string, ApActionMeta> = {};
function def(froms: string[], to: string, meta: ApActionMeta): void {
  for (const from of froms) ACTIONS[key(from, to)] = meta;
}

// Owner marks the plan implemented (needs evidence) -> Pending Verification.
def(
  [
    AP_STATUS.PENDING,
    AP_STATUS.NOT_DUE,
    AP_STATUS.IN_PROGRESS,
    AP_STATUS.OVERDUE,
    AP_STATUS.REJECTED,
  ],
  AP_STATUS.PENDING_VERIFICATION,
  {
    permission: null,
    ownerAction: true,
    requiresEvidence: true,
    effect: 'implement',
    notifyTemplate: 'action_implemented',
    label: 'Mark as implemented',
  },
);
// Auditor verifies -> Verified.
def([AP_STATUS.PENDING_VERIFICATION], AP_STATUS.VERIFIED, {
  permission: 'ACTION_PLANS.verify',
  ownerAction: false,
  requiresEvidence: false,
  effect: 'auditor_review',
  notifyTemplate: 'action_verified',
  label: 'Verify',
});
// Auditor returns for rework -> In Progress.
def([AP_STATUS.PENDING_VERIFICATION], AP_STATUS.IN_PROGRESS, {
  permission: 'ACTION_PLANS.verify',
  ownerAction: false,
  requiresEvidence: false,
  effect: 'auditor_review',
  notifyTemplate: 'action_returned',
  label: 'Return for rework',
});
// Auditor rejects -> Rejected.
def([AP_STATUS.PENDING_VERIFICATION], AP_STATUS.REJECTED, {
  permission: 'ACTION_PLANS.verify',
  ownerAction: false,
  requiresEvidence: false,
  effect: 'auditor_review',
  notifyTemplate: 'action_rejected',
  label: 'Reject',
});
// Head of Audit closes -> Closed.
def([AP_STATUS.VERIFIED], AP_STATUS.CLOSED, {
  permission: 'ACTION_PLANS.close',
  ownerAction: false,
  requiresEvidence: false,
  effect: 'hoa_review',
  notifyTemplate: 'action_closed',
  label: 'Approve and close',
});
// Head of Audit rejects a verification -> In Progress.
def([AP_STATUS.VERIFIED], AP_STATUS.IN_PROGRESS, {
  permission: 'ACTION_PLANS.close',
  ownerAction: false,
  requiresEvidence: false,
  effect: 'hoa_review',
  notifyTemplate: 'action_returned',
  label: 'Reject verification',
});

/** The action metadata for a transition pair, or null when not a catalogued action. */
export function actionForTransition(from: string, to: string): ApActionMeta | null {
  return ACTIONS[key(from, to)] ?? null;
}

// ---- Status sets, for the stats bar, filters and role visibility -----------

export const PENDING_SET: readonly string[] = [
  AP_STATUS.PENDING,
  AP_STATUS.NOT_DUE,
  AP_STATUS.IN_PROGRESS,
];
export const IMPLEMENTED_SET: readonly string[] = [
  AP_STATUS.IMPLEMENTED,
  AP_STATUS.PENDING_VERIFICATION,
];
export const VERIFIED_SET: readonly string[] = [AP_STATUS.VERIFIED, AP_STATUS.CLOSED];
// Past-due plans in these states are not counted as overdue (the work is done).
export const OVERDUE_EXCLUDE_SET: readonly string[] = [
  AP_STATUS.IMPLEMENTED,
  AP_STATUS.PENDING_VERIFICATION,
  AP_STATUS.VERIFIED,
  AP_STATUS.CLOSED,
];
// A board member or external auditor sees only completed-side plans.
export const BOARD_VISIBLE_SET: readonly string[] = [
  AP_STATUS.IMPLEMENTED,
  AP_STATUS.PENDING_VERIFICATION,
  AP_STATUS.VERIFIED,
  AP_STATUS.CLOSED,
];

/** Whether a plan counts as overdue: past due and not in a done state. */
export function isOverdue(status: string, daysOverdue: number): boolean {
  return daysOverdue > 0 && !OVERDUE_EXCLUDE_SET.includes(status);
}

/** An auditor may edit while the plan is not yet verified or closed. */
export function isEditableByAuditor(status: string): boolean {
  return status !== AP_STATUS.VERIFIED && status !== AP_STATUS.CLOSED;
}

/** An auditor may delete only an early-stage plan. */
const DELETABLE_SET: readonly string[] = [
  AP_STATUS.NOT_DUE,
  AP_STATUS.PENDING,
  AP_STATUS.IN_PROGRESS,
];
export function isDeletable(status: string): boolean {
  return DELETABLE_SET.includes(status);
}

/** A plan is non-terminal (delegable, evidence-uploadable) unless closed or rejected. */
export function isTerminal(status: string): boolean {
  return status === AP_STATUS.CLOSED || status === AP_STATUS.REJECTED;
}
