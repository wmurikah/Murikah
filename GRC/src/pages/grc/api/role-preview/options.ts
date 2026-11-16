export const prerender = false;

/**
 * Lazy options for the owner/super-admin role preview. Keeping this data out of
 * the shared layout removes two database queries from ordinary navigation.
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import { listRoleCodes } from '@grc/repos/permissionsAdmin';
import { listAffiliates } from '@grc/repos/workPaperLookups';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'private, no-store',
    },
  });

export const GET: APIRoute = async ({ locals }) => {
  const grc = locals.grc;
  if (!grc) return json({ error: 'unauthorised' }, 401);
  if (!grc.canRolePreview || grc.instanceSelected === false) {
    return json({ error: 'forbidden' }, 403);
  }

  try {
    const started = performance.now();
    const db = await getDb(getGrcEnv());
    const [roles, affiliates] = await Promise.all([
      listRoleCodes(db),
      listAffiliates(db, grc.organizationId),
    ]);
    const response = json({ roles, affiliates });
    response.headers.set(
      'server-timing',
      `role-preview-options;dur=${(performance.now() - started).toFixed(1)}`,
    );
    return response;
  } catch (error) {
    console.error('[grc.role-preview.options]', error);
    return json({ error: 'unavailable' }, 503);
  }
};
