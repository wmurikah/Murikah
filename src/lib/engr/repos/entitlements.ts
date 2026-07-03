/**
 * Plan entitlements. An organisation's current plan (its most recent trialing or
 * active subscription) carries the feature flags in plans.features_json; premium
 * capabilities are gated on those flags so a screen shows a tasteful locked state
 * rather than the feature when it is not in the plan. Everything is scoped to the
 * one organisation. Parsing is defensive: a missing or malformed flag reads as
 * off, never as an error.
 */
import type { Client } from '@libsql/client/web';

export const FEATURE_KEYS = [
  'rfq',
  'pm_automation',
  'mileage_lpo',
  'multi_level_billing',
  'api_access',
  'sso',
] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];

export type Features = Record<FeatureKey, boolean>;

export interface OrgPlan {
  planCode: string;
  planName: string;
  status: string;
  trialEndsAt: string | null;
  features: Features;
}

const allOff = (): Features =>
  FEATURE_KEYS.reduce((acc, k) => {
    acc[k] = false;
    return acc;
  }, {} as Features);

function parseFeatures(raw: unknown): Features {
  const out = allOff();
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        for (const k of FEATURE_KEYS) out[k] = Boolean((parsed as Record<string, unknown>)[k]);
      }
    } catch {
      // Malformed features_json: everything off.
    }
  }
  return out;
}

/** The organisation's current plan and features, or null when it has none. */
export async function getOrgPlan(db: Client, orgId: string): Promise<OrgPlan | null> {
  const res = await db.execute({
    sql: `SELECT p.code AS code, p.name AS name, s.status AS status,
                 s.trial_ends_at AS trial_ends_at, p.features_json AS features
            FROM subscriptions s
            JOIN plans p ON p.id = s.plan_id
           WHERE s.org_id = ? AND s.status IN ('TRIALING', 'ACTIVE', 'PAST_DUE')
        ORDER BY s.updated_at DESC LIMIT 1`,
    args: [orgId],
  });
  const row = res.rows[0];
  if (!row) return null;
  return {
    planCode: String(row.code),
    planName: String(row.name),
    status: String(row.status),
    trialEndsAt: row.trial_ends_at == null ? null : String(row.trial_ends_at),
    features: parseFeatures(row.features),
  };
}

export async function orgFeatures(db: Client, orgId: string): Promise<Features> {
  const plan = await getOrgPlan(db, orgId);
  return plan?.features ?? allOff();
}

export async function hasFeature(db: Client, orgId: string, key: FeatureKey): Promise<boolean> {
  const features = await orgFeatures(db, orgId);
  return features[key];
}

export interface PlanRow {
  code: string;
  name: string;
  description: string | null;
  priceMonthlyMinor: number;
  currency: string;
  features: Features;
}

/** The active plans, in display order, for the upgrade page. */
export async function listPlans(db: Client): Promise<PlanRow[]> {
  const res = await db.execute({
    sql: `SELECT code, name, description, price_monthly_minor, currency, features_json
            FROM plans WHERE is_active = 1 ORDER BY sort_order`,
    args: [],
  });
  return res.rows.map((r) => ({
    code: String(r.code),
    name: String(r.name),
    description: r.description == null ? null : String(r.description),
    priceMonthlyMinor: Number(r.price_monthly_minor ?? 0),
    currency: String(r.currency),
    features: parseFeatures(r.features_json),
  }));
}

/** Whole days left in a trial, or null when the plan is not a live trial. */
export function trialDaysLeft(plan: OrgPlan | null, now: Date): number | null {
  if (!plan || plan.status !== 'TRIALING' || !plan.trialEndsAt) return null;
  const end = new Date(plan.trialEndsAt).getTime();
  if (Number.isNaN(end)) return null;
  return Math.max(0, Math.ceil((end - now.getTime()) / 86400000));
}
