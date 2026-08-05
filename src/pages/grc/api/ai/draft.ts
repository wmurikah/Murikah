export const prerender = false;

/**
 * Drafting help for the work-paper form: a first draft of the observation
 * detail, the numbered recommendations, or a risk-rating suggestion with a
 * one-sentence rationale. Gated behind the plan's AI feature and the
 * work-paper create or edit permission. The result is JSON the form drops into
 * an editable field, clearly labelled AI-assisted; nothing here is final and a
 * provider failure degrades to a logged JSON error, never a 500. Every call is
 * recorded to ai_invocations by the service with its purpose, latency and
 * outcome.
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import { draftAssistance, parseDraftKind } from '@grc/ai/features';
import { aiEnabled } from '@grc/ai/gate';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

export const POST: APIRoute = async ({ request, locals }) => {
  const grc = locals.grc;
  if (!grc) return json({ error: 'unauthorised' }, 401);
  if (!aiEnabled((f) => grc.hasFeature(f))) {
    return json({ error: 'AI assistance is not part of your plan.' }, 403);
  }
  if (
    !grc.isPlatformOwner &&
    !grc.perms.includes('WORK_PAPERS.create') &&
    !grc.perms.includes('WORK_PAPERS.edit')
  ) {
    return json({ error: 'forbidden' }, 403);
  }

  const form = await request.formData();
  const kind = parseDraftKind(form.get('kind') == null ? null : String(form.get('kind')));
  if (!kind) return json({ error: 'Unknown drafting request.' }, 400);
  const f = (key: string): string => String(form.get(key) ?? '').trim();

  const db = await getDb(getGrcEnv());
  const result = await draftAssistance(db, grc.organizationId, grc.userId, grc.roleCode, kind, {
    title: f('observation_title'),
    description: f('observation_description'),
    riskDescription: f('risk_description'),
    testObjective: f('test_objective'),
    recommendation: f('recommendation'),
    auditArea: f('audit_area'),
  });

  // A provider failure is a degraded outcome, not a server error: the form
  // shows the message in its status line (the same contract as the insights
  // endpoint), and the failed invocation is already on the trail.
  if (!result.ok) {
    return json({ ok: false, error: result.error ?? 'The AI request failed.' });
  }
  return json({
    ok: true,
    content: result.content,
    rating: result.rating ?? null,
    disclaimer: result.disclaimer,
  });
};
