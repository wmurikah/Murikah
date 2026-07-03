export const prerender = false;

/**
 * Rate item write endpoint. Add an item to a rate card, edit an existing item in
 * place (when an id is posted), or remove one (when delete_id is posted), so a
 * rate card is fully editable and not a one-way create. Gate: rates.manage.
 */
import type { APIRoute } from 'astro';
import { getEngrEnv } from '@engr/env';
import { getDb } from '@engr/db';
import {
  addRateItem,
  updateRateItem,
  deleteRateItem,
  type RateItemInput,
} from '@engr/repos/adminRateCards';
import { jsonResponse, wantsJson, readBody, str, toMinorUnits } from '@engr/workflow/respond';

function seeOther(location: string): Response {
  return new Response(null, { status: 303, headers: { location } });
}

export const POST: APIRoute = async ({ request, locals }) => {
  const engr = locals.engr;
  if (!engr) return jsonResponse({ error: 'unauthorised' }, 401);
  if (!engr.perms.includes('rates.manage')) {
    return wantsJson(request)
      ? jsonResponse({ error: 'forbidden' }, 403)
      : seeOther('/admin/rate-cards?error=forbidden');
  }

  const body = await readBody(request);
  const rateCardId = str(body.rate_card_id).trim();
  const cardPath = `/admin/rate-cards/${rateCardId || 'new'}`;
  const db = await getDb(getEngrEnv());
  const ctx = { orgId: engr.orgId, userId: engr.userId };

  const deleteId = str(body.delete_id).trim();
  const itemId = str(body.id).trim();

  let result;
  if (deleteId) {
    result = await deleteRateItem(db, ctx, deleteId);
  } else {
    const input: RateItemInput = {
      rateCardId,
      categoryId: str(body.category_id).trim() || null,
      description: str(body.description).trim(),
      unit: str(body.unit).trim() || null,
      unitRateMinor: toMinorUnits(body.unit_rate) ?? 0,
    };
    result = itemId
      ? await updateRateItem(db, ctx, itemId, input)
      : await addRateItem(db, ctx, input);
  }

  if (result.ok) {
    return wantsJson(request)
      ? jsonResponse({ ok: true, id: result.id }, 200)
      : seeOther(`${cardPath}?saved=1`);
  }
  const status = result.code === 'conflict' ? 409 : result.code === 'not_found' ? 404 : 422;
  if (wantsJson(request)) {
    return jsonResponse({ ok: false, error: result.code, message: result.message }, status);
  }
  return seeOther(`${cardPath}?error=${result.code}`);
};
