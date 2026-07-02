/**
 * The notification dispatcher: the only reader of QUEUED rows. Producers only
 * ever insert QUEUED; this drains them. The notifications table is the contract,
 * so this can be a Cron drain now and a queue consumer later with no change to
 * any producer.
 *
 * Safety:
 *  - Each row is claimed atomically before sending: UPDATE ... SET status='SENT'
 *    WHERE id = ? AND status = 'QUEUED'. Only the run that changes exactly one
 *    row owns it, so overlapping runs cannot double-send. The enum has no
 *    intermediate state, so the claim is the SENT write; a provider failure then
 *    flips the row to FAILED. There is a small crash window (claimed SENT, the
 *    process dies before the provider call); the delivery-receipt webhook
 *    reconciles it, which is acceptable for reminders.
 *  - Rows are read oldest-first across all orgs, so one org's backlog cannot
 *    starve another within a bounded batch.
 *  - The production gate lives in the adapters: outside production nothing
 *    reaches a provider, yet the queue still drains as a dry-run.
 *  - Quiet hours hold SMS and EMAIL (left QUEUED) and deliver only IN_APP.
 *  - SMS metering falls back to EMAIL then IN_APP when an org is over its cap.
 */
import type { Client } from '@libsql/client/web';
import type { Clock } from '../time';
import { eatMinutesOfDay, eatYearMonth } from '../time';
import type { DeliveryEnv } from './env';
import { channelFor } from './channels/registry';
import type { DeliveryRecipient, OutboundNotification } from './channels/types';

export interface DispatchOptions {
  limit: number;
}

export interface DispatchSummary {
  scanned: number;
  sent: number;
  failed: number;
  held: number;
  skipped: number;
}

interface OrgPolicy {
  quietStart: number | null; // minutes since EAT midnight
  quietEnd: number | null;
  smsCap: number | null;
  smsUsage: number;
}

