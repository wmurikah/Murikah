/**
 * Boots the built worker locally for the smoke test: an in-process fake Turso
 * server seeded with the demo data, then `wrangler dev` on the build output
 * (dist/server/wrangler.json) with the GRC bindings pointed at the fake server.
 * Requests are made with a raw node:http client that pins the Host header to
 * grc.localhost (the worker routes by host) and carries the session cookie jar.
 *
 * The worker's own log output is buffered and replayed on failure, so a 500
 * found by the smoke test arrives together with the tagged server-side cause.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { FakeTursoServer } from './fakeTurso.ts';
import { seedDatabase, SMOKE_SESSION_SECRET } from './seed.ts';
import { FakeS3Server } from './fakeS3.ts';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const WRANGLER_CONFIG = join(REPO_ROOT, 'dist', 'server', 'wrangler.json');
const SCHEMA_MD = join(REPO_ROOT, 'grc', 'db', 'schema.md');
const HOST = 'grc.localhost';
const BOOT_TIMEOUT_MS = 120_000;

/**
 * A posted form. A plain object for the common case; URLSearchParams when a key
 * repeats, as the batch release does with one work_paper_id per selected draft.
 */
export type SmokeForm = Record<string, string> | URLSearchParams;

/** A file part of a multipart post: the bytes, and how they are announced. */
export interface SmokeUpload {
  field: string;
  filename: string;
  contentType: string;
  content: string;
}

export interface SmokeResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export class SmokeServer {
  private turso: FakeTursoServer | null = null;
  private s3: FakeS3Server | null = null;
  /** The harness's S3 stand-in, so a test can restore a connection it broke. */
  s3Origin = '';
  private wrangler: ChildProcess | null = null;
  private port = 0;
  private serverLog = '';
  private cookies = new Map<string, string>();

  /** The worker's buffered stdout and stderr, for failure diagnostics. */
  get log(): string {
    return this.serverLog;
  }

  /** The seeded database itself, so a verification script can read state back. */
  get database(): FakeTursoServer['db'] | null {
    return this.turso ? this.turso.db : null;
  }

  async start(): Promise<void> {
    if (!existsSync(WRANGLER_CONFIG)) {
      // The smoke test runs against the build output; build it when absent so a
      // plain `pnpm test` works from a clean checkout.
      const build = spawnSync('pnpm', ['build'], { cwd: REPO_ROOT, stdio: 'inherit' });
      if (build.status !== 0) throw new Error('pnpm build failed; cannot run the smoke test');
    }

    this.turso = new FakeTursoServer(SCHEMA_MD);
    // Somewhere the R2 connection test can actually succeed, so the smoke run
    // can prove that a passing test activates a provider (Build Prompt 54).
    this.s3 = new FakeS3Server();
    this.s3Origin = await this.s3.listen();
    await seedDatabase(this.turso.db, this.s3Origin);
    const dbUrl = await this.turso.listen();

    this.port = 20000 + Math.floor(Math.random() * 20000);
    this.wrangler = spawn(
      'pnpm',
      [
        'exec',
        'wrangler',
        'dev',
        '--config',
        WRANGLER_CONFIG,
        '--port',
        String(this.port),
        '--ip',
        '127.0.0.1',
        '--show-interactive-dev-session=false',
        '--var',
        `TURSO_GRC_DATABASE_URL:${dbUrl}`,
        '--var',
        'TURSO_GRC_AUTH_TOKEN:smoke-token',
        '--var',
        // The session signer base64-decodes the secret, so it must be base64.
        // Shared with the seed, which seals the storage connection with it.
        `GRC_SESSION_SECRET:${SMOKE_SESSION_SECRET}`,
      ],
      {
        cwd: REPO_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' },
      },
    );
    this.wrangler.stdout?.on('data', (d: Buffer) => (this.serverLog += d.toString()));
    this.wrangler.stderr?.on('data', (d: Buffer) => (this.serverLog += d.toString()));

    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    for (;;) {
      if (Date.now() > deadline) {
        throw new Error(`worker did not come up on port ${this.port}\n${this.serverLog}`);
      }
      if (this.wrangler.exitCode !== null) {
        throw new Error(`wrangler exited with ${this.wrangler.exitCode}\n${this.serverLog}`);
      }
      try {
        const res = await this.rawRequest('GET', '/login', undefined, false);
        if (res.status > 0) break;
      } catch {
        // Not listening yet.
      }
      await delay(500);
    }
  }

  async stop(): Promise<void> {
    if (this.wrangler) {
      this.wrangler.kill('SIGTERM');
      // Give wrangler a moment to shut workerd down before force-killing.
      for (let i = 0; i < 20 && this.wrangler.exitCode === null; i++) await delay(250);
      if (this.wrangler.exitCode === null) this.wrangler.kill('SIGKILL');
      this.wrangler = null;
    }
    if (this.turso) {
      await this.turso.close();
      this.turso = null;
    }
    if (this.s3) {
      await this.s3.close();
      this.s3 = null;
    }
  }

