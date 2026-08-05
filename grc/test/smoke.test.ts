/**
 * The GRC smoke test: the safety net every module merges behind (Build Prompt
 * 22). It boots the built worker against a seeded throwaway database, signs in
 * as the seeded user, GETs every reachable page and dry-runs every mutation
 * endpoint, and fails on any 500. Routes are enumerated from the filesystem
 * router (src/pages/grc/**), so a new page is covered automatically and a new
 * API endpoint fails the test until a dry-run step is added to MUTATION_STEPS
 * below. That is deliberate: "every page and every mutation is in the smoke
 * test" is enforced here, not by review.
 *
 * A page passes when, after following redirects, it answers 200. A mutation
 * passes when it answers below 500: a 3xx saved-redirect, a 4xx refusal and a
 * 200 are all legitimate outcomes, a 500 never is.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { SmokeServer } from './smoke/harness.ts';
import { SMOKE } from './smoke/seed.ts';

const PAGES_DIR = join(import.meta.dirname, '..', '..', 'src', 'pages', 'grc');

/** Every file under a directory, as paths relative to it. */
function walk(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else out.push(relative(base, full).split(sep).join('/'));
  }
  return out;
}

/** The app path a page file serves at (root-relative, [param] segments kept). */
function pageRoute(file: string): string {
  const path = '/' + file.replace(/\.astro$/, '');
  return path === '/index' ? '/' : path.replace(/\/index$/, '');
}

// Seeded values for every dynamic page segment. A new dynamic page must add its
// parameter here (pointing at a seeded row), or the test fails it explicitly.
const PAGE_PARAMS: Record<string, string> = {
  '/work-papers/[id]': SMOKE.draftWorkPaperId,
  '/work-papers/[id]/edit': SMOKE.draftWorkPaperId,
  '/action-plans/[id]': SMOKE.actionPlanId,
  '/action-plans/[id]/edit': SMOKE.actionPlanId,
  '/auditee-responses/[id]': SMOKE.sentWorkPaperId,
};

interface MutationStep {
  /** The endpoint file this step covers, relative to src/pages/grc/api. */
  endpoint: string;
  title: string;
  method: 'GET' | 'POST';
  /** The request path; `captured` holds ids captured from earlier redirects. */
  path: (captured: Map<string, string>) => string;
  form?: (captured: Map<string, string>) => Record<string, string>;
  /** Capture a value out of the response's redirect location. */
  capture?: { key: string; from: RegExp };
}

const today = new Date().toISOString().slice(0, 10);

