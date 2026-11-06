import type { Client } from '@libsql/client/web';
import { createSession, sessionMaxAge, type SessionPayload } from './session.ts';

export type SessionPrivilege = 'STANDARD' | 'PRIVILEGED' | 'RESTRICTED';

function privilege(payload: SessionPayload): SessionPrivilege {
  if (payload.passwordChangeOnly || payload.authStage) return 'RESTRICTED';
  if (
    payload.isPlatformOwner ||
    payload.roles.includes('OWNER') ||
    payload.roles.includes('ADMIN')
  ) {
    return 'PRIVILEGED';
  }
  return 'STANDARD';
}

async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function requestIp(request?: Request): string {
  if (!request) return 'unknown';
  return (
    request.headers.get('cf-connecting-ip') ??
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown'
  );
}

export async function createTrackedSession(
  db: Client,
  payload: SessionPayload,
  secret: string,
  secure: boolean,
  request?: Request,
): Promise<string> {
  const sessionId = crypto.randomUUID().replace(/-/g, '');
  const level = privilege(payload);
  const complete: SessionPayload = {
    ...payload,
    sessionId,
    privilegedSession: level === 'PRIVILEGED',
  };
  const now = new Date();
  const expires = new Date(now.getTime() + sessionMaxAge(complete) * 1000);
  const ip = requestIp(request);
  await db.execute({
    sql: `INSERT INTO auth_sessions
            (id, user_id, org_id, session_version, privilege_level, ip_hash, user_agent,
             created_at, last_seen_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      sessionId,
      complete.sub,
      complete.org,
      complete.sessionVersion ?? 0,
      level,
      await sha256(ip),
      request?.headers.get('user-agent')?.slice(0, 500) ?? null,
      now.toISOString(),
      now.toISOString(),
      expires.toISOString(),
    ],
  });
  await db.execute({
    sql: `INSERT INTO audit_logs
            (org_id, actor_user_id, action, entity_type, entity_id, after_json, ip, user_agent)
          VALUES (?, ?, 'auth.session.created', 'auth_session', ?, ?, ?, ?)`,
    args: [
      complete.org,
      complete.sub,
      sessionId,
      JSON.stringify({ privilege_level: level, expires_at: expires.toISOString() }),
      ip === 'unknown' ? null : ip,
      request?.headers.get('user-agent')?.slice(0, 500) ?? null,
    ],
  });
  return createSession(complete, secret, secure);
}

export async function revokeUserSessions(
  db: Client,
  userId: string,
  reason: string,
): Promise<void> {
  await db.execute({
    sql: `UPDATE auth_sessions SET revoked_at = ?, revoked_reason = ?
           WHERE user_id = ? AND revoked_at IS NULL`,
    args: [new Date().toISOString(), reason, userId],
  });
}

export const SESSION_IDLE_SECONDS: Record<SessionPrivilege, number> = {
  PRIVILEGED: 15 * 60,
  STANDARD: 2 * 60 * 60,
  RESTRICTED: 10 * 60,
};
