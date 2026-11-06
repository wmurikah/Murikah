export const prerender = false;

/**
 * RFQ detail as JSON. Engineers (rfq.view) get the full comparison with every
 * quote; a contractor (quotes.view) gets only the RFQ they are invited to and
 * their own quote, never a competitor's.
 */
import type { APIRoute } from 'astro';
import { getEngrEnv } from '@engr/env';
import { getDb } from '@engr/db';
import { getRfqDetail, updateRfqDraft } from '@engr/repos/rfqs';
import { contractorForUser } from '@engr/repos/techniciansPick';
import { getRfqForContractor, getQuoteForContractor } from '@engr/repos/quotes';
import {
  jsonResponse,
  wantsJson,
  redirectResponse,
  readBody,
  str,
  toMinorUnits,
} from '@engr/workflow/respond';

export const GET: APIRoute = async ({ locals, params }) => {
  const engr = locals.engr;
  if (!engr) return jsonResponse({ error: 'unauthorised' }, 401);
  const id = params.id;
  if (!id) return jsonResponse({ error: 'invalid' }, 400);
  const db = await getDb(getEngrEnv());

  if (engr.perms.includes('rfq.view')) {
    const rfq = await getRfqDetail(db, engr.orgId, id);
    return rfq
      ? jsonResponse({ ok: true, rfq }, 200)
      : jsonResponse({ ok: false, error: 'not_found' }, 404);
  }
  if (engr.perms.includes('quotes.view')) {
    const contractorId = await contractorForUser(db, engr.orgId, engr.userId);
    if (!contractorId) return jsonResponse({ error: 'forbidden' }, 403);
    const rfq = await getRfqForContractor(db, engr.orgId, id, contractorId);
    if (!rfq) return jsonResponse({ ok: false, error: 'not_found' }, 404);
    const quote = await getQuoteForContractor(db, engr.orgId, id, contractorId);
    return jsonResponse({ ok: true, rfq, quote }, 200);
  }
  return jsonResponse({ error: 'forbidden' }, 403);
};

/** Update due date and threshold while the RFQ is still an internal draft. */
export const POST: APIRoute = async ({ request, locals, params }) => {
  const engr = locals.engr;
  if (!engr) return jsonResponse({ error: 'unauthorised' }, 401);
  const id = params.id;
  if (!id) return jsonResponse({ error: 'invalid' }, 400);
  const back = `/rfqs/${id}`;
  if (!engr.perms.includes('rfq.edit')) {
    return wantsJson(request)
      ? jsonResponse({ error: 'forbidden' }, 403)
      : redirectResponse(request, back, 'error=forbidden');
  }
  const body = await readBody(request);
  const db = await getDb(getEngrEnv());
  const result = await updateRfqDraft(db, { orgId: engr.orgId, userId: engr.userId }, id, {
    dueDate: str(body.due_date).trim() || null,
    thresholdMinor: toMinorUnits(body.threshold),
  });
  if (result.ok) {
    return wantsJson(request)
      ? jsonResponse({ ok: true }, 200)
      : redirectResponse(request, back, 'saved=1');
  }
  return wantsJson(request)
    ? jsonResponse({ ok: false, error: result.code, message: result.message }, 409)
    : redirectResponse(request, back, `error=${result.code}`);
};