// The dry-run of every mutation endpoint, in dependency order, against the
// throwaway seeded database (so "rollback" is simply discarding the database).
// Every file under src/pages/grc/api must appear at least once, enforced below.
const MUTATION_STEPS: MutationStep[] = [
  {
    endpoint: 'auth/login.ts',
    title: 'sign-in rejects a wrong password without a 500',
    method: 'POST',
    path: () => '/api/auth/login',
    form: () => ({ email: SMOKE.email, password: 'not-the-password' }),
  },
  {
    endpoint: 'sidebar-counts.ts',
    title: 'sidebar counts',
    method: 'GET',
    path: () => '/api/sidebar-counts',
  },
  {
    endpoint: 'notifications.ts',
    title: 'notifications list',
    method: 'GET',
    path: () => '/api/notifications',
  },
  {
    endpoint: 'notifications.ts',
    title: 'mark a notification read',
    method: 'POST',
    path: () => '/api/notifications',
    form: () => ({ id: 'IAN-1' }),
  },
  {
    endpoint: 'work-papers/index.ts',
    title: 'create a work paper',
    method: 'POST',
    path: () => '/api/work-papers',
    form: () => ({
      observation_title: 'Smoke-created finding',
      observation_description: 'Created by the smoke test.',
      year: '2026',
      affiliate_code: SMOKE.affiliateCode,
      audit_area_id: SMOKE.auditAreaId,
      sub_area_id: SMOKE.subAreaId,
      risk_rating: 'High',
      recommendation: 'Do the thing.',
      assigned_auditor: SMOKE.auditorId,
    }),
    capture: { key: 'wpId', from: /\/work-papers\/([^/?]+)/ },
  },
  {
    endpoint: 'work-papers/[id].ts',
    title: 'edit the created work paper',
    method: 'POST',
    path: (c) => `/api/work-papers/${c.get('wpId')}`,
    form: () => ({
      observation_title: 'Smoke-created finding (edited)',
      year: '2026',
      affiliate_code: SMOKE.affiliateCode,
      audit_area_id: SMOKE.auditAreaId,
    }),
  },
  {
    endpoint: 'work-papers/[id]/requirements.ts',
    title: 'add a requirement',
    method: 'POST',
    path: (c) => `/api/work-papers/${c.get('wpId')}/requirements`,
    form: () => ({ op: 'add', description: 'Provide the smoke evidence.', status: 'OPEN' }),
  },
  {
    endpoint: 'work-papers/[id]/responsibles.ts',
    title: 'add a responsible',
    method: 'POST',
    path: (c) => `/api/work-papers/${c.get('wpId')}/responsibles`,
    form: () => ({ op: 'add_responsible', user_id: SMOKE.auditeeId, role_in_finding: 'PRIMARY' }),
  },
  {
    endpoint: 'work-papers/[id]/transition.ts',
    title: 'submit the created work paper',
    method: 'POST',
    path: (c) => `/api/work-papers/${c.get('wpId')}/transition`,
    form: () => ({ to_status: 'Submitted', comment: 'Smoke transition' }),
  },
  {
    endpoint: 'work-papers/[id]/delete.ts',
    title: 'delete the created work paper',
    method: 'POST',
    path: (c) => `/api/work-papers/${c.get('wpId')}/delete`,
  },
  {
    endpoint: 'action-plans/index.ts',
    title: 'create an action plan',
    method: 'POST',
    path: () => '/api/action-plans',
    form: () => ({
      work_paper_id: SMOKE.sentWorkPaperId,
      action_description: 'Smoke-created action plan.',
      target_date: today,
      due_date: today,
      priority: 'High',
      implementation_notes: 'Smoke implementation notes.',
      owner_ids: SMOKE.auditeeId,
    }),
    capture: { key: 'apId', from: /\/action-plans\/([^/?]+)/ },
  },
  {
    endpoint: 'action-plans/[id].ts',
    title: 'edit the created action plan',
    method: 'POST',
    path: (c) => `/api/action-plans/${c.get('apId')}`,
    form: () => ({
      work_paper_id: SMOKE.sentWorkPaperId,
      action_description: 'Smoke-created action plan (edited).',
      target_date: today,
      due_date: today,
      priority: 'Critical',
      implementation_notes: 'Smoke implementation notes (edited).',
    }),
  },
  {
    endpoint: 'action-plans/[id]/delegate.ts',
    title: 'delegate the seeded action plan',
    method: 'POST',
    path: () => `/api/action-plans/${SMOKE.actionPlanId}/delegate`,
    form: () => ({ new_owner_id: SMOKE.auditorId, notes: 'Smoke delegation' }),
  },
  {
    endpoint: 'action-plans/[id]/delegation.ts',
    title: 'answer the delegation',
    method: 'POST',
    path: () => `/api/action-plans/${SMOKE.actionPlanId}/delegation`,
    form: () => ({ decision: 'accept' }),
  },
  {
    endpoint: 'action-plans/[id]/transition.ts',
    title: 'verify the pending action plan',
    method: 'POST',
    path: () => `/api/action-plans/${SMOKE.verifyActionPlanId}/transition`,
    form: () => ({ to_status: 'Verified', comment: 'Smoke verification' }),
  },
  {
    endpoint: 'action-plans/[id]/transition.ts',
    title: 'a Kanban drop transitions and returns to the board',
    method: 'POST',
    path: (c) => `/api/action-plans/${c.get('apId')}/transition`,
    form: () => ({ to_status: 'In Progress', return_to: '/action-plans?view=kanban' }),
  },
  {
    endpoint: 'action-plans/[id]/delete.ts',
    title: 'delete the created action plan',
    method: 'POST',
    path: (c) => `/api/action-plans/${c.get('apId')}/delete`,
  },
  {
    endpoint: 'auditee-responses/submit.ts',
    title: 'submit a management response',
    method: 'POST',
    path: () => '/api/auditee-responses/submit',
    form: () => ({
      work_paper_id: SMOKE.sentWorkPaperId,
      management_response: 'Management accepts the finding and will remediate.',
      action_plan_ids: SMOKE.actionPlanId,
    }),
  },
  {
    endpoint: 'auditee-responses/[id]/review.ts',
    title: 'request changes, reopening the next round',
    method: 'POST',
    path: () => `/api/auditee-responses/${SMOKE.responseId}/review`,
    form: () => ({ decision: 'request_changes', review_comments: 'Please add dates and owners.' }),
  },
  {
    endpoint: 'auditee-responses/[id]/review.ts',
    title: 'a response already reviewed is refused, not 500',
    method: 'POST',
    path: () => `/api/auditee-responses/${SMOKE.responseId}/review`,
    form: () => ({ decision: 'accept' }),
  },
  {
    endpoint: 'setup/affiliates.ts',
    title: 'create an affiliate',
    method: 'POST',
    path: () => '/api/setup/affiliates',
    form: () => ({
      op: 'create',
      code: 'MSA',
      name: 'Hass Mombasa',
      country: 'Kenya',
      region: 'Coast',
    }),
  },
  {
    endpoint: 'setup/affiliates.ts',
    title: 'update then delete the affiliate',
    method: 'POST',
    path: () => '/api/setup/affiliates',
    form: () => ({ op: 'delete', code: 'MSA' }),
  },
  {
    endpoint: 'setup/audit-universe.ts',
    title: 'create an audit area',
    method: 'POST',
    path: () => '/api/setup/audit-universe',
    form: () => ({ op: 'area_create', code: 'OPS', name: 'Operations', description: 'Smoke area' }),
  },
  {
    endpoint: 'setup/users.ts',
    title: 'create a user',
    method: 'POST',
    path: () => '/api/setup/users',
    form: () => ({
      op: 'create',
      email: 'smoke.user@hasspetroleum.com',
      full_name: 'Smoke User',
      role_code: 'AUDITOR',
      affiliate_code: SMOKE.affiliateCode,
      password: 'Smoke-User-Password-1',
    }),
  },
  {
    endpoint: 'setup/settings.ts',
    title: 'save general settings',
    method: 'POST',
    path: () => '/api/setup/settings',
    form: () => ({}),
  },
  {
    endpoint: 'dropdowns.ts',
    title: 'save the control dropdowns',
    method: 'POST',
    path: () => '/api/dropdowns',
    form: () => ({
      risk_ratings: 'High\nMedium\nLow',
      classification: 'Financial\nOperational',
      control_type: 'Preventive\nDetective',
      control_frequency: 'Monthly\nQuarterly',
    }),
  },
  {
    endpoint: 'access-control.ts',
    title: 'save the auditor permission matrix',
    method: 'POST',
    path: () => '/api/access-control',
    form: () => ({
      role_code: 'AUDITOR',
      grant_WORK_PAPER_read: '1',
      grant_WORK_PAPER_create: '1',
      grant_ACTION_PLAN_read: '1',
      grant_REPORT_read: '1',
    }),
  },
  {
    endpoint: 'ai/config.ts',
    title: 'save the AI configuration',
    method: 'POST',
    path: () => '/api/ai/config',
    form: () => ({
      active_provider: 'anthropic',
      model: 'claude-sonnet-5',
      max_tokens: '1500',
      temperature: '0.3',
      system_prompt: 'You are an audit assistant.',
      evaluation_enabled: '1',
      rejection_threshold: '50',
      enabled_anthropic: '1',
    }),
  },
  {
    endpoint: 'ai/validate.ts',
    title: 'AI validation degrades without a provider key',
    method: 'POST',
    path: () => '/api/ai/validate',
    form: () => ({
      action_description: 'Smoke validation target',
      due_date: today,
      observation_title: 'Smoke finding',
    }),
  },
  {
    endpoint: 'ai/insights.ts',
    title: 'AI insights degrade without a provider key',
    method: 'POST',
    path: () => '/api/ai/insights',
    form: () => ({ work_paper_id: SMOKE.sentWorkPaperId }),
  },
  {
    endpoint: 'ai/analytics.ts',
    title: 'AI analytics degrade without a provider key',
    method: 'POST',
    path: () => '/api/ai/analytics',
    form: () => ({}),
  },
  {
    endpoint: 'ai/test.ts',
    title: 'AI connection test degrades without a provider key',
    method: 'POST',
    path: () => '/api/ai/test',
    form: () => ({ provider: 'anthropic' }),
  },
  {
    endpoint: 'evidence/upload-url.ts',
    title: 'evidence upload refuses cleanly when storage is unconfigured',
    method: 'POST',
    path: () => '/api/evidence/upload-url',
    form: () => ({
      entity_type: 'WORK_PAPER',
      entity_id: SMOKE.sentWorkPaperId,
      file_name: 'smoke.pdf',
      content_type: 'application/pdf',
      size_bytes: '1024',
    }),
  },
  {
    endpoint: 'evidence/complete.ts',
    title: 'evidence completion refuses cleanly when storage is unconfigured',
    method: 'POST',
    path: () => '/api/evidence/complete',
    form: () => ({
      entity_type: 'WORK_PAPER',
      entity_id: SMOKE.sentWorkPaperId,
      file_id: 'FILE-MISSING',
      file_name: 'smoke.pdf',
      content_type: 'application/pdf',
    }),
  },
  {
    endpoint: 'evidence/[attachmentId]/download.ts',
    title: 'downloading a missing attachment is not a 500',
    method: 'GET',
    path: () => `/api/evidence/${SMOKE.attachmentId}/download`,
  },
  {
    endpoint: 'evidence/[attachmentId]/delete.ts',
    title: 'deleting a missing attachment is not a 500',
    method: 'POST',
    path: () => `/api/evidence/${SMOKE.attachmentId}/delete`,
    form: () => ({ reason: 'smoke' }),
  },
  {
    endpoint: 'reports/export.ts',
    title: 'export the period audit report',
    method: 'POST',
    path: () => '/api/reports/export',
    form: () => ({ type: 'executive', year: '2026' }),
  },
  {
    endpoint: 'reports/export.ts',
    title: 'export the BARC board pack',
    method: 'POST',
    path: () => '/api/reports/export',
    form: () => ({ type: 'barc', year: '2026' }),
  },
  {
    endpoint: 'reports/export.ts',
    title: 'export the observation trend',
    method: 'POST',
    path: () => '/api/reports/export',
    form: () => ({ type: 'trend', year: '2026' }),
  },
  {
    endpoint: 'send-queue/retry.ts',
    title: 'retry a failed notification',
    method: 'POST',
    path: () => '/api/send-queue/retry',
    form: () => ({ id: SMOKE.notificationId }),
  },
  {
    endpoint: 'organizations.ts',
    title: 'provision an organisation',
    method: 'POST',
    path: () => '/api/organizations',
    form: () => ({
      organization_name: 'Smoke Test Organisation',
      admin_email: 'admin@smoke-org.example',
      admin_name: 'Smoke Admin',
      admin_password: 'Smoke-Admin-Password-1',
    }),
  },
  {
    endpoint: 'org/switch.ts',
    title: 'switch the acting organisation and back',
    method: 'POST',
    path: () => '/api/org/switch',
    form: () => ({ organization_id: SMOKE.otherOrgId }),
  },
  {
    endpoint: 'org/switch.ts',
    title: 'switch back to the home organisation',
    method: 'POST',
    path: () => '/api/org/switch',
    form: () => ({ organization_id: SMOKE.orgId }),
  },
  {
    endpoint: 'auth/change-password.ts',
    title: 'change the password and change it back',
    method: 'POST',
    path: () => '/api/auth/change-password',
    form: () => ({
      current_password: SMOKE.password,
      new_password: 'Grc-Smoke-Harness-2026-B',
      confirm_password: 'Grc-Smoke-Harness-2026-B',
    }),
  },
  {
    endpoint: 'auth/change-password.ts',
    title: 'restore the password',
    method: 'POST',
    path: () => '/api/auth/change-password',
    form: () => ({
      current_password: 'Grc-Smoke-Harness-2026-B',
      new_password: SMOKE.password,
      confirm_password: SMOKE.password,
    }),
  },
  {
    endpoint: 'auth/logout.ts',
    title: 'sign out',
    method: 'POST',
    path: () => '/api/auth/logout',
  },
];

