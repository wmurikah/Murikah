import type { MigrationDatabase } from './migrations/types.ts';

export const DOMAIN_TABLES = [
  'plans',
  'permissions',
  'organisations',
  'subscriptions',
  'subscription_invoices',
  'roles',
  'role_permissions',
  'users',
  'user_roles',
  'regions',
  'stations',
  'asset_categories',
  'assets',
  'engineer_assignments',
  'contractors',
  'contractor_categories',
  'contractor_stations',
  'technicians',
  'slas',
  'rate_cards',
  'rate_items',
  'service_requests',
  'rfqs',
  'rfq_invitations',
  'quotes',
  'quote_items',
  'pm_checklist_templates',
  'pm_checklist_items',
  'pm_schedules',
  'pm_occurrences',
  'lpos',
  'work_orders',
  'job_safety_analyses',
  'site_arrivals',
  'job_cards',
  'job_card_spares',
  'pm_checklist_results',
  'mileage_claims',
  'work_costs',
  'work_cost_items',
  'cost_approvals',
  'bills',
  'bill_costs',
  'bill_approvals',
  'payments',
  'attachments',
  'notifications',
  'audit_logs',
  'org_settings',
  'lpo_lines',
  'auth_tokens',
  'user_mfa',
  'mfa_recovery_codes',
  'auth_sessions',
  'auth_login_limits',
  'auth_login_events',
  'supplier_invoices',
  'asset_movements',
] as const;

export const REQUIRED_COLUMNS: Record<string, string[]> = {
  bills: ['invoice_required'],
  supplier_invoices: [
    'id',
    'org_id',
    'contractor_id',
    'bill_id',
    'invoice_no',
    'issue_date',
    'due_date',
    'amount_minor',
    'currency',
    'original_pdf',
  ],
  asset_movements: [
    'id',
    'org_id',
    'asset_id',
    'from_station_id',
    'from_region_id',
    'to_station_id',
    'to_region_id',
    'moved_at',
  ],
  organisations: ['parent_org_id'],
  regions: ['currency'],
  users: ['is_platform_owner', 'session_version'],
  lpos: [
    'region_id',
    'notes',
    'submitted_at',
    'submitted_by',
    'subtotal_minor',
    'mileage_minor',
    'approved_by',
    'approved_at',
    'issued_by',
    'issued_at',
    'sealed_hash',
    'sealed_at',
    'version',
    'supersedes_id',
    'superseded_by_id',
    'cancelled_at',
    'cancel_reason',
  ],
  lpo_lines: [
    'id',
    'org_id',
    'lpo_id',
    'work_order_id',
    'wo_no',
    'station_id',
    'station_name',
    'asset_id',
    'asset_tag',
    'category_id',
    'category_name',
    'sla_id',
    'sla_name',
    'description',
    'amount_minor',
    'currency',
    'created_at',
  ],
  rfqs: ['submitted_at', 'submitted_by', 'released_at', 'released_by'],
  pm_schedules: ['created_by', 'activated_by', 'activated_at'],
  auth_tokens: ['id', 'org_id', 'user_id', 'purpose', 'token_hash', 'expires_at', 'used_at'],
  user_mfa: [
    'user_id',
    'secret_ciphertext',
    'secret_iv',
    'pending_expires_at',
    'enabled_at',
    'last_totp_step',
  ],
  mfa_recovery_codes: ['id', 'user_id', 'code_hash', 'used_at'],
  auth_sessions: [
    'id',
    'user_id',
    'org_id',
    'session_version',
    'privilege_level',
    'ip_hash',
    'user_agent',
    'created_at',
    'last_seen_at',
    'expires_at',
    'revoked_at',
    'revoked_reason',
  ],
  auth_login_limits: [
    'scope',
    'key_hash',
    'failure_count',
    'blocked_until',
    'first_failure_at',
    'last_failure_at',
  ],
  auth_login_events: [
    'id',
    'account_hash',
    'ip_hash',
    'org_id',
    'user_id',
    'outcome',
    'created_at',
  ],
};

