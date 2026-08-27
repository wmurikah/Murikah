/**
 * GET and POST /api/service/cases on cms.murikah.com.
 *
 * The queue. Scope-filtered, searched, filtered and paginated in SQL, with
 * the queue presets as server-side clauses over the already-scoped rows.
 * Creation defaults the priority from the category and records an override;
 * overriding at all needs the MANAGE permission, checked here and again in
 * the repository.
 */
import type { APIRoute } from 'astro';
import {
  requireCasesView,
  requireCasesCreate,
  writeContext,
} from '../../../../../lib/cms/admin/guard.ts';
import { canManageCases } from '../../../../../lib/cms/permissions.ts';
import { connect } from '../../../../../lib/cms/admin/crudRoute.ts';
import { readCaseQuery, validateCase } from '../../../../../lib/cms/admin/serviceInput.ts';
import {
  createCase,
  listCases,
  caseIndicators,
} from '../../../../../lib/cms/repos/serviceAdmin.ts';
import {
  failure,
  invalid,
  methodNotAllowed,
  ok,
  readJson,
  serverError,
} from '../../../../../lib/cms/admin/respond.ts';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const auth = requireCasesView(context);
  if (!auth.ok) return auth.response;
  const connection = await connect();
  if ('response' in connection) return connection.response;
  try {
    const userId = auth.principal.user.userId;
    if (context.url.searchParams.get('indicators') === '1') {
      return ok(await caseIndicators(connection.db, userId, new Date()));
    }
    return ok(await listCases(connection.db, userId, readCaseQuery(context.url.searchParams)));
  } catch (error) {
    return serverError('service.cases.list', error);
  }
};

export const POST: APIRoute = async (context) => {
  const auth = requireCasesCreate(context);
  if (!auth.ok) return auth.response;
  const today = new Date().toISOString().slice(0, 10);
  const parsed = validateCase(await readJson(context.request), today);
  if (!parsed.ok) return invalid(parsed.errors);
  const connection = await connect();
  if ('response' in connection) return connection.response;
  try {
    const result = await createCase(
      connection.db,
      auth.principal.user.userId,
      parsed.value,
      writeContext(context.request, auth.principal),
      canManageCases(auth.principal.user.permissions),
    );
    return result.ok ? ok(result.value) : failure(result);
  } catch (error) {
    return serverError('service.cases.create', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET or POST');
