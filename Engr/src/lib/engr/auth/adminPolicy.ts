/** Administrative delegation boundaries beyond the coarse permission grants. */
export type UserManagementScope = 'none' | 'operational' | 'admin' | 'all';

export const OPERATIONAL_ROLE_CODES = [
  'ENGINEER',
  'STATION_MANAGER',
  'CONTRACTOR',
  'TECHNICIAN',
  'VIEWER',
] as const;

export const STANDARD_ROLE_CODES = [
  'OWNER',
  'ADMIN',
  'ENGINEERING_MANAGER',
  'ENGINEER',
  'STATION_MANAGER',
  'FINANCIAL_CONTROLLER',
  'CONTRACTOR',
  'TECHNICIAN',
  'VIEWER',
] as const;

const OPERATIONAL = new Set<string>(OPERATIONAL_ROLE_CODES);
const ORG_WIDE_TECHNICIAN_ROLES = new Set(['OWNER', 'ADMIN', 'ENGINEERING_MANAGER']);

export function userManagementScope(
  roles: readonly string[],
  isPlatformOwner: boolean,
): UserManagementScope {
  if (isPlatformOwner || roles.includes('OWNER')) return 'all';
  if (roles.includes('ADMIN')) return 'admin';
  if (roles.includes('ENGINEERING_MANAGER')) return 'operational';
  return 'none';
}

export function mayAssignRoleCode(scope: UserManagementScope, code: string): boolean {
  if (scope === 'all') return true;
  if (scope === 'admin') return code !== 'OWNER';
  if (scope === 'operational') return OPERATIONAL.has(code);
  return false;
}

/** Only an Owner/platform owner may alter the Owner role contract. */
export function mayManageRoleCode(scope: UserManagementScope, code: string): boolean {
  if (scope === 'all') return true;
  if (scope === 'admin') return code !== 'OWNER';
  return false;
}

export function mayManageTargetUser(
  scope: UserManagementScope,
  targetRoleCodes: readonly string[],
  targetIsPlatformOwner: boolean,
): boolean {
  if (scope === 'none') return false;
  if (targetIsPlatformOwner) return scope === 'all';
  if (scope === 'all') return true;
  if (scope === 'admin') return !targetRoleCodes.includes('OWNER');
  return targetRoleCodes.every((code) => OPERATIONAL.has(code));
}

/** Contractor portal accounts may administer only their own technicians. */
export function requiresContractorTechnicianScope(roles: readonly string[]): boolean {
  return roles.includes('CONTRACTOR') && !roles.some((role) => ORG_WIDE_TECHNICIAN_ROLES.has(role));
}
