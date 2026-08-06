/**
 * Login throttling rules, decided from durable counts in `login_attempts`.
 * A failure streak (failures since the last success) inside the window locks
 * the email or the IP temporarily; the caller answers with the same generic
 * failure so the throttle is not an account-existence oracle. Import-free, so
 * node strips types and unit-tests this directly.
 */

/** How far back failures count. */
export const THROTTLE_WINDOW_MINUTES = 15;

/** Failures per email inside the window before that email is locked. */
export const EMAIL_MAX_FAILURES = 5;

/** Failures per IP inside the window before that IP is locked (bounds spraying). */
export const IP_MAX_FAILURES = 20;

export interface ThrottleDecision {
  locked: boolean;
  /** Which limit tripped, for the security-event detail. */
  reason: 'email' | 'ip' | null;
}

/** Decide from the recent failure streaks whether this attempt may proceed. */
export function throttleDecision(emailFailures: number, ipFailures: number): ThrottleDecision {
  if (emailFailures >= EMAIL_MAX_FAILURES) return { locked: true, reason: 'email' };
  if (ipFailures >= IP_MAX_FAILURES) return { locked: true, reason: 'ip' };
  return { locked: false, reason: null };
}

/** The ISO timestamp the failure window opens at. */
export function windowStartIso(nowMs: number): string {
  return new Date(nowMs - THROTTLE_WINDOW_MINUTES * 60 * 1000).toISOString();
}