interface ColumnShape {
  type: string;
  notNull: boolean;
  defaultValue: string | null;
}

const REQUIRED_COLUMN_SHAPES: Record<string, Record<string, ColumnShape>> = {
  organisations: {
    parent_org_id: { type: 'TEXT', notNull: false, defaultValue: null },
  },
  regions: {
    currency: { type: 'TEXT', notNull: true, defaultValue: "'KES'" },
  },
  users: {
    is_platform_owner: { type: 'INTEGER', notNull: true, defaultValue: '0' },
    session_version: { type: 'INTEGER', notNull: true, defaultValue: '0' },
  },
  lpos: {
    region_id: { type: 'TEXT', notNull: false, defaultValue: null },
    notes: { type: 'TEXT', notNull: false, defaultValue: null },
    subtotal_minor: { type: 'INTEGER', notNull: true, defaultValue: '0' },
    mileage_minor: { type: 'INTEGER', notNull: true, defaultValue: '0' },
    approved_by: { type: 'TEXT', notNull: false, defaultValue: null },
    approved_at: { type: 'TEXT', notNull: false, defaultValue: null },
    issued_by: { type: 'TEXT', notNull: false, defaultValue: null },
    issued_at: { type: 'TEXT', notNull: false, defaultValue: null },
    sealed_hash: { type: 'TEXT', notNull: false, defaultValue: null },
    sealed_at: { type: 'TEXT', notNull: false, defaultValue: null },
    version: { type: 'INTEGER', notNull: true, defaultValue: '1' },
    supersedes_id: { type: 'TEXT', notNull: false, defaultValue: null },
    superseded_by_id: { type: 'TEXT', notNull: false, defaultValue: null },
    cancelled_at: { type: 'TEXT', notNull: false, defaultValue: null },
    cancel_reason: { type: 'TEXT', notNull: false, defaultValue: null },
  },
  lpo_lines: {
    amount_minor: { type: 'INTEGER', notNull: true, defaultValue: '0' },
    currency: { type: 'TEXT', notNull: true, defaultValue: "'KES'" },
  },
};

export const REQUIRED_INDEXES = [
  'ix_lpo_lines_lpo',
  'ix_lpos_region',
  'ix_org_parent',
  'ux_roles_system',
  'ux_users_email',
  'ix_auth_tokens_user_purpose',
  'ix_mfa_recovery_user',
  'ix_auth_sessions_user_active',
  'ix_auth_login_events_account',
  'ix_auth_login_events_ip',
  'ux_contractors_portal_user',
  'ux_technicians_portal_user',
  'ux_engineer_assignments_station',
  'ux_engineer_assignments_category',
  'ix_notifications_queue_created',
  'ix_notifications_unread',
  'ix_requests_org_created_active',
  'ix_pm_occ_org_due',
] as const;

