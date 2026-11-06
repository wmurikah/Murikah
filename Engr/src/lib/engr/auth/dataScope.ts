/**
 * Record visibility for the standard portal roles.
 *
 * Permission keys answer which kind of record a user may open. These scopes
 * answer which records of that kind they may open. Internal organisation roles
 * can read the organisation queue, while the three portal roles are tied to
 * their station, contractor or technician relationship in the database.
 */
export type ActorDataScope = 'org' | 'station' | 'contractor' | 'technician';

const ORG_SCOPED_ROLES = new Set([
  'OWNER',
  'ADMIN',
  'ENGINEERING_MANAGER',
  'ENGINEER',
  'FINANCIAL_CONTROLLER',
  'VIEWER',
]);

export function actorDataScope(roles: readonly string[]): ActorDataScope {
  if (roles.some((role) => ORG_SCOPED_ROLES.has(role))) return 'org';
  if (roles.includes('STATION_MANAGER')) return 'station';
  if (roles.includes('CONTRACTOR')) return 'contractor';
  if (roles.includes('TECHNICIAN')) return 'technician';

  // Custom roles are organisation-owned and explicitly granted by an Owner or
  // Administrator. Their view permissions therefore use the organisation
  // scope unless one of the standard portal roles above narrows them.
  return 'org';
}
