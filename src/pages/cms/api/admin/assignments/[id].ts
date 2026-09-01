/**
 * PATCH /api/admin/assignments/{id} on cms.murikah.com.
 *
 * Ends an assignment, changes its primary flag, or deactivates it. The level
 * and its location are not editable: changing where an assignment sits is a
 * different posting, and rewriting the row would erase the record that the
 * person ever held the first one.
 */
import type { APIRoute } from 'astro';
import { requireUsersManage, writeContext } from '../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../lib/cms/admin/crudRoute.ts';
import { updateAssignment } from '../../../../../lib/cms/repos/userAdmin.ts';
import {
  failure,
  invalid,
  methodNotAllowed,
  ok,
  readJson,
  serverError,
} from '../../../../../lib/cms/admin/respond.ts';

export const prerender = false;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const PATCH: APIRoute = async (context) => {
  const auth = requireUsersManage(context);
  if (!auth.ok) return auth.response;

  const raw = (await readJson(context.request)) as Record<string, unknown> | null;
  const body = raw ?? {};
  const effectiveToRaw = typeof body.effectiveTo === 'string' ? body.effectiveTo.trim() : '';
  const effectiveTo = effectiveToRaw === '' ? null : effectiveToRaw;
  if (effectiveTo !== null && !ISO_DATE.test(effectiveTo)) {
    return invalid([{ field: 'effectiveTo', message: 'Enter a date as YYYY-MM-DD.' }]);
  }
  const truthy = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true' || v === 'on';

  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    const result = await updateAssignment(
      connection.db,
      context.params.id ?? '',
      {
        effectiveTo,
        isPrimary: truthy(body.isPrimary),
        active: body.active === undefined ? true : truthy(body.active),
      },
      writeContext(context.request, auth.principal),
    );
    return result.ok ? ok(result.value) : failure(result);
  } catch (error) {
    return serverError('admin.assignments.update', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('PATCH');
