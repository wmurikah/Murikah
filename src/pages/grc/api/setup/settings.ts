export const prerender = false;

/**
 * Save the general organisation settings (workflow deadlines and notification
 * defaults) to the config table. SUPER_ADMIN or platform owner only, gated on
 * CONFIG, scoped to the acting organisation, validated by field kind and audited.
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import { can } from '@grc/auth/rbac';
import { writeAuditLog } from '@grc/repos/audit';
import { setConfigValue, SETTINGS_FIELDS } from '@grc/repos/orgConfig';
import { isValidEmail } from '@grc/repos/setupValidation';

const PAGE = '/settings/general';
const back = (q: string): Response =>
  new Response(null, { status: 303, headers: { location: `${PAGE}?${q}` } });

export const POST: APIRoute = async ({ request, locals }) => {
  const grc = locals.grc;
  if (!grc) return new Response(null, { status: 303, headers: { location: '/login' } });
  if (!can(locals, 'update', 'CONFIG')) {
    return back(`error=${encodeURIComponent('You cannot change settings.')}`);
  }

  const form = await request.formData();
  const db = await getDb(getGrcEnv());
  const org = grc.organizationId;

  try {
    for (const field of SETTINGS_FIELDS) {
      const raw = String(form.get(field.key) ?? '').trim();
      if (field.kind === 'email' && raw !== '' && !isValidEmail(raw)) {
        return back(`error=${encodeURIComponent(`${field.label} must be a valid email.`)}`);
      }
      if (field.kind === 'number' && raw !== '' && !Number.isFinite(Number(raw))) {
        return back(`error=${encodeURIComponent(`${field.label} must be a number.`)}`);
      }
      await setConfigValue(db, org, field.key, raw);
    }
    await writeAuditLog(db, {
      organizationId: org,
      userId: grc.userId,
      action: 'SETTINGS.update',
      entityType: 'config',
      entityId: 'general',
    }).catch(() => undefined);
    return back(`saved=${encodeURIComponent('Settings saved.')}`);
  } catch (err) {
    console.error('[grc.setup.settings]', err);
    return back(`error=${encodeURIComponent('Settings could not be saved. Please try again.')}`);
  }
};
