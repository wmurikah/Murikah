import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import ts from 'typescript';
import {
  hasSensitiveGrant,
  isSensitiveMutationPath,
  requiredMfaStage,
  safeMfaNext,
} from '../src/lib/engr/auth/mfaGate.ts';
import { requireFreshMfa, sensitiveActionDecision } from '../src/lib/engr/auth/sensitiveAction.ts';
import { safeAttachmentUrl } from '../src/lib/engr/auth/attachmentUrls.ts';

const origin = 'https://engr.murikah.com';

test('approval and payment grants require enrollment, then a fresh challenge', () => {
  for (const grant of [
    'lpo.approve',
    'cost.approve',
    'bill.approve.finance',
    'rfq.award',
    'payment.record',
    'payment.reverse',
    'users.assign_roles',
    'roles.manage',
  ]) {
    assert.equal(hasSensitiveGrant([grant]), true, grant);
  }
  assert.equal(hasSensitiveGrant(['requests.view', 'rfq.create']), false);
  assert.equal(
    requiredMfaStage({
      mandatory: true,
      enabled: false,
      verifiedAt: 0,
      now: 2000,
      privilegedPath: true,
    }),
    'enroll',
  );
  assert.equal(
    requiredMfaStage({
      mandatory: true,
      enabled: true,
      verifiedAt: 1000,
      now: 2000,
      privilegedPath: true,
    }),
    'challenge',
  );
  assert.equal(
    requiredMfaStage({
      mandatory: true,
      enabled: true,
      verifiedAt: 1500,
      now: 2000,
      privilegedPath: true,
    }),
    null,
  );
  assert.equal(
    requiredMfaStage({
      mandatory: true,
      enabled: true,
      verifiedAt: 2001,
      now: 2000,
      privilegedPath: true,
    }),
    'challenge',
  );
  assert.equal(
    sensitiveActionDecision({ engr: { mfaEnabled: true, mfaVerifiedAt: 1400 } }, 2000),
    'allow',
  );
  assert.equal(
    sensitiveActionDecision({ engr: { mfaEnabled: true, mfaVerifiedAt: 1399 } }, 2000),
    'challenge',
  );
  assert.equal(
    sensitiveActionDecision({ engr: { mfaEnabled: true, mfaVerifiedAt: 2001 } }, 2000),
    'challenge',
  );
  assert.equal(
    sensitiveActionDecision({ engr: { mfaEnabled: false, mfaVerifiedAt: 1400 } }, 2000),
    'enroll',
  );
});

test('mutation endpoint guard allows fresh MFA and rejects stale or unenrolled sessions', async () => {
  const now = Math.floor(Date.now() / 1000);
  const request = new Request(`${origin}/api/payments`, {
    method: 'POST',
    headers: { accept: 'application/json' },
  });
  assert.equal(
    requireFreshMfa(request, { engr: { mfaEnabled: true, mfaVerifiedAt: now - 599 } }),
    null,
  );
  const stale = requireFreshMfa(request, { engr: { mfaEnabled: true, mfaVerifiedAt: now - 601 } });
  assert.equal(stale?.status, 403);
  assert.equal((await stale?.json()).error, 'mfa_required');
  const unenrolled = requireFreshMfa(request, { engr: { mfaEnabled: false, mfaVerifiedAt: 0 } });
  assert.equal(unenrolled?.status, 403);
  assert.equal((await unenrolled?.json()).error, 'mfa_enrollment_required');
  const form = new Request(`${origin}/api/lpos/lpo-1/approve`, {
    method: 'POST',
    headers: {
      accept: 'text/html',
      referer: `${origin}/lpos/lpo-1`,
    },
  });
  const redirect = requireFreshMfa(form, { engr: { mfaEnabled: true, mfaVerifiedAt: now - 601 } });
  assert.equal(redirect?.status, 303);
  assert.equal(redirect?.headers.get('location'), '/mfa/challenge?next=%2Flpos%2Flpo-1');
  const hostile = new Request(`${origin}/api/lpos/lpo-1/approve`, {
    method: 'POST',
    headers: {
      accept: 'text/html',
      referer: 'https://evil.example/lpos/lpo-1',
    },
  });
  assert.equal(
    requireFreshMfa(hostile, { engr: { mfaEnabled: true, mfaVerifiedAt: now - 601 } })?.headers.get(
      'location',
    ),
    '/mfa/challenge?next=%2F',
  );
});

