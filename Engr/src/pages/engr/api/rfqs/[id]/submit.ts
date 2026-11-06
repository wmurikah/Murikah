export const prerender = false;

/** Submit an RFQ draft for independent manager release. Gate: rfq.submit. */
import type { APIRoute } from 'astro';
import { getEngrEnv } from '@engr/env';
import { getDb } from '@engr/db';
import { submitRfq } from '@engr/repos/rfqs';
import { jsonResponse, wantsJson, redirectResponse } from '@engr/workflow/respond';

export const POST: APIRoute = async ({ request, locals, params }) => {
  const engr = locals.engr;
  if (!engr) return jsonResponse({ error: 'unauthorised' }, 401);
  const id = params.id;
  if (!id) return jsonResponse({ error: 'invalid' }, 400);
  const back = `/rfqs/${id}`;
  if (!engr.perms.includes('rfq.submit')) {
    return wantsJson(request)
      ? jsonResponse({ error: 'forbidden' }, 403)
      : redirectResponse(request, back, 'error=forbidden');
  }
  const db = await getDb(getEngrEnv());
  const result = await submitRfq(db, { orgId: engr.orgId, userId: engr.userId }, id);
  if (result.ok) {
    return wantsJson(request)
      ? jsonResponse({ ok: true }, 200)
      : redirectResponse(request, back, 'submitted=1');
  }
  return wantsJson(request)
    ? jsonResponse({ ok: false, error: result.code, message: result.message }, 409)
    : redirectResponse(request, back, `error=${result.code}`);
};
