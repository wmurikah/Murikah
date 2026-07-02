export const prerender = false;

/**
 * Delivery-receipt webhook seam. Providers (Africa's Talking delivery reports,
 * the email provider's events) call this to report the outcome of a send, and we
 * reconcile the notification's status from the receipt.
 *
 * Verification is by a shared secret (ENGR_WEBHOOK_SECRET), passed as the
 * `x-webhook-secret` header or a `secret` query parameter. Per-provider
 * signature verification (for example Svix for the email provider) can be added
 * here later without changing the route.
 *
 * The receipt must carry a `reference` equal to our notification id; the send
 * integration will pass it through to the provider. Inbound reply handling
 * (two-way SMS) is deliberately out of scope, but the route is shaped to host it
 * later. This endpoint is unauthenticated by session on purpose: it is a machine
 * callback, gated by the shared secret and keyed on an unguessable id.
 */
import type { APIRoute } from 'astro';
import { getEngrEnv } from '@engr/env';
import { getDeliveryEnv } from '@engr/notify/env';
import { getDb } from '@engr/db';
import { applyDeliveryReceipt } from '@engr/repos/notifications';
import { jsonResponse, readBody, str } from '@engr/workflow/respond';

interface Receipt {
  reference: string;
  delivered: boolean;
  reason: string | null;
}

// Map a provider payload to a normalised receipt. Unknown providers fall back to
// a generic { reference, delivered } shape.
function parseReceipt(provider: string, body: Record<string, unknown>): Receipt | null {
  const reference = str(body.reference).trim();
  if (provider === 'africastalking') {
    const status = str(body.status).trim().toLowerCase();
    if (!reference) return null;
    return {
      reference,
      delivered: status === 'success' || status === 'delivered',
      reason: str(body.status) || null,
    };
  }
  if (provider === 'resend') {
    const type = str(body.type).trim();
    const data = (body.data ?? {}) as Record<string, unknown>;
    const ref = reference || str(data.reference).trim();
    if (!ref) return null;
    const delivered = type === 'email.delivered';
    return { reference: ref, delivered, reason: delivered ? null : type || null };
  }
  if (!reference) return null;
  return {
    reference,
    delivered: body.delivered === true || str(body.delivered) === 'true',
    reason: str(body.reason) || null,
  };
}

export const POST: APIRoute = async ({ request, params }) => {
  const delivery = getDeliveryEnv();
  if (!delivery.webhookSecret) {
    return jsonResponse({ error: 'webhook not configured' }, 503);
  }
  const provided =
    request.headers.get('x-webhook-secret') ??
    new URL(request.url).searchParams.get('secret') ??
    '';
  if (provided !== delivery.webhookSecret) {
    return jsonResponse({ error: 'unauthorised' }, 401);
  }

  const provider = str(params.provider).trim() || 'generic';
  const body = await readBody(request);
  const receipt = parseReceipt(provider, body);
  if (!receipt) {
    // Acknowledge so the provider does not retry a payload we cannot map.
    return jsonResponse({ ok: false, reason: 'no reference' }, 200);
  }

  const db = await getDb(getEngrEnv());
  const updated = await applyDeliveryReceipt(
    db,
    receipt.reference,
    receipt.delivered,
    receipt.reason,
  );
  return jsonResponse({ ok: true, updated }, 200);
};
