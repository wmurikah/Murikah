/**
 * GET and POST /api/admin/workflows on cms.murikah.com.
 *
 * A workflow definition is a named, versioned process with applicability by
 * country, affiliate and business unit. A new definition always starts at
 * version 1; later versions come from /api/admin/workflows/{id}/versions, so a
 * caller cannot open a definition at an arbitrary version number and leave a
 * gap in the history.
 *
 * Authorisation is ADMIN.WORKFLOWS.MANAGE, PERM-017.
 */
import type { APIRoute } from 'astro';
import {
  requireWorkflowsManage,
  requireWorkflowView,
  writeContext,
} from '../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../lib/cms/admin/crudRoute.ts';
import { validateDefinition } from '../../../../../lib/cms/admin/workflowInput.ts';
import { createDefinition, listDefinitions } from '../../../../../lib/cms/repos/workflowAdmin.ts';
import {
  failure,
  invalid,
  methodNotAllowed,
  ok,
  readJson,
  serverError,
} from '../../../../../lib/cms/admin/respond.ts';
import { isoDay } from '../../../../../lib/cms/workflow/model.ts';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const auth = requireWorkflowView(context);
  if (!auth.ok) return auth.response;

  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    return ok({ items: await listDefinitions(connection.db) });
  } catch (error) {
    return serverError('admin.workflows.list', error);
  }
};

export const POST: APIRoute = async (context) => {
  const auth = requireWorkflowsManage(context);
  if (!auth.ok) return auth.response;

  const ctx = writeContext(context.request, auth.principal);
  const parsed = validateDefinition(await readJson(context.request), isoDay(ctx.now));
  if (!parsed.ok) return invalid(parsed.errors);

  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    const result = await createDefinition(connection.db, parsed.value, ctx);
    return result.ok ? ok(result.value, 201) : failure(result);
  } catch (error) {
    return serverError('admin.workflows.create', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET or POST');
