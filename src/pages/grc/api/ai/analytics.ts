export const prerender = false;

/**
 * Generate the analytics insight (ANALYTICS_INSIGHTS) for the acting
 * organisation. Gated behind the plan's AI feature and an auditor role; the
 * invocation is logged to ai_invocations by the service. Returns JSON with the
 * Markdown insight and its disclaimer.
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import { loadEnumLabels } from '@grc/repos/enums';
import { getPortfolio, portfolioSummary } from '@grc/repos/analytics';
import { analyticsInsights } from '@grc/ai/features';
import { aiEnabled } from '@grc/ai/gate';

export const POST: APIRoute = async ({ locals }) => {
  const grc = locals.grc;
  if (!grc) return new Response(JSON.stringify({ error: 'unauthorised' }), { status: 401 });
  if (!aiEnabled((f) => grc.hasFeature(f))) {
    return new Response(JSON.stringify({ error: 'AI assistance is not part of your plan.' }), {
      status: 403,
    });
  }
  const isAuditor =
    grc.isPlatformOwner ||
    grc.perms.includes('WORK_PAPERS.view') ||
    grc.perms.includes('REPORTS.view');
  if (!isAuditor) {
    return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 });
  }

  const db = await getDb(getGrcEnv());
  const [wpLabels, apLabels] = await Promise.all([
    loadEnumLabels(db, 'WORK_PAPER_STATUS'),
    loadEnumLabels(db, 'ACTION_PLAN_STATUS'),
  ]);
  const portfolio = await getPortfolio(
    db,
    grc.organizationId,
    new Map([...wpLabels, ...apLabels]),
    new Date(),
    grc.affiliateScope,
  );
  const result = await analyticsInsights(
    db,
    grc.organizationId,
    grc.userId,
    portfolioSummary(portfolio),
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
