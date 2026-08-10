/**
 * The GRC smoke test: the safety net every module merges behind (Build Prompt
 * 22). It boots the built worker against a seeded throwaway database, signs in
 * as the seeded user (two-step verification is universal since Build Prompt
 * 37, so every sign-in completes the email-code step by planting a known
 * challenge through the database handle), GETs every reachable page and
 * dry-runs every mutation endpoint, and fails on any 500. Routes are enumerated from the filesystem
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
// The one catalogue the matrix, the save and the seed all read, so the role-save
// step asserts against the real module list rather than a copy of it.
import {
  PERMISSION_ACTIONS,
  PERMISSION_MODULES,
  PLATFORM_DEFAULT_ORG,
} from '../../src/lib/grc/auth/permissionModules.ts';
// The same planner the cron drain uses, so the "one digest, never one email per
// finding" assertion runs the real grouping rather than a copy of it.
import { planNormalDigests } from '../../src/lib/grc/notify/render.ts';
import { reviewQueueLink } from '../../src/lib/grc/notify/links.ts';

const REVIEW_QUEUE_LINK = reviewQueueLink();

/** The cells the role-save step ticks, and therefore expects stored as allowed. */
const GRANTED_IN_SAVE: [string, string][] = [
  ['WORK_PAPER', 'read'],
  ['WORK_PAPER', 'create'],
  ['ACTION_PLAN', 'read'],
  ['REPORT', 'read'],
  ['NOTIFICATION', 'read'],
  ['SETUP', 'read'],
  ['CONFIG', 'read'],
  ['AUDIT_LOG', 'read'],
];

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
    title: 'add a requirement, with the date it was asked for',
    expect: 'success',
    verify: (db, c) => {
      const r = db
        .prepare(
          `SELECT requested_date, received_date, status FROM work_paper_requirements
            WHERE work_paper_id = ? AND description = 'Provide the smoke evidence.'`,
        )
        .get(String(c.get('wpId'))) as {
        requested_date?: string;
        received_date?: string | null;
        status?: string;
      };
      assert.ok(r, 'the requirement row must exist');
      assert.equal(String(r.requested_date), '2026-02-02', 'the date requested is stored');
      assert.ok(r.received_date == null, 'nothing has been received yet');
      // The status is derived from the date, never submitted, so the two cannot
      // disagree (Build Prompt 52).
      assert.equal(String(r.status), 'OUTSTANDING', 'an unreceived requirement is outstanding');
    },
    method: 'POST',
    path: (c) => `/api/work-papers/${c.get('wpId')}/requirements`,
    form: () => ({
      op: 'add',
      description: 'Provide the smoke evidence.',
      requested_date: '2026-02-02',
    }),
  },
  {
    // Clearing the date of receipt reopens the requirement. This is the half of
    // the derivation a "mark received" flag would never have to answer, and the
    // half a stored status typed in beside the date gets wrong.
    endpoint: 'work-papers/[id]/requirements.ts',
    title: 'clearing the date received puts a requirement back outstanding',
    expect: 'success',
    verify: (db) => {
      const r = db
        .prepare(
          `SELECT received_date, status FROM work_paper_requirements WHERE requirement_id = ?`,
        )
        .get(SMOKE.receivedRequirementId) as { received_date?: string | null; status?: string };
      assert.ok(r.received_date == null, 'the date of receipt is gone');
      assert.equal(String(r.status), 'OUTSTANDING', 'so the status says outstanding');
    },
    method: 'POST',
    path: () => `/api/work-papers/${SMOKE.sentWorkPaperId}/requirements`,
    form: () => ({
      op: 'update',
      requirement_id: SMOKE.receivedRequirementId,
      description: 'Provide the approved bank mandate.',
      requested_date: '2026-01-05',
      received_date: '',
    }),
  },
  {
    // And dating it again marks it received, with the status following the date
    // rather than the form: nothing here submits a status at all.
    endpoint: 'work-papers/[id]/requirements.ts',
    title: 'dating a requirement received marks it received',
    expect: 'success',
    verify: (db) => {
      const r = db
        .prepare(
          `SELECT received_date, status FROM work_paper_requirements WHERE requirement_id = ?`,
        )
        .get(SMOKE.receivedRequirementId) as { received_date?: string; status?: string };
      assert.equal(String(r.received_date), '2026-02-09', 'the date received is stored');
      assert.equal(String(r.status), 'RECEIVED', 'the status follows the date, not the form');
      // The other seeded requirement was never received and must be untouched,
      // so the detail page still has one of each state to show.
      const other = db
        .prepare(`SELECT received_date FROM work_paper_requirements WHERE requirement_id = ?`)
        .get(SMOKE.requirementId) as { received_date?: string | null };
      assert.ok(other.received_date == null, 'the outstanding requirement stays outstanding');
    },
    method: 'POST',
    path: () => `/api/work-papers/${SMOKE.sentWorkPaperId}/requirements`,
    form: () => ({
      op: 'update',
      requirement_id: SMOKE.receivedRequirementId,
      description: 'Provide the approved bank mandate.',
      requested_date: '2026-01-05',
      received_date: '2026-02-09',
    }),
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
    // Build Prompt 53. An empty selection is refused in the same shape as any
    // other bad request, rather than redirecting as though something happened.
    endpoint: 'work-papers/submit-batch.ts',
    title: 'a batch release with nothing selected refuses and says so',
    expect: 'refusal',
    method: 'POST',
    path: () => '/api/work-papers/submit-batch',
    form: () => ({}),
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
    // Build Prompt 50, the review chain. Draft to Submitted has just run; these
    // carry it on to Under Review and Approved, the path the seeded
    // status_transitions define. Nothing here names a transition the engine does
    // not already hold: a hard-coded step would pass even if the table were
    // empty, which is the opposite of what this proves.
    endpoint: 'work-papers/[id]/transition.ts',
    title: 'start the review on the submitted work paper',
    expect: 'success',
    verify: (db, c) => {
      const r = db
        .prepare(`SELECT status FROM work_papers WHERE work_paper_id = ?`)
        .get(String(c.get('wpId'))) as { status?: string };
      assert.equal(String(r.status), 'Under Review', 'Submitted moves to Under Review');
    },
    method: 'POST',
    path: (c) => `/api/work-papers/${c.get('wpId')}/transition`,
    form: () => ({ to_status: 'Under Review' }),
  },
  {
    endpoint: 'work-papers/[id]/transition.ts',
    title: 'a return for revision without the required comment is refused',
    // The seeded rule sets requires_comment on Under Review to Revision
    // Required. Omitting it must refuse, or the rule is decorative.
    expect: 'refusal',
    verify: (db, c) => {
      const r = db
        .prepare(`SELECT status FROM work_papers WHERE work_paper_id = ?`)
        .get(String(c.get('wpId'))) as { status?: string };
      assert.equal(String(r.status), 'Under Review', 'a refused move changes nothing');
    },
    method: 'POST',
    path: (c) => `/api/work-papers/${c.get('wpId')}/transition`,
    form: () => ({ to_status: 'Revision Required' }),
  },
  {
    endpoint: 'work-papers/[id]/transition.ts',
    title: 'approve the reviewed work paper, and the revisions record the whole chain',
    expect: 'success',
    verify: (db, c) => {
      const id = String(c.get('wpId'));
      const r = db
        .prepare(
          `SELECT status, approved_by_name AS approver, approved_date AS approved
             FROM work_papers WHERE work_paper_id = ?`,
        )
        .get(id) as { status?: string; approver?: string; approved?: string };
      assert.equal(String(r.status), 'Approved');
      // The dated attribution the detail's review trail reads back. Before this
      // build it was stamped and shown nowhere.
      assert.ok(r.approver, 'the approver is stamped');
      assert.ok(r.approved, 'and the date with them');

      // One work_paper_revisions row per move, in order, with the actor and the
      // comment: the iterations a reviewer needs to see.
      const rows = db
        .prepare(
          `SELECT from_status AS f, to_status AS t, user_name AS who, comments AS c
             FROM work_paper_revisions WHERE work_paper_id = ?
            ORDER BY revision_number ASC`,
        )
        .all(id) as { f: string; t: string; who: string | null; c: string | null }[];
      assert.deepEqual(
        rows.map((x) => `${x.f} -> ${x.t}`),
        ['Draft -> Submitted', 'Submitted -> Under Review', 'Under Review -> Approved'],
        'every move is recorded, and the refused one is not',
      );
      assert.ok(
        rows.every((x) => x.who),
        'each revision names who made the move',
      );
      assert.equal(rows[0].c, 'Smoke transition', 'the comment is kept with its move');
    },
    method: 'POST',
    path: (c) => `/api/work-papers/${c.get('wpId')}/transition`,
    form: () => ({ to_status: 'Approved' }),
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
    // No admin types a password any more (Build Prompt 39): the endpoint mints
    // one, hashes it, forces a change and hands it back through the sealed
    // single-use row the page reads.
    endpoint: 'setup/users.ts',
    title: 'create a user with a system-generated password',
    expect: 'success',
    verify: (db, captured) => {
      const r = db
        .prepare(
          `SELECT user_id AS id, password_hash AS h, must_change_password AS m
             FROM users WHERE email = 'smoke.user@hasspetroleum.com'`,
        )
        .get() as { id?: string; h?: string; m?: number | bigint } | undefined;
      assert.ok(r?.id, 'the user row must exist');
      assert.equal(Number(r.m), 1, 'a generated password always forces a change');
      assert.ok(
        String(r.h ?? '').startsWith('pbkdf2$'),
        'only a canonical PBKDF2 hash is stored, never the plaintext',
      );
      // The sealed handoff is what the page reads once; the plaintext must not
      // be sitting in it readably.
      const handoff = db
        .prepare(
          `SELECT config_value AS v FROM config
            WHERE organization_id = ? AND config_key = ?`,
        )
        .get(SMOKE.orgId, `USER_TEMP_PW::${String(r.id)}`) as { v?: string } | undefined;
      assert.ok(handoff?.v, 'the generated password must be stashed for the admin');
      const stashed = JSON.parse(String(handoff.v)) as { sealed?: string; actorUserId?: string };
      assert.ok(stashed.sealed, 'the stash holds a sealed value');
      assert.equal(stashed.actorUserId, SMOKE.userId, 'bound to the admin who minted it');
      // The edit steps below need the new id, which the redirect does not carry;
      // the reset step compares against this hash to prove it really changed.
      captured.set('newUserId', String(r.id));
      captured.set('createdHash', String(r.h ?? ''));
    },
    method: 'POST',
    path: () => '/api/setup/users',
    form: () => ({
      op: 'create',
      email: 'smoke.user@hasspetroleum.com',
      full_name: 'Smoke User',
      role_code: 'AUDITOR',
      affiliate_code: SMOKE.affiliateCode,
    }),
  },
  {
    // Email identifies a user across the platform at sign-in, so an address
    // already held in another organisation cannot be taken here.
    endpoint: 'setup/users.ts',
    title: 'an email already used in another organisation is refused',
    expect: 'refusal',
    verify: (db) => {
      const r = db
        .prepare(`SELECT COUNT(*) AS n FROM users WHERE email = ?`)
        .get(SMOKE.otherOrgUserEmail) as { n: number | bigint };
      assert.equal(Number(r.n), 1, 'no second account may take the address');
    },
    method: 'POST',
    path: () => '/api/setup/users',
    form: () => ({
      op: 'create',
      email: SMOKE.otherOrgUserEmail,
      full_name: 'Cross Org Clash',
      role_code: 'AUDITOR',
    }),
  },
  {
    // Every account must carry a valid email: it is where the universal
    // second-factor code goes (Build Prompt 37), so an edit that clears it is
    // refused rather than silently saved.
    endpoint: 'setup/users.ts',
    title: 'an edit that drops the email is refused',
    expect: 'refusal',
    verify: (db) => {
      const r = db
        .prepare(`SELECT COUNT(*) AS n FROM users WHERE email = 'smoke.user@hasspetroleum.com'`)
        .get() as { n: number | bigint };
      assert.equal(Number(r.n), 1, 'the address must survive the refused edit');
    },
    method: 'POST',
    path: () => '/api/setup/users',
    form: (captured) => ({
      op: 'update',
      user_id: captured.get('newUserId') ?? '',
      email: '',
      full_name: 'Smoke User',
      role_code: 'AUDITOR',
    }),
  },
  {
    endpoint: 'setup/users.ts',
    title: 'an edit sets a valid email on the account',
    expect: 'success',
    verify: (db, captured) => {
      const r = db
        .prepare(`SELECT email FROM users WHERE user_id = ?`)
        .get(captured.get('newUserId') ?? '') as { email?: string } | undefined;
      assert.equal(r?.email, 'smoke.edited@hasspetroleum.com', 'the new address must be stored');
    },
    method: 'POST',
    path: () => '/api/setup/users',
    form: (captured) => ({
      op: 'update',
      user_id: captured.get('newUserId') ?? '',
      email: 'smoke.edited@hasspetroleum.com',
      full_name: 'Smoke User',
      role_code: 'AUDITOR',
      phone: '+254700000111',
    }),
  },
  {
    endpoint: 'setup/users.ts',
    title: "an edit that takes another account's email is refused",
    expect: 'refusal',
    verify: (db, captured) => {
      const r = db
        .prepare(`SELECT email FROM users WHERE user_id = ?`)
        .get(captured.get('newUserId') ?? '') as { email?: string } | undefined;
      assert.equal(r?.email, 'smoke.edited@hasspetroleum.com', 'the refused edit changes nothing');
    },
    method: 'POST',
    path: () => '/api/setup/users',
    form: (captured) => ({
      op: 'update',
      user_id: captured.get('newUserId') ?? '',
      email: SMOKE.instanceAdminEmail,
      full_name: 'Smoke User',
      role_code: 'AUDITOR',
    }),
  },
  {
    // The reset path is the create path: a fresh generated password, hashed,
    // forced to change, emailed and stashed. Never one the admin typed.
    endpoint: 'setup/users.ts',
    title: 'reset a password to a freshly generated one',
    expect: 'success',
    verify: (db, captured) => {
      const id = captured.get('newUserId') ?? '';
      const r = db
        .prepare(
          `SELECT password_hash AS h, must_change_password AS m FROM users WHERE user_id = ?`,
        )
        .get(id) as { h?: string; m?: number | bigint } | undefined;
      assert.equal(Number(r?.m), 1, 'a reset forces a change at the next sign-in');
      assert.ok(String(r?.h ?? '').startsWith('pbkdf2$'), 'the new password is stored hashed');
      assert.notEqual(
        String(r?.h ?? ''),
        captured.get('createdHash') ?? '',
        'the reset must actually change the stored hash',
      );
      const handoff = db
        .prepare(
          `SELECT config_value AS v FROM config
            WHERE organization_id = ? AND config_key = ?`,
        )
        .get(SMOKE.orgId, `USER_TEMP_PW::${id}`) as { v?: string } | undefined;
      assert.ok(handoff?.v, 'the reset password is stashed for the admin too');
    },
    method: 'POST',
    path: () => '/api/setup/users',
    form: (captured) => ({
      op: 'reset_password',
      user_id: captured.get('newUserId') ?? '',
    }),
  },
  {
    endpoint: 'setup/settings.ts',
    title: 'save general settings',
    expect: 'success',
    // A real browser posts the whole pre-filled form. MFA_AUTHENTICATOR_ROLES
    // only gates the authenticator-app alternative (Build Prompt 37):
    // verification itself is universal, so no value here can lock anyone out,
    // and the platform owner always qualifies for the app regardless.
    form: () => ({
      RESPONSE_DEADLINE_DAYS: '14',
      MAX_RESPONSE_ROUNDS: '3',
      STALE_REMINDER_DAYS: '3',
      OVERDUE_REMINDER_DAY: 'Monday',
      MFA_AUTHENTICATOR_ROLES: 'SUPER_ADMIN',
      NOTIFY_SENDER_EMAIL: 'audit@hasspetroleum.com',
      NOTIFY_REPLY_TO: 'audit@hasspetroleum.com',
    }),
    verify: (db) => {
      const r = db
        .prepare(
          `SELECT config_value AS v FROM config
            WHERE organization_id = ? AND config_key = 'MFA_AUTHENTICATOR_ROLES'`,
        )
        .get(SMOKE.orgId) as { v?: string } | undefined;
      assert.equal(String(r?.v), 'SUPER_ADMIN', 'the saved settings must persist');
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
    // Build Prompt 43. The save is atomic and covers the whole matrix, so this
    // step proves all three halves of that: every cell landed (not the three
    // quarters the old sequential loop managed before a foreign key stopped it),
    // the ticked cells are allowed, and a cell the seed granted but this
    // submission left unticked is now refused. Ticking CONFIG and AUDIT_LOG is
    // deliberate: those are the two modules whose missing `permission_modules`
    // rows broke every save, and the smoke schema now enforces that reference.
    endpoint: 'access-control.ts',
    title: 'save the auditor permission matrix, in full, for this organisation alone',
    expect: 'success',
    verify: (db) => {
      const cells = PERMISSION_MODULES.length * PERMISSION_ACTIONS.length;
      const countFor = (org: string): number => {
        const r = db
          .prepare(
            `SELECT COUNT(*) AS n FROM role_permissions
              WHERE role_code = 'AUDITOR' AND organization_id = ?`,
          )
          .get(org) as { n: number | bigint };
        return Number(r.n);
      };
      assert.equal(
        countFor(SMOKE.orgId),
        cells,
        'the whole matrix must be stored for the acting organisation',
      );
      const allowed = (org: string, module: string, action: string): number => {
        const row = db
          .prepare(
            `SELECT is_allowed AS a FROM role_permissions
              WHERE organization_id = ? AND role_code = 'AUDITOR'
                AND module_code = ? AND action_code = ?`,
          )
          .get(org, module, action) as { a?: number | bigint } | undefined;
        return Number(row?.a ?? -1);
      };
      for (const [module, action] of GRANTED_IN_SAVE) {
        assert.equal(
          allowed(SMOKE.orgId, module, action),
          1,
          `${module}.${action} must be stored as allowed`,
        );
      }
      // Inherited as allowed from the platform defaults, left unticked here: the
      // un-tick has to apply too, or a half-applied save would pass this step.
      assert.equal(
        allowed(SMOKE.orgId, 'WORK_PAPER', 'update'),
        0,
        'an unticked cell must be stored as refused, not left as it was',
      );
      // Every module in the catalogue is represented, including the ones the
      // live permission_modules table was missing.
      for (const module of PERMISSION_MODULES) {
        assert.notEqual(
          allowed(SMOKE.orgId, module.code, 'read'),
          -1,
          `${module.code} must have a stored grant, so the module row exists`,
        );
      }

      // AC-01, the whole point of Build Prompt 44: the save reached this
      // organisation and nobody else. Before it, this same submission rewrote
      // the AUDITOR role for every customer on the platform at once.
      assert.equal(
        countFor(SMOKE.otherOrgId),
        cells,
        "the other organisation's own grants must still be there",
      );
      for (const [module, action] of GRANTED_IN_SAVE) {
        assert.equal(
          allowed(SMOKE.otherOrgId, module, action),
          action === 'read' ? 1 : 0,
          `${module}.${action} must be untouched in the other organisation`,
        );
      }
      // The platform defaults are not this organisation's to change either.
      assert.equal(
        allowed(PLATFORM_DEFAULT_ORG, 'WORK_PAPER', 'update'),
        1,
        'the platform defaults must survive an organisation saving its own set',
      );
    },
    method: 'POST',
    path: () => '/api/access-control',
    form: () => ({
      role_code: 'AUDITOR',
      ...Object.fromEntries(GRANTED_IN_SAVE.map(([m, a]) => [`grant_${m}_${a}`, '1'])),
    }),
  },
  {
    // The other half of AC-03: a save the database refuses must refuse visibly
    // and change nothing. A role that does not exist violates the
    // role_permissions foreign key on the first insert, which is the shape of
    // the failure that used to escape as {"error":"internal_error"} with three
    // quarters of the matrix already committed. It must now come back as a
    // handled error redirect, with the batch rolled back whole.
    endpoint: 'access-control.ts',
    title: 'a refused permission save changes nothing and says so',
    expect: 'refusal',
    verify: (db) => {
      const ghost = db
        .prepare(`SELECT COUNT(*) AS n FROM role_permissions WHERE role_code = 'GHOST_ROLE'`)
        .get() as { n: number | bigint };
      assert.equal(Number(ghost.n), 0, 'a rolled-back save must leave no row behind');
      // The role saved by the previous step is untouched by the failed one.
      const auditor = db
        .prepare(
          `SELECT COUNT(*) AS n FROM role_permissions
            WHERE role_code = 'AUDITOR' AND organization_id = ?`,
        )
        .get(SMOKE.orgId) as { n: number | bigint };
      assert.equal(
        Number(auditor.n),
        PERMISSION_MODULES.length * PERMISSION_ACTIONS.length,
        'a failed save must not disturb another role',
      );
    },
    method: 'POST',
    path: () => '/api/access-control',
    form: () => ({ role_code: 'GHOST_ROLE', grant_WORK_PAPER_read: '1' }),
  },
  {
    // Build Prompt 42: the platform owner's cache recovery lever. Flushing an
    // organisation's namespace is idempotent and touches no database row, so the
    // step asserts the redirect reports what it removed rather than a row change.
    endpoint: 'platform/cache.ts',
    title: "flush an organisation's cached entries",
    expect: 'success',
    method: 'POST',
    path: () => '/api/platform/cache',
    form: () => ({ op: 'flush', organization_id: SMOKE.orgId }),
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
    title: 'evidence upload refuses an entity type it does not recognise',
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
    title: 'evidence completion refuses an upload that never landed',
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
    // The path the providers that cannot sign a URL take (Build Prompt 51).
    // The harness posts urlencoded forms, so this is the no-file case: it must
    // refuse in the same JSON contract as every other evidence endpoint rather
    // than throwing on a body that is not multipart.
    endpoint: 'evidence/put.ts',
    title: 'a direct evidence write refuses a request carrying no file',
    expect: 'refusal',
    method: 'POST',
    path: () => '/api/evidence/put',
    form: () => ({
      entity_type: 'work_paper',
      entity_id: SMOKE.sentWorkPaperId,
      file_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeffff1111',
      file_name: 'smoke-direct.pdf',
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
    // Build Prompt 51. The folder is the one part of a connection that can be
    // changed without disturbing which provider is active, so it is the step
    // that proves the endpoint writes rather than only answering.
    endpoint: 'admin/storage/save.ts',
    title: 'choosing a storage folder is stored against the organisation',
    expect: 'success',
    verify: (db) => {
      const r = db
        .prepare(
          `SELECT folder_id, is_active FROM storage_connections
            WHERE organization_id = ? AND provider = 'r2'`,
        )
        .get(SMOKE.orgId) as { folder_id?: string; is_active?: number | bigint };
      assert.equal(String(r.folder_id), 'smoke-evidence', 'the chosen folder must persist');
      assert.equal(Number(r.is_active), 1, 'choosing a folder must not deactivate the provider');
    },
    method: 'POST',
    path: () => '/api/admin/storage/save',
    form: () => ({
      action: 'folder',
      provider: 'r2',
      folder_id: 'smoke-evidence',
      folder_name: 'smoke-evidence',
    }),
  },
  {
    endpoint: 'admin/storage/save.ts',
    title: 'an OAuth provider refuses to be configured by typed-in fields',
    expect: 'refusal',
    method: 'POST',
    path: () => '/api/admin/storage/save',
    form: () => ({ action: 'save', provider: 'dropbox', bucket: 'nope' }),
  },
  {
    // Activation is refused for a provider that has never passed a test, so
    // evidence never starts depending on a connection nobody has proved.
    endpoint: 'admin/storage/save.ts',
    title: 'an unconfigured provider cannot be made the active one',
    expect: 'refusal',
    verify: (db) => {
      const r = db
        .prepare(
          `SELECT provider FROM storage_connections
            WHERE organization_id = ? AND is_active = 1`,
        )
        .get(SMOKE.orgId) as { provider?: string };
      assert.equal(String(r.provider), 'r2', 'the tested provider stays the active one');
    },
    method: 'POST',
    path: () => '/api/admin/storage/save',
    form: () => ({ action: 'activate', provider: 'sharepoint' }),
  },
  {
    endpoint: 'admin/storage/[provider]/connect.ts',
    title: 'connecting a provider this deployment has not registered says so',
    expect: 'refusal',
    method: 'GET',
    path: () => '/api/admin/storage/google_drive/connect',
  },
  {
    endpoint: 'admin/storage/[provider]/callback.ts',
    title: 'a storage callback with no code and no state is refused, not a 500',
    expect: 'refusal',
    method: 'GET',
    path: () => '/api/admin/storage/dropbox/callback',
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
    title: 'enter another instance',
    expect: 'success',
    verify: (db) => {
      const r = db
        .prepare(
          `SELECT COUNT(*) AS n FROM audit_log
            WHERE action = 'ORG.switch' AND entity_id = ?`,
        )
        .get(SMOKE.otherOrgId) as { n: number | bigint };
      assert.ok(Number(r.n) >= 1, 'entering an instance must be audited');
    },
    method: 'POST',
    path: () => '/api/org/switch',
    form: () => ({ organization_id: SMOKE.otherOrgId }),
  },
  {
    endpoint: 'org/leave.ts',
    title: 'leave the instance, back to the all-instances view',
    expect: 'success',
    verify: (db) => {
      const r = db
        .prepare(
          `SELECT COUNT(*) AS n FROM audit_log
            WHERE action = 'ORG.leave' AND entity_id = ?`,
        )
        .get(SMOKE.otherOrgId) as { n: number | bigint };
      assert.ok(Number(r.n) >= 1, 'leaving an instance must be audited');
    },
    method: 'POST',
    path: () => '/api/org/leave',
  },
  {
    endpoint: 'org/switch.ts',
    title: 'an instance outside the platform set is refused, not fallen back from',
    expect: 'refusal',
    method: 'POST',
    path: () => '/api/org/switch',
    form: () => ({ organization_id: 'ORG-DOES-NOT-EXIST' }),
  },
  {
    endpoint: 'org/switch.ts',
    title: 'enter the Hass instance again, for the steps that follow',
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
    // No setup wall (Build Prompt 37): backup codes are generated from
    // account security, hashes stored for verification, sealed plaintext
    // kept to show once.
    endpoint: 'auth/mfa/backup.ts',
    title: 'the signed-in admin generates backup codes from account security',
    expect: 'success',
    verify: (db) => {
      const row = db
        .prepare(
          `SELECT config_value AS v FROM config
            WHERE organization_id = ? AND config_key = 'MFA_TOTP::${SMOKE.userId}'`,
        )
        .get(SMOKE.orgId) as { v?: string } | undefined;
      const record = JSON.parse(String(row?.v ?? 'null')) as {
        backup?: string[];
        backupPlain?: string;
      } | null;
      assert.equal(record?.backup?.length, 8, 'eight backup-code hashes must be stored');
      assert.ok(record?.backupPlain, 'the sealed shown-once plaintext must be stored');
    },
    method: 'POST',
    path: () => '/api/auth/mfa/backup',
  },
  {
    // Email codes need no enrolment, so the method endpoint's email path is
    // an immediate switch; the authenticator path is dry-run in the MFA
    // life-cycle block below.
    endpoint: 'auth/mfa/enrol.ts',
    title: 'the method endpoint answers the signed-in admin (email switch)',
    expect: 'success',
    verify: (db) => {
      const row = db
        .prepare(
          `SELECT config_value AS v FROM config
            WHERE organization_id = ? AND config_key = 'MFA_TOTP::${SMOKE.userId}'`,
        )
        .get(SMOKE.orgId) as { v?: string } | undefined;
      const record = JSON.parse(String(row?.v ?? 'null')) as {
        method?: string;
        pendingMethod?: string;
      } | null;
      assert.equal(record?.method, 'email', 'the switch back to email codes is immediate');
      assert.equal(record?.pendingMethod, undefined, 'nothing stays pending');
    },
    method: 'POST',
    path: () => '/api/auth/mfa/enrol',
    form: () => ({ method: 'email' }),
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
    // A fully signed-in session has no sign-in code to send; the endpoint
    // must say so, not 500.
    endpoint: 'auth/mfa/send.ts',
    title: 'a code send outside the sign-in step is refused, not 500',
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

  // Universal two-step verification (Build Prompt 37): every sign-in lands on
  // the email-code step. The smoke run has no Graph mailer, so the automatic
  // sends visibly fail (which itself proves the send path is wired) and known
  // challenges are planted through the database handle before verifying.
  const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
  const readMfa = (db: SmokeDb, userId: string): MfaRecord => {
    const row = db
      .prepare(
        `SELECT config_value AS v FROM config
          WHERE organization_id = ? AND config_key = ?`,
      )
      .get(SMOKE.orgId, `MFA_TOTP::${userId}`) as { v?: string } | undefined;
    assert.ok(row?.v, `an MFA record must exist for ${userId}`);
    return JSON.parse(String(row.v)) as MfaRecord;
  };
  const writeMfa = (db: SmokeDb, userId: string, record: MfaRecord): void => {
    db.prepare(
      `UPDATE config SET config_value = ?
        WHERE organization_id = ? AND config_key = ?`,
    ).run(JSON.stringify(record), SMOKE.orgId, `MFA_TOTP::${userId}`);
  };
  const plantOtp = (userId: string, code: string): void => {
    const db = server.database;
    assert.ok(db, 'the fake database is reachable to plant a code');
    writeMfa(db, userId, {
      ...readMfa(db, userId),
      challenge: newChallenge(sha256(code), Date.now() - 90_000),
    });
  };
  /** The full universal sign-in: the password step, then the planted emailed code. */
  const signInWithEmailCode = async (
    email: string,
    password: string,
    userId: string,
  ): Promise<void> => {
    server.clearCookies();
    const login = await server.request('POST', '/api/auth/login', { email, password });
    assert.equal(login.status, 303, `login answered ${login.status}: ${login.body.slice(0, 300)}`);
    const location = String(login.headers.location ?? '');
    assert.ok(location.startsWith('/mfa'), `every sign-in must land on the step, got ${location}`);
    plantOtp(userId, '424242');
    const verified = await server.request('POST', '/api/auth/mfa/verify', { code: '424242' });
    const landed = String(verified.headers.location ?? '');
    assert.ok(!landed.includes('error'), `verification failed, redirected to ${landed}`);
  };

  /**
   * Enter an instance (Build Prompt 38). The platform owner is pinned to no
   * organisation, so after signing in they must select one before any module
   * page is reachable; every crawl and mutation below runs inside Hass.
   */
  const enterInstance = async (organizationId: string = SMOKE.orgId): Promise<void> => {
    const res = await server.request('POST', '/api/org/switch', {
      organization_id: organizationId,
    });
    assert.equal(
      String(res.headers.location ?? ''),
      '/',
      `entering ${organizationId} must land in its dashboard`,
    );
  };

  /** Sign in as the platform owner and enter Hass, the state most steps assume. */
  const signInAsOwnerInsideHass = async (): Promise<void> => {
    await signInWithEmailCode(SMOKE.email, SMOKE.password, SMOKE.userId);
    await enterInstance();
  };

  try {
    await t.test('sign in as the seeded user: the second factor is universal', async () => {
      server.clearCookies();
      const res = await server.request('POST', '/api/auth/login', {
        email: SMOKE.email,
        password: SMOKE.password,
      });
      assert.equal(res.status, 303, `login answered ${res.status}: ${res.body.slice(0, 300)}`);
      const location = String(res.headers.location ?? '');
      assert.ok(
        location.startsWith('/mfa'),
        `no role is exempt; login must land on the step, got ${location}`,
      );
      assert.ok(
        location.includes('senderror=1'),
        'without the Graph mailer the automatic sign-in send visibly fails',
      );
      const blocked = await server.get('/work-papers');
      assert.equal(
        blocked.hops[blocked.hops.length - 1],
        '/mfa',
        'a pending session must not reach the app',
      );
      // The password step provisions the email default with its first set of
      // backup codes, so an unavailable inbox never locks the account out and
      // there is still nothing to set up.
      const provisionDb = server.database;
      assert.ok(provisionDb, 'the fake database is reachable for verification');
      const provisioned = readMfa(provisionDb, SMOKE.userId);
      assert.equal(provisioned.method, 'email', 'the automatic default is email codes');
      assert.equal(provisioned.confirmed, true, 'the default needs no enrolment');
      assert.equal(provisioned.backup.length, 8, 'backup codes come with the account');
      assert.ok(provisioned.backupPlain, 'the sealed shown-once plaintext rides along');
      const step = await server.get('/mfa');
      assert.equal(step.status, 200, `step screen answered ${step.status}`);
      assert.ok(step.body.includes('code we emailed'), 'the step defaults to the email copy');
      assert.ok(step.body.includes('Or a backup code'), 'the step takes a backup code');
      assert.ok(step.body.includes('Resend code'), 'the step offers a resend');
      assert.ok(
        step.body.includes('Use an authenticator app instead'),
        'the admin sees the minimised authenticator link on the step',
      );
      plantOtp(SMOKE.userId, '424242');
      const wrong = await server.request('POST', '/api/auth/mfa/verify', { code: '000001' });
      assert.ok(String(wrong.headers.location ?? '').includes('error=1'), 'a wrong code refuses');
      const ok = await server.request('POST', '/api/auth/mfa/verify', { code: '424242' });
      // The platform owner is pinned to no organisation (Build Prompt 38), so
      // the second factor promotes them onto the all-instances view, not into
      // any customer's dashboard.
      assert.equal(
        String(ok.headers.location ?? ''),
        '/platform',
        'the platform owner lands on the all-instances view',
      );
    });

    await t.test('the platform owner is not pinned to any organisation', async () => {
      const platform = await server.get('/platform');
      assert.equal(platform.status, 200, `/platform answered ${platform.status}`);
      assert.ok(
        platform.body.includes('class="grc-orgline__name">All organisations'),
        'the shell reads "All organisations" while no instance is selected',
      );
      assert.ok(
        !platform.body.includes(`class="grc-orgline__name">${SMOKE.orgName}`),
        'no customer name is shown as the acting organisation',
      );
      assert.ok(
        platform.body.includes(SMOKE.orgName) && platform.body.includes(SMOKE.otherOrgName),
        'every instance on the platform is listed to enter',
      );

      // A module page needs an instance: the owner is prompted to pick one
      // rather than being defaulted into their home organisation.
      for (const path of ['/', '/work-papers', '/action-plans', '/settings/users']) {
        const res = await server.get(path);
        assert.equal(
          res.hops[res.hops.length - 1],
          '/platform',
          `${path} must send an owner with no instance to the all-instances view`,
        );
      }
      // An API path says so rather than answering with another org's data.
      const api = await server.request('GET', '/api/sidebar-counts');
      assert.equal(api.status, 409, `the counts endpoint answered ${api.status} with no instance`);
    });

    await t.test('entering an instance scopes everything to it, and leaving returns', async () => {
      await enterInstance();
      const dash = await server.get('/');
      assert.equal(dash.status, 200, 'the dashboard opens inside the entered instance');
      assert.ok(
        dash.body.includes(`class="grc-orgline__name">${SMOKE.orgName}`),
        'the shell names the instance being acted in',
      );
      assert.ok(
        !dash.body.includes('class="grc-orgline__name">All organisations'),
        'the organisation line is the instance name, not the platform label',
      );
      const wp = await server.get('/work-papers');
      assert.equal(wp.status, 200, 'the module pages open inside the instance');

      // Leaving clears the instance and puts the owner back above the customers.
      const left = await server.request('POST', '/api/org/leave');
      assert.equal(String(left.headers.location ?? ''), '/platform', 'leaving returns to the view');
      const after = await server.get('/');
      assert.equal(
        after.hops[after.hops.length - 1],
        '/platform',
        'after leaving, a module page prompts for an instance again',
      );

      // Back inside Hass for the page crawl and the mutation steps below.
      await enterInstance();
    });

    await t.test('the instance admin is pinned to their organisation', async () => {
      await signInWithEmailCode(SMOKE.instanceAdminEmail, SMOKE.password, SMOKE.instanceAdminId);
      const home = await server.get('/');
      assert.equal(home.status, 200, 'the pinned admin lands straight in their dashboard');
      assert.ok(home.body.includes(SMOKE.orgName), 'the shell always names their organisation');
      assert.ok(
        !home.body.includes('All organisations'),
        'a pinned admin has no all-instances view',
      );
      assert.ok(!home.body.includes('grc-switcher'), 'a pinned admin has no instance switcher');
      // The platform view and its endpoints are not theirs to reach.
      const platform = await server.get('/platform');
      assert.equal(
        platform.hops[platform.hops.length - 1],
        '/',
        'the all-instances view sends a pinned admin home',
      );
      const switched = await server.request('POST', '/api/org/switch', {
        organization_id: SMOKE.otherOrgId,
      });
      assert.equal(String(switched.headers.location ?? ''), '/', 'switching is refused');
      const stillHome = await server.get('/');
      assert.ok(
        stillHome.body.includes(SMOKE.orgName) && !stillHome.body.includes(SMOKE.otherOrgName),
        'a refused switch leaves them in their own organisation',
      );

      // AC-08: the super-label above the organisation name is the platform
      // owner's, and says nothing to somebody who belongs to one organisation.
      assert.ok(
        !stillHome.body.includes('grc-orgline__label'),
        'a pinned admin sees the organisation name alone, with no super-label',
      );

      // AC-02: the platform-wide config is not theirs to write. Both of these
      // sit on the shared GLOBAL sentinel, so a save here would change the model
      // every tenant's AI runs on, or the mailbox every tenant sends from.
      const aiSave = await server.request('POST', '/api/ai/config', {
        active_provider: 'anthropic',
        model: 'nothing-they-should-be-able-to-set',
      });
      assert.equal(aiSave.status, 403, 'an instance admin cannot change the platform AI config');
      // The exact refusal matters here, not merely that an error came back: the
      // smoke environment has no Graph credentials, so these endpoints error for
      // a second reason too, and only the owner-gate message proves the gate.
      const refusal = (res: { headers: Record<string, string | string[] | undefined> }): string =>
        decodeURIComponent(String(res.headers.location ?? ''));
      const mailConnect = await server.request('GET', '/api/admin/outlook/connect');
      assert.match(
        refusal(mailConnect),
        /connected by the platform owner/,
        'an instance admin cannot start the shared mailbox connect flow',
      );
      const mailTest = await server.request('POST', '/api/admin/outlook/test', {});
      assert.match(
        refusal(mailTest),
        /tested by the platform owner/,
        'an instance admin cannot send through the shared mailbox',
      );
      // The screens they can still read must not offer the controls either.
      const emailScreen = await server.get('/settings/email');
      assert.ok(
        emailScreen.body.includes('connected and tested by Murikah Labs'),
        'the email screen tells a pinned admin the mailbox is not theirs to manage',
      );
      assert.ok(
        !emailScreen.body.includes('/api/admin/outlook/test'),
        'the email screen offers a pinned admin no test action',
      );

      // AC-01: they may edit their own organisation's roles, and only those.
      const saved = await server.request('POST', '/api/access-control', {
        role_code: 'AUDITOR',
        grant_WORK_PAPER_read: '1',
      });
      assert.ok(
        !String(saved.headers.location ?? '').includes('error='),
        'an instance admin may edit their own roles',
      );
      const db = server.database;
      assert.ok(db, 'the fake database is reachable for verification');
      const allowedIn = (org: string): number => {
        const row = db
          .prepare(
            `SELECT is_allowed AS a FROM role_permissions
              WHERE organization_id = ? AND role_code = 'AUDITOR'
                AND module_code = 'WORK_PAPER' AND action_code = 'read'`,
          )
          .get(org) as { a?: number | bigint } | undefined;
        return Number(row?.a ?? -1);
      };
      assert.equal(allowedIn(SMOKE.orgId), 1, 'their own organisation took the change');
      assert.equal(
        allowedIn(SMOKE.otherOrgId),
        1,
        "the other organisation's own grant is as it was seeded",
      );
      assert.equal(
        allowedIn(PLATFORM_DEFAULT_ORG),
        1,
        'the platform defaults are not an instance admin to change',
      );
      // The revocations they just made reached nobody else: WORK_PAPER.create was
      // left unticked, so it is refused for them and untouched everywhere else.
      const createIn = (org: string): number => {
        const row = db
          .prepare(
            `SELECT is_allowed AS a FROM role_permissions
              WHERE organization_id = ? AND role_code = 'AUDITOR'
                AND module_code = 'WORK_PAPER' AND action_code = 'create'`,
          )
          .get(org) as { a?: number | bigint } | undefined;
        return Number(row?.a ?? -1);
      };
      assert.equal(createIn(SMOKE.orgId), 0, 'their own unticked cell is revoked');
      assert.equal(createIn(PLATFORM_DEFAULT_ORG), 1, 'the platform default keeps it');
      assert.equal(createIn(SMOKE.otherOrgId), 0, 'the other organisation keeps its own answer');

      // Back to the owner inside Hass, the state the rest of the run assumes.
      await signInAsOwnerInsideHass();
    });

    await t.test('the work paper detail shows the fields that are stored', async () => {
      // Build Prompt 50. The seed stores an assigned_auditor_id with no
      // denormalised name, a control_classification and control_standards, and
      // the detail rendered a dash over all three: it was reading form-field
      // names rather than column names, and the auditor alias was shadowed by
      // wp.*. These assert the stored values reach the page.
      const detail = await server.get(`/work-papers/${SMOKE.sentWorkPaperId}`);
      assert.equal(detail.status, 200);
      // Asserted as the label-and-value pair, not a bare substring: the words
      // appear elsewhere on the page (the auditor dropdown, the filters), and a
      // loose match would pass while the field itself still read a dash.
      const field = (label: string): string | null => {
        const m = new RegExp(`<dt>${label}</dt>\\s*<dd[^>]*>([^<]*)</dd>`).exec(detail.body);
        return m ? m[1].trim() : null;
      };
      assert.equal(
        field('Assigned auditor'),
        'Amina Auditor',
        'the assigned auditor resolves from assigned_auditor_id, not a dash',
      );
      assert.equal(field('Classification'), 'KEY', 'the stored classification is shown');
      assert.equal(
        field('Standards'),
        'ISO 27001, IIA Standards',
        'the stored standards are shown',
      );

      // The edit form prefills from the same values. Before this build it read
      // the same wrong keys, so it opened blank and saved the blank back over
      // real data: a display bug on the detail, a data-loss bug here.
      const edit = await server.get(`/work-papers/${SMOKE.draftWorkPaperId}/edit`);
      assert.equal(edit.status, 200);
      assert.ok(
        edit.body.includes('ISO 27001'),
        'the edit form prefills the stored standards rather than blanking them',
      );
      assert.ok(
        /<option[^>]*value="KEY"[^>]*selected/.test(edit.body),
        'and keeps the stored classification selected',
      );
      assert.ok(
        new RegExp(`<option[^>]*value="${SMOKE.auditorId}"[^>]*selected`).test(edit.body),
        'and the stored assigned auditor selected',
      );
    });

    await t.test('a role confined to its affiliate sees only its affiliate', async () => {
      // Build Prompt 45. The seed puts every other record in HKL and exactly one
      // finding and one action plan in HPL, and gives AFFILIATE_LEAD auditor-side
      // grants, so the row-level rules would show this viewer the whole
      // organisation. The confinement is the only thing narrowing them, which is
      // what makes these assertions mean something.
      await signInWithEmailCode(SMOKE.confinedUserEmail, SMOKE.password, SMOKE.confinedUserId);

      const list = await server.get('/work-papers');
      assert.equal(list.status, 200, 'a confined viewer still reaches their list');
      assert.ok(list.body.includes('WP/2026/002'), 'their own affiliate is listed');
      assert.ok(
        !list.body.includes('WP/2026/HPL'),
        'a finding in another affiliate must not be listed',
      );
      assert.ok(
        list.body.includes(`confined to the ${SMOKE.affiliateCode} affiliate`),
        'the screen says why the list is narrowed',
      );

      // The boundary holds on the detail route too, which takes its id from the
      // URL: a list predicate alone would leave this open to a guessed link.
      const foreign = await server.get(`/work-papers/${SMOKE.otherAffiliateWorkPaperId}`);
      assert.ok(
        foreign.status === 404 || !foreign.body.includes('Pipeline stock counts'),
        `a finding outside the affiliate must not open, got ${foreign.status}`,
      );
      const own = await server.get(`/work-papers/${SMOKE.sentWorkPaperId}`);
      assert.equal(own.status, 200, 'their own affiliate still opens');

      // And on the mutation endpoint behind it.
      const edited = await server.request(
        'POST',
        `/api/work-papers/${SMOKE.otherAffiliateWorkPaperId}`,
        { observation_title: 'Edited across the affiliate boundary', year: '2026' },
      );
      assert.ok(edited.status < 500, 'a refused edit is still a handled response');
      const db = server.database;
      assert.ok(db, 'the fake database is reachable for verification');
      const title = db
        .prepare(`SELECT observation_title AS t FROM work_papers WHERE work_paper_id = ?`)
        .get(SMOKE.otherAffiliateWorkPaperId) as { t?: string };
      assert.ok(
        !String(title.t).includes('across the affiliate boundary'),
        'an edit outside the affiliate must not persist',
      );

      // The aggregations narrow too, or the totals would leak what the lists hide.
      const plans = await server.get('/action-plans');
      assert.ok(!plans.body.includes('AP/2026/HPL'), 'plans outside the affiliate are excluded');
    });

    await t.test('a user on a Group affiliate is exempt from confinement', async () => {
      // Build Prompt 48. Same role, same grants, same confinement as the viewer
      // above: the only difference is that their affiliate carries is_group, so
      // any change in what they see is attributable to that flag and nothing
      // else. They must see both affiliates, exactly as an unconfined user does.
      await signInWithEmailCode(SMOKE.groupUserEmail, SMOKE.password, SMOKE.groupUserId);

      const list = await server.get('/work-papers');
      assert.equal(list.status, 200, 'a group viewer reaches their list');
      assert.ok(list.body.includes('WP/2026/002'), 'the HKL affiliate is listed');
      assert.ok(
        list.body.includes('WP/2026/HPL'),
        'and so is the HPL affiliate: the Group sees every affiliate',
      );
      assert.ok(
        list.body.includes('Group affiliate'),
        'the screen says why a confined role is not narrowing them',
      );

      // The detail route opens across the boundary too, which is the half a
      // list-only exemption would have missed.
      const foreign = await server.get(`/work-papers/${SMOKE.otherAffiliateWorkPaperId}`);
      assert.equal(foreign.status, 200, 'a finding in another affiliate opens');
      assert.ok(foreign.body.includes('Pipeline stock counts'), 'and renders its content');

      // The aggregations widen with it, or the totals would contradict the lists.
      const plans = await server.get('/action-plans');
      assert.ok(plans.body.includes('AP/2026/HPL'), 'plans in every affiliate are counted');
    });

    await t.test('a confined user with no affiliate is told, not shown an empty list', async () => {
      // The state that is easy to get wrong: an ordinary empty state here would
      // read as "your organisation has no findings" when the truth is "your
      // account is not finished".
      await signInWithEmailCode(SMOKE.unassignedUserEmail, SMOKE.password, SMOKE.unassignedUserId);
      const list = await server.get('/work-papers');
      assert.equal(list.status, 200, 'the page still renders rather than erroring');
      assert.ok(
        list.body.includes('Your account has no affiliate'),
        'the screen names the configuration problem',
      );
      assert.ok(!list.body.includes('WP/2026/002'), 'no findings are shown at all');
      assert.ok(!list.body.includes('WP/2026/HPL'), 'including the other affiliate');

      // Back to the owner inside Hass, the state the rest of the run assumes.
      await signInAsOwnerInsideHass();
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

    // Mutually exclusive Email connection states (Build Prompt 36): without a
    // stored connection the settings page shows the credentials setup banner;
    // with one it shows the connected panel and never the banner alongside it.
    await t.test('a connected mailbox hides the email setup banner', async () => {
      const db = server.database;
      assert.ok(db, 'the fake database is reachable');
      // The logout dry-run above ended the owner's session, so sign back in and
      // re-enter Hass: settings belong to an instance, not to the platform.
      await signInAsOwnerInsideHass();
      const before = await server.get('/settings/email');
      assert.equal(before.status, 200, `/settings/email answered ${before.status}`);
      assert.ok(
        before.body.includes('credentials are not configured'),
        'the setup banner shows while nothing is connected and no secrets are set',
      );
      assert.ok(!before.body.includes('Connected as'), 'no connected panel without a connection');
      const connectedAt = '2026-01-05T09:00:00.000Z';
      db.prepare(
        `INSERT INTO config (organization_id, config_key, config_value, updated_at)
          VALUES ('GLOBAL', 'MAIL_OUTLOOK_CONNECTION', ?, ?)`,
      ).run(
        JSON.stringify({
          sealedToken: 'smoke-sealed-token',
          address: 'hassaudit@outlook.com',
          connectedAt,
          status: 'ok',
          updatedAt: connectedAt,
        }),
        connectedAt,
      );
      try {
        const res = await server.get('/settings/email');
        assert.equal(res.status, 200, `/settings/email answered ${res.status}`);
        assert.ok(
          res.body.includes('Connected as hassaudit@outlook.com'),
          'the connected panel shows the mailbox address',
        );
        assert.ok(
          !res.body.includes('credentials are not configured'),
          'the setup banner must not show while a connection exists',
        );
      } finally {
        // Later steps (the test-email refusal already ran, but the auditee and
        // auth flows have not) expect the seeded not-connected state back.
        db.prepare(
          `DELETE FROM config
            WHERE organization_id = 'GLOBAL' AND config_key = 'MAIL_OUTLOOK_CONNECTION'`,
        ).run();
      }
    });

    // Work paper as parent (Build Prompt 27): an action plan cannot exist
    // without a finding, and the one seeded stray is surfaced and relinkable.
    // System-generated emailed passwords (Build Prompt 39): the admin never
    // types one, sees the generated value exactly once, and a mail outage
    // degrades to "here it is, pass it on" rather than losing the account.
    await t.test('a generated password is shown once and only once', async () => {
      const db = server.database;
      assert.ok(db, 'the fake database is reachable');
      const created = await server.request('POST', '/api/setup/users', {
        op: 'create',
        email: 'shown.once@hasspetroleum.com',
        full_name: 'Shown Once',
        role_code: 'AUDITOR',
      });
      const location = String(created.headers.location ?? '');
      assert.ok(location.includes('credential='), `create redirected to ${location}`);
      // The smoke run has no Graph mailer, so the send visibly fails and the
      // admin is told: the account still exists and the password is still shown.
      assert.ok(
        location.includes('mailerror='),
        'without a mailer the failure must be surfaced, not swallowed',
      );
      const row = db
        .prepare(`SELECT user_id AS id FROM users WHERE email = 'shown.once@hasspetroleum.com'`)
        .get() as { id?: string } | undefined;
      assert.ok(row?.id, 'a failed email must not undo the account');

      // A live credential must never travel in the URL.
      assert.ok(
        !/[?&]password=/.test(location),
        'the generated password must not ride in the query string',
      );

      const first = await server.get(`/settings/users?${location.split('?')[1]}`);
      assert.equal(first.status, 200, `the credential panel answered ${first.status}`);
      assert.ok(first.body.includes('Temporary password'), 'the panel shows the password once');
      assert.ok(first.body.includes('grc-temp-pw'), 'the value is rendered for copying');
      assert.ok(
        first.body.includes('could not be sent'),
        'the panel says the email did not go out',
      );

      // The password itself is what was generated, and it is gone from the
      // database the moment it has been read.
      const shown = /id="grc-temp-pw"[^>]*>([^<]+)</.exec(first.body);
      assert.ok(shown, 'the rendered password must be findable');
      assert.match(shown[1].trim(), /^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/, 'a generated shape');
      const left = db
        .prepare(
          `SELECT COUNT(*) AS n FROM config
            WHERE organization_id = ? AND config_key = ?`,
        )
        .get(SMOKE.orgId, `USER_TEMP_PW::${String(row.id)}`) as { n: number | bigint };
      assert.equal(Number(left.n), 0, 'reading the password clears it');

      const second = await server.get(`/settings/users?${location.split('?')[1]}`);
      assert.equal(second.status, 200, `the second view answered ${second.status}`);
      assert.ok(
        second.body.includes('Password already shown'),
        'a refresh must not show the password again',
      );
      assert.ok(!second.body.includes(shown[1].trim()), 'the password itself must not reappear');
    });

    await t.test('the admin never types a password on the users screen', async () => {
      const page = await server.get('/settings/users');
      assert.equal(page.status, 200, `the users screen answered ${page.status}`);
      assert.ok(
        !page.body.includes('name="password"'),
        'no password input may remain on the create or reset forms',
      );
      assert.ok(
        page.body.includes('A temporary password is generated for you'),
        'the create form explains what happens instead',
      );
    });

    await t.test('an action plan cannot be created or unlinked from its parent', async () => {
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

    // Evidence is a first-class section wherever a finding is written or read
    // (Build Prompt 41): a heading, a visible attach area that takes several
    // files at once, and uniform tiles with an image thumbnail.
    await t.test('every work paper view carries a clear evidence section', async () => {
      for (const path of [
        '/work-papers/new',
        `/work-papers/${SMOKE.draftWorkPaperId}`,
        `/work-papers/${SMOKE.draftWorkPaperId}/edit`,
      ]) {
        const res = await server.get(path);
        assert.equal(res.status, 200, `${path} answered ${res.status}`);
        assert.ok(
          res.body.includes('grc-evidence-panel'),
          `${path} must show the evidence section`,
        );
        assert.ok(
          res.body.includes('Supporting documents and images'),
          `${path} must say what the section is for`,
        );
      }
    });

    await t.test('the evidence list shows a thumbnail for an image', async () => {
      const db = server.database;
      assert.ok(db, 'the fake database is reachable');
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO files (file_id, organization_id, file_name, mime_type, size_bytes,
                            uploaded_by, created_at, storage_backend, storage_key)
         VALUES ('FILE-IMG', ?, 'ledger-photo.png', 'image/png', 2048, ?, ?, 'r2', 'k-img')`,
      ).run(SMOKE.orgId, SMOKE.userId, now);
      db.prepare(
        `INSERT INTO file_attachments (attachment_id, file_id, entity_type, entity_id,
                                       file_category, attached_by, attached_at)
         VALUES ('ATT-IMG', 'FILE-IMG', 'work_paper', ?, 'EVIDENCE', ?, ?)`,
      ).run(SMOKE.draftWorkPaperId, SMOKE.userId, now);

      const res = await server.get(`/work-papers/${SMOKE.draftWorkPaperId}`);
      assert.equal(res.status, 200, `the detail answered ${res.status}`);
      // The image is served from the reduced copy, so a wall of evidence stays
      // uniform and light; a document shows its extension instead.
      assert.ok(
        res.body.includes('/api/evidence/ATT-IMG/download?variant=preview'),
        'an image tile must load the preview variant',
      );
      assert.ok(res.body.includes('grc-evidence-tile__thumb'), 'the tile carries a thumbnail box');
      assert.ok(
        res.body.includes('grc-evidence-tile__thumb--doc'),
        'a document tile carries the document mark',
      );
    });

    await t.test('the preview variant falls back rather than breaking', async () => {
      // Nothing is in storage in the smoke environment, so the preview request
      // degrades exactly as an older file with no preview would: a deliberate
      // JSON 503, never a 500 and never a broken image contract.
      const res = await server.request('GET', '/api/evidence/ATT-IMG/download?variant=preview');
      assert.ok(res.status < 500 || res.status === 503, `preview answered ${res.status}`);
    });

    // Evidence storage is per organisation (Build Prompt 51). Hass has a tested,
    // active R2 connection in the seed and Coast deliberately has none, so this
    // proves both halves of the contract at once: the provider is resolved for
    // the acting organisation, and an organisation without one is told so
    // plainly rather than failing at the moment somebody tries to upload.
    await t.test('the active storage provider is resolved per organisation', async () => {
      const screen = await server.get('/settings/storage');
      assert.equal(screen.status, 200, `evidence storage answered ${screen.status}`);
      assert.ok(
        screen.body.includes('New evidence is stored in Cloudflare R2'),
        'Hass must see its own active provider named',
      );
      assert.ok(
        !screen.body.includes('smoke-secret-key'),
        'no stored credential may ever reach the screen',
      );
      assert.ok(
        screen.body.includes('••••'),
        'a stored credential is shown masked, so an administrator can tell one is set',
      );

      const prepared = await server.request('POST', '/api/evidence/upload-url', {
        entity_type: 'work_paper',
        entity_id: SMOKE.sentWorkPaperId,
        file_name: 'smoke-evidence.pdf',
        content_type: 'application/pdf',
        size_bytes: '1024',
      });
      assert.equal(
        prepared.status,
        200,
        `preparing an upload in Hass answered ${prepared.status}: ${prepared.body.slice(0, 300)}`,
      );
      const plan = JSON.parse(prepared.body) as { backend?: string; mode?: string; url?: string };
      assert.equal(plan.backend, 'r2', "the upload must be prepared against Hass's own provider");
      assert.equal(plan.mode, 'presigned', 'R2 signs a URL, so the bytes never touch the worker');
      assert.ok(
        String(plan.url).includes(SMOKE.storageBucket),
        "the signed URL must address Hass's own bucket",
      );

      // The same session, a different organisation, and nothing carries over.
      await enterInstance(SMOKE.otherOrgId);
      const coast = await server.get('/settings/storage');
      assert.equal(coast.status, 200, `Coast's evidence storage answered ${coast.status}`);
      assert.ok(
        coast.body.includes('No provider is active yet'),
        'an organisation with no connection must be told so, never shown a stranger provider',
      );
      assert.ok(
        !coast.body.includes(SMOKE.storageBucket),
        "Coast must never see Hass's storage settings",
      );
      const refused = await server.request('POST', '/api/evidence/upload-url', {
        entity_type: 'work_paper',
        entity_id: SMOKE.sentWorkPaperId,
        file_name: 'smoke-evidence.pdf',
        content_type: 'application/pdf',
        size_bytes: '1024',
      });
      assert.equal(
        refused.status,
        503,
        `an unconfigured organisation must refuse the upload, got ${refused.status}`,
      );
      assert.ok(
        refused.body.includes('not configured for your organisation'),
        `the refusal must say why, got ${refused.body.slice(0, 200)}`,
      );

      await enterInstance();
    });

    // Requirements are a request for information with two dates on it (Build
    // Prompt 52): what was asked for, when it was asked for, and when it
    // arrived. The seeded pair is deliberately one of each state, so a page
    // that rendered only one label would fail here.
    await t.test('requirements show both dates, and what is still outstanding', async () => {
      const res = await server.get(`/work-papers/${SMOKE.sentWorkPaperId}`);
      assert.equal(res.status, 200, `the detail answered ${res.status}`);
      for (const heading of ['Information requested', 'Date requested', 'Date received']) {
        assert.ok(res.body.includes(heading), `the requirements table must show ${heading}`);
      }
      assert.ok(res.body.includes('>Outstanding<'), 'a requirement not yet received reads so');
      assert.ok(res.body.includes('>Received<'), 'one that has arrived reads so');
      // The dates themselves are on the page, not only the labels.
      assert.ok(res.body.includes('2026-01-05'), 'the date requested is shown');
      assert.ok(res.body.includes('2026-02-09'), 'the date received is shown');
      // The status is never a form field: it is derived from the date, so there
      // is nothing on the screen for it to be typed into out of step.
      assert.ok(
        !/name="status"/.test(res.body),
        'a status a person can type beside the date is the bug this replaced',
      );
    });

    // Batch release and the head-of-audit digest (Build Prompt 53). An auditor
    // drafting a week of fieldwork releases it in one action, and the reviewer
    // gets one email listing everything, never one per finding.
    await t.test('several drafts release together and become one digest', async () => {
      const db = server.database;
      assert.ok(db, 'the fake database is reachable for verification');

      // Three real drafts, created through the API so they carry everything a
      // finding carries: a reference, an area, a risk rating.
      const created: string[] = [];
      for (const [i, title] of [
        'Bank reconciliations not performed',
        'Supplier master file uncontrolled',
        'Access reviews overdue',
      ].entries()) {
        const res = await server.request('POST', '/api/work-papers', {
          observation_title: title,
          observation_description: `Batch release smoke finding ${i + 1}.`,
          year: '2026',
          affiliate_code: SMOKE.affiliateCode,
          audit_area_id: SMOKE.auditAreaId,
          sub_area_id: SMOKE.subAreaId,
          risk_rating: 'High',
          recommendation: 'Fix it.',
          assigned_auditor: SMOKE.auditorId,
        });
        const m = /\/work-papers\/([^/?]+)/.exec(String(res.headers.location ?? ''));
        assert.ok(m, `create ${i + 1} redirected to ${res.headers.location}`);
        created.push(m[1]);
      }

      // The list offers the batch control for drafts the actor may release.
      const list = await server.get('/work-papers?status=Draft');
      assert.equal(list.status, 200, `the list answered ${list.status}`);
      assert.ok(
        list.body.includes('Submit selected for review'),
        'the list must offer the batch release',
      );
      assert.ok(list.body.includes('name="work_paper_id"'), 'and a checkbox per draft to release');

      const before = Number(
        (
          db
            .prepare(
              `SELECT COUNT(*) AS n FROM notification_queue WHERE batch_type = 'WP_SUBMITTED'`,
            )
            .get() as { n: number | bigint }
        ).n,
      );

      // One action, three findings.
      const body = new URLSearchParams();
      for (const id of created) body.append('work_paper_id', id);
      const released = await server.request('POST', '/api/work-papers/submit-batch', body);
      assert.ok(released.status < 400, `the batch answered ${released.status}`);
      const location = String(released.headers.location ?? '');
      assert.ok(!/[?&]error=/.test(location), `the batch bounced with an error: ${location}`);
      assert.ok(
        decodeURIComponent(location).includes('3 findings submitted for review'),
        `the batch must report what it did, got: ${location}`,
      );

      // Each one moved through the transition engine, with its own revision row:
      // a batch is many submissions, not a bulk update that skips the trail.
      for (const id of created) {
        const row = db
          .prepare(`SELECT status FROM work_papers WHERE work_paper_id = ?`)
          .get(id) as { status?: string };
        assert.equal(String(row.status), 'Submitted', `${id} must be submitted`);
        const revisions = db
          .prepare(
            `SELECT COUNT(*) AS n FROM work_paper_revisions
              WHERE work_paper_id = ? AND to_status = 'Submitted'`,
          )
          .get(id) as { n: number | bigint };
        assert.ok(Number(revisions.n) >= 1, `${id} must have its own revision row`);
      }

      // Every submission queued its own notification...
      const queued = db
        .prepare(
          `SELECT notification_id AS id, batch_type, recipient_email, rendered_subject, payload,
                  priority, status
             FROM notification_queue
            WHERE batch_type = 'WP_SUBMITTED' AND status = 'PENDING'`,
        )
        .all() as {
        id: string;
        batch_type: string;
        recipient_email: string;
        rendered_subject: string;
        payload: string;
        priority: string;
      }[];
      assert.ok(
        queued.length >= before + 3,
        `three submissions must queue three notifications, got ${queued.length - before}`,
      );

      // ...and the drain turns them into exactly one email per reviewer, with
      // every finding in one table. This is the real planner the cron uses.
      const plans = planNormalDigests(
        queued.map((r) => ({
          id: r.id,
          batchType: r.batch_type,
          recipientEmail: r.recipient_email,
          subject: r.rendered_subject,
          payload: r.payload,
        })),
        REVIEW_QUEUE_LINK,
      );
      const recipients = new Set(queued.map((r) => r.recipient_email));
      assert.ok(recipients.size >= 1, 'the head of audit must be among the recipients');
      assert.equal(plans.length, recipients.size, 'one email per reviewer, never one per finding');
      for (const plan of plans) {
        const mine = queued.filter((r) => r.recipient_email === plan.email);
        assert.equal(plan.rowIds.length, mine.length, 'the one email settles all their rows');
        if (mine.length > 1) {
          assert.match(
            plan.subject,
            /work papers submitted for review$/,
            `a batch digest names the count, got ${plan.subject}`,
          );
        }
        // The table carries every finding that reviewer was told about.
        for (const row of mine) {
          const reference = String(
            (JSON.parse(row.payload) as { reference?: string }).reference ?? '',
          );
          assert.ok(reference, 'the payload carries the reference');
          assert.ok(
            plan.body.includes(reference),
            `${reference} must appear in the digest for ${plan.email}`,
          );
        }
        assert.ok(plan.body.includes('Review the queue'), 'with one button to the review queue');
        assert.ok(
          plan.body.includes('/work-papers?status=Submitted'),
          'pointing at the findings waiting on them',
        );
      }
    });

    // Activation on a successful test (Build Prompt 54). A connection could be
    // written, tested and marked connected while is_active stayed 0, so a
    // working provider read as "not configured" and evidence could not be
    // attached without somebody flipping a column by hand. This walks that
    // exact state and proves the screen alone gets out of it.
    await t.test('a successful test activates the provider and opens the gate', async () => {
      const db = server.database;
      assert.ok(db, 'the fake database is reachable for verification');

      const activeRow = (): {
        provider?: string;
        status?: string;
        is_active?: number | bigint;
        connected_at?: string | null;
      } =>
        db
          .prepare(
            `SELECT provider, status, is_active, connected_at FROM storage_connections
              WHERE organization_id = ? AND provider = 'r2'`,
          )
          .get(SMOKE.orgId) as {
          provider?: string;
          status?: string;
          is_active?: number | bigint;
          connected_at?: string | null;
        };

      // Put the organisation into the reported state: tested and connected, but
      // never activated.
      db.prepare(
        `UPDATE storage_connections SET is_active = 0 WHERE organization_id = ? AND provider = 'r2'`,
      ).run(SMOKE.orgId);
      assert.equal(Number(activeRow().is_active), 0, 'the connection starts inactive');

      // The gate is shut, exactly as an unconfigured organisation's would be.
      const shut = await server.request('POST', '/api/evidence/upload-url', {
        entity_type: 'work_paper',
        entity_id: SMOKE.sentWorkPaperId,
        file_name: 'before.pdf',
        content_type: 'application/pdf',
        size_bytes: '1024',
      });
      assert.equal(shut.status, 503, 'a connected-but-inactive provider stores nothing');
      const screenBefore = await server.get('/settings/storage');
      assert.ok(
        screenBefore.body.includes('No provider is active yet'),
        'and the screen says so rather than showing a green tick',
      );

      // One press of Test connection.
      const tested = await server.request('POST', '/api/admin/storage/save', {
        action: 'test',
        provider: 'r2',
      });
      const location = String(tested.headers.location ?? '');
      assert.ok(
        !/[?&]error=/.test(location),
        `the test must pass against the harness S3, got ${decodeURIComponent(location)}`,
      );

      // It is now active and connected, with the attribution stamped.
      const after = activeRow();
      assert.equal(Number(after.is_active), 1, 'a passing test activates the provider');
      assert.equal(String(after.status), 'connected', 'and records that it was proved');
      assert.ok(after.connected_at, 'and when');

      // Exactly one provider is active for the organisation.
      const actives = db
        .prepare(
          `SELECT COUNT(*) AS n FROM storage_connections
            WHERE organization_id = ? AND is_active = 1`,
        )
        .get(SMOKE.orgId) as { n: number | bigint };
      assert.equal(Number(actives.n), 1, 'never two providers claiming the evidence');

      // And the gate is open, with no manual database flip anywhere.
      const open = await server.request('POST', '/api/evidence/upload-url', {
        entity_type: 'work_paper',
        entity_id: SMOKE.sentWorkPaperId,
        file_name: 'after.pdf',
        content_type: 'application/pdf',
        size_bytes: '1024',
      });
      assert.equal(open.status, 200, `the gate must open, got ${open.body.slice(0, 200)}`);
      const screenAfter = await server.get('/settings/storage');
      assert.ok(
        screenAfter.body.includes('New evidence is stored in Cloudflare R2'),
        'and the screen names the active provider',
      );
    });

    await t.test('a failed test leaves the provider inactive and says why', async () => {
      const db = server.database;
      assert.ok(db, 'the fake database is reachable for verification');

      // Point the connection at somewhere that will not answer, and save it.
      // Saving tests immediately, so this is the "saved but not active" path.
      const saved = await server.request('POST', '/api/admin/storage/save', {
        action: 'save',
        provider: 'r2',
        account_id: 'smoke-account',
        bucket: SMOKE.storageBucket,
        endpoint: 'http://127.0.0.1:1',
      });
      const location = decodeURIComponent(String(saved.headers.location ?? ''));
      assert.match(location, /error=/, 'a save that cannot be proved must not read as success');
      assert.match(location, /not active/, `it must say it is not active, got ${location}`);

      const row = db
        .prepare(
          `SELECT status, is_active FROM storage_connections
            WHERE organization_id = ? AND provider = 'r2'`,
        )
        .get(SMOKE.orgId) as { status?: string; is_active?: number | bigint };
      assert.equal(Number(row.is_active), 0, 'an unproved connection is never active');
      assert.equal(String(row.status), 'error', 'and the failure is recorded on the row');

      // The gate is shut again, which is the honest answer while nothing works.
      const shut = await server.request('POST', '/api/evidence/upload-url', {
        entity_type: 'work_paper',
        entity_id: SMOKE.sentWorkPaperId,
        file_name: 'nope.pdf',
        content_type: 'application/pdf',
        size_bytes: '1024',
      });
      assert.equal(shut.status, 503, 'nothing is stored through a provider that failed its test');

      // Putting the endpoint back proves the recovery is the same one press:
      // save, which tests, which activates. No column is touched by hand.
      const fixed = await server.request('POST', '/api/admin/storage/save', {
        action: 'save',
        provider: 'r2',
        account_id: 'smoke-account',
        bucket: SMOKE.storageBucket,
        endpoint: server.s3Origin,
      });
      assert.ok(
        !/[?&]error=/.test(String(fixed.headers.location ?? '')),
        `correcting the endpoint must re-activate it, got ${decodeURIComponent(
          String(fixed.headers.location ?? ''),
        )}`,
      );
      const restored = db
        .prepare(
          `SELECT status, is_active FROM storage_connections
            WHERE organization_id = ? AND provider = 'r2'`,
        )
        .get(SMOKE.orgId) as { status?: string; is_active?: number | bigint };
      assert.equal(Number(restored.is_active), 1, 'the working provider is active again');
      assert.equal(String(restored.status), 'connected', 'and proved');
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
      const page = await server.get(`/work-papers/${m[1]}`);
      assert.ok(page.body.includes('staged.pdf'), 'the bound evidence shows on the detail');
    });

    // Staging against a draft token is prepared exactly as a saved finding is,
    // through the organisation's own provider (Build Prompt 51). The key is
    // still built by the worker, so a client cannot smuggle a path of its own
    // in through the token.
    await t.test('a draft upload is prepared under the tenant prefix', async () => {
      const token = 'aaaaaaaa-bbbb-cccc-dddd-eeeeffff0000';
      const res = await server.request('POST', '/api/evidence/upload-url', {
        entity_type: 'work_paper_draft',
        entity_id: token,
        file_name: 'x.pdf',
        content_type: 'application/pdf',
        size_bytes: '10',
      });
      assert.equal(res.status, 200, `draft upload-url answered ${res.status}`);
      assert.ok(res.body.trimStart().startsWith('{'), 'the answer is the JSON contract');
      const plan = JSON.parse(res.body) as { url?: string };
      assert.ok(
        String(plan.url).includes(`org/${SMOKE.orgId}/work_paper_draft/${token}/`),
        `a staged key must sit under the tenant prefix, got ${String(plan.url).slice(0, 200)}`,
      );
    });

    await t.test('a draft upload refuses a token that is not a token', async () => {
      const res = await server.request('POST', '/api/evidence/upload-url', {
        entity_type: 'work_paper_draft',
        entity_id: '../../other-tenant',
        file_name: 'x.pdf',
        content_type: 'application/pdf',
        size_bytes: '10',
      });
      assert.equal(res.status, 400, `a path-like draft token answered ${res.status}`);
    });

    // Row scope and matrix gating, seen from the auditee side (Build Prompt
    // 26). The admin session signed out above, so sign in as the seeded
    // UNIT_MANAGER, whose role holds WORK_PAPER read but no CONFIG or USER
    // grant and none of the auditor-side actions.
    await t.test('sign in as the seeded auditee (universal email step included)', async () => {
      await signInWithEmailCode('owner@hasspetroleum.com', SMOKE.password, SMOKE.auditeeId);
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
      await signInWithEmailCode('auditor@hasspetroleum.com', SMOKE.password, SMOKE.auditorId);
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
        String(res.headers.location ?? '').startsWith('/mfa'),
        `the reset password must pass the password step, got ${res.headers.location}`,
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

    // The authenticator app as the admin-only alternative (Build Prompt 37
    // over 25 and 34): the minimised link on account security, the existing
    // TOTP enrolment (QR, manual key, backup codes), app-code sign-ins,
    // backup codes, and the immediate switch back to email codes.
    let mfaSecret = '';
    let mfaBackup: string[] = [];

    await t.test('the admin starts the authenticator enrolment, minimised link shown', async () => {
      await signInAsOwnerInsideHass();
      const security = await server.get('/mfa/setup');
      assert.equal(security.status, 200, `account security answered ${security.status}`);
      assert.ok(
        security.body.includes('Use an authenticator app instead'),
        'the admin sees the minimised authenticator link in account security',
      );
      assert.ok(
        security.body.includes('nothing to set up'),
        'the email default presents with no setup wall',
      );
      const enrol = await server.request('POST', '/api/auth/mfa/enrol', { method: 'totp' });
      assert.equal(enrol.status, 303, `enrol answered ${enrol.status}`);
      assert.ok(
        !String(enrol.headers.location ?? '').includes('error='),
        `the admin may enrol the app, got ${enrol.headers.location}`,
      );
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
        'an app-method account must be sent to the step, with no email send',
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
      assert.equal(
        String(ok.headers.location ?? ''),
        '/platform',
        'a valid code must promote the owner onto the all-instances view',
      );
      await enterInstance();
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
        '/platform',
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

    await t.test('switching back to email codes is immediate, backup codes kept', async () => {
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
      assert.equal(
        String(totp.headers.location ?? ''),
        '/platform',
        'the app code signs the admin in',
      );
      const before = readMfa(db, SMOKE.userId);
      const switchBack = await server.request('POST', '/api/auth/mfa/enrol', { method: 'email' });
      assert.ok(
        String(switchBack.headers.location ?? '').includes('email=1'),
        `email needs no enrolment; the switch must confirm at once, got ${switchBack.headers.location}`,
      );
      const after = readMfa(db, SMOKE.userId);
      assert.equal(after.method, 'email', 'email codes are active again');
      assert.equal(after.confirmed, true);
      assert.equal(after.pendingMethod, undefined, 'nothing stays pending');
      assert.deepEqual(after.backup, before.backup, 'the unused backup codes survive the switch');
      assert.equal(after.secret, '', 'the TOTP secret is dropped');
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
      writeMfa(db, SMOKE.userId, {
        ...readMfa(db, SMOKE.userId),
        challenge: newChallenge(sha256('271828'), Date.now() - 90_000),
      });
      const wrong = await server.request('POST', '/api/auth/mfa/verify', { code: '000001' });
      assert.ok(String(wrong.headers.location ?? '').includes('error=1'), 'a wrong code refuses');
      assert.equal(readMfa(db, SMOKE.userId).challenge?.attempts, 1, 'the wrong guess is counted');
      const ok = await server.request('POST', '/api/auth/mfa/verify', { code: '271828' });
      assert.equal(
        String(ok.headers.location ?? ''),
        '/platform',
        'the right emailed code promotes the session',
      );
      assert.equal(
        readMfa(db, SMOKE.userId).challenge?.used,
        true,
        'the challenge is spent on use',
      );
      await enterInstance();
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
      const base = readMfa(db, SMOKE.userId);
      writeMfa(db, SMOKE.userId, {
        ...base,
        challenge: { ...newChallenge(sha256('314159'), Date.now() - 90_000), used: true },
      });
      const used = await server.request('POST', '/api/auth/mfa/verify', { code: '314159' });
      assert.ok(
        String(used.headers.location ?? '').includes('error=1'),
        'a spent code never passes again',
      );
      writeMfa(db, SMOKE.userId, {
        ...base,
        challenge: newChallenge(sha256('314159'), Date.now() - 11 * 60_000),
      });
      const expired = await server.request('POST', '/api/auth/mfa/verify', { code: '314159' });
      assert.ok(
        String(expired.headers.location ?? '').includes('error=1'),
        'an expired code is refused',
      );
      writeMfa(db, SMOKE.userId, {
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
        backup_code: mfaBackup[1],
      });
      assert.equal(
        String(backup.headers.location ?? ''),
        '/platform',
        'a backup code passes for the email method',
      );
    });

    await t.test('a non-admin is email-only: no authenticator link, no enrolment', async () => {
      const db = server.database;
      assert.ok(db, 'the fake database is reachable for verification');
      await signInWithEmailCode('owner@hasspetroleum.com', SMOKE.password, SMOKE.auditeeId);
      const step = await server.get('/mfa/setup');
      assert.equal(step.status, 200, `account security answered ${step.status}`);
      assert.ok(
        !step.body.includes('Use an authenticator app instead'),
        'a non-admin must not see the authenticator link',
      );
      assert.ok(
        step.body.includes('nothing to set up'),
        'the auditee reaches account security with no wall',
      );
      const enrol = await server.request('POST', '/api/auth/mfa/enrol', { method: 'totp' });
      assert.ok(
        String(enrol.headers.location ?? '').includes('error='),
        `a non-admin cannot enrol an authenticator, got ${enrol.headers.location}`,
      );
      const record = readMfa(db, SMOKE.auditeeId);
      assert.equal(record.method, 'email', 'the auditee stays on email codes');
      assert.equal(record.pendingMethod, undefined, 'no enrolment was started');
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
