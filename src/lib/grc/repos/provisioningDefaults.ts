/**
 * The pure provisioning core (no imports, so node strips types and unit-tests it
 * directly): the Phase 1 config defaults, the trial constants, and the statement
 * builder. The dropdown seed values are injected by the caller (provisioning.ts),
 * so the defaults still live in one place (dropdowns.ts) without this module
 * importing it.
 */

/** The Phase 1 per-organisation config defaults (response, reminders, windows, sender, AI). */
export const PHASE1_CONFIG_DEFAULTS: Record<string, string> = {
  RESPONSE_DEADLINE_DAYS: '14',
  MAX_RESPONSE_ROUNDS: '3',
  STALE_REMINDER_DAYS: '3',
  OVERDUE_REMINDER_DAY: 'MONDAY',
  NOTIFICATION_WINDOW_START: '08:00',
  NOTIFICATION_WINDOW_END: '18:00',
  SENDER_EMAIL: 'audit@hasspetroleum.com',
  REPLY_TO_EMAIL: 'audit@hasspetroleum.com',
  AI_ACTIVE_PROVIDER: 'openai',
  AI_MODEL: 'gpt-4o-mini',
  AI_MAX_TOKENS: '1500',
  AI_TEMPERATURE: '0.3',
  AI_EVALUATION_ENABLED: 'false',
  AI_REJECTION_THRESHOLD: '50',
};

export const TRIAL_PLAN_CODE = 'trial';
export const TRIAL_STATUS = 'trialing';

export interface ProvisionInput {
  organizationName: string;
  adminEmail: string;
  adminName: string;
  /** A PBKDF2 hash from auth/password.ts hashPassword; the plain password is never stored. */
  adminPasswordHash: string;
  /** The provisioning instant, passed in so the statements are deterministic. */
  now: Date;
}

export interface ProvisionIds {
  organizationId: string;
  adminUserId: string;
}

export interface Statement {
  sql: string;
  args: (string | number)[];
}

/** A short organisation code from the name, suffixed with the id so it cannot collide. */
export function deriveOrgCode(organizationName: string, organizationId: string): string {
  const slug =
    organizationName
      .replace(/[^A-Za-z0-9]/g, '')
      .toUpperCase()
      .slice(0, 8) || 'ORG';
  return `${slug}-${organizationId
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, 4)
    .toUpperCase()}`;
}

/**
 * The full set of insert statements to provision an organisation: the org, a
 * first SUPER_ADMIN, a trial subscription, the Phase 1 config, and the injected
 * reference dropdowns. Pure, so it is unit-tested without a database.
 */
export function buildProvisioningStatements(
  ids: ProvisionIds,
  input: ProvisionInput,
  dropdownEntries: [string, string][],
): Statement[] {
  const now = input.now.toISOString();
  const statements: Statement[] = [
    {
      // The live organizations shape: org_code and org_name (there is no
      // `name` or `status` column), an is_active flag, and the house country
      // and timezone defaults. The earlier column list failed every
      // provisioning batch silently behind the endpoint's catch.
      sql: `INSERT INTO organizations
              (organization_id, org_code, org_name, country, timezone, is_active, created_at)
            VALUES (?, ?, ?, 'KE', 'Africa/Nairobi', 1, ?)`,
      args: [
        ids.organizationId,
        deriveOrgCode(input.organizationName, ids.organizationId),
        input.organizationName,
        now,
      ],
    },
    {
      sql: `INSERT INTO users
              (user_id, organization_id, email, full_name, password_hash, role_code,
               is_platform_owner, status, created_at)
            VALUES (?, ?, ?, ?, ?, 'SUPER_ADMIN', 0, 'ACTIVE', ?)`,
      args: [
        ids.adminUserId,
        ids.organizationId,
        input.adminEmail,
        input.adminName,
        input.adminPasswordHash,
        now,
      ],
    },
    {
      // The live subscriptions shape keys rows by subscription_id; derive it
      // from the organisation id so the builder stays deterministic and pure.
      sql: `INSERT INTO subscriptions (subscription_id, organization_id, plan_code, status, created_at)
            VALUES (?, ?, ?, ?, ?)`,
      args: [`SUB-${ids.organizationId}`, ids.organizationId, TRIAL_PLAN_CODE, TRIAL_STATUS, now],
    },
  ];
  const config: [string, string][] = [
    ...Object.entries(PHASE1_CONFIG_DEFAULTS),
    ...dropdownEntries,
  ];
  for (const [key, value] of config) {
    statements.push({
      // The live config table scopes by organization_id (there is no `scope`).
      sql: `INSERT INTO config (organization_id, config_key, config_value, updated_at) VALUES (?, ?, ?, ?)`,
      args: [ids.organizationId, key, value, now],
    });
  }
  return statements;
}
