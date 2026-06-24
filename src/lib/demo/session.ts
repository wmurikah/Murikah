/**
 * Anonymous demo sessions. The session id is a UUID held in an httpOnly,
 * SameSite=Lax cookie (Secure in production). We never store a raw IP, only a
 * salted hash, and a truncated user-agent. A visitor can only read and write
 * their own session's data.
 */
import type { APIContext } from 'astro';
import { DEMO_COOKIE, SESSION_TTL_SECONDS } from './config';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DemoSession {
  id: string;
  isNew: boolean;
}

/** Read the session cookie, or create a new session and set the cookie. */
export function getOrCreateSession(context: APIContext): DemoSession {
  const existing = context.cookies.get(DEMO_COOKIE)?.value;
  if (existing && UUID_RE.test(existing)) {
    return { id: existing, isNew: false };
  }

  const id = crypto.randomUUID();
  context.cookies.set(DEMO_COOKIE, id, {
    httpOnly: true,
    // Secure in production (https); relaxed on http://localhost for local dev.
    secure: context.url.protocol === 'https:',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  });
  return { id, isNew: true };
}

/** Salted SHA-256 of an IP, truncated. Never store the raw IP. */
export async function hashIp(ip: string, salt: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${salt}:${ip}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
}
