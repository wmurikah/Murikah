import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Migration, MigrationDatabase } from './types.ts';

/** Reviewed RBAC contract. Keep in sync with seed.sql and Turso Web scripts. */
export const RBAC_PERMISSIONS = [
  ['org.view', 'org', 'View organisation profile'],
  ['org.manage', 'org', 'Manage organisation profile and subscription'],
  ['users.view', 'users', 'View users'],
  ['users.invite', 'users', 'Invite a user'],
  ['users.update', 'users', 'Update a user profile'],
  ['users.suspend', 'users', 'Suspend or reactivate a user'],
  ['users.reset_password', 'users', 'Reset a user password'],
  ['users.assign_roles', 'users', 'Assign approved roles to users'],
  ['roles.view', 'roles', 'View roles'],
  ['roles.manage', 'roles', 'Create and manage role definitions'],
  ['stations.view', 'stations', 'View stations'],
  ['stations.manage', 'stations', 'Create and manage stations'],
  ['assets.view', 'assets', 'View assets'],
  ['assets.manage', 'assets', 'Create and manage assets'],
  ['contractors.view', 'contractors', 'View contractors'],
  ['contractors.manage', 'contractors', 'Create and manage contractors'],
  ['technicians.view', 'technicians', 'View technicians'],
  ['technicians.manage', 'technicians', 'Create and manage contractor technicians'],
  ['engineer_assignments.view', 'engineer_assignments', 'View engineer routing assignments'],
  ['engineer_assignments.manage', 'engineer_assignments', 'Manage engineer routing assignments'],
  ['slas.view', 'slas', 'View SLAs'],
  ['slas.manage', 'slas', 'Create and manage SLAs'],
  ['rates.view', 'rates', 'View rate cards'],
  ['rates.manage', 'rates', 'Create and manage rate cards'],
  ['requests.view', 'requests', 'View service requests'],
  ['requests.create', 'requests', 'Create a service request'],
  ['requests.accept', 'requests', 'Accept a service request'],
  ['requests.reject', 'requests', 'Reject a service request'],
  ['rfq.view', 'rfq', 'View RFQs'],
  ['rfq.create', 'rfq', 'Create an RFQ'],
  ['rfq.edit', 'rfq', 'Edit a draft RFQ'],
  ['rfq.submit', 'rfq', 'Submit an RFQ for release'],
  ['rfq.release', 'rfq', 'Release an RFQ to invited contractors'],
  ['rfq.award', 'rfq', 'Award an RFQ'],
  ['quotes.view', 'quotes', 'View quotes'],
  ['quotes.submit', 'quotes', 'Submit a quote against an RFQ'],
  ['quotes.select', 'quotes', 'Select the winning quote'],
  ['pm.view', 'pm', 'View preventive maintenance schedules'],
  ['pm.create', 'pm', 'Create a preventive maintenance schedule'],
  ['pm.edit', 'pm', 'Edit a draft preventive maintenance schedule'],
  ['pm.activate', 'pm', 'Activate or pause a preventive maintenance schedule'],
  ['pm.allocate', 'pm', 'Allocate a contractor to a maintenance occurrence'],
  ['pm.archive', 'pm', 'Archive a preventive maintenance schedule'],
  ['lpo.view', 'lpo', 'View LPOs'],
  ['lpo.create', 'lpo', 'Create an LPO draft'],
  ['lpo.edit', 'lpo', 'Edit an LPO draft'],
  ['lpo.submit', 'lpo', 'Submit an LPO for approval'],
  ['lpo.approve', 'lpo', 'Approve or reject an LPO'],
  ['lpo.issue', 'lpo', 'Issue an approved LPO'],
  ['lpo.cancel', 'lpo', 'Cancel or supersede an LPO'],
  ['lpo.close', 'lpo', 'Close an LPO'],
  ['workorder.view', 'workorder', 'View work orders'],
  ['workorder.create', 'workorder', 'Create a work order'],
  ['workorder.assign', 'workorder', 'Assign a contractor to a work order'],
  ['workorder.assign_technician', 'workorder', 'Assign a contractor technician'],
  ['workorder.accept', 'workorder', 'Accept or reject assigned work'],
  ['workorder.execute', 'workorder', 'Start and execute assigned work'],
  ['workorder.close', 'workorder', 'Close a work order'],
  ['workorder.cancel', 'workorder', 'Cancel a work order'],
  ['jsa.view', 'jsa', 'View job safety analyses'],
  ['jsa.submit', 'jsa', 'Submit a job safety analysis'],
  ['arrival.confirm', 'arrival', 'Confirm technician arrival on site'],
  ['jobcard.view', 'jobcard', 'View job cards'],
  ['jobcard.create', 'jobcard', 'Create and fill a job card'],
  ['jobcard.submit', 'jobcard', 'Request closure confirmation'],
  ['jobcard.confirm', 'jobcard', 'Confirm resolution or reopen work'],
  ['cost.view', 'cost', 'View work costs'],
  ['cost.create', 'cost', 'Create and cost completed work'],
  ['cost.submit', 'cost', 'Submit a cost for approval'],
  ['cost.approve', 'cost', 'Approve or reject a submitted cost'],
  ['bill.view', 'bill', 'View bills'],
  ['bill.create', 'bill', 'Create a bill from approved costs'],
  ['bill.submit', 'bill', 'Submit a bill for approval'],
  ['bill.approve.engineering', 'bill', 'Approve or reject a bill for Engineering'],
  ['bill.approve.finance', 'bill', 'Approve or reject a bill for Finance'],
  ['payment.view', 'payment', 'View payments'],
  ['payment.record', 'payment', 'Record a payment against a bill'],
  ['payment.reverse', 'payment', 'Reverse an incorrectly recorded payment'],
  ['notifications.monitor', 'notifications', 'Monitor organisation notification delivery'],
  ['notifications.retry', 'notifications', 'Retry a failed organisation notification'],
  ['notifications.configure', 'notifications', 'Configure organisation notification delivery'],
  ['reports.view', 'reports', 'View reports and dashboards'],
  ['reports.export', 'reports', 'Export organisation reports'],
  ['audit.view', 'audit', 'View organisation audit history'],
] as const;

