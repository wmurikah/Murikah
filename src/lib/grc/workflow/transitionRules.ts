/**
 * The data-driven workflow engine, pure half.
 *
 * The audit system does not hard-code status enums. The allowed values live in
 * `enum_values`, the allowed moves in `status_transitions` (each with a
 * `required_role` and a `requires_comment` flag), and the end states in
 * `workflow_terminal_states`. This module holds the pure decision: given those
 * rows (loaded elsewhere, scoped to the organisation) and an attempted change,
 * it says whether the change is allowed and why not. Keeping it free of imports
 * and IO lets it be unit tested directly and reused by every module, so the
 * exact ported workflow is enforced in one place.
 *
 * Every status comparison here goes through `sameStatus`, so the surrounding
 * whitespace and the casing an operator-managed reference row can carry never
 * decide a move (Build Prompt 57). Storage is untouched: the caller still writes
 * the canonical value, only the comparison is forgiving.
 */

/** One allowed transition, as read from `status_transitions`. */
export interface TransitionRule {
  fromStatus: string;
  toStatus: string;
  /** The role code required to make this move, or null when any role may. */
  requiredRole: string | null;
  /** Whether a comment must accompany the move. */
  requiresComment: boolean;
}

export interface TransitionAttempt {
  from: string;
  to: string;
  /** The acting user's single role code. */
  roleCode: string;
  /** A platform owner is not bound by required_role, mirroring the acting-org tier. */
  isPlatformOwner?: boolean;
  /** The comment supplied with the change, if any. */
  comment?: string | null;
}

export type TransitionOutcome =
  | { ok: true; rule: TransitionRule }
  | { ok: false; code: 'terminal' | 'not_allowed' | 'role' | 'comment'; message: string };

const hasText = (v: string | null | undefined): boolean => typeof v === 'string' && v.trim() !== '';

/**
 * A status reduced to what it means, for comparison only, never for storage.
 *
 * `enum_values`, `status_transitions` and `workflow_terminal_states` are
 * operator-managed reference rows. A trailing space in `from_status`, or a
 * `to_status` typed in a different case, is invisible on every screen that
 * displays it and matched nothing at all here, so a move the workflow plainly
 * defines was refused as "not permitted" and the row that refused it looked
 * correct to everyone who read it (Build Prompt 57). Build Prompt 55 made the
 * work-paper catalogue tolerant; the engine that decides the move was still
 * comparing raw strings, which is the comparison that produces that message.
 */
export function normaliseStatus(status: string | null | undefined): string {
  return String(status ?? '')
    .trim()
    .toLowerCase();
}

/** Whether two stored statuses name the same state, whitespace and case aside. */
export function sameStatus(a: string | null | undefined, b: string | null | undefined): boolean {
  return normaliseStatus(a) === normaliseStatus(b);
}

/**
 * Decide whether a status change is allowed.
 *
 * Order of checks, so the message is the most specific true reason:
 *  1. the current status is terminal, nothing may leave it;
 *  2. no transition row permits from -> to;
 *  3. the transition needs a role the actor does not hold (a platform owner is exempt);
 *  4. the transition needs a comment and none was given.
 */
export function evaluateTransition(
  rules: TransitionRule[],
  terminalStates: readonly string[],
  attempt: TransitionAttempt,
): TransitionOutcome {
  if (terminalStates.some((terminal) => sameStatus(terminal, attempt.from))) {
    return {
      ok: false,
      code: 'terminal',
      message: `"${attempt.from}" is an end state and cannot change.`,
    };
  }

  const match = rules.find(
    (r) => sameStatus(r.fromStatus, attempt.from) && sameStatus(r.toStatus, attempt.to),
  );
  if (!match) {
    return {
      ok: false,
      code: 'not_allowed',
      message: `A move from "${attempt.from}" to "${attempt.to}" is not permitted.`,
    };
  }

  const exempt = attempt.isPlatformOwner === true;
  if (match.requiredRole && !exempt && match.requiredRole !== attempt.roleCode) {
    return {
      ok: false,
      code: 'role',
      message: `Only ${match.requiredRole} may make this change.`,
    };
  }

  if (match.requiresComment && !hasText(attempt.comment)) {
    return {
      ok: false,
      code: 'comment',
      message: 'This change requires a comment.',
    };
  }

  return { ok: true, rule: match };
}

/** The set of statuses reachable from a status by the actor, for rendering the allowed actions. */
export function allowedNextStatuses(
  rules: TransitionRule[],
  terminalStates: readonly string[],
  from: string,
  roleCode: string,
  isPlatformOwner = false,
): string[] {
  if (terminalStates.some((terminal) => sameStatus(terminal, from))) return [];
  const exempt = isPlatformOwner;
  return rules
    .filter((r) => sameStatus(r.fromStatus, from))
    .filter((r) => !r.requiredRole || exempt || r.requiredRole === roleCode)
    .map((r) => r.toStatus);
}
