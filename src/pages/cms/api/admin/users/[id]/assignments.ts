/**
 * GET and POST /api/admin/users/{id}/assignments on cms.murikah.com.
 *
 * A user may hold more than one. Adding one never rewrites an existing row:
 * superseding a posting means ending it through
 * PATCH /api/admin/assignments/{id} and inserting a new one here, so the record
 * that the person ever held the first posting survives.
 */
import type { APIRoute } from 'astro';
import { requireUsersManage, writeContext } from '../../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../../lib/cms/admin/crudRoute.ts';
import { isoDay, validateAssignment } from '../../../../../../lib/cms/admin/userInput.ts';
import { createAssignment, listAssignments } from '../../../../../../lib/cms/repos/userAdmin.ts';
import {
  failure,
  invalid,
  methodNotAllowed,
  ok,
  readJson,
  serverError,
} from '../../../../../../lib/cms/admin/respond.ts';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const auth = requireUsersManage(context);
  if (!auth.ok) return auth.response;

  const connection = await connect();
  if ('response' in connection) return connection.response;
  try {
    return ok({ items: await listAssignments(connection.db, context.params.id ?? '') });
  } catch (error) {
    return serverError('admin.assignments.list', error);
  }
};

export const POST: APIRoute = async (context) => {
  const auth = requireUsersManage(context);
  if (!auth.ok) return auth.response;

  const ctx = writeContext(context.request, auth.principal);
  const parsed = validateAssignment(await readJson(context.request), isoDay(ctx.now));
  if (!parsed.ok) return invalid(parsed.errors);

  const connection = await connect();
  if ('response' in connection) return connection.response;
  try {
    const result = await createAssignment(
      connection.db,
      context.params.id ?? '',
      parsed.value,
      ctx,
    );
    return result.ok ? ok(result.value, 201) : failure(result);
  } catch (error) {
    return serverError('admin.assignments.create', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET or POST');