export const STANDARD_ROLES = [
  ['OWNER', 'Owner', 'Full control of the organisation account'],
  ['ADMIN', 'Administrator', 'Full operational and administrative access'],
  [
    'ENGINEERING_MANAGER',
    'Engineering Manager',
    'Organisation operations, setup, routing and engineering approvals',
  ],
  ['ENGINEER', 'Engineer', 'Create and populate engineering records without approval rights'],
  ['STATION_MANAGER', 'Station Manager', 'Raise station requests and confirm arrival and closure'],
  [
    'FINANCIAL_CONTROLLER',
    'Financial Controller',
    'Finance approval, payment recording and financial reporting',
  ],
  ['CONTRACTOR', 'Contractor', 'Quote, accept work, manage technicians, cost and bill'],
  ['TECHNICIAN', 'Technician', 'Execute assigned work, submit JSA and job cards'],
  ['VIEWER', 'Viewer', 'Read-only operational access'],
] as const;

const manager =
  `org.view users.view users.invite users.update users.suspend users.reset_password users.assign_roles roles.view stations.view stations.manage assets.view assets.manage contractors.view contractors.manage technicians.view technicians.manage engineer_assignments.view engineer_assignments.manage slas.view slas.manage rates.view rates.manage requests.view requests.create requests.accept requests.reject rfq.view rfq.create rfq.edit rfq.submit rfq.release rfq.award quotes.view quotes.select pm.view pm.create pm.edit pm.activate pm.allocate pm.archive lpo.view lpo.create lpo.edit lpo.submit lpo.approve lpo.issue lpo.cancel lpo.close workorder.view workorder.create workorder.assign workorder.cancel jsa.view jobcard.view cost.view cost.approve bill.view bill.approve.engineering payment.view notifications.monitor notifications.retry notifications.configure reports.view reports.export audit.view`.split(
    ' ',
  );
const engineer =
  `org.view stations.view assets.view contractors.view technicians.view engineer_assignments.view slas.view rates.view requests.view requests.create rfq.view rfq.create rfq.edit rfq.submit quotes.view pm.view pm.create pm.edit lpo.view lpo.create lpo.edit lpo.submit workorder.view workorder.create jsa.view jobcard.view reports.view`.split(
    ' ',
  );
const stationManager =
  `org.view requests.view requests.create workorder.view arrival.confirm jobcard.view jobcard.confirm`.split(
    ' ',
  );
const finance =
  `org.view contractors.view rates.view cost.view bill.view bill.approve.finance payment.view payment.record payment.reverse reports.view reports.export audit.view`.split(
    ' ',
  );
const contractor =
  `org.view technicians.view technicians.manage quotes.view quotes.submit lpo.view workorder.view workorder.accept workorder.assign_technician jsa.view jobcard.view cost.view cost.create cost.submit bill.view bill.create bill.submit`.split(
    ' ',
  );
const technician =
  `workorder.view workorder.execute jsa.view jsa.submit jobcard.view jobcard.create jobcard.submit`.split(
    ' ',
  );
