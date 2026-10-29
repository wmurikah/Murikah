/**
 * The fixture the organisation master-data tests arrange from.
 *
 * Deliberately not the Build Prompt 03 seed. That one exists to exercise the
 * sign-in path and its shape is chosen for that: one country, one affiliate,
 * one business unit. This phase's rules are about the arrangements the seeded
 * production data actually contains, so the fixture reproduces them:
 *
 *   - two affiliates in one country, because one affiliate per country is an
 *     assumption the real data breaks;
 *   - two affiliates sharing a trading name in different countries, because
 *     `affiliates.affiliate_name` is not UNIQUE and a duplicate name must be
 *     accepted while a duplicate code is refused;
 *   - a Group team with neither affiliate nor business unit, a team with an
 *     affiliate only, and a team with both, because all three exist in the seed
 *     and an INNER JOIN would silently lose the first two;
 *   - a team with no manager, because that is valid and must stay creatable.
 *
 * The permission rows are the ones
 * docs/cms/organisation/01_add_organisation_permissions.sql adds. They are
 * inserted here so the tests can run today, before the operator has run that
 * script against the real database. Nothing here points at hass-cms.
 */
import type { TestClient } from './db.ts';

export const ORG_IDS = {
  kenya: 'CTR-KE',
  uganda: 'CTR-UG',
  dormant: 'CTR-ZZ',
  hassKenya: 'AFF-KE',
  bahariKenya: 'AFF-KE2',
  hassUganda: 'AFF-UG',
  retail: 'BU-RET',
  aviation: 'BU-AVI',
  customerService: 'DEP-CS',
  finance: 'DEP-FIN',
  groupFinance: 'TEAM-GRP-FIN',
  kenyaFinance: 'TEAM-FIN-KE',
  kenyaSales: 'TEAM-SALES-KE',
  admin: 'USR-CATH',
  manager: 'USR-AMN',
  member: 'USR-ZULE',
  reader: 'USR-READ',
  outsider: 'USR-NONE',
  portal: 'USR-PORTAL',
} as const;

/** The two codes the permission script adds. */
export const ORG_PERMISSIONS = {
  view: 'PERM-029',
  manage: 'PERM-030',
} as const;

const run = (db: TestClient, sql: string, args: unknown[] = []) => db.execute({ sql, args });

