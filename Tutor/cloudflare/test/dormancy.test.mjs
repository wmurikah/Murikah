import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build, transform } from 'esbuild';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import vm from 'node:vm';

const directory = await mkdtemp(join(tmpdir(), 'tutor-dormancy-'));
let worker;
let TutorContainer;
try {
  const output = join(directory, 'worker.mjs');
  await build({
    entryPoints: [new URL('../src/index.ts', import.meta.url).pathname],
    outfile: output, bundle: true, format: 'esm', platform: 'node',
    plugins: [{ name: 'container-runtime', setup(builder) {
      builder.onResolve({ filter: /^@cloudflare\/containers$/ }, () => ({ path: 'container', namespace: 'test' }));
      builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: `
        export class Container {
          constructor(ctx) { this.ctx = ctx; }
          async start(options) { this.ctx.starts.push(options); this.ctx.container.running = true; }
          async stop() { this.ctx.stops++; this.ctx.container.running = false; }
          async getState() { return { status: this.ctx.container.running ? 'running' : 'stopped' }; }
          async fetch(request) { this.ctx.proxies++; return new Response('Tutor app', {headers: {'x-path': new URL(request.url).pathname}}); }
        }
        export function getContainer(namespace, name) { return namespace.getByName(name); }
      ` }));
    } }],
  });
  ({ default: worker, TutorContainer } = await import(pathToFileURL(output)));
} finally {
  await rm(directory, { recursive: true, force: true });
}

const origin = 'https://tutor.murikah.com';
const testAuthSecret = randomBytes(32).toString('hex');
const testAdminPassword = randomBytes(24).toString('base64url');
function fixture({ configured = true } = {}) {
  const ctx = {
    starts: [], stops: 0, proxies: 0, probes: 0,
    container: { running: false, getTcpPort() { return { fetch: async () => {
      ctx.probes++; return new Response('healthy');
    } }; } },
  };
  const container = new TutorContainer(ctx);
  const env = {
    TUTOR_CONTAINER: { getByName: () => container },
    MURIKAH_TUTOR_AUTH_SECRET: configured ? testAuthSecret : '',
    MURIKAH_TUTOR_ADMIN_PASSWORD: configured ? testAdminPassword : '',
    MURIKAH_TUTOR_RUNTIME: 'test',
  };
  const request = (path, init) => worker.fetch(new Request(origin + path, init), env);
  const wake = () => request('/__muri/wake', {
    method: 'POST', headers: { origin, accept: 'application/json' },
  });
  return { ctx, container, request, wake };
}

test('passive navigation, unknown paths and health probes never start compute', async () => {
  const { ctx, request } = fixture();
  for (const path of ['/', '/missing', '/health', '/__muri/runtime-status', '/__muri/runtime-revision', '/robots.txt', '/favicon.ico']) {
    const response = await request(path);
    assert.ok([200, 204, 503].includes(response.status));
  }
  assert.equal(ctx.starts.length, 0);
  assert.equal(ctx.probes, 0);
  assert.equal(ctx.proxies, 0);
});

test('wake and isolated diagnostics reject GET and cross-origin POST', async () => {
  const { ctx, request } = fixture();
  for (const path of ['/__muri/wake', '/__muri/container-diagnostics']) {
    assert.equal((await request(path)).status, 405);
    assert.equal((await request(path, { method: 'POST' })).status, 403);
    assert.equal((await request(path, { method: 'POST', headers: { origin: 'https://other.example' } })).status, 403);
  }
  assert.equal(ctx.starts.length, 0);
});

test('explicit wake uses SDK startup with runtime configuration and issues an admission cookie', async () => {
  const { ctx, request, wake } = fixture();
  const response = await wake();
  assert.equal(response.status, 200);
  assert.equal(ctx.starts.length, 1);
  assert.equal(ctx.starts[0].envVars.MURIKAH_TUTOR_AUTH_SECRET, testAuthSecret);
  const cookie = response.headers.get('set-cookie');
  assert.match(cookie, /Secure; HttpOnly; SameSite=Lax/);
  const app = await request('/api/chat?thread=example', { headers: { cookie: cookie.split(';')[0] } });
  assert.equal(await app.text(), 'Tutor app');
  assert.equal(app.headers.get('x-path'), '/api/chat');
  assert.equal(ctx.proxies, 1);
  assert.equal(ctx.starts.length, 1);
});

