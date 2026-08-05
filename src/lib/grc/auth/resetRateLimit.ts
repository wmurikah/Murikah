/**
 * Best-effort rate limiting for the forgot-password endpoint, per email and per
 * IP, in a fixed window held in isolate memory. A Worker isolate is recycled
 * without notice, so this alone is not a guarantee; the durable backstop is the
 * per-user cap on recent password_reset_tokens rows checked in the endpoint.
 * Together they bound both address enumeration (per IP, including unknown
 * emails that never reach the database) and mailbox flooding (per email).
 *
 * Import-free and clock-injected, so node strips types and unit-tests this
 * directly.
 */

export const RESET_WINDOW_MS = 15 * 60 * 1000;
export const RESET_EMAIL_LIMIT = 3;
export const RESET_IP_LIMIT = 10;

interface Window {
  startMs: number;
  count: number;
}

const byEmail = new Map<string, Window>();
const byIp = new Map<string, Window>();

function hit(map: Map<string, Window>, key: string, nowMs: number, limit: number): boolean {
  const w = map.get(key);
  if (!w || nowMs - w.startMs >= RESET_WINDOW_MS) {
    map.set(key, { startMs: nowMs, count: 1 });
    return true;
  }
  w.count += 1;
  return w.count <= limit;
}

/**
 * Record one request and say whether it is within both limits. A blank IP (no
 * forwarding header) is counted under a shared bucket, so a flood without an
 * IP is still bounded.
 */
export function allowResetRequest(email: string, ip: string | null, nowMs: number): boolean {
  const emailOk = hit(byEmail, email.trim().toLowerCase(), nowMs, RESET_EMAIL_LIMIT);
  const ipOk = hit(byIp, ip?.trim() || 'unknown', nowMs, RESET_IP_LIMIT);
  return emailOk && ipOk;
}

/** Clear the windows (tests only). */
export function resetRateLimitState(): void {
  byEmail.clear();
  byIp.clear();
}
