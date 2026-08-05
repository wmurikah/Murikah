/**
 * The auditee response round rules, pure and import-free so node strips types
 * and unit-tests this directly (the same convention as the other workflow
 * catalogues).
 *
 * Validity of the parent work paper's move is NOT decided here: submitting a
 * response, accepting it and sending it back are ordinary work-paper
 * transitions, so `status_transitions` (with its `required_role` and
 * `requires_comment`) stays the authority, exactly as it does everywhere else.
 * What this module carries is what the transition tables do not: which
 * work-paper status each review decision targets, how the round number moves,
 * and the deadline arithmetic.
 *
 * The lifecycle is: a finding is Sent to Auditee, the auditee submits a
 * management response (Response Received), and the reviewer either accepts it
 * (Response Reviewed) or requests changes, which reopens the finding to the
 * auditee (Sent to Auditee) on the next round.
 */

/** The status recorded on an `auditee_responses` row. */
export const RESPONSE_STATUS = {
  SUBMITTED: 'SUBMITTED',
  ACCEPTED: 'ACCEPTED',
  CHANGES_REQUESTED: 'CHANGES_REQUESTED',
} as const;

/** The `response_type` recorded on a round. */
export const RESPONSE_TYPE = {
  MANAGEMENT_RESPONSE: 'MANAGEMENT_RESPONSE',
} as const;

export type ReviewDecision = 'accept' | 'request_changes';

/** A reviewer's decision, or null when the value did not come from the form. */
export function parseDecision(raw: string | null): ReviewDecision | null {
  if (raw === 'accept' || raw === 'request_changes') return raw;
  return null;
}

/** The response status a decision records on the round being reviewed. */
export function statusForDecision(decision: ReviewDecision): string {
  return decision === 'accept' ? RESPONSE_STATUS.ACCEPTED : RESPONSE_STATUS.CHANGES_REQUESTED;
}

/**
 * The round number after a decision: accepting closes the current round, while
 * requesting changes opens the next one for the auditee.
 */
export function nextRound(currentRound: number, decision: ReviewDecision): number {
  const current = Number.isFinite(currentRound) && currentRound > 0 ? Math.floor(currentRound) : 1;
  return decision === 'accept' ? current : current + 1;
}

/** The default when an organisation has not configured its own value. */
export const DEFAULT_RESPONSE_DEADLINE_DAYS = 14;
export const DEFAULT_MAX_RESPONSE_ROUNDS = 3;

/** A configured positive integer, or the fallback when unset or nonsense. */
export function configuredNumber(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * The response deadline: the day the finding was sent plus the organisation's
 * allowance. Null when the finding carries no sent date, so the screen shows
 * "no deadline set" rather than inventing one.
 */
export function responseDeadline(sentDate: string | null, days: number): string | null {
  if (!sentDate) return null;
  const sent = Date.parse(sentDate);
  if (Number.isNaN(sent)) return null;
  return new Date(sent + days * 86400000).toISOString().slice(0, 10);
}

export interface DeadlineState {
  /** Whole days until the deadline; negative once it has passed. */
  daysRemaining: number | null;
  overdue: boolean;
  /** Due today or within two days, and not yet overdue. */
  dueSoon: boolean;
}

/** How a deadline stands relative to now, for the auditee's prominent banner. */
export function deadlineState(deadline: string | null, now: number = Date.now()): DeadlineState {
  if (!deadline) return { daysRemaining: null, overdue: false, dueSoon: false };
  const due = Date.parse(deadline);
  if (Number.isNaN(due)) return { daysRemaining: null, overdue: false, dueSoon: false };
  const daysRemaining = Math.floor((due - now) / 86400000);
  return {
    daysRemaining,
    overdue: daysRemaining < 0,
    dueSoon: daysRemaining >= 0 && daysRemaining <= 2,
  };
}

/** True once the rounds allowance is used up, so the cycle escalates instead of looping. */
export function roundsExhausted(round: number, maxRounds: number): boolean {
  return round > maxRounds;
}