  /** Forget the session, as a browser losing its cookies would. */
  clearCookies(): void {
    this.cookies.clear();
  }

  /**
   * Take a copy of the cookie jar, and put one back. Two signed-in actors in one
   * test need their own jars: proving that an access change reaches a session
   * that is already open means holding that session while another one changes
   * the matrix underneath it.
   */
  exportCookies(): Map<string, string> {
    return new Map(this.cookies);
  }

  importCookies(jar: Map<string, string>): void {
    this.cookies = new Map(jar);
  }

  private storeCookies(setCookie: string | string[] | undefined): void {
    const list = typeof setCookie === 'string' ? [setCookie] : (setCookie ?? []);
    for (const raw of list) {
      const pair = raw.split(';')[0];
      const eq = pair.indexOf('=');
      if (eq < 1) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  private cookieHeader(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  /**
   * A multipart post, for the one thing a urlencoded body cannot carry: a file.
   * An owner fulfilling a requirement uploads the document with the form
   * (Build Prompt 58), and a smoke run that posted only the note would prove the
   * half of that path which never touches the evidence store.
   */
  async postMultipart(
    path: string,
    fields: Record<string, string>,
    upload?: SmokeUpload,
  ): Promise<SmokeResponse> {
    const boundary = `----murikahsmoke${'0'.repeat(8)}`;
    const parts: string[] = [];
    for (const [name, value] of Object.entries(fields)) {
      parts.push(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      );
    }
    if (upload) {
      parts.push(
        `--${boundary}\r\nContent-Disposition: form-data; name="${upload.field}"; ` +
          `filename="${upload.filename}"\r\nContent-Type: ${upload.contentType}\r\n\r\n` +
          `${upload.content}\r\n`,
      );
    }
    parts.push(`--${boundary}--\r\n`);
    return this.rawRequest('POST', path, undefined, true, {
      body: parts.join(''),
      contentType: `multipart/form-data; boundary=${boundary}`,
    });
  }

  private rawRequest(
    method: string,
    path: string,
    form?: SmokeForm,
    useCookies = true,
    raw?: { body: string; contentType: string },
  ): Promise<SmokeResponse> {
    // URLSearchParams as well as a plain object, because a form can legitimately
    // repeat a key: the batch release posts one work_paper_id per finding
    // selected (Build Prompt 53), which an object cannot express.
    const body =
      raw !== undefined
        ? raw.body
        : form === undefined
          ? undefined
          : form instanceof URLSearchParams
            ? form.toString()
            : Object.entries(form)
                .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
                .join('&');
    const headers: Record<string, string> = { host: HOST };
    if (useCookies && this.cookies.size > 0) headers.cookie = this.cookieHeader();
    if (method !== 'GET') {
      // Astro's origin check rejects cross-origin form posts; we are same-origin.
      headers.origin = `http://${HOST}`;
    }
    if (body !== undefined) {
      headers['content-type'] = raw?.contentType ?? 'application/x-www-form-urlencoded';
      headers['content-length'] = String(Buffer.byteLength(body));
    }
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        { host: '127.0.0.1', port: this.port, path, method, headers },
        (res) => {
          let data = '';
          res.on('data', (c: Buffer) => (data += c.toString()));
          res.on('end', () => {
            this.storeCookies(res.headers['set-cookie']);
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data });
          });
        },
      );
      // A wedged worker must fail the step, not hang the whole run: without
      // this, a dev-proxy socket that accepts but never answers blocks forever.
      req.setTimeout(30_000, () => {
        req.destroy(new Error(`no response within 30s for ${method} ${path}`));
      });
      req.on('error', reject);
      if (body !== undefined) req.write(body);
      req.end();
    });
  }

  /**
   * A single request, no redirect following. wrangler dev occasionally restarts
   * workerd mid-request (a transport failure, not an app response), surfacing as
   * a connection error or its "worker restarted mid-request" 503; those never
   * reached the app, so they are retried a couple of times before counting.
   */
  async request(method: 'GET' | 'POST', path: string, form?: SmokeForm): Promise<SmokeResponse> {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await this.rawRequest(method, path, form);
        const restarted = res.status === 503 && res.body.includes('restarted mid-request');
        if (!restarted || attempt >= 2) return res;
      } catch (err) {
        if (attempt >= 2) throw err;
      }
      await delay(750);
    }
  }

  /** A GET following same-host redirects, returning the final response and the hops. */
  async get(path: string, maxHops = 6): Promise<SmokeResponse & { hops: string[] }> {
    const hops: string[] = [path];
    let current = path;
    for (let i = 0; i < maxHops; i++) {
      const res = await this.request('GET', current);
      const location = res.headers.location;
      if (res.status >= 300 && res.status < 400 && typeof location === 'string') {
        current = location.startsWith('http')
          ? new URL(location).pathname + new URL(location).search
          : location;
        hops.push(current);
        continue;
      }
      return { ...res, hops };
    }
    throw new Error(`redirect loop: ${hops.join(' -> ')}`);
  }
}
