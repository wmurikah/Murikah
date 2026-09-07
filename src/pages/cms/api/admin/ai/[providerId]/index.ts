/** PATCH /api/admin/ai/:providerId. Edits a provider; never touches a key. */
import type { APIRoute } from 'astro';
import { requireAiManage } from '../../../../../../lib/cms/ai/access.ts';
import { writeContext } from '../../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../../lib/cms/admin/crudRoute.ts';
import { updateProvider } from '../../../../../../lib/cms/ai/providers.ts';
import { readInput } from '../index.ts';
import {
  invalid,
  methodNotAllowed,
  ok,
  serverError,
} from '../../../../../../lib/cms/admin/respond.ts';

export const prerender = false;

export const PATCH: APIRoute = async (context) => {
  const auth = requireAiManage(context);
  if (!auth.ok) return auth.response;
  const id = String(context.params.providerId ?? '');
  const body = (await context.request.json().catch(() => null)) as Record<string, unknown> | null;
  if (body === null) return invalid([{ field: 'body', message: 'Send JSON.' }]);
  const input = readInput(body);
  if (input === null) {
    return invalid([{ field: 'providerType', message: 'Choose Anthropic or OpenAI.' }]);
  }
  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    const result = await updateProvider(
      connection.db,
      id,
      input,
      writeContext(context.request, auth.principal),
    );
    return result.ok ? ok({ updated: true }) : invalid(result.errors);
  } catch (error) {
    return serverError('admin.ai.update', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('PATCH');