const viewer =
  `org.view stations.view assets.view slas.view requests.view pm.view workorder.view jsa.view jobcard.view reports.view`.split(
    ' ',
  );

export const STANDARD_ROLE_GRANTS: Readonly<Record<string, readonly string[] | 'ALL'>> = {
  OWNER: 'ALL',
  ADMIN: 'ALL',
  ENGINEERING_MANAGER: manager,
  ENGINEER: engineer,
  STATION_MANAGER: stationManager,
  FINANCIAL_CONTROLLER: finance,
  CONTRACTOR: contractor,
  TECHNICIAN: technician,
  VIEWER: viewer,
};

/** Keys from earlier prototypes that never represented an enforceable route or
 * were replaced by the reviewed two-stage approval permissions. Keeping them
 * would let a custom role appear to grant an action the application cannot do. */
export const RETIRED_PERMISSIONS = [
  'users.manage',
  'requests.edit',
  'requests.submit',
  'requests.route',
  'requests.cancel',
  'pm.manage',
  'workorder.edit',
  'workorder.reassign',
  'jsa.review',
  'cost.verify',
  'cost.approve.l1',
  'cost.approve.l2',
  'bill.verify',
  'bill.approve.l1',
  'bill.approve.l2',
  'bill.approve.l3',
  'attachments.upload',
  'attachments.manage',
  'settings.view',
  'settings.manage',
] as const;

