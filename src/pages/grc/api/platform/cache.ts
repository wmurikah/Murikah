export const prerender = false;

/**
 * Cache diagnostics and recovery, for the platform owner only (Build Prompt 42).
 *
 * GET returns the counters as JSON: the platform roll-up, this isolate's own
 * figures, and which backend is in use. POST takes one of two operations:
 * `flush` clears one organisation's namespace, and `reset` clears the counters
 * so a measurement can start clean.
 *
 * The flush is namespaced by construction. It can only ever remove entries under
 * the organisation it names, so a cache problem in one tenant is recoverable
 * without touching another's entries and without a deploy. The gate is the
 * platform owner flag, not a role grant: this acts across organisations, so it
 * belongs to the owner alone and the endpoint refuses independently of the
 * middleware rather than trusting it.
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import { cacheStatsReport, hitRate, resetCacheStats } from '@grc/cache';
import { flushOrganisation } from '@grc/cache/invalidate';
import { writeAuditLog } from '@grc/repos/audit';
import { GRC_CACHE_PATH } from '@grc/routing';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function back(query: string): Response {
  return new Response(null, { status: 303, headers: { location: `${GRC_CACHE_PATH}?${query}` } });
}

export const GET: APIRoute = async ({ locals }) => {
  const grc = locals.grc;
  if (!grc) return json({ error: 'unauthorised' }, 401);
  if (!grc.isPlatformOwner) return json({ error: 'forbidden' }, 403);

  const report = await cacheStatsReport();
  return json({ ...report, hitRate: hitRate(report.total) });
};

export const POST: APIRoute = async ({ request, locals }) => {
  const grc = locals.grc;
  if (!grc) return json({ error: 'unauthorised' }, 401);
  if (!grc.isPlatformOwner) return json({ error: 'forbidden' }, 403);

  const form = await request.formData();
  const op = String(form.get('op') ?? 'flush');

  if (op === 'reset') {
    await resetCacheStats();
    return back(`done=${encodeURIComponent('Cache counters reset.')}`);
  }

  const organizationId = String(form.get('organization_id') ?? '').trim();
  if (organizationId === '') return back(`error=${encodeURIComponent('Choose an organisation.')}`);

  const db = await getDb(getGrcEnv());
  const removed = await flushOrganisation(db, organizationId);
  try {
    await writeAuditLog(db, {
      organizationId,
      userId: grc.userId,
      action: 'CACHE.flush',
      details: `${removed} entries`,
    });
  } catch {
    // best-effort audit
  }
  return back(`done=${encodeURIComponent(`Flushed ${removed} cached entries.`)}`);
};
