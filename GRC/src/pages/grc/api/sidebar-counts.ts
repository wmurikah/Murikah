export const prerender = false;

/**
 * The sidebar badge counts as JSON, for the non-blocking live refresh
 * (getSidebarCounts). The shell paints empty badges first, then calls this
 * endpoint, so a count query cannot delay page navigation. Scoped to the acting
 * organisation and the signed-in user; returns 401 when there is no session.
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import { getSidebarCounts } from '@grc/repos/dashboard';

export const GET: APIRoute = async ({ locals }) => {
  const grc = locals.grc;
  if (!grc) return new Response(JSON.stringify({ error: 'unauthorised' }), { status: 401 });

  const started = performance.now();
  const db = await getDb(getGrcEnv());
  const counts = await getSidebarCounts(
    db,
    grc.organizationId,
    grc.userId,
    grc.affiliateScope,
    grc.isPlatformOwner || grc.perms.includes('WORK_PAPERS.review'),
  );
  return new Response(JSON.stringify(counts), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'server-timing': `sidebar-counts;dur=${(performance.now() - started).toFixed(1)}`,
    },
  });
};