test('every consequential mutation route invokes the fresh-MFA endpoint guard', () => {
  const paths = [
    'lpos/[id]/approve.ts',
    'lpos/[id]/issue.ts',
    'lpos/[id]/cancel.ts',
    'lpos/[id]/close.ts',
    'lpos/[id]/mileage/decision.ts',
    'rfqs/[id]/award.ts',
    'rfqs/[id]/procurement-decision.ts',
    'rfqs/[id]/release.ts',
    'payments/index.ts',
    'payments/[id]/reverse.ts',
    'bills/[id]/decision.ts',
    'costs/[id]/decision.ts',
    'requests/[id]/accept.ts',
    'requests/[id]/reject.ts',
    'requests/[id]/assign-contractor.ts',
    'admin/roles.ts',
    'admin/users.ts',
    'org/switch.ts',
    'workorders/[id]/cancel.ts',
  ];
  for (const path of paths) {
    const route = readFileSync(join(import.meta.dirname, '../src/pages/engr/api', path), 'utf8');
    assert.match(
      route,
      /if \(!engr\) return jsonResponse\([^;]+;\s*const mfaGate = requireFreshMfa\(request, locals\);\s*if \(mfaGate\) return mfaGate;/,
      path,
    );
  }
  for (const path of [
    '/api/lpos/123/approve',
    '/api/rfqs/123/award',
    '/api/rfqs/123/procurement-decision',
    '/api/bills/123/decision',
    '/api/payments',
    '/api/payments/123/reverse',
    '/api/admin/users',
    '/api/admin/roles',
    '/api/org/switch',
  ]) {
    assert.equal(isSensitiveMutationPath(path, 'POST'), true, path);
    assert.equal(isSensitiveMutationPath(path, 'GET'), false, path);
  }
  assert.equal(isSensitiveMutationPath('/api/payments/123', 'POST'), false);
});

test('MFA redirect stays on an allowed application page', () => {
  assert.equal(safeMfaNext('/admin/users?tab=active', origin), '/admin/users?tab=active');
  assert.equal(safeMfaNext('/lpos/123', origin), '/lpos/123');
  for (const candidate of [
    '//evil.example',
    '/\\evil.example',
    '/%5cevil.example',
    '/%2fevil.example',
    'https://evil.example',
    '/api/org/switch',
    '/mfa/challenge',
    '/admin/%2F%2Fevil.example',
    '/\n/evil.example',
  ]) {
    assert.equal(safeMfaNext(candidate, origin), '/', candidate);
  }
});

test('attachment links require an exact approved HTTPS host and cannot use common redirect forms', () => {
  const hosts = 'files.hasspetroleum.com, tenant.sharepoint.com';
  assert.equal(
    safeAttachmentUrl('https://files.hasspetroleum.com/photo.jpg', hosts),
    'https://files.hasspetroleum.com/photo.jpg',
  );
  assert.equal(
    safeAttachmentUrl('https://tenant.sharepoint.com/sites/engineering/photo.jpg', hosts),
    'https://tenant.sharepoint.com/sites/engineering/photo.jpg',
  );
  for (const candidate of [
    'javascript:alert(1)',
    'data:text/html,hello',
    'http://files.hasspetroleum.com/photo.jpg',
    '//files.hasspetroleum.com/photo.jpg',
    'https://files.hasspetroleum.com@evil.example/photo.jpg',
    'https://files.hasspetroleum.com.evil.example/photo.jpg',
    'https://evil-files.hasspetroleum.com/photo.jpg',
    'https://files.hasspetroleum.com:8443/photo.jpg',
    'https://files.hasspetroleum.com/redirect?url=https://evil.example',
    'https://files.hasspetroleum.com/other?next=https://evil.example',
    'https://files.hasspetroleum.com/%2Fredirect',
    `https://files.hasspetroleum.com/${'x'.repeat(501)}`,
  ]) {
    assert.equal(safeAttachmentUrl(candidate, hosts), null, candidate);
  }
  assert.equal(safeAttachmentUrl('https://files.hasspetroleum.com/photo.jpg', undefined), null);
  const detail = readFileSync(
    join(import.meta.dirname, '../src/pages/engr/requests/[id].astro'),
    'utf8',
  );
  assert.match(detail, /safeUrl: safeAttachmentUrl\(item\.fileUrl,/);
  assert.match(detail, /href=\{a\.safeUrl\}/);
  assert.doesNotMatch(detail, /href=\{a\.fileUrl\}/);
});

/** Execute representative real route handlers with their database and workflow
 * dependencies replaced, so the test proves a denied POST cannot reach a write. */
async function loadMutationRoute(path: string): Promise<(context: object) => Promise<Response>> {
  const stub = (source: string) =>
    `data:text/javascript,${encodeURIComponent(source).replaceAll("'", '%27')}`;
  const files = join(import.meta.dirname, '../src');
  const modules: Record<string, string> = {
    '@engr/auth/sensitiveAction': pathToFileURL(join(files, 'lib/engr/auth/sensitiveAction.ts'))
      .href,
    '@engr/env': stub(
      "export const getEngrEnv = () => ({ attachmentAllowedHosts: 'files.hasspetroleum.com' });",
    ),
    '@engr/db': stub(`export const getDb = async () => ({ execute: async (query) => {
      if (query.sql.includes('FROM stations')) return { rows: [{ id: 'station-1' }] };
      if (query.sql.includes('INSERT INTO attachments')) {
        globalThis.__securityWrites++;
        globalThis.__attachmentStored = query.args[4];
      }
      return { rows: [] };
    } });`),
    '@engr/repos/lpos': stub(
      'export const approveLpo = async () => { globalThis.__securityWrites++; return { ok: true }; };',
    ),
    '@engr/repos/payments': stub(
      'export const reversePayment = async () => { globalThis.__securityWrites++; return { ok: true }; };',
    ),
    '@engr/workflow/rfqAward': stub(
      "export const awardRfq = async () => { globalThis.__securityWrites++; return { ok: true, outcome: 'sent_to_procurement' }; };",
    ),
    '@engr/repos/quotes': stub(
      'export const selectPreferredQuote = async () => { globalThis.__securityWrites++; return { ok: true }; };',
    ),
    '@engr/auth/rbac': stub('export const requirePermission = () => {};'),
    '@engr/repos/requests': stub(`
      export const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
      export const createRequest = async () => { globalThis.__securityWrites++; return { id: 'req-1', requestNo: 'SR-1' }; };
      export const listQueue = async () => [];
    `),
    '@engr/repos/engineerAssignments': stub(
      'export const resolveEngineerInCharge = async () => null;',
    ),
    '@engr/repos/approvers': stub('export const usersWithPermission = async () => [];'),
    '@engr/notify': stub('export const enqueue = async () => {};'),
    '@engr/auth/dataScope': stub("export const actorDataScope = () => 'org';"),
    '@engr/auth/attachmentUrls': pathToFileURL(join(files, 'lib/engr/auth/attachmentUrls.ts')).href,
    '@engr/workflow/respond': stub(`
      export const jsonResponse = (value, status) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
      export const wantsJson = (request) => request.headers.get('accept')?.includes('application/json');
      export const redirectResponse = () => new Response(null, { status: 303, headers: { location: '/' } });
      export const readBody = async (request) => request.json();
      export const str = (value) => String(value ?? '');
    `),
  };
  let source = readFileSync(join(files, 'pages/engr/api', path), 'utf8');
  for (const [alias, target] of Object.entries(modules)) {
    source = source.replaceAll(`'${alias}'`, `'${target}'`);
  }
  const javascript = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const imported = await import(
    `data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`
  );
  return imported.POST;
}

test('approval, award and reversal endpoints block writes until an enrolled user verifies MFA', async () => {
  const globalState = globalThis as typeof globalThis & { __securityWrites: number };
  const cases = [
    {
      path: 'lpos/[id]/approve.ts',
      url: `${origin}/api/lpos/lpo-1/approve`,
      permission: 'lpo.approve',
    },
    { path: 'rfqs/[id]/award.ts', url: `${origin}/api/rfqs/rfq-1/award`, permission: 'rfq.award' },
    {
      path: 'payments/[id]/reverse.ts',
      url: `${origin}/api/payments/pay-1/reverse`,
      permission: 'payment.reverse',
    },
  ];
  for (const entry of cases) {
    const POST = await loadMutationRoute(entry.path);
    const request = () =>
      new Request(entry.url, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ quote_id: 'quote-1', intent: 'award' }),
      });
    const actor = { orgId: 'org-1', userId: 'user-1', perms: [entry.permission], roles: [] };
    const now = Math.floor(Date.now() / 1000);
    globalState.__securityWrites = 0;
    const unenrolled = await POST({
      request: request(),
      locals: { engr: { ...actor, mfaEnabled: false, mfaVerifiedAt: 0 } },
      params: { id: 'item-1' },
    });
    assert.equal(unenrolled.status, 403, entry.path);
    assert.equal(globalState.__securityWrites, 0, entry.path);
    const stale = await POST({
      request: request(),
      locals: { engr: { ...actor, mfaEnabled: true, mfaVerifiedAt: now - 601 } },
      params: { id: 'item-1' },
    });
    assert.equal(stale.status, 403, entry.path);
    assert.equal(globalState.__securityWrites, 0, entry.path);
    const fresh = await POST({
      request: request(),
      locals: { engr: { ...actor, mfaEnabled: true, mfaVerifiedAt: now - 1 } },
      params: { id: 'item-1' },
    });
    assert.equal(fresh.status, 200, entry.path);
    assert.equal(globalState.__securityWrites, 1, entry.path);
  }
  delete (globalState as { __securityWrites?: number }).__securityWrites;
});

