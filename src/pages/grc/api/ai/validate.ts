export const prerender = false;

/**
 * Action-plan SMART validation (VALIDATE_ACTION_PLAN), called on create or edit.
 * Gated behind the plan's AI feature. When the AI provider is disabled or
 * unavailable it falls back to the basic non-AI validation, so the feature still
 * works. Returns the validation as JSON with its disclaimer.
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import { validateActionPlan } from '@grc/ai/features';
import { aiEnabled } from '@grc/ai/gate';

export const POST: APIRoute = async ({ request, locals }) => {
  const grc = locals.grc;
  if (!grc) return new Response(JSON.stringify({ error: 'unauthorised' }), { status: 401 });
  if (!aiEnabled((f) => grc.hasFeature(f))) {
    return new Response(JSON.stringify({ error: 'AI assistance is not part of your plan.' }), {
      status: 403,
    });
  }
  const canWork =
    grc.isPlatformOwner ||
    grc.perms.includes('ACTION_PLANS.create') ||
    grc.perms.includes('ACTION_PLANS.edit') ||
    grc.perms.includes('AUDITEE.respond');
  if (!canWork) return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 });

  const form = await request.formData();
  const description = String(form.get('action_description') ?? '').trim();
  const dueDate = String(form.get('due_date') ?? '').trim() || null;
  const observationTitle = String(form.get('observation_title') ?? '').trim();
  const owners = form
    .getAll('owner_ids')
    .map((v) => String(v).trim())
    .filter(Boolean);
  const actionPlanId = String(form.get('action_plan_id') ?? '').trim() || null;

  const db = await getDb(getGrcEnv());
  const result = await validateActionPlan(
    db,
    grc.organizationId,
    grc.userId,
    { description, dueDate: dueDate ?? '', owners: owners.join(', '), observationTitle },
    { description, ownerCount: owners.length, dueDate },
    new Date(),
    actionPlanId,
  );

  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};
