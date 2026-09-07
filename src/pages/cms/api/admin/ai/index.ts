/**
 * GET and POST /api/admin/ai on cms.murikah.com.
 *
 * Provider credentials and destinations are selected by application policy,
 * never by request input. The browser supplies the provider type; the server
 * resolves its one approved Worker secret name and one approved endpoint.
 */
import type { APIRoute } from 'astro';
import { requireAiManage } from '../../../../../lib/cms/ai/access.ts';
import { writeContext } from '../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../lib/cms/admin/crudRoute.ts';
import { listProviders, createProvider } from '../../../../../lib/cms/ai/providers.ts';
import {
  canonicalAiProviderFields,
  isApprovedAiProviderType,
} from '../../../../../lib/cms/ai/security.ts';
import {
  invalid,
  methodNotAllowed,
  ok,
  serverError,
} from '../../../../../lib/cms/admin/respond.ts';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const auth = requireAiManage(context);
  if (!auth.ok) return auth.response;
  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    return ok({ providers: await listProviders(connection.db) });
  } catch (error) {
    return serverError('admin.ai.list', error);
  }
};

export function readInput(body: Record<string, unknown>) {
  const providerType = String(body.providerType ?? '');
  if (!isApprovedAiProviderType(providerType)) return null;
  const fixed = canonicalAiProviderFields(providerType);
  if (fixed === null) return null;
  return {
    providerName: String(body.providerName ?? ''),
    providerType,
    baseUrl: fixed.baseUrl,
    model: String(body.model ?? ''),
    secretName: fixed.secretName,
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
  };
}

export const POST: APIRoute = async (context) => {
  const auth = requireAiManage(context);
  if (!auth.ok) return auth.response;
  const body = (await context.request.json().catch(() => null)) as Record<string, unknown> | null;
  if (body === null) return invalid([{ field: 'body', message: 'Send JSON.' }]);
  const input = readInput(body);
  if (input === null) {
    return invalid([{ field: 'providerType', message: 'Choose Anthropic or OpenAI.' }]);
  }
  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    const result = await createProvider(
      connection.db,
      input,
      writeContext(context.request, auth.principal),
    );
    return result.ok ? ok({ id: result.id }, 201) : invalid(result.errors);
  } catch (error) {
    return serverError('admin.ai.create', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET or POST');
