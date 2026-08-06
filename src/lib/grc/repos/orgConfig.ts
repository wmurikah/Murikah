/**
 * General organisation settings held as scalar values in the `config` table,
 * keyed by organization_id (the typed schema layer names the column). These are
 * the workflow and notification defaults a SUPER_ADMIN edits on the Settings
 * page: the auditee response deadline and rounds, the reminder cadence, and the
 * notification sender and reply-to. The control-field vocabularies live
 * separately (dropdowns.ts); the AI defaults live under the GLOBAL sentinel
 * (ai/config.ts).
 */
import type { Client } from '@libsql/client/web';
import { C, cols } from '@grc/schema/columns';

const cfg = cols(C.config);

export type SettingKind = 'number' | 'text' | 'email';

export interface SettingField {
  key: string;
  label: string;
  kind: SettingKind;
  hint?: string;
}

/** The editable general settings, in display order. Keys are the config_key values. */
export const SETTINGS_FIELDS: SettingField[] = [
  {
    key: 'RESPONSE_DEADLINE_DAYS',
    label: 'Auditee response deadline (days)',
    kind: 'number',
    hint: 'How long an auditee has to respond once a finding is sent.',
  },
  {
    key: 'MAX_RESPONSE_ROUNDS',
    label: 'Maximum response rounds',
    kind: 'number',
    hint: 'How many times a response can go back and forth before escalation.',
  },
  {
    key: 'STALE_REMINDER_DAYS',
    label: 'Stale draft reminder (days)',
    kind: 'number',
    hint: 'A draft work paper older than this reminds its assigned auditor.',
  },
  {
    key: 'OVERDUE_REMINDER_DAY',
    label: 'Weekly overdue reminder day',
    kind: 'text',
    hint: 'The weekday the overdue action-plan reminder runs, e.g. Monday.',
  },
  {
    key: 'MFA_AUTHENTICATOR_ROLES',
    label: 'Roles allowed an authenticator app',
    kind: 'text',
    hint: 'Two-step verification itself is universal (email codes). SUPER_ADMIN when blank; ALL for every role; NONE for email codes only; or a comma-separated list of role codes. The platform owner always qualifies.',
  },
  {
    key: 'NOTIFY_SENDER_EMAIL',
    label: 'Notification sender email',
    kind: 'email',
  },
  {
    key: 'NOTIFY_REPLY_TO',
    label: 'Notification reply-to email',
    kind: 'email',
  },
];

export const SETTINGS_KEYS: string[] = SETTINGS_FIELDS.map((f) => f.key);

/** Read the given config keys for an organisation into a map (missing keys absent). */
export async function getConfigValues(
  db: Client,
  organizationId: string,
  keys: string[],
): Promise<Map<string, string>> {
  if (keys.length === 0) return new Map();
  const placeholders = keys.map(() => '?').join(', ');
  const res = await db.execute({
    sql: `SELECT ${cfg.config_key} AS k, ${cfg.config_value} AS v FROM config
           WHERE ${cfg.organization_id} = ? AND ${cfg.config_key} IN (${placeholders})`,
    args: [organizationId, ...keys],
  });
  return new Map(res.rows.map((r) => [String(r.k), r.v == null ? '' : String(r.v)]));
}

/** Upsert one config value for an organisation. */
export async function setConfigValue(
  db: Client,
  organizationId: string,
  key: string,
  value: string,
): Promise<void> {
  const now = new Date().toISOString();
  const upd = await db.execute({
    sql: `UPDATE config SET ${cfg.config_value} = ?, ${cfg.updated_at} = ?
           WHERE ${cfg.organization_id} = ? AND ${cfg.config_key} = ?`,
    args: [value, now, organizationId, key],
  });
  if ((upd.rowsAffected ?? 0) === 0) {
    await db.execute({
      sql: `INSERT INTO config (${cfg.organization_id}, ${cfg.config_key}, ${cfg.config_value}, ${cfg.updated_at})
             VALUES (?, ?, ?, ?)`,
      args: [organizationId, key, value, now],
    });
  }
}

/**
 * Platform-wide config rows hang off the fixed GLOBAL organization_id sentinel
 * (the same convention as the AI settings in ai/config.ts), because the live
 * config table has no scope column and these values belong to the platform,
 * not a tenant.
 */
export const GLOBAL_CONFIG_ORG = 'GLOBAL';

/** Read one platform-wide config value, or null when absent. */
export async function getGlobalConfigValue(db: Client, key: string): Promise<string | null> {
  const values = await getConfigValues(db, GLOBAL_CONFIG_ORG, [key]);
  const v = values.get(key);
  return v === undefined ? null : v;
}

/**
 * Create the inactive GLOBAL sentinel organisation row, for a schema that
 * enforces the config.organization_id foreign key. Inactive (is_active 0), so
 * it never appears in organisation lists or the switcher.
 */
async function ensureGlobalSentinel(db: Client): Promise<void> {
  const org = cols(C.organizations);
  const existing = await db.execute({
    sql: `SELECT ${org.organization_id} FROM organizations WHERE ${org.organization_id} = ? LIMIT 1`,
    args: [GLOBAL_CONFIG_ORG],
  });
  if (existing.rows.length > 0) return;
  await db.execute({
    sql: `INSERT INTO organizations
            (${org.organization_id}, ${org.org_code}, ${org.org_name}, ${org.is_active}, ${org.created_at})
          VALUES (?, ?, ?, 0, ?)`,
    args: [
      GLOBAL_CONFIG_ORG,
      GLOBAL_CONFIG_ORG,
      'Platform (global configuration)',
      new Date().toISOString(),
    ],
  });
}

/**
 * Upsert one platform-wide config value. When the first write is refused (a
 * foreign key on config.organization_id with no sentinel row yet) it creates
 * the sentinel and retries once, mirroring the AI config self-heal.
 */
export async function setGlobalConfigValue(db: Client, key: string, value: string): Promise<void> {
  try {
    await setConfigValue(db, GLOBAL_CONFIG_ORG, key, value);
  } catch (err) {
    console.error('[grc.config] global write refused, creating the GLOBAL sentinel', err);
    await ensureGlobalSentinel(db);
    await setConfigValue(db, GLOBAL_CONFIG_ORG, key, value);
  }
}
