/**
 * The requirement loop, pure and import-free so it can be unit tested and reused
 * (Build Prompt 58).
 *
 * A requirement is a request for information with two sides. Audit asks, an
 * owner provides, audit reads what came back and either accepts it, which ends
 * the ask, or says what is still missing, which sends it round again. Every
 * round is a `requirement_submissions` row carrying both halves: what the owner
 * gave, and what audit said to it.
 *
 * THE STATUS IS DERIVED, NEVER TYPED IN. This module computes the status from
 * the facts that produced it: whether the requirement is closed, and how audit
 * answered the latest round. That is the same rule migration 005 established for
 * receipt, and for the same reason: a status typed in beside the record can
 * disagree with it, and then nobody can tell which of the two is lying. The
 * repository writes the derived value into `work_paper_requirements.status` so
 * SQL filters and reports keep working, but the screens ask this function.
 */

/** The four states a requirement can be in, as stored in `status`. */
export const REQUIREMENT_STATUS = {
  /** Asked for, nothing provided yet, or nothing provided since the last ask. */
  OUTSTANDING: 'OUTSTANDING',
  /** The owner has provided something and audit has not yet answered it. */
  AWAITING_REVIEW: 'AWAITING_REVIEW',
  /** Audit read it and asked for more; it is the owner's move again. */
  MORE_INFO: 'MORE_INFO',
  /** Audit accepted it. The ask is over. */
  CLOSED: 'CLOSED',
} as const;

export type RequirementStatus = (typeof REQUIREMENT_STATUS)[keyof typeof REQUIREMENT_STATUS];

/** How audit answered one round, as stored in `requirement_submissions.review_status`. */
export const REVIEW_STATUS = {
  /** Provided, not yet reviewed. */
  PENDING: 'PENDING',
  /** Accepted: this round satisfied the requirement. */
  ACCEPTED: 'ACCEPTED',
  /** Not enough: `additional_info_request` says what else is wanted. */
  MORE_INFO: 'MORE_INFO',
} as const;

export type ReviewStatus = (typeof REVIEW_STATUS)[keyof typeof REVIEW_STATUS];

/** The one-word label a screen shows for a status. */
const STATUS_LABELS: Record<string, string> = {
  [REQUIREMENT_STATUS.OUTSTANDING]: 'Outstanding',
  [REQUIREMENT_STATUS.AWAITING_REVIEW]: 'Awaiting review',
  [REQUIREMENT_STATUS.MORE_INFO]: 'More info',
  [REQUIREMENT_STATUS.CLOSED]: 'Closed',
};

/**
 * The label for a stored status.
 *
 * Rows written before this module carry free text ('OPEN', 'PENDING',
 * 'RECEIVED'), and they are labelled rather than hidden: an unknown code reads
 * as itself, which is honest, instead of being silently relabelled as one of the
 * four states nobody has actually put it in.
 */
export function requirementStatusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

/** The statuses offered as a filter, in lifecycle order. */
export const REQUIREMENT_STATUS_FILTERS: readonly RequirementStatus[] = [
  REQUIREMENT_STATUS.OUTSTANDING,
  REQUIREMENT_STATUS.AWAITING_REVIEW,
  REQUIREMENT_STATUS.MORE_INFO,
  REQUIREMENT_STATUS.CLOSED,
];

/** What the derivation needs to know: the close state and the latest round. */
export interface RequirementState {
  /** Set when audit accepted a round; the ask is over. */
  closedAt?: string | null;
  /**
   * The legacy receipt date (migration 005). A requirement marked received
   * before this module existed had its ask answered, so it reads as closed
   * rather than reappearing on somebody's list years later.
   */
  receivedDate?: string | null;
  /** `review_status` of the newest round, or null when nothing was provided. */
  latestReviewStatus?: string | null;
  /** Whether any round exists at all. */
  hasSubmission?: boolean;
}

/**
 * The status a requirement is actually in.
 *
 * Order matters: closed wins over everything, because an accepted requirement
 * that later shows "awaiting review" would be a reopened ask nobody made.
 */
export function requirementStatus(state: RequirementState): RequirementStatus {
  if (state.closedAt) return REQUIREMENT_STATUS.CLOSED;
  if (!state.hasSubmission) {
    return state.receivedDate ? REQUIREMENT_STATUS.CLOSED : REQUIREMENT_STATUS.OUTSTANDING;
  }
  const review = state.latestReviewStatus ?? REVIEW_STATUS.PENDING;
  if (review === REVIEW_STATUS.MORE_INFO) return REQUIREMENT_STATUS.MORE_INFO;
  if (review === REVIEW_STATUS.ACCEPTED) return REQUIREMENT_STATUS.CLOSED;
  return REQUIREMENT_STATUS.AWAITING_REVIEW;
}

/** Whether the owner's side is open: they are the ones who have to act next. */
export function awaitsOwner(status: RequirementStatus): boolean {
  return status === REQUIREMENT_STATUS.OUTSTANDING || status === REQUIREMENT_STATUS.MORE_INFO;
}

/** Whether audit is the one holding it up. */
export function awaitsAudit(status: RequirementStatus): boolean {
  return status === REQUIREMENT_STATUS.AWAITING_REVIEW;
}

/** The round number a new submission takes: the next one, counting from one. */
export function nextRound(rounds: number): number {
  return (Number.isFinite(rounds) && rounds > 0 ? Math.floor(rounds) : 0) + 1;
}

/** The two decisions audit can make on a round. */
export type ReviewDecision = 'accept' | 'more_info';

/** Whether a posted decision is one this module performs. */
export function isReviewDecision(value: string): value is ReviewDecision {
  return value === 'accept' || value === 'more_info';
}

/** The `review_status` a decision stores. */
export function reviewStatusFor(decision: ReviewDecision): ReviewStatus {
  return decision === 'accept' ? REVIEW_STATUS.ACCEPTED : REVIEW_STATUS.MORE_INFO;
}

/**
 * The outstanding question an owner is answering this round, if any: the
 * additional information audit asked for when it sent the last round back.
 * Anything else, including an accepted round, leaves nothing to answer.
 */
export function openInfoRequest(
  latest: { reviewStatus?: string | null; additionalInfoRequest?: string | null } | null,
): string | null {
  if (!latest || latest.reviewStatus !== REVIEW_STATUS.MORE_INFO) return null;
  const asked = (latest.additionalInfoRequest ?? '').trim();
  return asked === '' ? null : asked;
}
