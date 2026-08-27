/**
 * Server-side authorisation on the workflow endpoints, called directly.
 *
 * The interface is never involved. These invoke the exported route handlers
 * with a request and a principal, which is what curl does, and the guard
 * refuses before the endpoint connects to anything.
 *
 * The two permissions are separate on purpose and are proved separate:
 * ADMIN.WORKFLOWS.MANAGE designs the process, ADMIN.WORKFLOW_ROLES.MANAGE
 * grants approval authority. Holding one does not confer the other, because the
 * second is the escalation an attacker actually wants.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { APIContext } from 'astro';
import type { CmsIdentity } from '../../src/lib/cms/repos/identity.ts';
import {
  ROLES_MANAGE,
  WORKFLOWS_MANAGE,
  WORKFLOW_ROLES_MANAGE,
} from '../../src/lib/cms/permissions.ts';

import * as workflowRoles from '../../src/pages/cms/api/admin/workflow-roles/index.ts';
import * as workflowRoleItem from '../../src/pages/cms/api/admin/workflow-roles/[id].ts';
import * as roleAssignments from '../../src/pages/cms/api/admin/workflow-roles/[id]/assignments.ts';
import * as assignmentItem from '../../src/pages/cms/api/admin/workflow-assignments/[id].ts';
import * as assignmentRules from '../../src/pages/cms/api/admin/workflow-assignments/[id]/authority-rules.ts';
import * as ruleItem from '../../src/pages/cms/api/admin/authority-rules/[id].ts';
import * as workflows from '../../src/pages/cms/api/admin/workflows/index.ts';
import * as workflowItem from '../../src/pages/cms/api/admin/workflows/[id].ts';
import * as versions from '../../src/pages/cms/api/admin/workflows/[id]/versions.ts';
import * as stages from '../../src/pages/cms/api/admin/workflows/[id]/stages.ts';
import * as stageItem from '../../src/pages/cms/api/admin/workflow-stages/[id].ts';
import * as preview from '../../src/pages/cms/api/admin/approval-preview.ts';
import * as instances from '../../src/pages/cms/api/workflow/instances.ts';
import * as stageInstance from '../../src/pages/cms/api/workflow/stages/[id].ts';
import * as decision from '../../src/pages/cms/api/workflow/stages/[id]/decision.ts';
import * as reResolve from '../../src/pages/cms/api/workflow/stages/[id]/re-resolve.ts';

function identity(permissions: string[]): CmsIdentity {
  return {
    userId: 'USR-TEST',
    firstName: 'Test',
    lastName: 'User',
    displayName: 'Test User',
    email: 'test.user@hasspetroleum.com',
    userType: 'INTERNAL',
    locale: 'en-KE',
    timezone: 'Africa/Nairobi',
    assignment: null,
    roles: [],
    scopes: [],
    permissions,
    portalMemberships: [],
  };
}

function context(permissions: string[] | null, method = 'POST', body: unknown = {}): APIContext {
  const url = new URL('https://cms.murikah.com/api/admin/workflow-roles');
  const request = new Request(url, {
    method,
    headers: { 'content-type': 'application/json', 'user-agent': 'HassCMS Test' },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
  });
  const locals =
    permissions === null
      ? {}
      : {
          cms: {
            sessionId: 'ASESS-test',
            user: identity(permissions),
            can: (code: string) => permissions.includes(code),
          },
        };
  return { locals, params: { id: 'WROLE-SO-FIN' }, request, url } as unknown as APIContext;
}

const errorOf = async (response: Response) =>
  (await response.json()) as { error: { code: string } };

type Handler = (c: APIContext) => Promise<Response> | Response;

/** Reading workflow configuration: either manage permission is enough. */
const READS: [string, Handler][] = [
  ['GET /api/admin/workflow-roles', (c) => workflowRoles.GET(c)],
  ['GET /api/admin/workflow-roles/{id}', (c) => workflowRoleItem.GET(c)],
  ['GET /api/admin/workflow-roles/{id}/assignments', (c) => roleAssignments.GET(c)],
  ['GET /api/admin/workflow-assignments/{id}', (c) => assignmentItem.GET(c)],
  ['GET /api/admin/workflow-assignments/{id}/authority-rules', (c) => assignmentRules.GET(c)],
  ['GET /api/admin/authority-rules/{id}', (c) => ruleItem.GET(c)],
  ['GET /api/admin/workflows', (c) => workflows.GET(c)],
  ['GET /api/admin/workflows/{id}', (c) => workflowItem.GET(c)],
  ['GET /api/admin/workflows/{id}/stages', (c) => stages.GET(c)],
  ['GET /api/admin/workflow-stages/{id}', (c) => stageItem.GET(c)],
  ['POST /api/admin/approval-preview', (c) => preview.POST(c)],
];

