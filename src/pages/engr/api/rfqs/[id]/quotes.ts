export const prerender = false;

/**
 * Contractor submits a priced quote against an RFQ they were invited to. Gate:
 * quotes.submit. Line items are read here; the authoritative total is computed
 * server-side in the repository, never taken from the client. Up to 12 line
 * rows are read from the form (empty rows are dropped).
 */
import type { APIRoute } from 'astro';
import { getEngrEnv } from '@engr/env';
import { getDb } from '@engr/db';
import { submitQuote, type QuoteItemInput, type SubmitQuoteInput } from '@engr/repos/quotes';
import {
  jsonResponse,
  wantsJson,
  redirectResponse,
  str,
  toMinorUnits,
} from '@engr/workflow/respond';

const MAX_ITEMS = 12;
const TRUTHY = ['1', 'true', 'on'];

function itemFromJson(raw: unknown): QuoteItemInput {
  const r = (raw ?? {}) as Record<string, unknown>;
  const unitRateMinor =
    typeof r.unit_rate_minor === 'number'
      ? Math.round(r.unit_rate_minor)
      : (toMinorUnits(r.unit_rate) ?? 0);
  return {
    description: str(r.description),
    unit: str(r.unit).trim() || null,
    qty: Number(str(r.qty)) || 0,
    unitRateMinor,
    isSpare: r.is_spare === true || r.is_spare === 1 || TRUTHY.includes(str(r.is_spare)),
    categoryId: str(r.category_id).trim() || null,
  };
}

async function parseQuote(request: Request): Promise<SubmitQuoteInput> {
  const contentType = request.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const body = (await request.json()) as Record<string, unknown>;
    const rawItems = Array.isArray(body.items) ? body.items : [];
    return {
      diagnosis: str(body.diagnosis).trim() || null,
      proposedSolution: str(body.proposed_solution).trim() || null,
      siteVisitDone: body.site_visit_done === true || TRUTHY.includes(str(body.site_visit_done)),
      items: rawItems.map(itemFromJson),
    };
  }
  const form = await request.formData();
  const items: QuoteItemInput[] = [];
  for (let i = 1; i <= MAX_ITEMS; i++) {
    items.push({
      description: str(form.get(`item_${i}_description`)),
      unit: str(form.get(`item_${i}_unit`)).trim() || null,
      qty: Number(str(form.get(`item_${i}_qty`))) || 0,
      unitRateMinor: toMinorUnits(form.get(`item_${i}_rate`)) ?? 0,
      isSpare: TRUTHY.includes(str(form.get(`item_${i}_is_spare`))),
      categoryId: str(form.get(`item_${i}_category`)).trim() || null,
    });
  }
  return {
    diagnosis: str(form.get('diagnosis')).trim() || null,
    proposedSolution: str(form.get('proposed_solution')).trim() || null,
    siteVisitDone: TRUTHY.includes(str(form.get('site_visit_done'))),
    items,
  };
}

export const POST: APIRoute = async ({ request, locals, params }) => {
  const engr = locals.engr;
  if (!engr) return jsonResponse({ error: 'unauthorised' }, 401);
  const id = params.id;
  if (!id) return jsonResponse({ error: 'invalid' }, 400);
  const back = `/engr/contractor/rfqs/${id}`;

  if (!engr.perms.includes('quotes.submit')) {
    return wantsJson(request)
      ? jsonResponse({ error: 'forbidden' }, 403)
      : redirectResponse(request, back, 'error=forbidden');
  }

  const input = await parseQuote(request);
  const db = await getDb(getEngrEnv());
  const result = await submitQuote(db, { orgId: engr.orgId, userId: engr.userId }, id, input);

  if (result.ok) {
    return wantsJson(request)
      ? jsonResponse({ ok: true, quoteId: result.quoteId, quoteNo: result.quoteNo }, 201)
      : redirectResponse(request, back, 'submitted=1');
  }
  const status =
    result.code === 'forbidden'
      ? 403
      : result.code === 'conflict'
        ? 409
        : result.code === 'not_found'
          ? 404
          : 422;
  return wantsJson(request)
    ? jsonResponse({ ok: false, error: result.code, message: result.message }, status)
    : redirectResponse(request, back, `error=${result.code}`);
};
