/**
 * SaaS awareness: read an organisation's subscription and its plan feature
 * flags, so premium features can be gated and a trial can show an upgrade
 * prompt. The gating UI is refined per module later; this exposes the flags.
 *
 * Shape of features_json is a flat object of flag to boolean, for example
 * { "ai_assistance": false, "board_reporting": true }. A platform owner is
 * treated as entitled to everything (handled at the locals.grc.hasFeature seam),
 * regardless of the acting organisation's plan.
 */
import type { Client } from '@libsql/client/web';

export interface Subscription {
  planCode: string | null;
  status: string | null;
  features: Record<string, boolean>;
}

function parseFeatures(raw: unknown): Record<string, boolean> {
  if (typeof raw !== 'string' || raw.trim() === '') return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return {};
    const out: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      out[key] = value === true || value === 1 || value === '1' || value === 'true';
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * The acting organisation's subscription and resolved feature flags. Returns an
 * empty, no-features subscription when the organisation has no subscription row,
 * so callers never crash on an unsubscribed tenant.
 */
export async function loadSubscription(db: Client, organizationId: string): Promise<Subscription> {
  const res = await db.execute({
    sql: `SELECT s.plan_code AS plan_code, s.status AS status, p.features_json AS features_json
            FROM subscriptions s
            LEFT JOIN plans p ON p.plan_code = s.plan_code
           WHERE s.organization_id = ?
           LIMIT 1`,
    args: [organizationId],
  });
  const row = res.rows[0];
  if (!row) return { planCode: null, status: null, features: {} };
  return {
    planCode: row.plan_code == null ? null : String(row.plan_code),
    status: row.status == null ? null : String(row.status),
    features: parseFeatures(row.features_json),
  };
}
