export const prerender = false;

/** Authorised write entrypoint for the auditable asset custody workflow. */
import type { APIRoute } from 'astro';
import { getEngrEnv } from '@engr/env';
import { getDb } from '@engr/db';
import { requireFreshMfa } from '@engr/auth/sensitiveAction';
import {
  requestTransfer, transitionTransfer, type TransferAction,
} from '@engr/repos/assetTransfers';
import { jsonResponse, wantsJson, readBody, str } from '@engr/workflow/respond';

const ACTIONS = new Set<TransferAction>(['approve','reject','dispatch','receive','cancel']);

export const POST: APIRoute = async ({ request, locals }) => {
  const engr = locals.engr;
  if (!engr) return jsonResponse({ error: 'unauthorised' }, 401);
  const body = await readBody(request);
  const action = str(body.action).trim();
  const id = str(body.id).trim();
  const actor = { orgId: engr.orgId, userId: engr.userId, roles: engr.roles, perms: engr.perms };
  const back = id ? `/admin/assets/transfers/${encodeURIComponent(id)}` : '/admin/assets/transfers/new';
  if (action !== 'request' && !ACTIONS.has(action as TransferAction))
    return jsonResponse({ error: 'invalid_action' }, 400);
  // Physical receipt or independent approval is a sensitive custody decision.
  if (action === 'approve' || action === 'receive') {
    const gate = requireFreshMfa(request, locals);
    if (gate) return gate;
  }
  const db = await getDb(getEngrEnv(), locals);
  const result = action === 'request'
    ? await requestTransfer(db, actor, {
        assetId: str(body.asset_id).trim(),
        toStationId: str(body.to_station_id).trim(),
        reason: str(body.reason).trim(),
      })
    : await transitionTransfer(db, actor, id, action as TransferAction, {
        serial: str(body.serial).trim(),
        condition: str(body.condition).trim(),
        note: str(body.note).trim(),
      });
  if (result.ok) {
    return wantsJson(request)
      ? jsonResponse({ ok: true, id: result.id }, action === 'request' ? 201 : 200)
      : new Response(null, { status: 303, headers: { location: `/admin/assets/transfers/${result.id}?saved=1` } });
  }
  const status = result.code === 'forbidden' ? 403 : result.code === 'not_found' ? 404 : result.code === 'conflict' ? 409 : 422;
  if (wantsJson(request)) return jsonResponse({ ok: false, error: result.code, message: result.message }, status);
  return new Response(null, { status: 303, headers: { location: `${back}?error=${encodeURIComponent(result.code)}` } });
};
