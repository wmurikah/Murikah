/**
 * POST /api/admin/ai/:providerId/verify.
 *
 * The smallest call that proves the named secret opens the model, and the
 * result written where the screen reads it. The key is read from the Worker
 * environment at this moment and is not returned, logged or stored.
 *
 * Two round trips to the database, one subrequest to the provider.
 */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { requireUsersManage, writeContext } from '../../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../../lib/cms/admin/crudRoute.ts';
import { getProvider, recordVerification } from '../../../../../../lib/cms/ai/providers.ts';
import { verifyProvider, secretPresent } from '../../../../../../lib/cms/ai/model.ts';
import { methodNotAllowed, ok, serverError } from '../../../../../../lib/cms/admin/respond.ts';

export const prerender = false;

export const POST: APIRoute = async (context) => {
  const auth = requireUsersManage(context);
  if (!auth.ok) return auth.response;
  const id = String(context.params.providerId ?? '');
  const connection = await connect();
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
    // A BOOLEAN, NEVER THE VALUE. The screen needs to distinguish "the secret
    // is not set on this Worker" from "the key was refused", and that is the
    // whole of what it needs.
    return ok({ status, secretPresent: secretPresent(environment, provider.secretName) });
  } catch (error) {
    return serverError('admin.ai.verify', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('POST');
