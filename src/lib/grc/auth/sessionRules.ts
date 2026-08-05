/**
 * Session liveness rules: the absolute expiry and the sliding idle window,
 * decided from timestamps so the repo stays a thin query layer and the rule is
 * unit-testable. Import-free.
 */

/** A session idle beyond this is dead, regardless of its absolute expiry. */
export const SESSION_IDLE_SECONDS = 60 * 60; // 60 minutes

/** How stale last_seen_at may be before a resolve refreshes it (bounds writes). */
export const SESSION_TOUCH_INTERVAL_SECONDS = 60;

export interface SessionLiveness {
  alive: boolean;
  /** Why a dead session died, for logging. */
  reason: 'expired' | 'idle' | null;
  /** Whether the resolver should stamp a fresh last_seen_at. */
  shouldTouch: boolean;
}

/**
 * Decide whether a session is still alive. A missing last_seen_at (a row from
 * before the idle rule) falls back to the absolute expiry alone and is stamped
 * on first use.
 */
export function sessionLiveness(
  expiresAtIso: string | null,
  lastSeenAtIso: string | null,
  nowMs: number,
): SessionLiveness {
  if (expiresAtIso) {
    const expires = Date.parse(expiresAtIso);
    if (!Number.isNaN(expires) && expires <= nowMs) {
      return { alive: false, reason: 'expired', shouldTouch: false };
    }
  }
  if (lastSeenAtIso) {
    const seen = Date.parse(lastSeenAtIso);
    if (!Number.isNaN(seen)) {
      if (nowMs - seen > SESSION_IDLE_SECONDS * 1000) {
        return { alive: false, reason: 'idle', shouldTouch: false };
      }
      return {
        alive: true,
        reason: null,
        shouldTouch: nowMs - seen > SESSION_TOUCH_INTERVAL_SECONDS * 1000,
      };
    }
  }
  return { alive: true, reason: null, shouldTouch: true };
}
