export const prerender = false;

/**
 * Retry a failed or dead-lettered notification, SUPER_ADMIN only. Returns the row
 * to PENDING with a clean slate so the next drain re-sends it. Scoped to the
 * acting organisation and gated strictly on SUPER_ADMIN (or a platform owner).
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import { retryRow } from '@grc/repos/sendQueue';

export const POST: APIRoute = async ({ request, locals }) => {
  const grc = locals.grc;
  if (!grc) return new Response(null, { status: 303, headers: { location: '/login' } });
  if (!grc.isPlatformOwner && grc.roleCode !== 'SUPER_ADMIN') {
    return new Response('Forbidden', { status: 403 });
  }

  const form = await request.formData();
  const id = String(form.get('id') ?? '').trim();
  if (!id) return new Response(null, { status: 303, headers: { location: '/send-queue' } });

  const db = await getDb(getGrcEnv());
  const ok = await retryRow(db, grc.organizationId, id);
  const msg = ok ? 'Queued for retry.' : 'That row could not be retried.';
  return new Response(null, {
    status: 303,
    headers: { location: `/send-queue?done=${encodeURIComponent(msg)}` },
  });
};
