export const prerender = false;

/**
 * Retry a failed notification: flip it back to QUEUED so the next dispatch run
 * picks it up. Gate: reports.view, the operations console permission.
 */
import type { APIRoute } from 'astro';
import { getEngrEnv } from '@engr/env';
import { getDb } from '@engr/db';
import { retryFailed } from '@engr/repos/notifications';
import { jsonResponse, wantsJson, redirectResponse } from '@engr/workflow/respond';

export const POST: APIRoute = async ({ request, locals, params }) => {
  const engr = locals.engr;
  if (!engr) return jsonResponse({ error: 'unauthorised' }, 401);
  const id = params.id;
  if (!id) return jsonResponse({ error: 'invalid' }, 400);
  const back = '/ops/notifications';

  if (!engr.perms.includes('reports.view')) {
    return wantsJson(request)
      ? jsonResponse({ error: 'forbidden' }, 403)
      : redirectResponse(request, back, 'error=forbidden');
  }

  const db = await getDb(getEngrEnv());
  const ok = await retryFailed(db, engr.orgId, id);
  if (!ok) {
    return wantsJson(request)
      ? jsonResponse({ ok: false, error: 'conflict' }, 409)
      : redirectResponse(request, back, 'error=conflict');
  }
  return wantsJson(request)
    ? jsonResponse({ ok: true }, 200)
    : redirectResponse(request, back, 'retried=1');
};