test('request-create endpoint rejects unsafe attachment URLs before inserting a request', async () => {
  const POST = await loadMutationRoute('requests/index.ts');
  const globalState = globalThis as typeof globalThis & {
    __securityWrites: number;
    __attachmentStored?: string;
  };
  const context = (attachmentUrl: string) => ({
    request: new Request(`${origin}/api/requests`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        station_id: 'station-1',
        issue: 'Pump stopped',
        attachment_url: attachmentUrl,
      }),
    }),
    locals: { engr: { orgId: 'org-1', userId: 'user-1', roles: [], perms: ['requests.create'] } },
  });
  globalState.__securityWrites = 0;
  for (const value of [
    'javascript:alert(1)',
    'https://files.hasspetroleum.com.evil.example/p.jpg',
    'https://files.hasspetroleum.com/redirect?url=https://evil.example',
  ]) {
    const response = await POST(context(value));
    assert.equal(response.status, 422, value);
    assert.equal(globalState.__securityWrites, 0, value);
  }
  const accepted = await POST(context('https://files.hasspetroleum.com/photo.jpg'));
  assert.equal(accepted.status, 201);
  assert.equal(globalState.__securityWrites, 2);
  assert.equal(globalState.__attachmentStored, 'https://files.hasspetroleum.com/photo.jpg');
  delete (globalState as { __securityWrites?: number }).__securityWrites;
  delete globalState.__attachmentStored;
});
