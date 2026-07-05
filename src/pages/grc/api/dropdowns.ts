export const prerender = false;

/**
 * Save the managed control-field dropdowns, SUPER_ADMIN only. Writes the four
 * value lists to the organisation's config (one value per line from the form),
 * invalidates the dropdown cache and records the change in audit_log. Scoped to
 * the acting organisation.
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import { saveDropdown, invalidateDropdownCache, DROPDOWN_KEYS } from '@grc/repos/dropdowns';
import { writeAuditLog } from '@grc/repos/audit';

function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { location } });
}

function lines(form: FormData, field: string): string[] {
  return String(form.get(field) ?? '')
    .split(/\r?\n/)
    .map((v) => v.trim())
    .filter(Boolean);
}

export const POST: APIRoute = async ({ request, locals }) => {
  const grc = locals.grc;
  if (!grc) return redirect('/login');
  if (!grc.isPlatformOwner && grc.roleCode !== 'SUPER_ADMIN') {
    return new Response('Forbidden', { status: 403 });
  }

  const form = await request.formData();
  const db = await getDb(getGrcEnv());
  const org = grc.organizationId;

  await saveDropdown(db, org, DROPDOWN_KEYS.riskRatings, lines(form, 'risk_ratings'));
  await saveDropdown(db, org, DROPDOWN_KEYS.classification, lines(form, 'classification'));
  await saveDropdown(db, org, DROPDOWN_KEYS.controlType, lines(form, 'control_type'));
  await saveDropdown(db, org, DROPDOWN_KEYS.controlFrequency, lines(form, 'control_frequency'));
  invalidateDropdownCache(org);
  try {
    await writeAuditLog(db, {
      organizationId: org,
      userId: grc.userId,
      action: 'DROPDOWN.update',
      details: 'control fields',
    });
  } catch {
    // best-effort audit
  }

  return redirect(`/settings/dropdowns?done=${encodeURIComponent('Dropdowns saved.')}`);
};