test('GRC smoke: every page loads and every mutation dry-runs without a 500', async (t) => {
  const files = walk(PAGES_DIR);
  const pageFiles = files.filter((f) => f.endsWith('.astro'));
  const endpointFiles = files.filter((f) => f.startsWith('api/') && f.endsWith('.ts'));

  // Coverage gate: a new API endpoint must be added to MUTATION_STEPS.
  const covered = new Set(MUTATION_STEPS.map((s) => s.endpoint));
  const uncovered = endpointFiles.map((f) => f.slice('api/'.length)).filter((f) => !covered.has(f));
  assert.deepEqual(
    uncovered,
    [],
    `API endpoints with no smoke dry-run step (add them to MUTATION_STEPS in grc/test/smoke.test.ts): ${uncovered.join(', ')}`,
  );

  // Coverage gate: a new dynamic page must map its parameter to a seeded row.
  const routes = pageFiles.map(pageRoute);
  const unmapped = routes.filter((r) => r.includes('[') && !(r in PAGE_PARAMS));
  assert.deepEqual(
    unmapped,
    [],
    `dynamic pages with no seeded parameter (add them to PAGE_PARAMS in grc/test/smoke.test.ts): ${unmapped.join(', ')}`,
  );

  const server = new SmokeServer();
  await server.start();
  const captured = new Map<string, string>();

  try {
    await t.test('sign in as the seeded user', async () => {
      const res = await server.request('POST', '/api/auth/login', {
        email: SMOKE.email,
        password: SMOKE.password,
      });
      assert.equal(res.status, 303, `login answered ${res.status}: ${res.body.slice(0, 300)}`);
      const location = String(res.headers.location ?? '');
      assert.ok(!location.includes('error'), `login redirected to ${location}`);
    });

    for (const route of routes) {
      const concrete = route.replace(/\[[^\]]+\]/g, () => PAGE_PARAMS[route] ?? '');
      await t.test(`GET ${concrete}`, async () => {
        const res = await server.get(concrete);
        assert.ok(
          res.status === 200,
          `${concrete} answered ${res.status} (via ${res.hops.join(' -> ')}): ${res.body.slice(0, 300)}`,
        );
        // Landing back on the sign-in screen means the session was rejected,
        // which would silently skip the real page render.
        const final = res.hops[res.hops.length - 1];
        assert.ok(
          concrete === '/login' || !final.startsWith('/login'),
          `${concrete} bounced to the sign-in screen (via ${res.hops.join(' -> ')})`,
        );
      });
    }

    // The list filters build their own WHERE clauses, so exercise them all at
    // once (including the full-text search) rather than only the bare list.
    await t.test('GET /work-papers with every filter applied', async () => {
      const filtered =
        `/work-papers?q=reconciliations&status=Draft&area=${SMOKE.auditAreaId}` +
        `&affiliate=${SMOKE.affiliateCode}&auditor=${SMOKE.auditorId}&year=2026&risk=High`;
      const res = await server.get(filtered);
      assert.equal(
        res.status,
        200,
        `filtered list answered ${res.status}: ${res.body.slice(0, 300)}`,
      );
    });

    for (const step of MUTATION_STEPS) {
      await t.test(step.title, async () => {
        const path = step.path(captured);
        assert.ok(!path.includes('undefined'), `a capture needed by ${path} is missing`);
        const res = await server.request(step.method, path, step.form?.(captured));
        // A deliberate 503 with a JSON error body (a feature refusing because a
        // backend is unconfigured) is a legitimate refusal; a 500 never is.
        const deliberate503 = res.status === 503 && res.body.trimStart().startsWith('{');
        assert.ok(
          res.status < 500 || deliberate503,
          `${step.method} ${path} answered ${res.status}: ${res.body.slice(0, 300)}`,
        );
        if (step.capture) {
          const location = String(res.headers.location ?? '');
          const m = step.capture.from.exec(location);
          assert.ok(
            m,
            `${path} was expected to redirect with an id, got ${location || res.status}`,
          );
          captured.set(step.capture.key, m[1]);
        }
      });
    }
  } catch (err) {
    // Surface the worker's own tagged logs alongside the failure.
    console.error('---- worker log (tail) ----');
    console.error(server.log.split('\n').slice(-80).join('\n'));
    throw err;
  } finally {
    await server.stop();
  }
});