async function applyRbac(db: MigrationDatabase): Promise<void> {
  const lpoColumns = await db.execute('PRAGMA table_info(lpos)');
  if (!lpoColumns.rows.some((row) => String(row.name) === 'submitted_at')) {
    await db.execute('ALTER TABLE lpos ADD COLUMN submitted_at TEXT');
  }
  if (!lpoColumns.rows.some((row) => String(row.name) === 'submitted_by')) {
    await db.execute(
      'ALTER TABLE lpos ADD COLUMN submitted_by TEXT REFERENCES users(id) ON DELETE SET NULL',
    );
  }

  const rfqColumns = await db.execute('PRAGMA table_info(rfqs)');
  if (!rfqColumns.rows.some((row) => String(row.name) === 'submitted_at')) {
    await db.execute('ALTER TABLE rfqs ADD COLUMN submitted_at TEXT');
  }
  if (!rfqColumns.rows.some((row) => String(row.name) === 'submitted_by')) {
    await db.execute(
      'ALTER TABLE rfqs ADD COLUMN submitted_by TEXT REFERENCES users(id) ON DELETE SET NULL',
    );
  }
  if (!rfqColumns.rows.some((row) => String(row.name) === 'released_at')) {
    await db.execute('ALTER TABLE rfqs ADD COLUMN released_at TEXT');
  }
  if (!rfqColumns.rows.some((row) => String(row.name) === 'released_by')) {
    await db.execute(
      'ALTER TABLE rfqs ADD COLUMN released_by TEXT REFERENCES users(id) ON DELETE SET NULL',
    );
  }

  const pmColumns = await db.execute('PRAGMA table_info(pm_schedules)');
  if (!pmColumns.rows.some((row) => String(row.name) === 'created_by')) {
    await db.execute(
      'ALTER TABLE pm_schedules ADD COLUMN created_by TEXT REFERENCES users(id) ON DELETE SET NULL',
    );
  }
  if (!pmColumns.rows.some((row) => String(row.name) === 'activated_by')) {
    await db.execute(
      'ALTER TABLE pm_schedules ADD COLUMN activated_by TEXT REFERENCES users(id) ON DELETE SET NULL',
    );
  }
  if (!pmColumns.rows.some((row) => String(row.name) === 'activated_at')) {
    await db.execute('ALTER TABLE pm_schedules ADD COLUMN activated_at TEXT');
  }

  // Before maker/checker, these records were immediately released or issued.
  // Preserve that meaning while supplying the new provenance fields.
  await db.execute(`UPDATE lpos
                       SET submitted_at = COALESCE(submitted_at, created_at),
                           submitted_by = COALESCE(submitted_by, created_by),
                           approved_at = COALESCE(approved_at, created_at),
                           approved_by = COALESCE(approved_by, created_by),
                           issued_at = COALESCE(issued_at, created_at),
                           issued_by = COALESCE(issued_by, created_by)`);
  await db.execute(`UPDATE rfqs
                       SET submitted_at = COALESCE(submitted_at, created_at),
                           submitted_by = COALESCE(submitted_by, created_by),
                           released_at = COALESCE(released_at, created_at),
                           released_by = COALESCE(released_by, created_by)`);
  await db.execute(`UPDATE pm_schedules AS schedule
                       SET created_by = COALESCE(
                         created_by,
                         (SELECT actor_user_id FROM audit_logs
                           WHERE org_id = schedule.org_id
                             AND entity_type = 'pm_schedule'
                             AND entity_id = schedule.id
                             AND action = 'pm.schedule.create'
                           ORDER BY created_at ASC LIMIT 1)
                       )`);
  await db.execute(`UPDATE pm_schedules
                       SET activated_at = COALESCE(activated_at, created_at),
                           activated_by = COALESCE(activated_by, created_by)
                     WHERE status = 'ACTIVE'`);

  const duplicateChecks = [
    {
      sql: `SELECT portal_user_id FROM contractors
             WHERE portal_user_id IS NOT NULL
             GROUP BY portal_user_id HAVING COUNT(*) > 1 LIMIT 1`,
      message: 'A portal user is linked to more than one contractor',
    },
    {
      sql: `SELECT portal_user_id FROM technicians
             WHERE portal_user_id IS NOT NULL
             GROUP BY portal_user_id HAVING COUNT(*) > 1 LIMIT 1`,
      message: 'A portal user is linked to more than one technician',
    },
    {
      sql: `SELECT org_id, station_id FROM engineer_assignments
             WHERE scope_type = 'STATION' AND station_id IS NOT NULL
             GROUP BY org_id, station_id HAVING COUNT(*) > 1 LIMIT 1`,
      message: 'A station has more than one engineer routing owner',
    },
    {
      sql: `SELECT org_id, category_id FROM engineer_assignments
             WHERE scope_type = 'CATEGORY' AND category_id IS NOT NULL
             GROUP BY org_id, category_id HAVING COUNT(*) > 1 LIMIT 1`,
      message: 'An asset category has more than one engineer routing owner',
    },
  ];
  for (const check of duplicateChecks) {
    if ((await db.execute(check.sql)).rows.length > 0) {
      throw new Error(`${check.message}; resolve the duplicate before applying migration 006`);
    }
  }

  await db.execute(
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_contractors_portal_user
       ON contractors(portal_user_id) WHERE portal_user_id IS NOT NULL`,
  );
  await db.execute(
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_technicians_portal_user
       ON technicians(portal_user_id) WHERE portal_user_id IS NOT NULL`,
  );
  await db.execute(
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_engineer_assignments_station
       ON engineer_assignments(org_id, station_id) WHERE scope_type = 'STATION'`,
  );
  await db.execute(
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_engineer_assignments_category
       ON engineer_assignments(org_id, category_id) WHERE scope_type = 'CATEGORY'`,
  );

  await db.execute({
    sql: `DELETE FROM permissions WHERE key IN (${RETIRED_PERMISSIONS.map(() => '?').join(',')})`,
    args: [...RETIRED_PERMISSIONS],
  });

  for (const [key, module, description] of RBAC_PERMISSIONS) {
    await db.execute({
      sql: `INSERT INTO permissions (key, module, description) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET module = excluded.module, description = excluded.description`,
      args: [key, module, description],
    });
  }
  for (const [code, name, description] of STANDARD_ROLES) {
    await db.execute({
      sql: `INSERT OR IGNORE INTO roles (org_id, code, name, description, is_system) VALUES (NULL, ?, ?, ?, 1)`,
      args: [code, name, description],
    });
    await db.execute({
      sql: `UPDATE roles SET description = ? WHERE code = ?`,
      args: [description, code],
    });
  }
  const codes = STANDARD_ROLES.map(([code]) => code);
  await db.execute({
    sql: `DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE code IN (${codes.map(() => '?').join(',')}))`,
    args: codes,
  });
  for (const [code, grants] of Object.entries(STANDARD_ROLE_GRANTS)) {
    if (grants === 'ALL') {
      await db.execute({
        sql: `INSERT OR IGNORE INTO role_permissions (role_id, permission_id) SELECT r.id, p.id FROM roles r CROSS JOIN permissions p WHERE r.code = ?`,
        args: [code],
      });
    } else {
      for (const permission of grants) {
        await db.execute({
          sql: `INSERT OR IGNORE INTO role_permissions (role_id, permission_id) SELECT r.id, p.id FROM roles r CROSS JOIN permissions p WHERE r.code = ? AND p.key = ?`,
          args: [code, permission],
        });
      }
    }
  }
}

export const comprehensiveRbac: Migration = {
  id: '006',
  description: 'Apply comprehensive organisation role and workflow permissions',
  checksum: createHash('sha256')
    .update(readFileSync(new URL(import.meta.url)))
    .digest('hex'),
  up: applyRbac,
};
