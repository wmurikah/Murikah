export const prerender = false;

/**
 * Test an AI provider's connection, SUPER_ADMIN only. Sends a tiny request with
 * that provider's Worker-secret key and reports success or the error. Gated
 * behind the plan's AI feature and strictly on SUPER_ADMIN (or a platform owner).
 */
import type { APIRoute } from 'astro';
import { testConnection } from '@grc/ai/service';
import { isProvider } from '@grc/ai/providers';
import { aiEnabled } from '@grc/ai/gate';

export const POST: APIRoute = async ({ request, locals }) => {
  const grc = locals.grc;
  if (!grc) return new Response(JSON.stringify({ error: 'unauthorised' }), { status: 401 });
  if (
    !aiEnabled((f) => grc.hasFeature(f)) ||
    (!grc.isPlatformOwner && grc.roleCode !== 'SUPER_ADMIN')
  ) {
    return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 });
  }

  const form = await request.formData();
  const providerRaw = String(form.get('provider') ?? '');
  if (!isProvider(providerRaw)) {
    return new Response(JSON.stringify({ ok: false, error: 'unknown provider' }), { status: 400 });
  }
  const result = await testConnection(providerRaw);
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};
