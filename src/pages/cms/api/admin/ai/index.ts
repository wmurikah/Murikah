/**
 * GET and POST /api/admin/ai on cms.murikah.com.
 *
 * The provider list, and a new provider. The key is never in the payload and
 * has no column to go into: what travels is the NAME of a Worker secret.
 */
import type { APIRoute } from 'astro';
import { requireUsersManage, writeContext } from '../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../lib/cms/admin/crudRoute.ts';
import { listProviders, createProvider } from '../../../../../lib/cms/ai/providers.ts';
import {
  invalid,
  methodNotAllowed,
  ok,
  serverError,
} from '../../../../../lib/cms/admin/respond.ts';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const auth = requireUsersManage(context);
  if (!auth.ok) return auth.response;
  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    return ok({ providers: await listProviders(connection.db) });
  } catch (error) {
    return serverError('admin.ai.list', error);
  }
};

const readInput = (body: Record<string, unknown>) => ({
  providerName: String(body.providerName ?? ''),
  providerType: String(body.providerType ?? ''),
  baseUrl:
    body.baseUrl === undefined || body.baseUrl === null || body.baseUrl === ''
      ? null
      : String(body.baseUrl),
  model: String(body.model ?? ''),
  secretName: String(body.secretName ?? ''),
  maxOutputTokens:
    body.maxOutputTokens === undefined ||
    body.maxOutputTokens === null ||
    body.maxOutputTokens === ''
      ? null
      : Number(body.maxOutputTokens),
  temperature:
    body.temperature === undefined || body.temperature === null || body.temperature === ''
      ? null
      : Number(body.temperature),
  purpose: String(body.purpose ?? ''),
  active: body.active === true || body.active === 'true' || body.active === 1,
});

export const POST: APIRoute = async (context) => {
  const auth = requireUsersManage(context);
  if (!auth.ok) return auth.response;
  const body = (await context.request.json().catch(() => null)) as Record<string, unknown> | null;
  if (body === null) return invalid([{ field: 'body', message: 'Send JSON.' }]);
  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    const result = await createProvider(
      connection.db,
      readInput(body),
      writeContext(context.request, auth.principal),
    );
    return result.ok ? ok({ id: result.id }, 201) : invalid(result.errors);
  } catch (error) {
    return serverError('admin.ai.create', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET or POST');
export { readInput };
