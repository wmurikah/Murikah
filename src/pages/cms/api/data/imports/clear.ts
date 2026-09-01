/**
 * POST /api/data/imports/clear — clear the import history, by scope.
 *
 * GET previews: how many batches, rows and landed rows would go, how many
 * would be skipped and why. Nothing is written.
 *
 * THE SCOPE IS THE POINT. "Delete everything" is rarely what somebody means,
 * so it is one of four options rather than the only one, and it is the only
 * one that demands a typed phrase. The typed phrase is checked HERE as well as
 * on the screen: a confirmation enforced only in a browser is one an API call
 * does not have to make.
 */
import type { APIRoute } from 'astro';
import { requireImportUpload, writeContext } from '../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../lib/cms/admin/crudRoute.ts';
import {
  previewClear,
  clearHistory,
  type ClearScope,
} from '../../../../../lib/cms/import/batchAdmin.ts';
import {
  methodNotAllowed,
  ok,
  readJson,
  serverError,
} from '../../../../../lib/cms/admin/respond.ts';
import { apiError } from '../../../../../lib/cms/errors.ts';

export const prerender = false;

const SCOPES = new Set<ClearScope>(['failed', 'before', 'no-records', 'everything']);

function selectionOf(raw: unknown): { scope: ClearScope; before: string | null } | null {
  const body = (raw ?? {}) as { scope?: unknown; before?: unknown };
  const scope = String(body.scope ?? '') as ClearScope;
  if (!SCOPES.has(scope)) return null;
  const before = typeof body.before === 'string' && body.before !== '' ? body.before : null;
  return { scope, before };
}

export const GET: APIRoute = async (context) => {
  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  // Both import types, because the history holds both and a clear spans it.
  const auth = requireImportUpload(context, 'SALES_ORDER');
  if (!auth.ok) return auth.response;
  try {
    const url = new URL(context.request.url);
    const selection = selectionOf({
      scope: url.searchParams.get('scope'),
      before: url.searchParams.get('before'),
    });
    if (selection === null) return apiError('invalid_request', 'Choose what to clear.', 400);
    return ok(await previewClear(connection.db, selection));
  } catch (error) {
    return serverError('data.imports.clear.preview', error);
  }
};

export const POST: APIRoute = async (context) => {
  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  const auth = requireImportUpload(context, 'SALES_ORDER');
  if (!auth.ok) return auth.response;
  try {
    const body = (await readJson(context.request)) as { confirmation?: unknown } | null;
    const selection = selectionOf(body);
    if (selection === null) return apiError('invalid_request', 'Choose what to clear.', 400);
    const confirmation = typeof body?.confirmation === 'string' ? body.confirmation.trim() : '';
    return ok(
      await clearHistory(
        connection.db,
        selection,
        writeContext(context.request, auth.principal),
        confirmation,
      ),
    );
  } catch (error) {
    return serverError('data.imports.clear', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET, POST');
