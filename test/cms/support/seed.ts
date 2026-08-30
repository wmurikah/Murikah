/**
 * Fixture users for the authentication tests.
 *
 * Modelled on the shape of the operator's seed rather than copied from it: the
 * reference rows the foreign keys need, then one user per account state the
 * login flow has to distinguish. Ids are fixed so a test can address a row.
 *
 * No real password appears here. Every credential is written through the same
 * hashing module the API verifies with, so the fixtures cannot drift from the
 * implementation the way a hard-coded hash would.
 */
import type { TestClient } from './db.ts';
import { hashPassword, PASSWORD_ALGORITHM_PBKDF2 } from '../../../src/lib/cms/auth/password.ts';

/** Test-only credentials. Never a real password, and never reused elsewhere. */
export const FIXTURE_PASSWORD = 'test-only-password-not-a-real-one';
export const WRONG_PASSWORD = 'test-only-wrong-password';

export const IDS = {
  active: 'USR-ACTIVE',
  suspended: 'USR-SUSPENDED',
  inactive: 'USR-INACTIVE',
  noCredential: 'USR-NOCRED',
  legacyAlgorithm: 'USR-LEGACY',
  external: 'USR-EXTERNAL',
} as const;

export const EMAILS = {
  active: 'catherine.mwangi@hasspetroleum.com',
  suspended: 'suspended.user@hasspetroleum.com',
  inactive: 'inactive.user@hasspetroleum.com',
  noCredential: 'nocred.user@hasspetroleum.com',
  legacyAlgorithm: 'legacy.user@hasspetroleum.com',
  external: 'portal.user@example.co.ke',
  unknown: 'nobody.at.all@hasspetroleum.com',
} as const;

const run = (db: TestClient, sql: string, args: unknown[] = []) => db.execute({ sql, args });

