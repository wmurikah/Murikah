/**
 * Boots the built worker against an in-process Turso stand-in, so the route
 * guards can be exercised as HTTP rather than as function calls.
 *
 * This follows the GRC smoke harness: `wrangler dev` on the build output, with
 * the CMS bindings pointed at a fake Turso server, and a raw node:http client
 * that pins the Host header (the worker routes by host) and keeps a cookie jar.
 * No browser framework is involved, and none is needed: every case section 14
 * lists is a status code, a Location header or a response body.
 *
 * Redirects are never followed automatically, because the assertion is usually
 * about the 302 itself rather than about where it lands.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { FakeCmsTurso } from './hrana.ts';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');

/** A port the operating system says is free right now. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}
const HOST = 'cms.murikah.com';
const BOOT_TIMEOUT_MS = 180_000;

export interface WorkerResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  /** The Location header, for a redirect assertion. */
  location: string | undefined;
}

export interface CallOptions {
  body?: unknown;
  /** Sent verbatim; omit to use the jar. */
  cookie?: string | null;
  /** A browser sends this on every non-GET fetch; Astro's CSRF check needs it. */
  origin?: boolean;
  accept?: string;
  form?: Record<string, string>;
  /** Override the Host header, to prove the other products are unaffected. */
  host?: string;
}

export class CmsWorker {
  private turso: FakeCmsTurso | null = null;
  private wrangler: ChildProcess | null = null;
  private port = 0;
  private log = '';
  private cookies = new Map<string, string>();

  /** The fake database, for arranging state and asserting rows. */
  get db() {
    if (!this.turso) throw new Error('worker not started');
    return this.turso.db;
  }

  get serverLog(): string {
    return this.log;
  }

  /** `ddl` is the operator's schema and seed, executed verbatim. */
  async start(ddl: string, sessionSecret: string): Promise<void> {
    this.turso = new FakeCmsTurso(ddl);
    const dbUrl = await this.turso.listen();
    // Ask the operating system for a free port rather than guessing one. A
    // guessed port collides with a worker left behind by an earlier run, and
    // the harness then talks to that stale process serving an old build, which
    // fails in ways that look like application bugs rather than like the
    // environment problem they are.
    this.port = await freePort();

    this.wrangler = spawn(
      'npx',
      [
        'wrangler',
        'dev',
        '--config',
        'dist/server/wrangler.json',
        '--port',
        String(this.port),
        '--ip',
        '127.0.0.1',
        '--var',
        `TURSO_CMS_DATABASE_URL:${dbUrl}`,
        '--var',
        'TURSO_CMS_AUTH_TOKEN:test-token',
        '--var',
        `CMS_SESSION_SECRET:${sessionSecret}`,
      ],
      { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    this.wrangler.stdout?.on('data', (d: Buffer) => (this.log += d.toString()));
    this.wrangler.stderr?.on('data', (d: Buffer) => (this.log += d.toString()));

    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const probe = await this.call('GET', '/login');
        if (probe.status > 0) return;
      } catch {
        await delay(1000);
      }
    }
    throw new Error(`worker did not start within ${BOOT_TIMEOUT_MS}ms:\n${this.log}`);
  }

  async call(method: string, path: string, options: CallOptions = {}): Promise<WorkerResponse> {
    const payload = options.form
      ? new URLSearchParams(options.form).toString()
      : options.body !== undefined
        ? JSON.stringify(options.body)
        : null;

    const headers: Record<string, string> = {
      host: options.host ?? HOST,
      'user-agent': 'HassCMS Test',
    };
    if (payload !== null) {
      headers['content-type'] = options.form
        ? 'application/x-www-form-urlencoded'
        : 'application/json';
      headers['content-length'] = String(Buffer.byteLength(payload));
    }
    if (options.accept) headers.accept = options.accept;
    // Default to behaving like a browser on any non-safe method.
    if (options.origin !== false && method !== 'GET') {
      headers.origin = `http://${options.host ?? HOST}`;
    }

    const cookie = options.cookie === undefined ? this.cookieHeader() : options.cookie;
    if (cookie) headers.cookie = cookie;

    return new Promise((resolve, reject) => {
      const req = httpRequest(
        { host: '127.0.0.1', port: this.port, method, path, headers },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            this.storeCookies(res.headers['set-cookie']);
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: data,
              location: res.headers.location,
            });
          });
        },
      );
      req.on('error', reject);
      if (payload !== null) req.write(payload);
      req.end();
    });
  }

  private storeCookies(setCookie: string[] | undefined): void {
    for (const entry of setCookie ?? []) {
      const [pair] = entry.split(';');
      const separator = pair?.indexOf('=') ?? -1;
      if (separator === -1 || !pair) continue;
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      if (value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  cookieHeader(): string | null {
    if (this.cookies.size === 0) return null;
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  sessionCookie(): string | undefined {
    return this.cookies.get('cms_session');
  }

  clearCookies(): void {
    this.cookies.clear();
  }

  async stop(): Promise<void> {
    this.wrangler?.kill('SIGTERM');
    this.turso?.close();
    await delay(200);
  }
}