/** Granting approval authority. ADMIN.WORKFLOW_ROLES.MANAGE, and nothing else. */
const AUTHORITY_WRITES: [string, Handler][] = [
  ['POST /api/admin/workflow-roles', (c) => workflowRoles.POST(c)],
  ['PATCH /api/admin/workflow-roles/{id}', (c) => workflowRoleItem.PATCH(c)],
  ['POST /api/admin/workflow-roles/{id}/assignments', (c) => roleAssignments.POST(c)],
  ['PATCH /api/admin/workflow-assignments/{id}', (c) => assignmentItem.PATCH(c)],
  ['POST /api/admin/workflow-assignments/{id}/authority-rules', (c) => assignmentRules.POST(c)],
  ['PATCH /api/admin/authority-rules/{id}', (c) => ruleItem.PATCH(c)],
  ['POST /api/workflow/stages/{id}/re-resolve', (c) => reResolve.POST(c)],
];

/** Designing the process. ADMIN.WORKFLOWS.MANAGE, and nothing else. */
const PROCESS_WRITES: [string, Handler][] = [
  ['POST /api/admin/workflows', (c) => workflows.POST(c)],
  ['PATCH /api/admin/workflows/{id}', (c) => workflowItem.PATCH(c)],
  ['POST /api/admin/workflows/{id}/versions', (c) => versions.POST(c)],
  ['POST /api/admin/workflows/{id}/stages', (c) => stages.POST(c)],
  ['PATCH /api/admin/workflows/{id}/stages', (c) => stages.PATCH(c)],
  ['PATCH /api/admin/workflow-stages/{id}', (c) => stageItem.PATCH(c)],
  ['POST /api/workflow/instances', (c) => instances.POST(c)],
];

/** Every route, including the two an ordinary approver reaches. */
const EVERY: [string, Handler][] = [
  ...READS,
  ...AUTHORITY_WRITES,
  ...PROCESS_WRITES,
  ['GET /api/workflow/stages/{id}', (c) => stageInstance.GET(c)],
  ['POST /api/workflow/stages/{id}/decision', (c) => decision.POST(c)],
];

const READ_METHOD = (name: string) => (name.startsWith('GET') ? 'GET' : 'POST');

test('every workflow route refuses an anonymous caller with 401', async () => {
  for (const [name, handler] of EVERY) {
    const response = await handler(context(null, READ_METHOD(name)));
    assert.equal(response.status, 401, `${name} answered ${response.status}`);
    assert.equal((await errorOf(response)).error.code, 'unauthorised', name);
  }
});

test('every workflow configuration route refuses a signed-in caller with no workflow permission', async () => {
  // A user who administers roles, which is a real and considerable permission,
  // and holds neither workflow one. Holding some administration is not holding
  // this administration.
  for (const [name, handler] of [...READS, ...AUTHORITY_WRITES, ...PROCESS_WRITES]) {
    const response = await handler(context([ROLES_MANAGE], READ_METHOD(name)));
    assert.equal(response.status, 403, `${name} answered ${response.status}`);
    assert.equal((await errorOf(response)).error.code, 'forbidden', name);
  }
});

test('designing a workflow does not confer the authority to grant approval authority', async () => {
  for (const [name, handler] of AUTHORITY_WRITES) {
    const response = await handler(context([WORKFLOWS_MANAGE], READ_METHOD(name)));
    assert.equal(response.status, 403, `${name} answered ${response.status}`);
  }
});

test('granting approval authority does not confer the authority to redesign the process', async () => {
  for (const [name, handler] of PROCESS_WRITES) {
    const response = await handler(context([WORKFLOW_ROLES_MANAGE], READ_METHOD(name)));
    assert.equal(response.status, 403, `${name} answered ${response.status}`);
  }
});

test('either workflow permission is enough to read the configuration', async () => {
  for (const held of [WORKFLOWS_MANAGE, WORKFLOW_ROLES_MANAGE]) {
    for (const [name, handler] of READS) {
      const response = await handler(context([held], READ_METHOD(name)));
      // Past the guard. Without a database it is 503 or a validation refusal,
      // and neither is 401 or 403, which is the whole claim.
      assert.notEqual(response.status, 401, `${name} with ${held}`);
      assert.notEqual(response.status, 403, `${name} with ${held}`);
    }
  }
});

