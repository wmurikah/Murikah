export const prerender = false;

/**
 * Save the AI configuration. Writes the non-secret settings to the GLOBAL config
 * scope (the API keys stay Worker secrets) and records the change in audit_log.
 *
 * Platform owner only (Build Prompt 44). These settings sit on the platform-wide
 * `GLOBAL` sentinel, so they are one row shared by every customer: an instance
 * admin holding `CONFIG.update` could change the model, the provider and the
 * evaluation threshold for every tenant on the platform at once (audit finding
 * AC-02). The gate is now `isPlatformOwner` alone, not the matrix, because no
 * per-organisation grant can be the right authority for a write whose blast
 * radius is the whole platform. Per-organisation AI configuration is the proper
 * fix and a later option; until then the write belongs to the owner.
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
  if (!aiEnabled((f) => grc.hasFeature(f)) || !grc.isPlatformOwner) {
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