export async function seed(db: TestClient): Promise<void> {
  const NOW = '2026-08-26 08:00:00';
  const TODAY = '2026-01-01';

  // Reference data the foreign keys require.
  await run(
    db,
    `INSERT INTO countries (country_id, iso2, country_name, timezone, currency_code, active) VALUES ('CTR-KE','KE','Kenya','Africa/Nairobi','KES',1)`,
  );
  await run(
    db,
    `INSERT INTO affiliates (affiliate_id, affiliate_code, affiliate_name, country_id, active) VALUES ('AFF-KE','HKE','Hass Kenya','CTR-KE',1)`,
  );
  await run(
    db,
    `INSERT INTO business_units (business_unit_id, business_unit_code, business_unit_name, active) VALUES ('BU-RET','RET','Retail',1)`,
  );
  await run(
    db,
    `INSERT INTO departments (department_id, department_name, active) VALUES ('DEP-CS','Customer Service',1)`,
  );
  await run(
    db,
    `INSERT INTO job_titles (job_title_id, title_name, department_id, active) VALUES ('JT-CSM','Customer Service Manager','DEP-CS',1)`,
  );

  // Two access roles with distinct permissions, so a resolution test proves the
  // union across roles rather than a single role's list.
  await run(
    db,
    `INSERT INTO access_roles (role_id, role_name, is_system_role, active) VALUES ('ROLE-ADMIN','System Administrator',1,1)`,
  );
  await run(
    db,
    `INSERT INTO access_roles (role_id, role_name, is_system_role, active) VALUES ('ROLE-CSM','Customer Service Manager',0,1)`,
  );
  await run(
    db,
    `INSERT INTO access_roles (role_id, role_name, is_system_role, active) VALUES ('ROLE-PORTAL','Customer Portal User',1,1)`,
  );

  const perms: [string, string, string, string][] = [
    ['PERM-1', 'ADMIN', 'USERS', 'MANAGE'],
    ['PERM-2', 'ADMIN', 'ROLES', 'MANAGE'],
    ['PERM-3', 'SERVICE', 'CASES', 'VIEW'],
    ['PERM-4', 'SERVICE', 'CASES', 'CREATE'],
    ['PERM-5', 'AUDIT', 'EVENTS', 'VIEW'],
    ['PERM-6', 'PORTAL', 'ACCOUNT', 'VIEW'],
  ];
  for (const [id, m, r, a] of perms) {
    await run(
      db,
      `INSERT INTO permissions (permission_id, module_name, resource_name, action_name) VALUES (?,?,?,?)`,
      [id, m, r, a],
    );
  }
  // ROLE-ADMIN holds 1, 2, 5 and is DENIED 3 (allowed = 0), which proves the
  // resolution honours the flag instead of assuming a row means a grant.
  for (const [role, perm, allowed] of [
    ['ROLE-ADMIN', 'PERM-1', 1],
    ['ROLE-ADMIN', 'PERM-2', 1],
    ['ROLE-ADMIN', 'PERM-5', 1],
    ['ROLE-ADMIN', 'PERM-3', 0],
    ['ROLE-CSM', 'PERM-3', 1],
    ['ROLE-CSM', 'PERM-4', 1],
    ['ROLE-PORTAL', 'PERM-6', 1],
  ] as [string, string, number][]) {
    await run(
      db,
      `INSERT INTO role_permissions (role_permission_id, role_id, permission_id, allowed) VALUES (?,?,?,?)`,
      [`RP-${role}-${perm}`, role, perm, allowed],
    );
  }

  const user = async (
    id: string,
    email: string,
    status: string,
    verified: string | null,
    type = 'INTERNAL',
  ) =>
    run(
      db,
      `INSERT INTO users (user_id, user_type, first_name, last_name, display_name, email, status, email_verified_at, timezone, locale, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,'Africa/Nairobi','en-KE',?,?)`,
      [id, type, 'Test', 'User', `Test ${id}`, email, status, verified, NOW, NOW],
    );

  await user(IDS.active, EMAILS.active, 'ACTIVE', '2026-01-05 08:00:00');
  await user(IDS.suspended, EMAILS.suspended, 'SUSPENDED', '2026-01-05 08:00:00');
  // INACTIVE is the only state that may carry a null email_verified_at without
  // violating the schema CHECK, so it doubles as the unverified case.
  await user(IDS.inactive, EMAILS.inactive, 'INACTIVE', null);
  await user(IDS.noCredential, EMAILS.noCredential, 'ACTIVE', '2026-01-05 08:00:00');
  await user(IDS.legacyAlgorithm, EMAILS.legacyAlgorithm, 'ACTIVE', '2026-01-05 08:00:00');
  await user(IDS.external, EMAILS.external, 'ACTIVE', '2026-01-05 08:00:00', 'EXTERNAL');

  const hash = await hashPassword(FIXTURE_PASSWORD);
  const credential = async (id: string, userId: string, stored: string, algorithm: string) =>
    run(
      db,
      `INSERT INTO auth_credentials (credential_id, user_id, password_hash, password_algorithm, must_change_password, password_changed_at, failed_attempts, locked_until, created_at, updated_at) VALUES (?,?,?,?,0,?,0,NULL,?,?)`,
      [id, userId, stored, algorithm, NOW, NOW, NOW],
    );

  await credential('CRED-ACTIVE', IDS.active, hash, PASSWORD_ALGORITHM_PBKDF2);
  await credential('CRED-SUSP', IDS.suspended, hash, PASSWORD_ALGORITHM_PBKDF2);
  await credential('CRED-INACT', IDS.inactive, hash, PASSWORD_ALGORITHM_PBKDF2);
  await credential('CRED-EXT', IDS.external, hash, PASSWORD_ALGORITHM_PBKDF2);
  // The shape the operator's seed writes: unusable until the bootstrap runs.
  await credential(
    'CRED-LEGACY',
    IDS.legacyAlgorithm,
    '$argon2id$DEMO_DISABLED$LEGACY',
    'ARGON2ID',
  );

  // Catherine: two roles, a primary affiliate-level assignment, one team scope.
  await run(
    db,
    `INSERT INTO user_assignments (assignment_id, user_id, job_title_id, department_id, assignment_level, country_id, affiliate_id, business_unit_id, effective_from, effective_to, is_primary, active) VALUES ('UA-1',?,'JT-CSM','DEP-CS','AFFILIATE','CTR-KE','AFF-KE',NULL,?,NULL,1,1)`,
    [IDS.active, TODAY],
  );
  await run(
    db,
    `INSERT INTO user_roles (user_role_id, user_id, role_id, effective_from, effective_to, active) VALUES ('UR-1',?,'ROLE-ADMIN',?,NULL,1)`,
    [IDS.active, TODAY],
  );
  await run(
    db,
    `INSERT INTO user_roles (user_role_id, user_id, role_id, effective_from, effective_to, active) VALUES ('UR-2',?,'ROLE-CSM',?,NULL,1)`,
    [IDS.active, TODAY],
  );
  // An expired role assignment, which must not resolve.
  await run(
    db,
    `INSERT INTO user_roles (user_role_id, user_id, role_id, effective_from, effective_to, active) VALUES ('UR-3',?,'ROLE-PORTAL','2026-01-01','2026-02-01',1)`,
    [IDS.active],
  );
  await run(
    db,
    `INSERT INTO user_role_scopes (scope_id, user_role_id, scope_type, country_id) VALUES ('SC-1','UR-2','COUNTRY','CTR-KE')`,
  );

  // The external portal user, with an account membership.
  await run(
    db,
    `INSERT INTO accounts (account_id, account_code, account_name, account_type, country_id, affiliate_id, status, created_at, updated_at) VALUES ('ACC-1','A001','Kenya Transporters Ltd','CUSTOMER','CTR-KE','AFF-KE','ACTIVE',?,?)`,
    [NOW, NOW],
  );
  await run(
    db,
    `INSERT INTO user_roles (user_role_id, user_id, role_id, effective_from, effective_to, active) VALUES ('UR-EXT',?,'ROLE-PORTAL',?,NULL,1)`,
    [IDS.external, TODAY],
  );
  await run(
    db,
    `INSERT INTO customer_portal_memberships (portal_membership_id, user_id, account_id, portal_role_id, status, created_at) VALUES ('PM-1',?, 'ACC-1','ROLE-PORTAL','ACTIVE',?)`,
    [IDS.external, NOW],
  );
}