function parseHhmm(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function inQuietHours(nowMin: number, start: number | null, end: number | null): boolean {
  if (start == null || end == null || start === end) return false;
  if (start < end) return nowMin >= start && nowMin < end;
  // Overnight window, for example 21:00 to 06:00.
  return nowMin >= start || nowMin < end;
}

async function resolveRecipient(
  db: Client,
  orgId: string,
  row: Record<string, unknown>,
): Promise<DeliveryRecipient | null> {
  if (row.recipient_user_id != null) {
    const res = await db.execute({
      sql: `SELECT full_name AS name, phone, email FROM users WHERE id = ? AND org_id = ? LIMIT 1`,
      args: [String(row.recipient_user_id), orgId],
    });
    const r = res.rows[0];
    return r
      ? {
          name: r.name == null ? null : String(r.name),
          phone: r.phone == null ? null : String(r.phone),
          email: r.email == null ? null : String(r.email),
        }
      : null;
  }
  if (row.recipient_contractor_id != null) {
    const res = await db.execute({
      sql: `SELECT name, phone, email FROM contractors WHERE id = ? AND org_id = ? LIMIT 1`,
      args: [String(row.recipient_contractor_id), orgId],
    });
    const r = res.rows[0];
    return r
      ? {
          name: r.name == null ? null : String(r.name),
          phone: r.phone == null ? null : String(r.phone),
          email: r.email == null ? null : String(r.email),
        }
      : null;
  }
  if (row.recipient_technician_id != null) {
    const res = await db.execute({
      sql: `SELECT full_name AS name, phone, email FROM technicians WHERE id = ? AND org_id = ? LIMIT 1`,
      args: [String(row.recipient_technician_id), orgId],
    });
    const r = res.rows[0];
    return r
      ? {
          name: r.name == null ? null : String(r.name),
          phone: r.phone == null ? null : String(r.phone),
          email: r.email == null ? null : String(r.email),
        }
      : null;
  }
  return null;
}

export async function runDispatch(
  db: Client,
  env: DeliveryEnv,
  clock: Clock,
  options: DispatchOptions,
): Promise<DispatchSummary> {
  const now = clock.now();
  const nowIso = now.toISOString();
  const nowMin = eatMinutesOfDay(now);
  const usageKey = `sms_usage_${eatYearMonth(now)}`;
  const summary: DispatchSummary = { scanned: 0, sent: 0, failed: 0, held: 0, skipped: 0 };
  const policies = new Map<string, OrgPolicy>();

  async function policyFor(orgId: string): Promise<OrgPolicy> {
    const cached = policies.get(orgId);
    if (cached) return cached;
    const res = await db.execute({
      sql: `SELECT key, value_json FROM org_settings
             WHERE org_id = ? AND key IN ('quiet_hours', 'sms_monthly_cap', ?)`,
      args: [orgId, usageKey],
    });
    let quietStart: number | null = null;
    let quietEnd: number | null = null;
    let smsCap: number | null = null;
    let smsUsage = 0;
    for (const row of res.rows) {
      const key = String(row.key);
      const raw = typeof row.value_json === 'string' ? row.value_json : '';
      try {
        const parsed: unknown = JSON.parse(raw);
        if (key === 'quiet_hours' && parsed && typeof parsed === 'object') {
          const obj = parsed as { start?: unknown; end?: unknown };
          quietStart = parseHhmm(obj.start);
          quietEnd = parseHhmm(obj.end);
        } else if (key === 'sms_monthly_cap' && typeof parsed === 'number') {
          smsCap = parsed;
        } else if (key === usageKey && typeof parsed === 'number') {
          smsUsage = parsed;
        }
      } catch {
        // Malformed setting: leave the default.
      }
    }
    const policy: OrgPolicy = { quietStart, quietEnd, smsCap, smsUsage };
    policies.set(orgId, policy);
    return policy;
  }

  async function bumpSmsUsage(orgId: string, policy: OrgPolicy): Promise<void> {
    policy.smsUsage += 1;
    await db.execute({
      sql: `INSERT INTO org_settings (org_id, key, value_json, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(org_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      args: [orgId, usageKey, JSON.stringify(policy.smsUsage), nowIso],
    });
  }

  const batch = await db.execute({
    sql: `SELECT id, org_id, channel, subject, body, template_key, entity_type, entity_id,
                 recipient_user_id, recipient_contractor_id, recipient_technician_id
            FROM notifications
           WHERE status = 'QUEUED'
        ORDER BY created_at ASC
           LIMIT ?`,
    args: [Math.max(1, Math.min(options.limit, 500))],
  });

  for (const raw of batch.rows) {
    const row = raw as Record<string, unknown>;
    summary.scanned += 1;
    const id = String(row.id);
    const orgId = String(row.org_id);
    const channel = String(row.channel);
    const policy = await policyFor(orgId);

    // Quiet hours hold SMS and EMAIL; IN_APP is always delivered.
    if (
      (channel === 'SMS' || channel === 'EMAIL') &&
      inQuietHours(nowMin, policy.quietStart, policy.quietEnd)
    ) {
      summary.held += 1;
      continue;
    }

    // Claim the row before any send. Only the run that changes one row owns it.
    const claim = await db.execute({
      sql: `UPDATE notifications SET status = 'SENT', sent_at = ? WHERE id = ? AND status = 'QUEUED'`,
      args: [nowIso, id],
    });
    if (claim.rowsAffected !== 1) {
      summary.skipped += 1; // Another run claimed it first.
      continue;
    }

    const recipient = await resolveRecipient(db, orgId, row);
    if (!recipient) {
      summary.failed += 1;
      await db.execute({
        sql: `UPDATE notifications SET status = 'FAILED', error = ? WHERE id = ?`,
        args: ['recipient not found', id],
      });
      continue;
    }

    const notification: OutboundNotification = {
      id,
      orgId,
      channel,
      subject: row.subject == null ? null : String(row.subject),
      body: row.body == null ? null : String(row.body),
      templateKey: row.template_key == null ? null : String(row.template_key),
      entityType: row.entity_type == null ? null : String(row.entity_type),
      entityId: row.entity_id == null ? null : String(row.entity_id),
    };

    // SMS metering: over the monthly cap, fall back to EMAIL then IN_APP.
    let effectiveKey = channel;
    let note: string | null = null;
    let meteredSms = false;
    if (channel === 'SMS' && policy.smsCap != null && policy.smsUsage >= policy.smsCap) {
      if (recipient.email) {
        effectiveKey = 'EMAIL';
        note = 'sms monthly cap reached, delivered by email';
      } else {
        effectiveKey = 'IN_APP';
        note = 'sms monthly cap reached, held in-app';
      }
    } else if (channel === 'SMS') {
      meteredSms = true;
    }

    const adapter = channelFor(effectiveKey);
    if (!adapter) {
      summary.failed += 1;
      await db.execute({
        sql: `UPDATE notifications SET status = 'FAILED', error = ? WHERE id = ?`,
        args: [`no adapter for channel ${effectiveKey}`, id],
      });
      continue;
    }

    const result = await adapter.send(notification, recipient, env);
    if (result.ok) {
      summary.sent += 1;
      const errorNote = [note, result.error].filter(Boolean).join('; ') || null;
      if (errorNote) {
        await db.execute({
          sql: `UPDATE notifications SET error = ? WHERE id = ?`,
          args: [errorNote, id],
        });
      }
      // Count a real SMS send against the monthly meter (not a dry-run).
      if (meteredSms && effectiveKey === 'SMS' && env.mode === 'production' && !result.error) {
        await bumpSmsUsage(orgId, policy);
      }
    } else {
      summary.failed += 1;
      await db.execute({
        sql: `UPDATE notifications SET status = 'FAILED', error = ? WHERE id = ?`,
        args: [[note, result.error].filter(Boolean).join('; ') || 'send failed', id],
      });
    }
  }

  return summary;
}
