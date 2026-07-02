export const prerender = false;

/**
 * Set the line items on a draft or recalled cost. Gate: cost.create, plus
 * ownership in the ladder. Amounts and the subtotal are computed server-side.
 */
import type { APIRoute } from 'astro';
import { getEngrEnv } from '@engr/env';
import { getDb } from '@engr/db';
import { setCostItems, type CostItemInput } from '@engr/workflow/costState';
import {
  jsonResponse,
  wantsJson,
  redirectResponse,
  str,
  toMinorUnits,
} from '@engr/workflow/respond';

const MAX_ITEMS = 15;

function parseItems(form: FormData): CostItemInput[] {
  const items: CostItemInput[] = [];
  for (let i = 1; i <= MAX_ITEMS; i++) {
    const description = str(form.get(`item_${i}_description`)).trim();
    const rateItemId = str(form.get(`item_${i}_rate_item`)).trim() || null;
    items.push({
      source: rateItemId ? 'PRICE_LIST' : 'MANUAL',
      rateItemId,
      categoryId: str(form.get(`item_${i}_category`)).trim() || null,
      description,
      unit: str(form.get(`item_${i}_unit`)).trim() || null,
      qty: Number(str(form.get(`item_${i}_qty`))) || 0,
      unitRateMinor: toMinorUnits(form.get(`item_${i}_rate`)) ?? 0,
    });
  }
  return items;
}

export const POST: APIRoute = async ({ request, locals, params }) => {
  const engr = locals.engr;
  if (!engr) return jsonResponse({ error: 'unauthorised' }, 401);
  const id = params.id;
  if (!id) return jsonResponse({ error: 'invalid' }, 400);
  const back = `/engr/costs/${id}`;
  if (!engr.perms.includes('cost.create')) {
    return wantsJson(request)
      ? jsonResponse({ error: 'forbidden' }, 403)
      : redirectResponse(request, back, 'error=forbidden');
  }

  const form = await request.formData();
  const db = await getDb(getEngrEnv());
  const result = await setCostItems(
    db,
    { orgId: engr.orgId, userId: engr.userId },
    id,
    parseItems(form),
  );
  if (result.ok) {
    return wantsJson(request)
      ? jsonResponse({ ok: true }, 200)
      : redirectResponse(request, back, 'saved=1');
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
