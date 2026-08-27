/**
 * GET /api/portal/documents/{attachmentId} on cms.murikah.com.
 *
 * The download. The checks run in the order the build prompt names: the
 * session (the caller reached this handler), the membership and the account
 * ownership (the scope predicate inside `portalDownload`), and the
 * visibility flag, before anything is streamed.
 *
 * THE STORAGE KEY NEVER LEAVES THE SERVER. The response carries the file,
 * not a location, so there is nothing for a customer to guess at or share.
 */
import type { APIRoute } from 'astro';
import { connect } from '../../../../../lib/cms/admin/crudRoute.ts';
import { requirePortal } from '../../../../../lib/cms/portal/guard.ts';
import { portalDownload } from '../../../../../lib/cms/repos/portalData.ts';
import { methodNotAllowed, serverError } from '../../../../../lib/cms/admin/respond.ts';
import { notFound, apiError } from '../../../../../lib/cms/errors.ts';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const connection = await connect();
  if ('response' in connection) return connection.response;
  const auth = await requirePortal(context, connection.db);
  if (!auth.ok) return auth.response;
  try {
    const file = await portalDownload(connection.db, auth.scope, context.params.attachmentId ?? '');
    // Invisible, another customer's, or absent: one answer for all three.
    if (file === null) return notFound('That document could not be found.');

    // There is no object store binding in this worker, and adding one would
    // mean editing the fenced Cloudflare configuration. So the endpoint
    // authorises the download and says plainly that the bytes are not
    // reachable yet, rather than pretending or leaking the storage key.
    return apiError(
      'unavailable',
      `"${file.filename}" is available to you, but file storage is not connected to this environment yet. Please ask your Hass contact to send it while we finish that setup.`,
      503,
    );
  } catch (error) {
    return serverError('portal.download', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET');
