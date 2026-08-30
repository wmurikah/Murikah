/**
 * GET and POST /api/portal/helpdesk on cms.murikah.com.
 *
 * GET lists the customer's own requests. POST raises a real service case
 * with `channel = 'WEB'`, the account from the membership and the priority
 * from the category. The payload carries no account and no priority, so
 * there is nothing in it to tamper with.
 */
import type { APIRoute } from 'astro';
import { connect } from '../../../../../lib/cms/admin/crudRoute.ts';
import { requirePortal } from '../../../../../lib/cms/portal/guard.ts';
import { portalCases } from '../../../../../lib/cms/repos/portalData.ts';
import {
  raisePortalCase,
  PORTAL_CASE_TYPES,
  type PortalCaseInput,
} from '../../../../../lib/cms/repos/portalWrites.ts';
import {
  invalid,
  methodNotAllowed,
  ok,
  readJson,
  serverError,
} from '../../../../../lib/cms/admin/respond.ts';
import { throttle, PORTAL_THROTTLES } from '../../../../../lib/cms/portal/throttle.ts';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const connection = await connect();
  if ('response' in connection) return connection.response;
  const auth = await requirePortal(context, connection.db);
  if (!auth.ok) return auth.response;
  try {
    return ok({ cases: await portalCases(connection.db, auth.scope) });
  } catch (error) {
    return serverError('portal.cases', error);
  }
};

export const POST: APIRoute = async (context) => {
  const connection = await connect();
  if ('response' in connection) return connection.response;
  const auth = await requirePortal(context, connection.db);
  if (!auth.ok) return auth.response;
  // Bounded before the body is read, so a flood costs nothing to refuse.
  const limited = await throttle(context.request, PORTAL_THROTTLES.raiseCase, auth.scope.userId);
  if (limited) return limited;
  const body = ((await readJson(context.request)) ?? {}) as Record<string, unknown>;
  const caseType = String(body.caseType ?? '');
  if (!(PORTAL_CASE_TYPES as readonly string[]).includes(caseType)) {
    return invalid([{ field: 'caseType', message: 'Choose a request type.' }]);
  }
  try {
    const result = await raisePortalCase(
      connection.db,
      auth.scope,
      {
        caseType: caseType as PortalCaseInput['caseType'],
        caseCategoryId: String(body.caseCategoryId ?? ''),
        subject: String(body.subject ?? ''),
        description: String(body.description ?? ''),
      },
      new Date(),
    );
    return result.ok
      ? ok(result.value, 201)
      : invalid([{ field: result.field ?? 'subject', message: result.reason }]);
  } catch (error) {
    return serverError('portal.raiseCase', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET or POST');
