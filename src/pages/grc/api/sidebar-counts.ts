export const prerender = false;

/**
 * The sidebar badge counts as JSON, for the live refresh (getSidebarCounts). The
 * layout renders the counts server-side on every navigation; this endpoint lets a
 * light client poll refresh them between navigations. Scoped to the acting
 * organisation and the signed-in user; returns 401 when there is no session.
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import { getSidebarCounts } from '@grc/repos/dashboard';

export const GET: APIRoute = async ({ locals }) => {
  const grc = locals.grc;
  if (!grc) return new Response(JSON.stringify({ error: 'unauthorised' }), { status: 401 });

  const db = await getDb(getGrcEnv());
  const counts = await getSidebarCounts(db, grc.organizationId, grc.userId);
  return new Response(JSON.stringify(counts), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
};
