export const prerender = false;

/**
 * Work-paper insights (WORK_PAPER_INSIGHTS) on demand from the work paper view.
 * Gated behind the plan's AI feature and an auditor role; scoped to the acting
 * organisation. Returns the Markdown analysis and its disclaimer as JSON; the
 * invocation is logged to ai_invocations by the service.
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import { getWorkPaper } from '@grc/repos/workPapers';
import { workPaperInsights } from '@grc/ai/features';
import { aiEnabled } from '@grc/ai/gate';

const str = (v: unknown): string => (v == null ? '' : String(v));

export const POST: APIRoute = async ({ request, locals }) => {
  const grc = locals.grc;
  if (!grc) return new Response(JSON.stringify({ error: 'unauthorised' }), { status: 401 });
  if (!aiEnabled((f) => grc.hasFeature(f))) {
    return new Response(JSON.stringify({ error: 'AI assistance is not part of your plan.' }), {
      status: 403,
    });
  }
  if (!grc.isPlatformOwner && !grc.perms.includes('WORK_PAPERS.view')) {
    return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 });
  }

  const form = await request.formData();
  const id = String(form.get('work_paper_id') ?? '').trim();
  if (!id) return new Response(JSON.stringify({ error: 'missing work paper' }), { status: 400 });

  const db = await getDb(getGrcEnv());
  const wp = await getWorkPaper(db, grc.organizationId, id, grc.affiliateScope);
  if (!wp) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });

  const result = await workPaperInsights(
    db,
    grc.organizationId,
    grc.userId,
    {
      reference: str(wp.reference),
      title: str(wp.observation_title),
      description: str(wp.observation_description),
      riskRating: str(wp.risk_rating),
      recommendation: str(wp.recommendation),
      affiliate: str(wp.affiliate_name ?? wp.affiliate_code),
      auditArea: str(wp.audit_area_name),
    },
    id,
  );

  return new Response(
    JSON.stringify({
      ok: result.ok,
      markdown: result.markdown,
      disclaimer: result.disclaimer,
      error: result.error,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
};
