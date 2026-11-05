/** Organisation-level notification preferences. Provider credentials stay in
 * Cloudflare secrets; this repository stores only safe channel/policy choices. */
import type { Client } from '@libsql/client/web';

export interface NotificationSettings {
  emailEnabled: boolean;
  smsEnabled: boolean;
  quietStart: string;
  quietEnd: string;
  smsMonthlyCap: number | null;
}

const DEFAULTS: NotificationSettings = {
  emailEnabled: false,
  smsEnabled: false,
  quietStart: '',
  quietEnd: '',
  smsMonthlyCap: null,
};

function parseJson(raw: unknown): unknown {
  if (typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function getNotificationSettings(
  db: Client,
  orgId: string,
): Promise<NotificationSettings> {
  const res = await db.execute({
    sql: `SELECT key, value_json FROM org_settings
           WHERE org_id = ? AND key IN ('notification_channels', 'quiet_hours', 'sms_monthly_cap')`,
    args: [orgId],
  });
  const result = { ...DEFAULTS };
  for (const row of res.rows) {
    const value = parseJson(row.value_json);
    if (row.key === 'notification_channels' && Array.isArray(value)) {
      result.emailEnabled = value.includes('EMAIL');
      result.smsEnabled = value.includes('SMS');
    } else if (row.key === 'quiet_hours' && value && typeof value === 'object') {
      const quiet = value as { start?: unknown; end?: unknown };
      result.quietStart = typeof quiet.start === 'string' ? quiet.start : '';
      result.quietEnd = typeof quiet.end === 'string' ? quiet.end : '';
    } else if (row.key === 'sms_monthly_cap' && typeof value === 'number') {
      result.smsMonthlyCap = value;
    }
  }
  return result;
}

const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export async function saveNotificationSettings(
  db: Client,
  ctx: { orgId: string; userId: string },
  input: NotificationSettings,
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (
    (input.quietStart && !TIME.test(input.quietStart)) ||
    (input.quietEnd && !TIME.test(input.quietEnd))
  ) {
    return { ok: false, message: 'Quiet hours must use a valid 24-hour time.' };
  }
  if ((input.quietStart && !input.quietEnd) || (!input.quietStart && input.quietEnd)) {
    return { ok: false, message: 'Enter both quiet-hour times, or leave both empty.' };
  }
  if (
    input.smsMonthlyCap !== null &&
    (!Number.isInteger(input.smsMonthlyCap) || input.smsMonthlyCap < 0)
  ) {
    return { ok: false, message: 'The SMS monthly cap must be a whole number of zero or more.' };
  }

  const channels = ['IN_APP'];
  if (input.emailEnabled) channels.push('EMAIL');
  if (input.smsEnabled) channels.push('SMS');
  const now = new Date().toISOString();
  const values: Array<[string, unknown]> = [
    ['notification_channels', channels],
    ['quiet_hours', { start: input.quietStart || null, end: input.quietEnd || null }],
    ['sms_monthly_cap', input.smsMonthlyCap],
  ];

  const tx = await db.transaction('write');
  try {
    for (const [key, value] of values) {
      await tx.execute({
        sql: `INSERT INTO org_settings (org_id, key, value_json, updated_at)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(org_id, key) DO UPDATE
                    SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
        args: [ctx.orgId, key, JSON.stringify(value), now],
      });
    }
    await tx.execute({
      sql: `INSERT INTO audit_logs
              (org_id, actor_user_id, action, entity_type, entity_id, after_json)
            VALUES (?, ?, 'notifications.settings.update', 'organisation', ?, ?)`,
      args: [
        ctx.orgId,
        ctx.userId,
        ctx.orgId,
        JSON.stringify({
          channels,
          quiet_hours: values[1][1],
          sms_monthly_cap: input.smsMonthlyCap,
        }),
      ],
    });
    await tx.commit();
    return { ok: true };
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}