test('an unrecognised verb is 405, not a silent success', async () => {
  const routes: [string, Handler][] = [
    ['workflow-roles', (c) => workflowRoles.ALL(c)],
    ['workflow-roles/{id}', (c) => workflowRoleItem.ALL(c)],
    ['workflow-roles/{id}/assignments', (c) => roleAssignments.ALL(c)],
    ['workflow-assignments/{id}', (c) => assignmentItem.ALL(c)],
    ['workflow-assignments/{id}/authority-rules', (c) => assignmentRules.ALL(c)],
    ['authority-rules/{id}', (c) => ruleItem.ALL(c)],
    ['workflows', (c) => workflows.ALL(c)],
    ['workflows/{id}', (c) => workflowItem.ALL(c)],
    ['workflows/{id}/versions', (c) => versions.ALL(c)],
    ['workflows/{id}/stages', (c) => stages.ALL(c)],
    ['workflow-stages/{id}', (c) => stageItem.ALL(c)],
    ['approval-preview', (c) => preview.ALL(c)],
    ['workflow/instances', (c) => instances.ALL(c)],
    ['workflow/stages/{id}', (c) => stageInstance.ALL(c)],
    ['workflow/stages/{id}/decision', (c) => decision.ALL(c)],
    ['workflow/stages/{id}/re-resolve', (c) => reResolve.ALL(c)],
  ];
  for (const [name, handler] of routes) {
    const response = await handler(context([WORKFLOWS_MANAGE], 'DELETE'));
    assert.equal(response.status, 405, `${name} answered ${response.status}`);
  }
});

test('no workflow route exports DELETE', async () => {
  const modules: [string, Record<string, unknown>][] = [
    ['workflow-roles', workflowRoles],
    ['workflow-roles/{id}', workflowRoleItem],
    ['workflow-roles/{id}/assignments', roleAssignments],
    ['workflow-assignments/{id}', assignmentItem],
    ['workflow-assignments/{id}/authority-rules', assignmentRules],
    ['authority-rules/{id}', ruleItem],
    ['workflows', workflows],
    ['workflows/{id}', workflowItem],
    ['workflows/{id}/versions', versions],
    ['workflows/{id}/stages', stages],
    ['workflow-stages/{id}', stageItem],
    ['approval-preview', preview],
    ['workflow/instances', instances],
    ['workflow/stages/{id}', stageInstance],
    ['workflow/stages/{id}/decision', decision],
    ['workflow/stages/{id}/re-resolve', reResolve],
  ];
  for (const [name, module] of modules) {
    assert.equal('DELETE' in module, false, `${name} exports DELETE`);
    // And every one renders per request, or the middleware guard runs at build
    // time and the endpoint is baked as a static file.
    assert.equal(module.prerender, false, `${name} is missing prerender = false`);
  }
});

test('the decision endpoint refuses an anonymous caller and never reads an approver from the body', async () => {
  // Anonymous: 401 before anything else.
  const anonymous = await decision.POST(
    context(null, 'POST', { decision: 'APPROVED', userId: 'USR-CATH' }),
  );
  assert.equal(anonymous.status, 401);

  // Signed in, with a body naming somebody else. There is no parameter for an
  // approver anywhere below this point, so the id is inert: the request gets no
  // further than the stage lookup, which is a 404 or a 503, never a 200.
  const impersonating = await decision.POST(
    context([], 'POST', {
      decision: 'APPROVED',
      userId: 'USR-CATH',
      approverId: 'USR-CATH',
      actorUserId: 'USR-CATH',
    }),
  );
  assert.notEqual(impersonating.status, 200);
});

test('the preview refuses a request it cannot understand, before it reaches a database', async () => {
  const response = await preview.POST(
    context([WORKFLOWS_MANAGE], 'POST', { processType: 'NOT_A_PROCESS' }),
  );
  assert.equal(response.status, 422);
  const body = (await response.json()) as {
    error: { code: string; fields?: { field: string }[] };
  };
  assert.equal(body.error.code, 'validation_failed');
  assert.equal(body.error.fields?.[0]?.field, 'processType');
});

test('an authority rule cannot be written for a process the rule table cannot carry', async () => {
  const response = await assignmentRules.POST(
    context([WORKFLOW_ROLES_MANAGE], 'POST', { processType: 'CASE' }),
  );
  assert.equal(response.status, 422);
  const body = (await response.json()) as {
    error: { fields?: { field: string; message: string }[] };
  };
  assert.equal(body.error.fields?.[0]?.field, 'processType');
  assert.match(String(body.error.fields?.[0]?.message), /cannot carry a rule/);
});
