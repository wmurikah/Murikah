export const prerender = false;

import type { APIRoute } from 'astro';
import { getEngrEnv } from '@engr/env';
import { getDb } from '@engr/db';
import { saveNotificationSettings } from '@engr/repos/notificationSettings';
import { jsonResponse, wantsJson, redirectResponse } from '@engr/workflow/respond';

export const POST: APIRoute = async ({ request, locals }) => {
  const engr = locals.engr;
  if (!engr) return jsonResponse({ error: 'unauthorised' }, 401);
  if (!engr.perms.includes('settings.manage')) {
    return wantsJson(request)
      ? jsonResponse({ error: 'forbidden' }, 403)
      : redirectResponse(request, '/admin/notifications', 'error=forbidden');
  }

  const form = await request.formData();
  const capText = String(form.get('sms_monthly_cap') ?? '').trim();
  const result = await saveNotificationSettings(
    await getDb(getEngrEnv()),
    { orgId: engr.orgId, userId: engr.userId },
    {
      emailEnabled: form.get('email_enabled') === '1',
      smsEnabled: form.get('sms_enabled') === '1',
      quietStart: String(form.get('quiet_start') ?? '').trim(),
      quietEnd: String(form.get('quiet_end') ?? '').trim(),
      smsMonthlyCap: capText === '' ? null : Number(capText),
    },
  );
  if (!result.ok) {
    return wantsJson(request)
      ? jsonResponse({ ok: false, error: 'invalid', message: result.message }, 422)
      : redirectResponse(request, '/admin/notifications', 'error=invalid');
  }
  return wantsJson(request)
    ? jsonResponse({ ok: true }, 200)
    : redirectResponse(request, '/admin/notifications', 'saved=1');
};