export async function seedOrganisation(db: TestClient): Promise<void> {
  const NOW = '2026-08-27 08:00:00';

  const country = (id: string, iso2: string, name: string, tz: string, ccy: string, active = 1) =>
    run(
      db,
      `INSERT INTO countries (country_id, iso2, country_name, timezone, currency_code, active, created_at)
       VALUES (?,?,?,?,?,?,?)`,
      [id, iso2, name, tz, ccy, active, NOW],
    );
  await country(ORG_IDS.kenya, 'KE', 'Kenya', 'Africa/Nairobi', 'KES');
  await country(ORG_IDS.uganda, 'UG', 'Uganda', 'Africa/Kampala', 'UGX');
  // Deactivated, so "only active countries are offered" has something to refuse.
  await country(ORG_IDS.dormant, 'ZZ', 'Dormant Territory', 'Africa/Nairobi', 'USD', 0);

  const affiliate = (id: string, code: string, name: string, countryId: string, active = 1) =>
    run(
      db,
      `INSERT INTO affiliates (affiliate_id, affiliate_code, affiliate_name, country_id, active, created_at)
       VALUES (?,?,?,?,?,?)`,
      [id, code, name, countryId, active, NOW],
    );
  await affiliate(ORG_IDS.hassKenya, 'HKE', 'Hass Petroleum Kenya', ORG_IDS.kenya);
  // A second affiliate in the same country. One per country is an assumption
  // this fixture exists to break.
  await affiliate(ORG_IDS.bahariKenya, 'BKE', 'Bahari Energy Kenya', ORG_IDS.kenya);
  await affiliate(ORG_IDS.hassUganda, 'HUG', 'Hass Petroleum Uganda', ORG_IDS.uganda);

  const unit = (id: string, code: string, name: string, description: string | null) =>
    run(
      db,
      `INSERT INTO business_units (business_unit_id, business_unit_code, business_unit_name, description, active, created_at)
       VALUES (?,?,?,?,1,?)`,
      [id, code, name, description, NOW],
    );
  await unit(ORG_IDS.retail, 'RET', 'Retail', 'Service stations and forecourt');
  await unit(ORG_IDS.aviation, 'AVI', 'Aviation', 'Into-plane fuelling');

  const department = (id: string, name: string) =>
    run(
      db,
      `INSERT INTO departments (department_id, department_name, active, created_at) VALUES (?,?,1,?)`,
      [id, name, NOW],
    );
  await department(ORG_IDS.customerService, 'Customer Service');
  await department(ORG_IDS.finance, 'Finance');

  await run(
    db,
    `INSERT INTO job_titles (job_title_id, title_name, department_id, active) VALUES ('JT-CSM','Customer Service Manager',?,1)`,
    [ORG_IDS.customerService],
  );

  // Roles and the two permission codes the operator's script adds.
  const role = (id: string, name: string, system = 0) =>
    run(
      db,
      `INSERT INTO access_roles (role_id, role_name, is_system_role, active) VALUES (?,?,?,1)`,
      [id, name, system],
    );
  await role('ROLE-ADMIN', 'System Administrator', 1);
  await role('ROLE-CM', 'Country Manager');
  await role('ROLE-SALES', 'Sales Executive');
  await role('ROLE-PORTAL', 'Customer Portal User', 1);

  await run(
    db,
    `INSERT INTO permissions (permission_id, module_name, resource_name, action_name, description)
     VALUES (?,'ADMIN','ORGANISATION','VIEW','View organisation master data')`,
    [ORG_PERMISSIONS.view],
  );
  await run(
    db,
    `INSERT INTO permissions (permission_id, module_name, resource_name, action_name, description)
     VALUES (?,'ADMIN','ORGANISATION','MANAGE','Manage organisation master data')`,
    [ORG_PERMISSIONS.manage],
  );
  // A permission the organisation guard must ignore, so a test can prove that
  // holding some other ADMIN grant is not enough.
  await run(
    db,
    `INSERT INTO permissions (permission_id, module_name, resource_name, action_name)
     VALUES ('PERM-001','ADMIN','USERS','MANAGE')`,
  );

  const grant = (roleId: string, permissionId: string, allowed = 1) =>
    run(
      db,
      `INSERT INTO role_permissions (role_permission_id, role_id, permission_id, allowed) VALUES (?,?,?,?)`,
      [`RP-${roleId}-${permissionId}`, roleId, permissionId, allowed],
    );
  await grant('ROLE-ADMIN', ORG_PERMISSIONS.view);
  await grant('ROLE-ADMIN', ORG_PERMISSIONS.manage);
  await grant('ROLE-ADMIN', 'PERM-001');
  // The Country Manager reads and does not write. This is the split the
  // permission script makes, asserted rather than described.
  await grant('ROLE-CM', ORG_PERMISSIONS.view);
  // A role holding an unrelated ADMIN permission and nothing organisational.
  await grant('ROLE-SALES', 'PERM-001');

  const user = async (id: string, first: string, last: string, email: string, type = 'INTERNAL') =>
    run(
      db,
      `INSERT INTO users (user_id, user_type, first_name, last_name, display_name, email, status,
                          email_verified_at, timezone, locale, created_at, updated_at)
       VALUES (?,?,?,?,?,?,'ACTIVE',?,'Africa/Nairobi','en-KE',?,?)`,
      [id, type, first, last, `${first} ${last}`, email, NOW, NOW, NOW],
    );
  await user(ORG_IDS.admin, 'Catherine', 'Mwangi', 'catherine.mwangi@hasspetroleum.com');
  await user(ORG_IDS.manager, 'Amina', 'Noor', 'amina.noor@hasspetroleum.com');
  await user(ORG_IDS.member, 'Zuleika', 'Omar', 'zuleika.omar@hasspetroleum.com');
  await user(ORG_IDS.reader, 'Rita', 'Achieng', 'rita.achieng@hasspetroleum.com');
  await user(ORG_IDS.outsider, 'Otieno', 'Kamau', 'otieno.kamau@hasspetroleum.com');
  await user(ORG_IDS.portal, 'Portal', 'Contact', 'portal.contact@example.co.ke', 'EXTERNAL');

  const assign = (id: string, userId: string, roleId: string) =>
    run(
      db,
      `INSERT INTO user_roles (user_role_id, user_id, role_id, effective_from, effective_to, active)
       VALUES (?,?,?, '2026-01-01', NULL, 1)`,
      [id, userId, roleId],
    );
  await assign('UR-1', ORG_IDS.admin, 'ROLE-ADMIN');
  await assign('UR-2', ORG_IDS.reader, 'ROLE-CM');
  await assign('UR-3', ORG_IDS.outsider, 'ROLE-SALES');
  await assign('UR-4', ORG_IDS.portal, 'ROLE-PORTAL');

  // A primary assignment, so the deactivation safeguards have a reference to
  // count.
  await run(
    db,
    `INSERT INTO user_assignments (assignment_id, user_id, job_title_id, department_id, assignment_level,
       country_id, affiliate_id, business_unit_id, effective_from, effective_to, is_primary, active)
     VALUES ('UA-1',?, 'JT-CSM', ?, 'BUSINESS_UNIT', ?, ?, ?, '2026-01-01', NULL, 1, 1)`,
    [ORG_IDS.member, ORG_IDS.customerService, ORG_IDS.kenya, ORG_IDS.hassKenya, ORG_IDS.retail],
  );

  const team = (
    id: string,
    name: string,
    type: string,
    affiliateId: string | null,
    businessUnitId: string | null,
    managerUserId: string | null,
  ) =>
    run(
      db,
      `INSERT INTO teams (team_id, team_name, team_type, affiliate_id, business_unit_id, manager_user_id, active, created_at)
       VALUES (?,?,?,?,?,?,1,?)`,
      [id, name, type, affiliateId, businessUnitId, managerUserId, NOW],
    );
  // Group-wide: neither affiliate nor business unit, and no manager.
  await team(ORG_IDS.groupFinance, 'Group Finance', 'FINANCE', null, null, null);
  // An affiliate and no business unit.
  await team(
    ORG_IDS.kenyaFinance,
    'Kenya Finance',
    'FINANCE',
    ORG_IDS.hassKenya,
    null,
    ORG_IDS.manager,
  );
  // Both.
  await team(
    ORG_IDS.kenyaSales,
    'Kenya Sales',
    'SALES',
    ORG_IDS.hassKenya,
    ORG_IDS.retail,
    ORG_IDS.manager,
  );
}
