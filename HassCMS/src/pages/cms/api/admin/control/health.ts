/**
 * GET /api/admin/control/health on cms.murikah.com.
 *
 * System Health: deterministic configuration checks and nothing else. Every
 * check carries the rule it applied, so a reader can reproduce the count by
 * hand rather than taking the screen's word for it.
 */
import type { APIRoute } from 'astro';
import { connect } from '../../../../../lib/cms/admin/crudRoute.ts';
import { requireControlCentre } from '../../../../../lib/cms/admin/guard.ts';
import { systemHealth, expiringAuthority } from '../../../../../lib/cms/repos/controlCentre.ts';
import { methodNotAllowed, ok, serverError } from '../../../../../lib/cms/admin/respond.ts';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const auth = requireControlCentre(context);
  if (!auth.ok) return auth.response;
  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    const now = new Date();
    const [health, expiring] = await Promise.all([
      systemHealth(connection.db, now),
      expiringAuthority(connection.db, now, 30),
    ]);
    return ok({ ...health, expiring });
  } catch (error) {
    return serverError('admin.control.health', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET');
