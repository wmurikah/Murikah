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
import { createHash } from 'node:crypto';
import { join, relative, sep } from 'node:path';
import { SmokeServer } from './smoke/harness.ts';
import { SMOKE } from './smoke/seed.ts';
// The same RFC 6238 implementation the worker verifies against, so the round
// trip computes real codes for the enrolled secret.
import { totpAt } from '../../src/lib/cms/auth/totp.ts';
// The same challenge shape the worker stores, so the email-code round trip
// plants known challenges (the smoke run has no Graph mailer to deliver one).
import { newChallenge, OTP_MAX_ATTEMPTS } from '../../src/lib/grc/auth/emailOtp.ts';
import type { MfaRecord } from '../../src/lib/grc/auth/mfaRecord.ts';
// The same recogniser the worker names evidence with (Build Prompt 32); its
// import was dropped when the merge resolved this block, restored here.
import { isDeterministicName } from '../../src/lib/grc/storage/derived.ts';

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

/** The seeded database handle, for the state round-trip assertions. */
type SmokeDb = NonNullable<SmokeServer['database']>;

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
  /**
   * What the step means. A 'success' step must not bounce back with an error
   * redirect or an error body (a silent 303-with-error is a failure, not a
   * pass); a 'refusal' step must visibly refuse. Unmarked steps only keep the
   * no-500 rule (deliberate degradations that answer 200 with ok:false).
   */
  expect?: 'success' | 'refusal';
  /**
   * Assert the database effect of the step (the state round trip): a mutation
   * that "passed" without changing state is a failure the status code alone
   * cannot see.
   */
  verify?: (db: SmokeDb, captured: Map<string, string>) => void;
}

const today = new Date().toISOString().slice(0, 10);

