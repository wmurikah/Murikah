export const prerender = false;

/**
 * Award or prefer a quote on an RFQ.
 *  intent=prefer: mark a preferred quote without awarding. Gate: quotes.select.
 *  intent=award (default): award the winning quote. Gate: rfq.award. At or below
 *    the RFQ threshold this creates the work order at CONTRACTOR_ACCEPTED and
 *    the caller is sent to it; above the threshold the RFQ is routed to
 *    procurement and no work order is created yet.
 * A stale RFQ status returns 409, a missing permission 403.
 */
import type { APIRoute } from 'astro';
import { getEngrEnv } from '@engr/env';
import { getDb } from '@engr/db';
import { awardRfq } from '@engr/workflow/rfqAward';
import { selectPreferredQuote } from '@engr/repos/quotes';
import { jsonResponse, wantsJson, redirectResponse, readBody, str } from '@engr/workflow/respond';

function statusFor(code: string): number {
  return code === 'forbidden' ? 403 : code === 'conflict' ? 409 : code === 'not_found' ? 404 : 422;
}

export const POST: APIRoute = async ({ request, locals, params }) => {
  const engr = locals.engr;
  if (!engr) return jsonResponse({ error: 'unauthorised' }, 401);
  const id = params.id;
  if (!id) return jsonResponse({ error: 'invalid' }, 400);
  const back = `/rfqs/${id}`;

  const body = await readBody(request);
  const intent = str(body.intent).trim() || 'award';
  const quoteId = str(body.quote_id).trim();
  if (!quoteId) {
    return wantsJson(request)
      ? jsonResponse({ error: 'validation', message: 'Choose a quote.' }, 422)
      : redirectResponse(request, back, 'error=validation');
  }

  const db = await getDb(getEngrEnv());

  if (intent === 'prefer') {
    if (!engr.perms.includes('quotes.select')) {
      return wantsJson(request)
        ? jsonResponse({ error: 'forbidden' }, 403)
        : redirectResponse(request, back, 'error=forbidden');
    }
    const result = await selectPreferredQuote(
      db,
      { orgId: engr.orgId, userId: engr.userId },
      id,
      quoteId,
    );
    if (result.ok) {
      return wantsJson(request)
        ? jsonResponse({ ok: true, preferred: quoteId }, 200)
        : redirectResponse(request, back);
    }
    return wantsJson(request)
      ? jsonResponse(
          { ok: false, error: result.code, message: result.message },
          statusFor(result.code),
        )
      : redirectResponse(request, back, `error=${result.code}`);
  }

  if (!engr.perms.includes('rfq.award')) {
    return wantsJson(request)
      ? jsonResponse({ error: 'forbidden' }, 403)
      : redirectResponse(request, back, 'error=forbidden');
  }
  const actor = { orgId: engr.orgId, userId: engr.userId, perms: engr.perms, roles: engr.roles };
  const result = await awardRfq(db, actor, id, quoteId);

  if (result.ok) {
    if (result.outcome === 'awarded') {
      const woPath = `/workorders/${result.workOrderId}`;
      return wantsJson(request)
        ? jsonResponse(
            { ok: true, outcome: 'awarded', workOrderId: result.workOrderId, woNo: result.woNo },
            201,
          )
        : redirectResponse(request, woPath);
    }
    return wantsJson(request)
      ? jsonResponse({ ok: true, outcome: 'sent_to_procurement' }, 200)
      : redirectResponse(request, back, 'sent=procurement');
  }
  return wantsJson(request)
    ? jsonResponse(
        { ok: false, error: result.code, message: result.message },
        statusFor(result.code),
      )
    : redirectResponse(request, back, `error=${result.code}`);
};
