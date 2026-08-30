/** PATCH /api/admin/channels/:connectionId. */
import type { APIRoute } from 'astro';
import { requireUsersManage, writeContext } from '../../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../../lib/cms/admin/crudRoute.ts';
import { updateConnection } from '../../../../../../lib/cms/ai/channels.ts';
import { readConnectionInput } from '../index.ts';
import {
  invalid,
  methodNotAllowed,
  ok,
  serverError,
} from '../../../../../../lib/cms/admin/respond.ts';

export const prerender = false;

export const PATCH: APIRoute = async (context) => {
  const auth = requireUsersManage(context);
  if (!auth.ok) return auth.response;
  const id = String(context.params.connectionId ?? '');
  const body = (await context.request.json().catch(() => null)) as Record<string, unknown> | null;
  if (body === null) return invalid([{ field: 'body', message: 'Send JSON.' }]);
  const connection = await connect();
  if ('response' in connection) return connection.response;
  try {
    const result = await updateConnection(
      connection.db,
      id,
      readConnectionInput(body),
      writeContext(context.request, auth.principal),
    );
    return result.ok ? ok({ updated: true }) : invalid(result.errors);
  } catch (error) {
    return serverError('admin.channels.update', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('PATCH');