const INDEX_CONTRACTS = [
  {
    table: 'notifications',
    name: 'ix_notifications_queue_created',
    unique: false,
    partial: true,
    columns: ['created_at'],
  },
  {
    table: 'notifications',
    name: 'ix_notifications_unread',
    unique: false,
    partial: false,
    columns: ['org_id', 'channel', 'status', 'recipient_user_id'],
  },
  {
    table: 'service_requests',
    name: 'ix_requests_org_created_active',
    unique: false,
    partial: true,
    columns: ['org_id', 'created_at'],
  },
  {
    table: 'pm_occurrences',
    name: 'ix_pm_occ_org_due',
    unique: false,
    partial: false,
    columns: ['org_id', 'due_date'],
  },
  {
    table: 'lpo_lines',
    name: 'ix_lpo_lines_lpo',
    unique: false,
    partial: false,
    columns: ['lpo_id'],
  },
  {
    table: 'auth_sessions',
    name: 'ix_auth_sessions_user_active',
    unique: false,
    partial: false,
    columns: ['user_id', 'revoked_at', 'expires_at'],
  },
  {
    table: 'auth_login_events',
    name: 'ix_auth_login_events_account',
    unique: false,
    partial: false,
    columns: ['account_hash', 'created_at'],
  },
  {
    table: 'auth_login_events',
    name: 'ix_auth_login_events_ip',
    unique: false,
    partial: false,
    columns: ['ip_hash', 'created_at'],
  },
  { table: 'lpos', name: 'ix_lpos_region', unique: false, partial: false, columns: ['region_id'] },
  {
    table: 'organisations',
    name: 'ix_org_parent',
    unique: false,
    partial: false,
    columns: ['parent_org_id'],
  },
  { table: 'roles', name: 'ux_roles_system', unique: true, partial: true, columns: ['code'] },
  { table: 'users', name: 'ux_users_email', unique: true, partial: false, columns: ['email'] },
  {
    table: 'auth_tokens',
    name: 'ix_auth_tokens_user_purpose',
    unique: false,
    partial: false,
    columns: ['user_id', 'purpose', 'used_at'],
  },
  {
    table: 'mfa_recovery_codes',
    name: 'ix_mfa_recovery_user',
    unique: false,
    partial: false,
    columns: ['user_id', 'used_at'],
  },
  {
    table: 'contractors',
    name: 'ux_contractors_portal_user',
    unique: true,
    partial: true,
    columns: ['portal_user_id'],
  },
  {
    table: 'technicians',
    name: 'ux_technicians_portal_user',
    unique: true,
    partial: true,
    columns: ['portal_user_id'],
  },
  {
    table: 'engineer_assignments',
    name: 'ux_engineer_assignments_station',
    unique: true,
    partial: true,
    columns: ['org_id', 'station_id'],
  },
  {
    table: 'engineer_assignments',
    name: 'ux_engineer_assignments_category',
    unique: true,
    partial: true,
    columns: ['org_id', 'category_id'],
  },
] as const;

const FOREIGN_KEY_CONTRACTS = [
  { table: 'organisations', from: 'parent_org_id', target: 'organisations' },
  { table: 'lpos', from: 'region_id', target: 'regions' },
  { table: 'lpos', from: 'approved_by', target: 'users' },
  { table: 'lpos', from: 'issued_by', target: 'users' },
  { table: 'lpos', from: 'supersedes_id', target: 'lpos' },
  { table: 'lpos', from: 'superseded_by_id', target: 'lpos' },
  { table: 'lpo_lines', from: 'org_id', target: 'organisations' },
  { table: 'lpo_lines', from: 'lpo_id', target: 'lpos' },
  { table: 'lpo_lines', from: 'work_order_id', target: 'work_orders' },
  { table: 'lpo_lines', from: 'station_id', target: 'stations' },
  { table: 'lpo_lines', from: 'asset_id', target: 'assets' },
  { table: 'lpo_lines', from: 'category_id', target: 'asset_categories' },
  { table: 'lpo_lines', from: 'sla_id', target: 'slas' },
  { table: 'auth_tokens', from: 'org_id', target: 'organisations' },
  { table: 'auth_tokens', from: 'user_id', target: 'users' },
  { table: 'user_mfa', from: 'user_id', target: 'users' },
  { table: 'mfa_recovery_codes', from: 'user_id', target: 'users' },
  { table: 'auth_sessions', from: 'user_id', target: 'users' },
  { table: 'auth_sessions', from: 'org_id', target: 'organisations' },
  { table: 'auth_login_events', from: 'org_id', target: 'organisations' },
  { table: 'auth_login_events', from: 'user_id', target: 'users' },
] as const;

export const REQUIRED_VIEWS = [
  'v_open_work_orders',
  'v_pending_cost_approvals',
  'v_pending_bill_approvals',
  'v_upcoming_pm',
] as const;

