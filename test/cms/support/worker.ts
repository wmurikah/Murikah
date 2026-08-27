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
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
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
  private inspectorPort = 0;
  private log = '';
  private stateDir = join(tmpdir(), `cms-worker-${randomUUID()}`);
  private cookies = new Map<string, string>();

  /** The fake database, for arranging state and asserting rows. */
  get db() {
    if (!this.turso) throw new Error('worker not started');
    return this.turso.db;
  }

  get serverLog(): string {
    return this.log;
  }

  /** The port the worker is listening on, for a client other than `call`. */
  get portNumber(): number {
    return this.port;
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
    this.inspectorPort = await freePort();

    // The binary directly, not through `npx`. A wrapper process takes the
    // SIGTERM in stop() and wrangler beneath it survives, which is how a run
    // leaves a worker behind holding a port and a build.
    this.wrangler = spawn(
      join(REPO_ROOT, 'node_modules', '.bin', 'wrangler'),
      [
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
        // Its own state directory, so a run leaves nothing for the next one to
        // inherit and two `wrangler dev` instances in the same suite (the GRC
        // smoke test boots one too) never share .wrangler/state.
        '--persist-to',
        this.stateDir,
        // Its own inspector port. Wrangler binds one whether or not a debugger
        // ever attaches, and it defaults to 9229 for every session, so two
        // concurrent instances would contend for a port neither test uses.
        '--inspector-port',
        String(this.inspectorPort),
      ],
      { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    this.wrangler.stdout?.on('data', (d: Buffer) => (this.log += d.toString()));
    this.wrangler.stderr?.on('data', (d: Buffer) => (this.log += d.toString()));

    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        // A fresh worker answers the sign-in page. Anything else, including a
        // connection that hangs, counts as not ready yet.
        const probe = await this.call('GET', '/login', { cookie: null });
        if (probe.status === 200) return;
      } catch {
        // Not listening yet, or not answering. Either way, wait and retry.
      }
      await delay(1000);
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
        // A timeout is not optional here. Without one, a connection that is
        // accepted but never answered blocks the whole run indefinitely, which
        // is exactly what a half-started worker does, and the symptom is a
        // suite that appears to hang rather than a test that fails.
        { host: '127.0.0.1', port: this.port, method, path, headers, timeout: 15_000 },
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
      req.on('timeout', () => {
        req.destroy(new Error(`request to ${method} ${path} timed out`));
      });
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
    // SIGTERM asks; SIGKILL insists. Wrangler shuts workerd down on the signal,
    // which takes a moment, so give it one and then stop waiting. Leaving the
    // child alive holds the test process open, and a `wrangler dev` that
    // outlives its run is also how the next run ends up talking to a stale
    // build on a port it thought was free.
    const child = this.wrangler;
    this.wrangler = null;
    if (child) {
      child.kill('SIGTERM');
      for (let i = 0; i < 20 && child.exitCode === null && child.signalCode === null; i++) {
        await delay(250);
      }
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    await this.turso?.close();
    this.turso = null;
    // Leave nothing behind: a stale state directory is how the next run
    // inherits this one's problems.
    try {
      rmSync(this.stateDir, { recursive: true, force: true });
    } catch {
      // Best effort.
    }
  }
}
