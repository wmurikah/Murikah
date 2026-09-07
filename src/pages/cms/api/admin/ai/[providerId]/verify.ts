/**
 * POST /api/admin/ai/:providerId/verify.
 *
 * The smallest call that proves the approved provider credential works. The
 * provider row cannot choose the Worker secret or the network destination:
 * both are resolved through the application allowlist before any fetch occurs.
 */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { requireAiManage } from '../../../../../../lib/cms/ai/access.ts';
import { writeContext } from '../../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../../lib/cms/admin/crudRoute.ts';
import { getProvider, recordVerification } from '../../../../../../lib/cms/ai/providers.ts';
import { verifyProvider } from '../../../../../../lib/cms/ai/model.ts';
import { approvedProviderSecretPresent } from '../../../../../../lib/cms/ai/security.ts';
import { methodNotAllowed, ok, serverError } from '../../../../../../lib/cms/admin/respond.ts';

export const prerender = false;

export const POST: APIRoute = async (context) => {
  const auth = requireAiManage(context);
  if (!auth.ok) return auth.response;
  const id = String(context.params.providerId ?? '');
  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    const provider = await getProvider(connection.db, id);
    if (provider === null) return ok({ status: 'ERROR', secretPresent: false }, 404);
    const environment = env as unknown as Record<string, unknown>;
    const status = await verifyProvider(provider, environment);
    await recordVerification(
      connection.db,
      id,
      status,
      writeContext(context.request, auth.principal),
    );
    return ok({
      status,
      secretPresent: approvedProviderSecretPresent(provider, environment),
    });
  } catch (error) {
    return serverError('admin.ai.verify', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('POST');
