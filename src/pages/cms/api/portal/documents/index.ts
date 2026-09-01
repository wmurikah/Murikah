/**
 * GET /api/portal/documents on cms.murikah.com.
 *
 * Only attachments explicitly marked customer_visible, on entities inside
 * the caller's own accounts. The listing carries the customer-facing title
 * and never the storage key or the internal filename.
 */
import type { APIRoute } from 'astro';
import { connect } from '../../../../../lib/cms/admin/crudRoute.ts';
import { requirePortal } from '../../../../../lib/cms/portal/guard.ts';
import { verifyPortalTables } from '../../../../../lib/cms/portal/tenant.ts';
import { portalDocuments } from '../../../../../lib/cms/repos/portalData.ts';
import { methodNotAllowed, ok, serverError } from '../../../../../lib/cms/admin/respond.ts';
import { apiError } from '../../../../../lib/cms/errors.ts';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  const auth = await requirePortal(context, connection.db);
  if (!auth.ok) return auth.response;
  try {
    // Without the visibility column there is no way to tell an internal
    // attachment from a customer-facing one, so this serves nothing and says
    // why rather than guessing.
    const verified = await verifyPortalTables(connection.db);
    if (!verified.ok) {
      return apiError(
        'unavailable',
        `Documents are unavailable: ${verified.missing.join(', ')} is missing from the database.`,
        503,
      );
    }
    return ok({ documents: await portalDocuments(connection.db, auth.scope) });
  } catch (error) {
    return serverError('portal.documents', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET');
