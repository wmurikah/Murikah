/**
 * GET /api/admin/control/access-review on cms.murikah.com.
 *
 * Application access and approval authority, as two separate blocks per
 * person. The response shape has no merged capability list, because the merge
 * is the error this screen exists to prevent.
 */
import type { APIRoute } from 'astro';
import { connect } from '../../../../../lib/cms/admin/crudRoute.ts';
import { requireControlCentre } from '../../../../../lib/cms/admin/guard.ts';
import { accessReview } from '../../../../../lib/cms/repos/controlCentre.ts';
import { methodNotAllowed, ok, serverError } from '../../../../../lib/cms/admin/respond.ts';
import { toDbTimestamp } from '../../../../../lib/cms/auth/session.ts';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const auth = requireControlCentre(context);
  if (!auth.ok) return auth.response;
  const connection = await connect();
  if ('response' in connection) return connection.response;
  try {
    const today = toDbTimestamp(new Date()).slice(0, 10);
    const users = await accessReview(connection.db, today, {
      userId: context.url.searchParams.get('userId'),
      search: context.url.searchParams.get('q') ?? '',
    });
    return ok({ users, asAt: today });
  } catch (error) {
    return serverError('admin.control.accessReview', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET');