export const REQUIRED_TRIGGERS = [
  'trg_organisations_updated',
  'trg_subscriptions_updated',
  'trg_users_updated',
  'trg_stations_updated',
  'trg_assets_updated',
  'trg_requests_updated',
  'trg_rfqs_updated',
  'trg_quotes_updated',
  'trg_pm_schedules_updated',
  'trg_work_orders_updated',
  'trg_work_costs_updated',
  'trg_bills_updated',
  'trg_users_security_revoke',
  'trg_organisations_security_revoke',
  'trg_user_roles_security_insert',
  'trg_user_roles_security_delete',
  'trg_role_permissions_security_insert',
  'trg_role_permissions_security_delete',
] as const;

async function objectNames(db: MigrationDatabase, type: string): Promise<Set<string>> {
  const result = await db.execute({
    sql: `SELECT name FROM sqlite_schema WHERE type = ? AND name NOT LIKE 'sqlite_%'`,
    args: [type],
  });
  return new Set(result.rows.map((row) => String(row.name)));
}

export async function verifySchemaContract(db: MigrationDatabase): Promise<void> {
  const tables = await objectNames(db, 'table');
  const indexes = await objectNames(db, 'index');
  const views = await objectNames(db, 'view');
  const triggers = await objectNames(db, 'trigger');

  const missing: string[] = [];
  for (const table of DOMAIN_TABLES) if (!tables.has(table)) missing.push(`table:${table}`);
  for (const index of REQUIRED_INDEXES) if (!indexes.has(index)) missing.push(`index:${index}`);
  for (const view of REQUIRED_VIEWS) if (!views.has(view)) missing.push(`view:${view}`);
  for (const trigger of REQUIRED_TRIGGERS)
    if (!triggers.has(trigger)) missing.push(`trigger:${trigger}`);

  for (const [table, required] of Object.entries(REQUIRED_COLUMNS)) {
    if (!tables.has(table)) continue;
    const result = await db.execute(`PRAGMA table_info(${table})`);
    const columns = new Set(result.rows.map((row) => String(row.name)));
    for (const column of required) {
      if (!columns.has(column)) missing.push(`column:${table}.${column}`);
    }
  }

  for (const [table, shapes] of Object.entries(REQUIRED_COLUMN_SHAPES)) {
    if (!tables.has(table)) continue;
    const result = await db.execute(`PRAGMA table_info(${table})`);
    const byName = new Map(result.rows.map((row) => [String(row.name), row]));
    for (const [column, expected] of Object.entries(shapes)) {
      const actual = byName.get(column);
      if (!actual) continue;
      const actualDefault = actual.dflt_value === null ? null : String(actual.dflt_value);
      if (
        String(actual.type).toUpperCase() !== expected.type ||
        (Number(actual.notnull) === 1) !== expected.notNull ||
        actualDefault !== expected.defaultValue
      ) {
        missing.push(`shape:${table}.${column}`);
      }
    }
  }

  for (const expected of INDEX_CONTRACTS) {
    const list = await db.execute(`PRAGMA index_list(${expected.table})`);
    const actual = list.rows.find((row) => row.name === expected.name);
    if (!actual) continue;
    const info = await db.execute(`PRAGMA index_info(${expected.name})`);
    const columns = info.rows.map((row) => String(row.name));
    if (
      (Number(actual.unique) === 1) !== expected.unique ||
      (Number(actual.partial) === 1) !== expected.partial ||
      columns.join(',') !== expected.columns.join(',')
    ) {
      missing.push(`shape:index:${expected.name}`);
    }
  }

  for (const expected of FOREIGN_KEY_CONTRACTS) {
    const result = await db.execute(`PRAGMA foreign_key_list(${expected.table})`);
    const found = result.rows.some(
      (row) =>
        row.from === expected.from && row.table === expected.target && String(row.to) === 'id',
    );
    if (!found) missing.push(`foreign-key:${expected.table}.${expected.from}`);
  }

  if (missing.length) {
    throw new Error(`Engineering schema contract is incomplete: ${missing.join(', ')}`);
  }
}
