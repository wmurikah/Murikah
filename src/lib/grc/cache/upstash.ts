/**
 * The documented swap: an external Redis, reached over HTTP.
 *
 * Upstash exposes Redis as a REST endpoint, which is the only shape a Worker can
 * speak (there is no TCP socket and no in-process server). This satisfies the
 * same contract as the KV default, so switching is a matter of setting two
 * secrets: no call site names a backend, and none of them change.
 *
 *   wrangler secret put GRC_CACHE_REDIS_URL     # https://<db>.upstash.io
 *   wrangler secret put GRC_CACHE_REDIS_TOKEN   # the REST token
 *
 * cache/index.ts prefers this over KV whenever both are present. Redis honours
 * the exact TTL and deletes immediately, so the same code then gets tighter
 * lifetimes for free; the envelope expiry stays in place regardless, as the
 * backend-independent guarantee.
 *
 * `fetchImpl` is injectable so the adapter can be exercised in the unit tests
 * without a network.
 */
import type { GrcCache } from './types.ts';

export interface UpstashConfig {
  /** The REST base URL, e.g. https://eu2-example-12345.upstash.io */
  url: string;
  /** The REST bearer token. A runtime secret, never committed. */
  token: string;
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

interface UpstashBody {
  result?: unknown;
  error?: string;
}

export class UpstashCache implements GrcCache {
  readonly name = 'upstash-redis';
  readonly shared = true;

  private readonly config: UpstashConfig;
  private readonly fetchImpl: FetchLike;

  constructor(config: UpstashConfig, fetchImpl?: FetchLike) {
    this.config = config;
    this.fetchImpl = fetchImpl ?? ((input, init) => fetch(input, init));
  }

  private async command(args: (string | number)[]): Promise<unknown> {
    const res = await this.fetchImpl(this.config.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.config.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(args),
    });
    if (!res.ok) throw new Error(`Upstash responded ${res.status}`);
    const body = (await res.json()) as UpstashBody;
    if (typeof body.error === 'string' && body.error !== '') throw new Error(body.error);
    return body.result ?? null;
  }

  async get(key: string): Promise<string | null> {
    const result = await this.command(['GET', key]);
    return typeof result === 'string' ? result : null;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.command(['SET', key, value, 'EX', Math.max(1, Math.ceil(ttlSeconds))]);
  }

  async delete(key: string): Promise<void> {
    await this.command(['DEL', key]);
  }

  async deleteNamespace(prefix: string): Promise<number> {
    if (prefix === '') return 0;
    let cursor = '0';
    let removed = 0;
    do {
      const page = await this.command(['SCAN', cursor, 'MATCH', `${prefix}*`, 'COUNT', 500]);
      if (!Array.isArray(page) || page.length < 2) break;
      cursor = String(page[0]);
      const keys = Array.isArray(page[1]) ? page[1].map((k) => String(k)) : [];
      if (keys.length > 0) {
        await this.command(['DEL', ...keys]);
        removed += keys.length;
      }
    } while (cursor !== '0');
    return removed;
  }
}
