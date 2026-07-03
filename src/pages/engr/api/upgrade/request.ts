export const prerender = false;

/**
 * Request an upgrade. The billing integration is out of scope, so this records
 * the request against the organisation and notifies the platform owner, who can
 * follow up. Gate: org.manage (the organisation's own admin asks to upgrade).
 * Scoped to the acting organisation from the session.
 */
import type { APIRoute } from 'astro';
import { getEngrEnv } from '@engr/env';
import { getDb } from '@engr/db';
import { enqueue } from '@engr/notify';
import { jsonResponse, wantsJson, str } from '@engr/workflow/respond';

function seeOther(location: string): Response {
  return new Response(null, { status: 303, headers: { location } });
}

// The platform owner user(s), each notified in their own organisation so the
// notification reaches their bell. Defensive if the column is not yet migrated.
async function platformOwners(
  db: Awaited<ReturnType<typeof getDb>>,
): Promise<{ id: string; orgId: string }[]> {
  try {
    const res = await db.execute({
      sql: `SELECT id, org_id FROM users
             WHERE is_platform_owner = 1 AND deleted_at IS NULL AND status = 'ACTIVE'`,
      args: [],
    });
    return res.rows.map((r) => ({ id: String(r.id), orgId: String(r.org_id) }));
  } catch {
    return [];
  }
}

export const POST: APIRoute = async ({ request, locals }) => {
  const engr = locals.engr;
  if (!engr) return jsonResponse({ error: 'unauthorised' }, 401);
  if (!engr.perms.includes('org.manage')) {
    return wantsJson(request)
      ? jsonResponse({ error: 'forbidden' }, 403)
      : seeOther('/upgrade?error=forbidden');
  }

  const form = await request.formData();
  const requestedPlan = str(form.get('plan')).trim().toUpperCase() || 'GROWTH';
  const note = str(form.get('note')).trim().slice(0, 500);
  const db = await getDb(getEngrEnv());

  // Record the request against the organisation.
  await db.execute({
    sql: `INSERT INTO audit_logs (org_id, actor_user_id, action, entity_type, entity_id, after_json)
          VALUES (?, ?, 'upgrade.request', 'organisation', ?, ?)`,
    args: [engr.orgId, engr.userId, engr.orgId, JSON.stringify({ requestedPlan, note })],
  });

  // Notify the platform owner(s).
  const owners = await platformOwners(db);
  const subject = `Upgrade requested by ${engr.orgName ?? engr.orgSlug}`;
  const body = `${engr.orgName ?? engr.orgSlug} asked to upgrade to ${requestedPlan}.${
    note ? ` Note: ${note}` : ''
  }`;
  for (const owner of owners) {
    await enqueue(db, owner.orgId, {
      recipientType: 'user',
      recipientId: owner.id,
      templateKey: 'upgrade.request',
      subject,
      body,
      entityType: 'organisation',
      entityId: engr.orgId,
    });
  }

  return wantsJson(request) ? jsonResponse({ ok: true }, 200) : seeOther('/upgrade?requested=1');
};