test('a crawler or forged cookie cannot proxy traffic to an already warm app', async () => {
  const { ctx, request, wake } = fixture();
  await wake();
  await request('/');
  await request('/api/chat', { headers: { cookie: '__Host-murikah-tutor-open=9999999999.fake' } });
  assert.equal(ctx.proxies, 0);
});

test('missing runtime secrets fail closed without starting or issuing a cookie', async () => {
  const { ctx, wake } = fixture({ configured: false });
  const response = await wake();
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(ctx.starts.length, 0);
});

test('status checks stay read-only and report stopped state even after warm responses were cached', async () => {
  const { ctx, request, wake } = fixture();
  const opened = await wake();
  await request('/', { headers: { cookie: opened.headers.get('set-cookie').split(';')[0] } });
  ctx.container.running = false;
  const response = await request('/__muri/runtime-status');
  assert.equal((await response.json()).running, false);
  assert.equal(ctx.starts.length, 1);
  assert.equal(ctx.proxies, 1);
});

test('idle expiry gracefully stops the container and proxy races do not restart it', async () => {
  const { ctx, container, wake } = fixture();
  await wake();
  assert.equal(container.sleepAfter, '30m');
  await container.onActivityExpired();
  assert.equal(ctx.stops, 1);
  assert.equal((await container.fetch(new Request(origin))).status, 503);
  assert.equal(ctx.starts.length, 1);
});

test('dormant landing page does no polling or automatic wake until Open Tutor is selected', async () => {
  const { request } = fixture();
  const html = await (await request('/')).text();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const listeners = {};
  const elements = Object.fromEntries(['wake', 'status', 'small', 'progress'].map((id) => [id, {
    addEventListener(name, handler) { listeners[id + ':' + name] = handler; },
    querySelector() { return {}; },
  }]));
  const calls = [];
  vm.runInNewContext(script, {
    document: { hidden: false, getElementById: (id) => elements[id], addEventListener() {} },
    fetch: async (path) => { calls.push(path); return { ok: true, json: async () => ({ running: true, ready: false }) }; },
    setTimeout: () => {}, clearTimeout() {}, location: { reload() {} },
  });
  assert.deepEqual(calls, []);
  await listeners['wake:submit']({ preventDefault() {} });
  assert.deepEqual(calls, ['/__muri/wake', '/__muri/runtime-status']);
});

for (const [product, start, end, functionName] of [
  ['Engr', 'let bellRefreshing = false;', 'function startBellPolling()', 'refreshBell'],
  ['GRC', 'let refreshing = false;', 'setInterval(refresh, 60000);', 'refresh'],
]) {
  test(`${product} pauses hidden-tab polling and coalesces overlapping refreshes`, async () => {
    const source = await readFile(new URL(`../../../${product}/src/layouts/${product === 'Engr' ? 'Engr' : 'Grc'}Layout.astro`, import.meta.url), 'utf8');
    const fragment = source.slice(source.indexOf(start), source.indexOf(end));
    const { code } = await transform(fragment, { loader: 'ts' });
    let calls = 0;
    let finish;
    const document = { hidden: true, querySelectorAll: () => [] };
    const context = vm.createContext({ document, applyCounts() {}, fetch: () => {
      calls++;
      return new Promise((resolve) => { finish = () => resolve({ ok: true, json: async () => ({}) }); });
    } });
    vm.runInContext(code + `;globalThis.refreshUnderTest = ${functionName};`, context);
    await context.refreshUnderTest();
    assert.equal(calls, 0);
    document.hidden = false;
    const pending = context.refreshUnderTest();
    await context.refreshUnderTest();
    assert.equal(calls, 1);
    finish();
    await pending;
    const next = context.refreshUnderTest();
    assert.equal(calls, 2);
    finish();
    await next;
  });
}
