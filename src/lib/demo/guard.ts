/**
 * Shared guard for every demo and assistant endpoint: it establishes the
 * session, enforces the KV rate limit, and opens a best-effort Turso client.
 *
 * The demos compute their results server-side and deterministically, so they
 * still work when Turso is not configured (persistence is then skipped). The
 * rate limit degrades to "allow" when KV is absent (local dev without KV).
 */
import { env } from 'cloudflare:workers';
import type { APIContext } from 'astro';
import type { Client } from '@libsql/client/web';
import { createDbClient } from '@/lib/db';
import { rateLimit } from '@/lib/rate-limit';
import { clientIp, json } from '@/lib/http';
import { RATE_LIMITS, RATE_LIMIT_MESSAGE, type RateCategory } from './config';
import { getOrCreateSession, hashIp } from './session';

export interface DemoContext {
  sessionId: string;
  /** Turso client, or null when not configured. Treat writes as best-effort. */
  db: Client | null;
  ipHash: string;
}

/**
 * Returns a DemoContext, or a 429 Response if the rate limit is exceeded.
 * Callers do: `const g = await guard(ctx, 'demo'); if (g instanceof Response) return g;`
 */
export async function guard(
  context: APIContext,
  category: RateCategory,
): Promise<DemoContext | Response> {
  const session = getOrCreateSession(context);

  const ip = clientIp(context.request);
  const salt = env.DEMO_HASH_SALT ?? 'murikah-demo-salt';
  const ipHash = await hashIp(ip, salt);

  // Rate limit by category + session (the session falls back to the IP hash on
  // a brand-new visitor, so a missing cookie cannot bypass the limit).
  const cfg = RATE_LIMITS[category];
  // Key by the session when we have a returning cookie, else by the hashed IP,
  // so the limit stays effective even if a cookie does not persist.
  const limiterKey = `${category}:${session.isNew ? ipHash : session.id}`;
  const rl = await rateLimit(env.CACHE, limiterKey, cfg.limit, cfg.windowSeconds);
  if (!rl.ok) {
    return json({ ok: false, error: RATE_LIMIT_MESSAGE }, 429);
  }

  let db: Client | null = null;
  try {
    db = createDbClient(env);
  } catch {
    db = null; // Turso not configured; demos still work, persistence skipped.
  }

  if (db) {
    const ua = (context.request.headers.get('user-agent') ?? '').slice(0, 180);
    try {
      await db.execute({
        sql: `INSERT INTO demo_sessions (id, ip_hash, ua) VALUES (?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET last_seen_at = datetime('now')`,
        args: [session.id, ipHash, ua],
      });
    } catch {
      // best-effort; never block the demo on a logging failure
    }
  }

  return { sessionId: session.id, db, ipHash };
}