// The dry-run of every mutation endpoint, in dependency order, against the
// throwaway seeded database (so "rollback" is simply discarding the database).
// Every file under src/pages/grc/api must appear at least once, enforced below.
const MUTATION_STEPS: MutationStep[] = [
  {
    endpoint: 'auth/login.ts',
    title: 'sign-in rejects a wrong password without a 500',
    expect: 'refusal',
    method: 'POST',
    path: () => '/api/auth/login',
    form: () => ({ email: SMOKE.email, password: 'not-the-password' }),
  },
  {
    endpoint: 'sidebar-counts.ts',
    title: 'sidebar counts',
    expect: 'success',
    method: 'GET',
    path: () => '/api/sidebar-counts',
  },
  {
    endpoint: 'notifications.ts',
    title: 'notifications list',
    expect: 'success',
    method: 'GET',
    path: () => '/api/notifications',
  },
  {
    endpoint: 'notifications.ts',
    title: 'mark a notification read',
    expect: 'success',
    method: 'POST',
    path: () => '/api/notifications',
    form: () => ({ id: 'IAN-1' }),
  },
  {
    endpoint: 'work-papers/index.ts',
    title: 'create a work paper',
    expect: 'success',
    verify: (db) => {
      const r = db
        .prepare(`SELECT status FROM work_papers WHERE observation_title = 'Smoke-created finding'`)
        .get() as { status?: string } | undefined;
      assert.equal(String(r?.status), 'Draft', 'the created work paper must exist as a draft');
    },
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
    expect: 'success',
    verify: (db, c) => {
      const r = db
        .prepare(`SELECT observation_title AS t FROM work_papers WHERE work_paper_id = ?`)
        .get(String(c.get('wpId'))) as { t?: string };
      assert.equal(String(r.t), 'Smoke-created finding (edited)', 'the edit must persist');
    },
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
    expect: 'success',
    verify: (db, c) => {
      const r = db
        .prepare(`SELECT COUNT(*) AS n FROM work_paper_requirements WHERE work_paper_id = ?`)
        .get(String(c.get('wpId'))) as { n: number | bigint };
      assert.ok(Number(r.n) >= 1, 'the requirement row must exist');
    },
    method: 'POST',
    path: (c) => `/api/work-papers/${c.get('wpId')}/requirements`,
    form: () => ({ op: 'add', description: 'Provide the smoke evidence.', status: 'OPEN' }),
  },
  {
    endpoint: 'work-papers/[id]/responsibles.ts',
    title: 'add a responsible',
    expect: 'success',
    verify: (db, c) => {
      const r = db
        .prepare(
          `SELECT COUNT(*) AS n FROM work_paper_responsibles WHERE work_paper_id = ? AND user_id = ?`,
        )
        .get(String(c.get('wpId')), SMOKE.auditeeId) as { n: number | bigint };
      assert.ok(Number(r.n) >= 1, 'the responsible row must exist');
    },
    method: 'POST',
    path: (c) => `/api/work-papers/${c.get('wpId')}/responsibles`,
    form: () => ({ op: 'add_responsible', user_id: SMOKE.auditeeId, role_in_finding: 'PRIMARY' }),
  },
  {
    endpoint: 'work-papers/[id]/transition.ts',
    title: 'submit the created work paper',
    expect: 'success',
    verify: (db, c) => {
      const r = db
        .prepare(`SELECT status FROM work_papers WHERE work_paper_id = ?`)
        .get(String(c.get('wpId'))) as { status?: string };
      assert.equal(String(r.status), 'Submitted', 'the transition must land in the database');
    },
    method: 'POST',
    path: (c) => `/api/work-papers/${c.get('wpId')}/transition`,
    form: () => ({ to_status: 'Submitted', comment: 'Smoke transition' }),
  },
  {
    endpoint: 'work-papers/[id]/delete.ts',
    title: 'a submitted work paper refuses deletion',
    expect: 'refusal',
    verify: (db, c) => {
      const r = db
        .prepare(`SELECT deleted_at FROM work_papers WHERE work_paper_id = ?`)
        .get(String(c.get('wpId'))) as { deleted_at?: string | null };
      assert.ok(r.deleted_at == null, 'a submitted finding must survive a delete attempt');
    },
    method: 'POST',
    path: (c) => `/api/work-papers/${c.get('wpId')}/delete`,
  },
  {
    endpoint: 'work-papers/index.ts',
    title: 'create a disposable draft',
    expect: 'success',
    method: 'POST',
    path: () => '/api/work-papers',
    form: () => ({
      observation_title: 'Disposable smoke draft',
      year: '2026',
      affiliate_code: SMOKE.affiliateCode,
      audit_area_id: SMOKE.auditAreaId,
      assigned_auditor: SMOKE.auditorId,
    }),
    capture: { key: 'wpId2', from: /\/work-papers\/([^/?]+)/ },
  },
  {
    endpoint: 'work-papers/[id]/delete.ts',
    title: 'delete the disposable draft',
    expect: 'success',
    verify: (db, c) => {
      const r = db
        .prepare(`SELECT deleted_at FROM work_papers WHERE work_paper_id = ?`)
        .get(String(c.get('wpId2'))) as { deleted_at?: string | null } | undefined;
      assert.ok(!r || r.deleted_at != null, 'the draft must be deleted');
    },
    method: 'POST',
    path: (c) => `/api/work-papers/${c.get('wpId2')}/delete`,
  },
  {
    endpoint: 'action-plans/index.ts',
    title: 'create an action plan',
    expect: 'success',
    verify: (db, c) => {
      const r = db
        .prepare(`SELECT work_paper_id AS wp FROM action_plans WHERE action_plan_id = ?`)
        .get(String(c.get('apId'))) as { wp?: string };
      assert.equal(String(r.wp), SMOKE.sentWorkPaperId, 'the created plan must carry its parent');
    },
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
    expect: 'success',
    verify: (db, c) => {
      const r = db
        .prepare(`SELECT action_description AS d FROM action_plans WHERE action_plan_id = ?`)
        .get(String(c.get('apId'))) as { d?: string };
      assert.equal(String(r.d), 'Smoke-created action plan (edited).', 'the edit must persist');
    },
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
    expect: 'success',
    verify: (db) => {
      const r = db
        .prepare(`SELECT delegated_date AS d FROM action_plans WHERE action_plan_id = ?`)
        .get(SMOKE.actionPlanId) as { d?: string | null };
      assert.ok(r.d != null, 'the delegation must be recorded');
    },
    method: 'POST',
    path: () => `/api/action-plans/${SMOKE.actionPlanId}/delegate`,
    form: () => ({ new_owner_id: SMOKE.auditorId, notes: 'Smoke delegation' }),
  },
  {
    endpoint: 'action-plans/[id]/delegation.ts',
    title: 'answer the delegation',
    expect: 'success',
    verify: (db) => {
      const r = db
        .prepare(`SELECT delegation_accepted_date AS d FROM action_plans WHERE action_plan_id = ?`)
        .get(SMOKE.actionPlanId) as { d?: string | null };
      assert.ok(r.d != null, 'the acceptance must be recorded');
    },
    method: 'POST',
    path: () => `/api/action-plans/${SMOKE.actionPlanId}/delegation`,
    form: () => ({ decision: 'accept' }),
  },
  {
    endpoint: 'action-plans/[id]/transition.ts',
    title: 'verify the pending action plan',
    expect: 'success',
    verify: (db) => {
      const r = db
        .prepare(`SELECT status FROM action_plans WHERE action_plan_id = ?`)
        .get(SMOKE.verifyActionPlanId) as { status?: string };
      assert.equal(String(r.status), 'Verified', 'the verification must land in the database');
    },
    method: 'POST',
    path: () => `/api/action-plans/${SMOKE.verifyActionPlanId}/transition`,
    form: () => ({ to_status: 'Verified', comment: 'Smoke verification' }),
  },
  {
    endpoint: 'action-plans/[id]/transition.ts',
    title: 'a Kanban drop transitions and returns to the board',
    expect: 'success',
    verify: (db) => {
      const r = db
        .prepare(`SELECT status FROM action_plans WHERE action_plan_id = ?`)
        .get(SMOKE.verifyActionPlanId) as { status?: string };
      assert.equal(String(r.status), 'Closed', 'the drop must move the card in the database');
    },
    method: 'POST',
    path: () => `/api/action-plans/${SMOKE.verifyActionPlanId}/transition`,
    form: () => ({ to_status: 'Closed', return_to: '/action-plans?view=kanban' }),
  },
  {
    endpoint: 'action-plans/[id]/delete.ts',
    title: 'delete the created action plan',
    expect: 'success',
    verify: (db, c) => {
      const r = db
        .prepare(`SELECT deleted_at FROM action_plans WHERE action_plan_id = ?`)
        .get(String(c.get('apId'))) as { deleted_at?: string | null } | undefined;
      assert.ok(!r || r.deleted_at != null, 'the plan must be deleted');
    },
    method: 'POST',
    path: (c) => `/api/action-plans/${c.get('apId')}/delete`,
  },
  {
    endpoint: 'auditee-responses/submit.ts',
    title: 'submit a management response',
    expect: 'success',
    verify: (db) => {
      const r = db
        .prepare(
          `SELECT COUNT(*) AS n FROM auditee_responses
            WHERE work_paper_id = ? AND management_response LIKE '%accepts the finding%'`,
        )
        .get(SMOKE.sentWorkPaperId) as { n: number | bigint };
      assert.ok(Number(r.n) >= 1, 'the response row must exist with its text');
    },
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
    expect: 'success',
    verify: (db) => {
      const r = db
        .prepare(`SELECT status, response_round AS rr FROM work_papers WHERE work_paper_id = ?`)
        .get(SMOKE.sentWorkPaperId) as { status?: string; rr?: number | bigint };
      assert.equal(String(r.status), 'Sent to Auditee', 'the finding must reopen to the auditee');
      assert.equal(Number(r.rr), 2, 'the next round must be recorded');
    },
    method: 'POST',
    path: () => `/api/auditee-responses/${SMOKE.responseId}/review`,
    form: () => ({ decision: 'request_changes', review_comments: 'Please add dates and owners.' }),
  },
  {
    endpoint: 'auditee-responses/[id]/review.ts',
    title: 'a response already reviewed is refused, not 500',
    expect: 'refusal',
    method: 'POST',
    path: () => `/api/auditee-responses/${SMOKE.responseId}/review`,
    form: () => ({ decision: 'accept' }),
  },
  {
    endpoint: 'setup/affiliates.ts',
    title: 'create an affiliate',
    expect: 'success',
    verify: (db) => {
      const r = db
        .prepare(
          `SELECT COUNT(*) AS n FROM affiliates WHERE affiliate_code = 'MSA' AND deleted_at IS NULL`,
        )
        .get() as { n: number | bigint };
      assert.equal(Number(r.n), 1, 'the affiliate row must exist');
    },
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
    expect: 'success',
    verify: (db) => {
      const r = db
        .prepare(
          `SELECT COUNT(*) AS n FROM affiliates
            WHERE affiliate_code = 'MSA' AND deleted_at IS NULL AND is_active = 1`,
        )
        .get() as { n: number | bigint };
      assert.equal(Number(r.n), 0, 'the affiliate must be gone or inactive after the delete');
    },
    method: 'POST',
    path: () => '/api/setup/affiliates',
    form: () => ({ op: 'delete', code: 'MSA' }),
  },
  {
    endpoint: 'setup/audit-universe.ts',
    title: 'create an audit area',
    expect: 'success',
    verify: (db) => {
      const r = db
        .prepare(
          `SELECT COUNT(*) AS n FROM audit_areas WHERE area_code = 'OPS' AND deleted_at IS NULL`,
        )
        .get() as { n: number | bigint };
      assert.equal(Number(r.n), 1, 'the audit area must exist');
    },
    method: 'POST',
    path: () => '/api/setup/audit-universe',
    form: () => ({ op: 'area_create', code: 'OPS', name: 'Operations', description: 'Smoke area' }),
  },
  {
    endpoint: 'setup/users.ts',
    title: 'create a user',
    expect: 'success',
    verify: (db) => {
      const r = db
        .prepare(`SELECT COUNT(*) AS n FROM users WHERE email = 'smoke.user@hasspetroleum.com'`)
        .get() as { n: number | bigint };
      assert.equal(Number(r.n), 1, 'the user row must exist');
    },
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
    expect: 'success',
    // A real browser posts the whole pre-filled form; an empty post would
    // blank MFA_REQUIRED_ROLES, whose blank falls back to the default rule
    // (SUPER_ADMIN must enrol) and would lock the admin out of the rest of
    // the run - which is exactly what the field is for.
    form: () => ({
      RESPONSE_DEADLINE_DAYS: '14',
      MAX_RESPONSE_ROUNDS: '3',
      STALE_REMINDER_DAYS: '3',
      OVERDUE_REMINDER_DAY: 'Monday',
      MFA_REQUIRED_ROLES: 'NONE',
      NOTIFY_SENDER_EMAIL: 'audit@hasspetroleum.com',
      NOTIFY_REPLY_TO: 'audit@hasspetroleum.com',
    }),
    verify: (db) => {
      const r = db
        .prepare(
          `SELECT config_value AS v FROM config
            WHERE organization_id = ? AND config_key = 'MFA_REQUIRED_ROLES'`,
        )
        .get(SMOKE.orgId) as { v?: string } | undefined;
      assert.equal(String(r?.v), 'NONE', 'the saved settings must persist');
    },
    method: 'POST',
    path: () => '/api/setup/settings',
  },
  {
    // Without the Graph app credentials the connect action must visibly
    // refuse (an error banner on the Email screen), never a silent bounce.
    endpoint: 'admin/outlook/connect.ts',
    title: 'the Outlook connect action refuses without Graph credentials',
    expect: 'refusal',
    method: 'GET',
    path: () => '/api/admin/outlook/connect',
  },
  {
    // A bare callback (no code, no state) is a forged or broken sign-in
    // response and must refuse without a 500.
    endpoint: 'admin/outlook/callback.ts',
    title: 'the Outlook callback refuses an incomplete sign-in response',
    expect: 'refusal',
    method: 'GET',
    path: () => '/api/admin/outlook/callback',
    verify: (db) => {
      const r = db
        .prepare(
          `SELECT config_value AS v FROM config
            WHERE organization_id = 'GLOBAL' AND config_key = 'MAIL_OUTLOOK_CONNECTION'`,
        )
        .get() as { v?: string } | undefined;
      assert.equal(r, undefined, 'a refused callback must not store a connection');
    },
  },
  {
    endpoint: 'admin/outlook/test.ts',
    title: 'the test email refuses while Outlook is not connected',
    expect: 'refusal',
    method: 'POST',
    path: () => '/api/admin/outlook/test',
  },
  {
    endpoint: 'dropdowns.ts',
    title: 'save the control dropdowns',
    expect: 'success',
    verify: (db) => {
      const r = db
        .prepare(
          `SELECT config_value AS v FROM config
            WHERE organization_id = ? AND config_key = 'DROPDOWN_RISK_RATINGS'`,
        )
        .get(SMOKE.orgId) as { v?: string } | undefined;
      assert.ok(String(r?.v ?? '').includes('High'), 'the dropdown values must be stored');
    },
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
    expect: 'success',
    verify: (db) => {
      const granted = db
        .prepare(
          `SELECT is_allowed AS a FROM role_permissions
            WHERE role_code = 'AUDITOR' AND module_code = 'WORK_PAPER' AND action_code = 'read'`,
        )
        .get() as { a?: number | bigint } | undefined;
      assert.equal(Number(granted?.a ?? 0), 1, 'a granted cell must be stored as allowed');
    },
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
    expect: 'success',
    verify: (db) => {
      const r = db
        .prepare(
          `SELECT config_value AS v FROM config
            WHERE organization_id = 'GLOBAL' AND config_key = 'AI_ACTIVE_PROVIDER'`,
        )
        .get() as { v?: string } | undefined;
      assert.equal(String(r?.v), 'anthropic', 'the active provider must be stored');
    },
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
    endpoint: 'ai/draft.ts',
    title: 'AI observation draft degrades without a provider key',
    method: 'POST',
    path: () => '/api/ai/draft',
    form: () => ({
      kind: 'observation',
      observation_title: 'Smoke finding',
      risk_description: 'Controls may fail.',
    }),
  },
  {
    endpoint: 'ai/draft.ts',
    title: 'AI risk-rating suggestion degrades without a provider key',
    method: 'POST',
    path: () => '/api/ai/draft',
    form: () => ({ kind: 'risk_rating', observation_title: 'Smoke finding' }),
  },
  {
    endpoint: 'ai/draft.ts',
    title: 'an unknown drafting kind is refused, not 500',
    method: 'POST',
    path: () => '/api/ai/draft',
    form: () => ({ kind: 'sonnet' }),
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
    expect: 'refusal',
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
    expect: 'refusal',
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
    endpoint: 'evidence/[attachmentId]/delete.ts',
    title: 'deleting held evidence is blocked by the legal hold',
    expect: 'refusal',
    verify: (db) => {
      const r = db
        .prepare(`SELECT deleted_at FROM files WHERE file_id = ?`)
        .get(SMOKE.heldFileId) as { deleted_at?: string | null };
      assert.ok(r.deleted_at == null, 'a held file must never be deleted');
    },
    method: 'POST',
    path: () => `/api/evidence/${SMOKE.heldAttachmentId}/delete`,
    form: () => ({ reason: 'smoke: should be refused' }),
  },
  {
    endpoint: 'evidence/[attachmentId]/delete.ts',
    title: 'deleting unheld evidence queues the governed soft deletion',
    expect: 'success',
    verify: (db) => {
      const q = db
        .prepare(
          `SELECT COUNT(*) AS n FROM deletion_queue WHERE entity_type = 'file' AND entity_id = ?`,
        )
        .get(SMOKE.freeFileId) as { n: number | bigint };
      assert.ok(Number(q.n) >= 1, 'the governed deletion must be queued');
    },
    method: 'POST',
    path: () => `/api/evidence/${SMOKE.freeAttachmentId}/delete`,
    form: () => ({ reason: 'smoke: superseded document' }),
  },
  {
    endpoint: 'evidence/[attachmentId]/download.ts',
    title: 'a Drive-backed file still opens through the read-through',
    method: 'GET',
    path: () => `/api/evidence/ATT-${SMOKE.driveFileId}/download`,
  },
  {
    endpoint: 'evidence/[attachmentId]/download.ts',
    title: 'downloading a missing attachment is not a 500',
    expect: 'refusal',
    method: 'GET',
    path: () => `/api/evidence/${SMOKE.attachmentId}/download`,
  },
  {
    endpoint: 'evidence/[attachmentId]/delete.ts',
    title: 'deleting a missing attachment is not a 500',
    expect: 'refusal',
    method: 'POST',
    path: () => `/api/evidence/${SMOKE.attachmentId}/delete`,
    form: () => ({ reason: 'smoke' }),
  },
  {
    endpoint: 'reports/export.ts',
    title: 'export the period audit report',
    expect: 'success',
    method: 'POST',
    path: () => '/api/reports/export',
    form: () => ({ type: 'executive', year: '2026' }),
  },
  {
    endpoint: 'reports/export.ts',
    title: 'export the BARC board pack',
    expect: 'success',
    method: 'POST',
    path: () => '/api/reports/export',
    form: () => ({ type: 'barc', year: '2026' }),
  },
  {
    endpoint: 'reports/export.ts',
    title: 'export the observation trend',
    expect: 'success',
    method: 'POST',
    path: () => '/api/reports/export',
    form: () => ({ type: 'trend', year: '2026' }),
  },
  {
    endpoint: 'send-queue/retry.ts',
    title: 'retry a failed notification',
    expect: 'success',
    verify: (db) => {
      const r = db
        .prepare(`SELECT status FROM notification_queue WHERE notification_id = ?`)
        .get(SMOKE.notificationId) as { status?: string };
      assert.equal(String(r.status), 'PENDING', 'the retried row must return to PENDING');
    },
    method: 'POST',
    path: () => '/api/send-queue/retry',
    form: () => ({ id: SMOKE.notificationId }),
  },
  {
    endpoint: 'organizations.ts',
    title: 'provision an organisation',
    expect: 'success',
    verify: (db) => {
      const r = db
        .prepare(
          `SELECT COUNT(*) AS n FROM organizations WHERE org_name = 'Smoke Test Organisation'`,
        )
        .get() as { n: number | bigint };
      assert.equal(Number(r.n), 1, 'the provisioned organisation must exist');
    },
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
    expect: 'success',
    method: 'POST',
    path: () => '/api/org/switch',
    form: () => ({ organization_id: SMOKE.otherOrgId }),
  },
  {
    endpoint: 'org/switch.ts',
    title: 'switch back to the home organisation',
    expect: 'success',
    method: 'POST',
    path: () => '/api/org/switch',
    form: () => ({ organization_id: SMOKE.orgId }),
  },
  {
    endpoint: 'auth/change-password.ts',
    title: 'change the password and change it back',
    expect: 'success',
    verify: (db) => {
      const r = db
        .prepare(`SELECT COUNT(*) AS n FROM password_history WHERE user_id = ?`)
        .get(SMOKE.userId) as { n: number | bigint };
      assert.ok(Number(r.n) >= 1, 'the previous credential must be recorded');
    },
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
    expect: 'success',
    verify: (db) => {
      const r = db
        .prepare(`SELECT COUNT(*) AS n FROM password_history WHERE user_id = ?`)
        .get(SMOKE.userId) as { n: number | bigint };
      assert.ok(Number(r.n) >= 2, 'both changes must be recorded');
    },
    method: 'POST',
    path: () => '/api/auth/change-password',
    form: () => ({
      current_password: 'Grc-Smoke-Harness-2026-B',
      new_password: SMOKE.password,
      confirm_password: SMOKE.password,
    }),
  },
  {
    endpoint: 'auth/mfa/enrol.ts',
    title: 'MFA enrolment starts for the signed-in admin',
    method: 'POST',
    path: () => '/api/auth/mfa/enrol',
  },
  {
    endpoint: 'auth/mfa/confirm.ts',
    title: 'a wrong MFA confirmation code is refused, not 500',
    method: 'POST',
    path: () => '/api/auth/mfa/confirm',
    form: () => ({ code: '000000' }),
  },
  {
    endpoint: 'auth/mfa/verify.ts',
    title: 'the MFA step without a pending session is refused, not 500',
    method: 'POST',
    path: () => '/api/auth/mfa/verify',
    form: () => ({ code: '000000' }),
  },
  {
    // The admin's dry-run enrolment above is the authenticator method, so
    // there is no email code to send; the endpoint must say so, not 500.
    endpoint: 'auth/mfa/send.ts',
    title: 'a code send without an email enrolment is refused, not 500',
    expect: 'refusal',
    method: 'POST',
    path: () => '/api/auth/mfa/send',
  },
  {
    endpoint: 'auth/forgot-password.ts',
    title: 'a reset request for an unknown email answers neutrally',
    expect: 'success',
    method: 'POST',
    path: () => '/api/auth/forgot-password',
    form: () => ({ email: 'nobody@hasspetroleum.com' }),
  },
  {
    endpoint: 'auth/reset-password.ts',
    title: 'an invalid reset token is refused, not 500',
    expect: 'refusal',
    method: 'POST',
    path: () => '/api/auth/reset-password',
    form: () => ({
      token: 'not-a-real-token',
      new_password: 'Grc-Reset-Password-1',
      confirm_password: 'Grc-Reset-Password-1',
    }),
  },
  {
    endpoint: 'auth/logout.ts',
    title: 'sign out',
    expect: 'success',
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

        // The 500-detector cannot see a handler that catches its own failure
        // and answers 303-with-an-error, so a step that should succeed must
        // not bounce back with an error, and a deliberate refusal must
        // visibly refuse.
        const location = String(res.headers.location ?? '');
        if (step.expect === 'success') {
          assert.ok(
            res.status < 400,
            `${step.method} ${path} answered ${res.status}: ${res.body.slice(0, 300)}`,
          );
          assert.ok(
            !/[?&](error|failed)=/.test(location),
            `${step.method} ${path} silently bounced with an error: ${location}`,
          );
        } else if (step.expect === 'refusal') {
          const refused =
            res.status >= 400 ||
            /[?&]error=/.test(location) ||
            res.body.includes('"error"') ||
            res.body.includes('"ok":false');
          assert.ok(
            refused,
            `${step.method} ${path} was expected to refuse, got ${res.status} ${location}`,
          );
        }

        // The state round trip: a mutation that "passed" without changing the
        // database is a failure the status code alone cannot see.
        if (step.verify) {
          const db = server.database;
          assert.ok(db, 'the fake database is reachable for verification');
          step.verify(db, captured);
        }
      });
    }

    // Work paper as parent (Build Prompt 27): an action plan cannot exist
    // without a finding, and the one seeded stray is surfaced and relinkable.
    // The admin session signed out above, so sign back in.
    await t.test('an action plan cannot be created or unlinked from its parent', async () => {
      server.clearCookies();
      await server.request('POST', '/api/auth/login', {
        email: SMOKE.email,
        password: SMOKE.password,
      });
      const res = await server.request('POST', '/api/action-plans', {
        action_description: 'Orphan attempt from the smoke test',
        target_date: today,
        due_date: today,
        priority: 'High',
      });
      assert.equal(res.status, 303, `create answered ${res.status}`);
      assert.ok(
        String(res.headers.location ?? '').includes('error='),
        'creation without a parent must be refused',
      );
      const db = server.database;
      assert.ok(db, 'the fake database is reachable for verification');
      const created = db
        .prepare(
          `SELECT COUNT(*) AS n FROM action_plans
            WHERE action_description = 'Orphan attempt from the smoke test'`,
        )
        .get() as { n: number | bigint };
      assert.equal(Number(created.n), 0, 'no orphan row may be created');

      const unlink = await server.request('POST', `/api/action-plans/${SMOKE.actionPlanId}`, {
        action_description: 'Attempted unlink from the smoke test',
        target_date: today,
        due_date: today,
        priority: 'High',
      });
      assert.ok(
        String(unlink.headers.location ?? '').includes('error='),
        'unlinking an existing plan must be refused',
      );
      const still = db
        .prepare(`SELECT work_paper_id FROM action_plans WHERE action_plan_id = ?`)
        .get(SMOKE.actionPlanId) as { work_paper_id?: string };
      assert.equal(String(still.work_paper_id), SMOKE.sentWorkPaperId, 'the link must survive');
    });

    await t.test('the seeded stray is surfaced and can be relinked', async () => {
      const page = await server.get('/action-plans');
      assert.equal(page.status, 200);
      assert.ok(
        page.body.includes('Plans without a parent finding'),
        'the orphan panel must show while a stray exists',
      );
      const relink = await server.request('POST', `/api/action-plans/${SMOKE.orphanPlanId}`, {
        work_paper_id: SMOKE.sentWorkPaperId,
        action_description: 'Legacy stray plan with no parent finding.',
        target_date: today,
        due_date: today,
        priority: 'Low',
      });
      assert.ok(
        !String(relink.headers.location ?? '').includes('error='),
        `relinking failed: ${relink.headers.location}`,
      );
      const db = server.database;
      assert.ok(db);
      const row = db
        .prepare(`SELECT work_paper_id FROM action_plans WHERE action_plan_id = ?`)
        .get(SMOKE.orphanPlanId) as { work_paper_id?: string };
      assert.equal(String(row.work_paper_id), SMOKE.sentWorkPaperId, 'the stray must be linked');
      const after = await server.get('/action-plans');
      assert.ok(
        !after.body.includes('Plans without a parent finding'),
        'the orphan panel clears once every plan is linked',
      );
    });

    // Rich text and staged evidence (Build Prompt 28), on the admin session.
    await t.test('narrative Markdown renders as marks, never raw or unescaped', async () => {
      const res = await server.request('POST', '/api/work-papers', {
        observation_title: 'Rich-text smoke finding',
        observation_description:
          '## Background\nControls **failed** in *March*.\n- reconciliation missed\n- review skipped',
        recommendation: '1. Reconcile monthly\n2. Review quarterly',
        year: '2026',
        affiliate_code: SMOKE.affiliateCode,
        audit_area_id: SMOKE.auditAreaId,
        assigned_auditor: SMOKE.auditorId,
      });
      const location = String(res.headers.location ?? '');
      const m = /\/work-papers\/([^/?]+)/.exec(location);
      assert.ok(m, `create redirected to ${location}`);
      const page = await server.get(`/work-papers/${m[1]}`);
      assert.equal(page.status, 200);
      assert.ok(page.body.includes('<strong>failed</strong>'), 'bold renders as strong');
      assert.ok(page.body.includes('<em>March</em>'), 'italic renders as em');
      assert.ok(page.body.includes('<h4>Background</h4>'), 'the heading renders');
      assert.ok(page.body.includes('<li>reconciliation missed</li>'), 'bullets render as a list');
      assert.ok(!page.body.includes('**failed**'), 'no raw markers leak');
    });

    await t.test('evidence staged against a draft token binds to the new finding', async () => {
      const db = server.database;
      assert.ok(db, 'the fake database is reachable for verification');
      // Stage a file as the upload endpoints would have (storage itself is not
      // configured in the smoke environment, so the rows are planted directly).
      const draftToken = 'aaaaaaaa-bbbb-cccc-dddd-eeeeffff0000';
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO files (file_id, organization_id, file_name, mime_type, size_bytes,
                            uploaded_by, created_at, storage_backend, storage_key)
         VALUES ('FILE-STAGED', ?, 'staged.pdf', 'application/pdf', 100, ?, ?, 'r2', 'k')`,
      ).run(SMOKE.orgId, SMOKE.userId, now);
      db.prepare(
        `INSERT INTO file_attachments (attachment_id, file_id, entity_type, entity_id,
                                       file_category, attached_by, attached_at)
         VALUES ('ATT-STAGED', 'FILE-STAGED', 'work_paper_draft', ?, 'EVIDENCE', ?, ?)`,
      ).run(draftToken, SMOKE.userId, now);

      const res = await server.request('POST', '/api/work-papers', {
        observation_title: 'Finding with staged evidence',
        year: '2026',
        affiliate_code: SMOKE.affiliateCode,
        audit_area_id: SMOKE.auditAreaId,
        assigned_auditor: SMOKE.auditorId,
        draft_token: draftToken,
      });
      const location = String(res.headers.location ?? '');
      const m = /\/work-papers\/([^/?]+)/.exec(location);
      assert.ok(m, `create redirected to ${location}`);
      const bound = db
        .prepare(
          `SELECT entity_type, entity_id FROM file_attachments WHERE attachment_id = 'ATT-STAGED'`,
        )
        .get() as { entity_type?: string; entity_id?: string };
      assert.equal(String(bound.entity_type), 'work_paper', 'the staged attachment rebinds');
      assert.equal(String(bound.entity_id), m[1], 'the staged attachment binds to the new id');
      // Binding also gives the file its deterministic display name (Build
      // Prompt 32): affiliate, parent reference, kind, date, sequence, hash.
      const named = db
        .prepare(`SELECT file_name AS n FROM files WHERE file_id = 'FILE-STAGED'`)
        .get() as { n?: string } | undefined;
      assert.ok(
        isDeterministicName(String(named?.n)),
        `the bound file is renamed deterministically, got ${String(named?.n)}`,
      );
      assert.ok(
        String(named?.n).startsWith(`${SMOKE.affiliateCode}_`) &&
          String(named?.n).includes('_evidence_'),
        'the name says what the file belongs to',
      );
      const page = await server.get(`/work-papers/${m[1]}`);
      assert.ok(page.body.includes(String(named?.n)), 'the bound evidence shows on the detail');
    });

    await t.test('a draft upload refuses cleanly while storage is unconfigured', async () => {
      const res = await server.request('POST', '/api/evidence/upload-url', {
        entity_type: 'work_paper_draft',
        entity_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeffff0000',
        file_name: 'x.pdf',
        content_type: 'application/pdf',
        size_bytes: '10',
      });
      assert.equal(res.status, 503, `draft upload-url answered ${res.status}`);
      assert.ok(res.body.trimStart().startsWith('{'), 'the refusal is the JSON contract');
    });

    // Row scope and matrix gating, seen from the auditee side (Build Prompt
    // 26). The admin session signed out above, so sign in as the seeded
    // UNIT_MANAGER, whose role holds WORK_PAPER read but no CONFIG or USER
    // grant and none of the auditor-side actions.
    await t.test('sign in as the seeded auditee', async () => {
      server.clearCookies();
      const res = await server.request('POST', '/api/auth/login', {
        email: 'owner@hasspetroleum.com',
        password: SMOKE.password,
      });
      assert.equal(res.status, 303, `auditee login answered ${res.status}`);
      const location = String(res.headers.location ?? '');
      assert.ok(!location.includes('error'), `auditee login redirected to ${location}`);
    });

    await t.test('the auditee list shows their finding and hides the foreign draft', async () => {
      const res = await server.get('/work-papers');
      assert.equal(res.status, 200, `auditee list answered ${res.status}`);
      assert.ok(
        res.body.includes('WP/2026/002'),
        'the finding the auditee is responsible for is missing from their list',
      );
      assert.ok(
        !res.body.includes('WP/2026/001'),
        'a draft finding the auditee is not part of leaked into their list',
      );
    });

    await t.test('the page map turns the auditee away from the admin sections', async () => {
      for (const path of ['/settings', '/settings/users', '/send-queue', '/reports']) {
        const res = await server.get(path);
        const final = res.hops[res.hops.length - 1];
        assert.equal(
          final,
          '/',
          `${path} was not redirected to the dashboard (via ${res.hops.join(' -> ')})`,
        );
      }
    });

    await t.test('an admin mutation refuses the auditee with a 403, not a 500', async () => {
      const res = await server.request('POST', '/api/dropdowns', {
        risk_ratings: 'High',
        classification: 'Financial',
        control_type: 'Preventive',
        control_frequency: 'Monthly',
      });
      assert.equal(res.status, 403, `/api/dropdowns answered ${res.status} for the auditee`);
    });

    // Login security round trips (Build Prompt 25), then the forgotten-password
    // round trip (Build Prompt 24). The lockout and idle checks run first on
    // the seeded passwords; the reset then changes the auditor's password; MFA
    // enrolment goes last because it changes how the admin signs in.

    await t.test('repeated failures lock the account, right password included', async () => {
      server.clearCookies();
      for (let i = 0; i < 5; i++) {
        const res = await server.request('POST', '/api/auth/login', {
          email: 'lockout@hasspetroleum.com',
          password: 'wrong-password',
        });
        assert.equal(res.status, 303, `failure ${i + 1} answered ${res.status}`);
      }
      const locked = await server.request('POST', '/api/auth/login', {
        email: 'lockout@hasspetroleum.com',
        password: SMOKE.password,
      });
      assert.ok(
        String(locked.headers.location ?? '').includes('error=1'),
        'the lockout must refuse even the right password',
      );
      const db = server.database;
      assert.ok(db, 'the fake database is reachable for verification');
      const ev = db
        .prepare(`SELECT COUNT(*) AS n FROM security_events WHERE event_type = 'LOGIN_LOCKOUT'`)
        .get() as { n: number | bigint };
      assert.ok(Number(ev.n) >= 1, 'the lockout must be recorded in security_events');
    });

    await t.test('an idle session dies before its absolute expiry', async () => {
      server.clearCookies();
      const login = await server.request('POST', '/api/auth/login', {
        email: 'auditor@hasspetroleum.com',
        password: SMOKE.password,
      });
      assert.ok(!String(login.headers.location ?? '').includes('error'), 'auditor must sign in');
      const alive = await server.get('/work-papers');
      assert.equal(alive.status, 200);
      assert.ok(!alive.hops[alive.hops.length - 1].startsWith('/login'));
      const db = server.database;
      assert.ok(db);
      const stale = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      db.prepare(`UPDATE sessions SET last_seen_at = ? WHERE user_id = ?`).run(
        stale,
        SMOKE.auditorId,
      );
      const bounced = await server.get('/work-papers');
      assert.ok(
        bounced.hops[bounced.hops.length - 1].startsWith('/login'),
        `an idle session must be rejected (via ${bounced.hops.join(' -> ')})`,
      );
    });

    // The full forgotten-password round trip (Build Prompt 24): request a link
    // for the seeded auditor, pull the single-use token out of the queued
    // email, redeem it, sign in with the new password, and prove the token
    // died with its first use.
    const resetPassword = 'Grc-Smoke-Reset-2026-A';
    let resetToken = '';

    await t.test('a reset request queues an email carrying the link', async () => {
      server.clearCookies();
      const res = await server.request('POST', '/api/auth/forgot-password', {
        email: 'auditor@hasspetroleum.com',
      });
      assert.equal(res.status, 303, `forgot-password answered ${res.status}`);
      assert.ok(
        String(res.headers.location ?? '').includes('sent=1'),
        'expected the neutral redirect',
      );
      const db = server.database;
      assert.ok(db, 'the fake database is reachable for verification');
      const row = db
        .prepare(
          `SELECT rendered_body AS body FROM notification_queue
            WHERE batch_type = 'PASSWORD_RESET' ORDER BY rowid DESC LIMIT 1`,
        )
        .get() as { body?: string } | undefined;
      assert.ok(row?.body, 'the reset email was queued');
      const m = /reset-password\?token=([0-9a-f]+)/.exec(String(row.body));
      assert.ok(m, 'the queued email carries the reset link');
      resetToken = m[1];
    });

    await t.test('the reset screen validates the token and the endpoint redeems it', async () => {
      const page = await server.get(`/reset-password?token=${resetToken}`);
      assert.equal(page.status, 200, `reset screen answered ${page.status}`);
      assert.ok(!page.body.includes('not valid any more'), 'a fresh token must render the form');
      const res = await server.request('POST', '/api/auth/reset-password', {
        token: resetToken,
        new_password: resetPassword,
        confirm_password: resetPassword,
      });
      assert.equal(res.status, 303, `reset answered ${res.status}`);
      assert.ok(
        String(res.headers.location ?? '').includes('reset=1'),
        `reset redirected to ${res.headers.location}`,
      );
    });

    await t.test('the new password signs in and the used token is dead', async () => {
      const res = await server.request('POST', '/api/auth/login', {
        email: 'auditor@hasspetroleum.com',
        password: resetPassword,
      });
      assert.equal(res.status, 303, `login answered ${res.status}`);
      assert.ok(
        !String(res.headers.location ?? '').includes('error'),
        'the reset password must sign in',
      );
      const again = await server.request('POST', '/api/auth/reset-password', {
        token: resetToken,
        new_password: 'Grc-Smoke-Reset-2026-B',
        confirm_password: 'Grc-Smoke-Reset-2026-B',
      });
      assert.ok(
        String(again.headers.location ?? '').includes('error='),
        'a used token must be refused',
      );
    });

    // The full MFA life cycle (Build Prompt 25), last because enrolment
    // changes how the admin signs in.
    let mfaSecret = '';
    let mfaBackup: string[] = [];

    await t.test('MFA enrolment shows the key, the QR and the backup codes', async () => {
      server.clearCookies();
      const login = await server.request('POST', '/api/auth/login', {
        email: SMOKE.email,
        password: SMOKE.password,
      });
      assert.equal(login.status, 303);
      const enrol = await server.request('POST', '/api/auth/mfa/enrol');
      assert.equal(enrol.status, 303, `enrol answered ${enrol.status}`);
      const page = await server.get('/mfa/setup');
      assert.equal(page.status, 200, `setup screen answered ${page.status}`);
      const key = /Manual key: <code>([A-Z2-7 ]+)<\/code>/.exec(page.body);
      assert.ok(key, 'the setup screen shows the manual key');
      mfaSecret = key[1].replace(/ /g, '');
      assert.ok(page.body.includes('<svg'), 'the setup screen renders the QR in-worker');
      mfaBackup = [...page.body.matchAll(/<code>([A-Z2-9]{10})<\/code>/g)].map((m) => m[1]);
      assert.equal(mfaBackup.length, 8, 'eight backup codes are shown once');
    });

    await t.test('confirming a real code activates the factor', async () => {
      const code = await totpAt(mfaSecret, Math.floor(Date.now() / 1000));
      const res = await server.request('POST', '/api/auth/mfa/confirm', { code });
      assert.ok(
        String(res.headers.location ?? '').includes('done=1'),
        `confirm redirected to ${res.headers.location}`,
      );
    });

    await t.test('the next sign-in demands the code and a real one passes', async () => {
      server.clearCookies();
      const login = await server.request('POST', '/api/auth/login', {
        email: SMOKE.email,
        password: SMOKE.password,
      });
      assert.equal(
        String(login.headers.location ?? ''),
        '/mfa',
        'an enrolled account must be sent to the TOTP step',
      );
      const blocked = await server.get('/work-papers');
      assert.equal(
        blocked.hops[blocked.hops.length - 1],
        '/mfa',
        'a pending session must not reach the app',
      );
      const code = await totpAt(mfaSecret, Math.floor(Date.now() / 1000));
      const wrongCode = code === '000001' ? '000002' : '000001';
      const wrong = await server.request('POST', '/api/auth/mfa/verify', { code: wrongCode });
      assert.ok(String(wrong.headers.location ?? '').includes('error=1'));
      const ok = await server.request('POST', '/api/auth/mfa/verify', { code });
      assert.equal(String(ok.headers.location ?? ''), '/', 'a valid code must promote the session');
      const home = await server.get('/work-papers');
      assert.equal(home.status, 200, 'the promoted session reaches the app');
    });

    await t.test('a backup code passes the step once and only once', async () => {
      server.clearCookies();
      await server.request('POST', '/api/auth/login', {
        email: SMOKE.email,
        password: SMOKE.password,
      });
      const first = await server.request('POST', '/api/auth/mfa/verify', {
        backup_code: mfaBackup[0],
      });
      assert.equal(
        String(first.headers.location ?? ''),
        '/',
        'a backup code must promote the session',
      );
      server.clearCookies();
      await server.request('POST', '/api/auth/login', {
        email: SMOKE.email,
        password: SMOKE.password,
      });
      const again = await server.request('POST', '/api/auth/mfa/verify', {
        backup_code: mfaBackup[0],
      });
      assert.ok(
        String(again.headers.location ?? '').includes('error='),
        'a used backup code must be refused',
      );
    });

    // The email MFA method (Build Prompt 34): switching methods, the emailed
    // code at sign-in, single use, expiry, the lock, and backup codes. The
    // smoke run has no Graph mailer, so sends visibly fail (which itself
    // proves the send path is wired) and known challenges are planted through
    // the database handle.
    const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
    const readAdminMfa = (db: SmokeDb): MfaRecord => {
      const row = db
        .prepare(
          `SELECT config_value AS v FROM config
            WHERE organization_id = ? AND config_key = 'MFA_TOTP::${SMOKE.userId}'`,
        )
        .get(SMOKE.orgId) as { v?: string } | undefined;
      return JSON.parse(String(row?.v ?? 'null')) as MfaRecord;
    };
    const writeAdminMfa = (db: SmokeDb, record: MfaRecord): void => {
      db.prepare(
        `UPDATE config SET config_value = ?
          WHERE organization_id = ? AND config_key = 'MFA_TOTP::${SMOKE.userId}'`,
      ).run(JSON.stringify(record), SMOKE.orgId);
    };
    let emailBackup: string[] = [];

    await t.test(
      'switching to email codes keeps the app factor active until confirmed',
      async () => {
        const db = server.database;
        assert.ok(db, 'the fake database is reachable for verification');
        // The previous block ends on a pending session (its last action was a
        // refused backup-code reuse), so complete a fresh sign-in first: the
        // switch is a fully signed-in action.
        server.clearCookies();
        await server.request('POST', '/api/auth/login', {
          email: SMOKE.email,
          password: SMOKE.password,
        });
        const totp = await server.request('POST', '/api/auth/mfa/verify', {
          code: await totpAt(mfaSecret, Math.floor(Date.now() / 1000)),
        });
        assert.equal(String(totp.headers.location ?? ''), '/', 'the app code signs the admin in');
        const start = await server.request('POST', '/api/auth/mfa/enrol', { method: 'email' });
        assert.equal(start.status, 303, `enrol answered ${start.status}`);
        assert.ok(
          String(start.headers.location ?? '').includes('error='),
          'without the Graph mailer the enrolment code email visibly fails',
        );
        const record = readAdminMfa(db);
        assert.equal(record.confirmed, true, 'the active factor must stand during the switch');
        assert.equal(record.method, 'totp', 'the active method is still the app');
        assert.equal(record.pendingMethod, 'email', 'the email enrolment is pending');
        const page = await server.get('/mfa/setup');
        assert.equal(page.status, 200, `setup screen answered ${page.status}`);
        assert.ok(page.body.includes('Check your email'), 'the email panel is shown');
        emailBackup = [...page.body.matchAll(/<code>([A-Z2-9]{10})<\/code>/g)].map((m) => m[1]);
        assert.equal(emailBackup.length, 8, 'fresh backup codes are shown once');
      },
    );

    await t.test('confirming the emailed code activates the email method', async () => {
      const db = server.database;
      assert.ok(db, 'the fake database is reachable for verification');
      const record = readAdminMfa(db);
      writeAdminMfa(db, {
        ...record,
        challenge: newChallenge(sha256('654321'), Date.now() - 120_000),
      });
      const wrong = await server.request('POST', '/api/auth/mfa/confirm', { code: '111111' });
      assert.ok(String(wrong.headers.location ?? '').includes('error='), 'a wrong code refuses');
      assert.equal(
        readAdminMfa(db).challenge?.attempts,
        1,
        'a wrong guess counts against the challenge',
      );
      const ok = await server.request('POST', '/api/auth/mfa/confirm', { code: '654321' });
      assert.ok(
        String(ok.headers.location ?? '').includes('done=1'),
        `confirm redirected to ${ok.headers.location}`,
      );
      const after = readAdminMfa(db);
      assert.equal(after.method, 'email', 'the email method is now active');
      assert.equal(after.confirmed, true);
      assert.equal(after.pendingMethod, undefined, 'nothing stays pending');
      assert.equal(after.backup.length, 8, 'the backup-code hashes are stored');
    });

    await t.test('an email-method sign-in demands the emailed code', async () => {
      const db = server.database;
      assert.ok(db, 'the fake database is reachable for verification');
      server.clearCookies();
      const login = await server.request('POST', '/api/auth/login', {
        email: SMOKE.email,
        password: SMOKE.password,
      });
      const loc = String(login.headers.location ?? '');
      assert.ok(loc.startsWith('/mfa'), 'an email-method account must be sent to the step');
      assert.ok(
        loc.includes('senderror=1'),
        'without the Graph mailer the sign-in send visibly fails',
      );
      const step = await server.get('/mfa');
      assert.equal(step.status, 200, `step screen answered ${step.status}`);
      assert.ok(step.body.includes('emailed'), 'the step shows the email copy');
      const resend = await server.request('POST', '/api/auth/mfa/send');
      assert.ok(
        String(resend.headers.location ?? '').includes('error='),
        'a resend inside the cooldown is refused',
      );
      writeAdminMfa(db, {
        ...readAdminMfa(db),
        challenge: newChallenge(sha256('271828'), Date.now() - 90_000),
      });
      const wrong = await server.request('POST', '/api/auth/mfa/verify', { code: '000001' });
      assert.ok(String(wrong.headers.location ?? '').includes('error=1'), 'a wrong code refuses');
      assert.equal(readAdminMfa(db).challenge?.attempts, 1, 'the wrong guess is counted');
      const ok = await server.request('POST', '/api/auth/mfa/verify', { code: '271828' });
      assert.equal(
        String(ok.headers.location ?? ''),
        '/',
        'the right emailed code promotes the session',
      );
      assert.equal(readAdminMfa(db).challenge?.used, true, 'the challenge is spent on use');
      const home = await server.get('/work-papers');
      assert.equal(home.status, 200, 'the promoted session reaches the app');
    });

    await t.test('a used, expired or locked code refuses; a backup code still works', async () => {
      const db = server.database;
      assert.ok(db, 'the fake database is reachable for verification');
      server.clearCookies();
      await server.request('POST', '/api/auth/login', {
        email: SMOKE.email,
        password: SMOKE.password,
      });
      const base = readAdminMfa(db);
      writeAdminMfa(db, {
        ...base,
        challenge: { ...newChallenge(sha256('314159'), Date.now() - 90_000), used: true },
      });
      const used = await server.request('POST', '/api/auth/mfa/verify', { code: '314159' });
      assert.ok(
        String(used.headers.location ?? '').includes('error=1'),
        'a spent code never passes again',
      );
      writeAdminMfa(db, {
        ...base,
        challenge: newChallenge(sha256('314159'), Date.now() - 11 * 60_000),
      });
      const expired = await server.request('POST', '/api/auth/mfa/verify', { code: '314159' });
      assert.ok(
        String(expired.headers.location ?? '').includes('error=1'),
        'an expired code is refused',
      );
      writeAdminMfa(db, {
        ...base,
        challenge: {
          ...newChallenge(sha256('314159'), Date.now() - 90_000),
          attempts: OTP_MAX_ATTEMPTS,
        },
      });
      const locked = await server.request('POST', '/api/auth/mfa/verify', { code: '314159' });
      assert.ok(
        String(locked.headers.location ?? '').includes('error=1'),
        'a locked challenge refuses even the right code',
      );
      const backup = await server.request('POST', '/api/auth/mfa/verify', {
        backup_code: emailBackup[0],
      });
      assert.equal(
        String(backup.headers.location ?? ''),
        '/',
        'a backup code passes for the email method',
      );
    });

    await t.test('an unenrolled user under a required rule is locked to enrolment', async () => {
      const db = server.database;
      assert.ok(db, 'the fake database is reachable for verification');
      db.prepare(
        `UPDATE config SET config_value = 'ALL'
          WHERE organization_id = ? AND config_key = 'MFA_REQUIRED_ROLES'`,
      ).run(SMOKE.orgId);
      server.clearCookies();
      const login = await server.request('POST', '/api/auth/login', {
        email: 'owner@hasspetroleum.com',
        password: SMOKE.password,
      });
      assert.ok(!String(login.headers.location ?? '').includes('error'), 'the auditee signs in');
      const res = await server.get('/work-papers');
      assert.equal(
        res.hops[res.hops.length - 1],
        '/mfa/setup',
        `an unenrolled user must be locked to enrolment (via ${res.hops.join(' -> ')})`,
      );
      db.prepare(
        `UPDATE config SET config_value = 'NONE'
          WHERE organization_id = ? AND config_key = 'MFA_REQUIRED_ROLES'`,
      ).run(SMOKE.orgId);
    });
  } catch (err) {
    // Surface the worker's own tagged logs alongside the failure.
    console.error('---- worker log (tail) ----');
    console.error(server.log.split('\n').slice(-80).join('\n'));
    throw err;
  } finally {
    await server.stop();
  }
});
