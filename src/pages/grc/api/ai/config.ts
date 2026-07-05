export const prerender = false;

/**
 * Save the AI configuration, SUPER_ADMIN only. Writes the non-secret settings to
 * the GLOBAL config scope (the API keys stay Worker secrets) and records the
 * change in audit_log. Gated behind the plan's AI feature and strictly on
 * SUPER_ADMIN (or a platform owner).
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import { saveAiConfig } from '@grc/ai/config';
import { isProvider } from '@grc/ai/providers';
import { aiEnabled } from '@grc/ai/gate';
import { writeAuditLog } from '@grc/repos/audit';

export const POST: APIRoute = async ({ request, locals }) => {
  const grc = locals.grc;
  if (!grc) return new Response(null, { status: 303, headers: { location: '/login' } });
  if (
    !aiEnabled((f) => grc.hasFeature(f)) ||
    (!grc.isPlatformOwner && grc.roleCode !== 'SUPER_ADMIN')
  ) {
    return new Response('Forbidden', { status: 403 });
  }

  const form = await request.formData();
  const activeRaw = String(form.get('active_provider') ?? 'openai');
  const activeProvider = isProvider(activeRaw) ? activeRaw : 'openai';
  const maxTokens = Number(form.get('max_tokens') ?? 1500);
  const temperature = Number(form.get('temperature') ?? 0.3);
  const rejectionThreshold = Number(form.get('rejection_threshold') ?? 50);

  const db = await getDb(getGrcEnv());
  await saveAiConfig(db, {
    activeProvider,
    model: String(form.get('model') ?? '').trim(),
    maxTokens: Number.isFinite(maxTokens) ? maxTokens : 1500,
    temperature: Number.isFinite(temperature) ? temperature : 0.3,
    systemPrompt: String(form.get('system_prompt') ?? '').trim(),
    evaluationEnabled: form.get('evaluation_enabled') === '1',
    rejectionThreshold: Number.isFinite(rejectionThreshold) ? rejectionThreshold : 50,
    enabled: {
      openai: form.get('enabled_openai') === '1',
      anthropic: form.get('enabled_anthropic') === '1',
      google: form.get('enabled_google') === '1',
    },
  });
  try {
    await writeAuditLog(db, {
      organizationId: grc.organizationId,
      userId: grc.userId,
      action: 'AI.config',
      details: `active=${activeProvider}`,
    });
  } catch {
    // best-effort audit
  }

  return new Response(null, {
    status: 303,
    headers: { location: `/settings/ai?done=${encodeURIComponent('Settings saved.')}` },
  });
};
