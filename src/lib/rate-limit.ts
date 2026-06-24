/**
 * Minimal KV-backed rate limiter (fixed counter with a TTL window). Degrades to
 * "allow" when the KV binding is absent (e.g. local dev without KV configured),
 * so the endpoints keep working. Not a distributed-perfect limiter — adequate to
 * blunt form abuse for the framework scaffold.
 */
export interface RateLimitResult {
  ok: boolean;
  remaining: number;
}

export async function rateLimit(
  kv: KVNamespace | undefined,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  if (!kv) return { ok: true, remaining: limit };

  const storageKey = `rl:${key}`;
  const current = Number.parseInt((await kv.get(storageKey)) ?? '0', 10) || 0;

  if (current >= limit) return { ok: false, remaining: 0 };

  // Always (re)set the TTL — this behaves as a rolling window, which is fine
  // (and slightly stricter) for abuse prevention.
  await kv.put(storageKey, String(current + 1), { expirationTtl: windowSeconds });
  return { ok: true, remaining: limit - current - 1 };
}
