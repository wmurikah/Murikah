/**
 * Durable sign-in telemetry over the live `login_attempts` and
 * `security_events` tables: every attempt is recorded (success or failure with
 * its reason), the throttle reads failure streaks from the same rows, and
 * lockouts and MFA failures land in security_events. Durable storage means the
 * throttle survives Worker isolate recycling, unlike an in-memory counter.
 * Column names come from the typed schema layer.
 */
import type { Client } from '@libsql/client/web';
import { C, cols } from '@grc/schema/columns';
import { windowStartIso } from '@grc/auth/loginThrottle';

const LA = cols(C.login_attempts);
const SE = cols(C.security_events);

export type FailureReason = 'unknown_email' | 'bad_password' | 'locked_out' | 'mfa_failed' | null;

export interface AttemptRecord {
  email: string;
  userId: string | null;
  organizationId: string | null;
  success: boolean;
  failureReason: FailureReason;
  ip: string | null;
  userAgent: string | null;
}

/** Record one attempt. Best-effort: telemetry never fails the sign-in itself. */
export async function recordLoginAttempt(db: Client, a: AttemptRecord): Promise<void> {
  try {
    await db.execute({
      sql: `INSERT INTO login_attempts
              (${LA.attempt_id}, ${LA.email}, ${LA.user_id}, ${LA.organization_id}, ${LA.success},
               ${LA.failure_reason}, ${LA.ip_address}, ${LA.user_agent}, ${LA.attempted_at})
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        crypto.randomUUID(),
        a.email,
        a.userId,
        a.organizationId,
        a.success ? 1 : 0,
        a.failureReason,
        a.ip,
        a.userAgent,
        new Date().toISOString(),
      ],
    });
  } catch (err) {
    console.error('[grc.auth.attempts] attempt record failed', err);
  }
}

export interface FailureStreaks {
  byEmail: number;
  byIp: number;
}

/**
 * The failure streaks the throttle decides from: failures inside the window
 * and since the key's last success, per email and per IP.
 */
export async function failureStreaks(
  db: Client,
  email: string,
  ip: string | null,
): Promise<FailureStreaks> {
  const since = windowStartIso(Date.now());
  const emailRes = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM login_attempts
           WHERE ${LA.email} = ? AND ${LA.success} = 0 AND ${LA.attempted_at} > ?
             AND ${LA.attempted_at} > COALESCE(
               (SELECT MAX(${LA.attempted_at}) FROM login_attempts
                 WHERE ${LA.email} = ? AND ${LA.success} = 1), '')`,
    args: [email, since, email],
  });
  let byIp = 0;
  if (ip && ip.trim() !== '') {
    const ipRes = await db.execute({
      sql: `SELECT COUNT(*) AS n FROM login_attempts
             WHERE ${LA.ip_address} = ? AND ${LA.success} = 0 AND ${LA.attempted_at} > ?`,
      args: [ip, since],
    });
    byIp = Number(ipRes.rows[0]?.n ?? 0);
  }
  return { byEmail: Number(emailRes.rows[0]?.n ?? 0), byIp };
}

export interface SecurityEvent {
  eventType: string;
  severity: 'info' | 'warning' | 'critical';
  userId: string | null;
  actorEmail: string | null;
  ip: string | null;
  details: string;
}

/** Record a security event. Best-effort, tagged on failure. */
export async function recordSecurityEvent(db: Client, e: SecurityEvent): Promise<void> {
  try {
    await db.execute({
      sql: `INSERT INTO security_events
              (${SE.event_id}, ${SE.occurred_at}, ${SE.event_type}, ${SE.severity}, ${SE.user_id},
               ${SE.actor_email}, ${SE.ip_address}, ${SE.details})
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        crypto.randomUUID(),
        new Date().toISOString(),
        e.eventType,
        e.severity,
        e.userId,
        e.actorEmail,
        e.ip,
        e.details,
      ],
    });
  } catch (err) {
    console.error('[grc.auth.attempts] security event record failed', err);
  }
}
