/** GET and POST /api/admin/channels. auto_create_case defaults to off. */
import type { APIRoute } from 'astro';
import { requireUsersManage, writeContext } from '../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../lib/cms/admin/crudRoute.ts';
import { listConnections, createConnection } from '../../../../../lib/cms/ai/channels.ts';
import { invalid, methodNotAllowed, ok, serverError } from '../../../../../lib/cms/admin/respond.ts';

export const prerender = false;

const nullable = (v: unknown): string | null =>
  v === undefined || v === null || v === '' ? null : String(v);

export const readConnectionInput = (body: Record<string, unknown>) => ({
  channel: String(body.channel ?? ''),
  displayName: String(body.displayName ?? ''),
  provider: String(body.provider ?? ''),
  accountIdentifier: String(body.accountIdentifier ?? ''),
  affiliateId: nullable(body.affiliateId),
  secretName: String(body.secretName ?? ''),
  webhookSecretName: nullable(body.webhookSecretName),
  // OFF UNLESS SOMEBODY SAYS OTHERWISE, at every layer: the column defaults to
  // 0, and an absent field here is false rather than undefined.
  autoCreateCase: body.autoCreateCase === true || body.autoCreateCase === 'true',
  defaultCaseCategoryId: nullable(body.defaultCaseCategoryId),
  status: String(body.status ?? 'DRAFT'),
});

export const GET: APIRoute = async (context) => {
  const auth = requireUsersManage(context);
  if (!auth.ok) return auth.response;
  const connection = await connect();
  if ('response' in connection) return connection.response;
  try {
    return ok({ connections: await listConnections(connection.db) });
  } catch (error) {
    return serverError('admin.channels.list', error);
  }
};

export const POST: APIRoute = async (context) => {
  const auth = requireUsersManage(context);
  if (!auth.ok) return auth.response;
  const body = (await context.request.json().catch(() => null)) as Record<string, unknown> | null;
  if (body === null) return invalid([{ field: 'body', message: 'Send JSON.' }]);
  const connection = await connect();
  if ('response' in connection) return connection.response;
  try {
    const result = await createConnection(
      connection.db,
      readConnectionInput(body),
      writeContext(context.request, auth.principal),
    );
    return result.ok ? ok({ id: result.id }, 201) : invalid(result.errors);
  } catch (error) {
    return serverError('admin.channels.create', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET or POST');
