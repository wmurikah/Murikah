const PASSWORD_CHANGE_PATHS = new Set([
  '/change-password',
  '/api/auth/change-password',
  '/api/auth/logout',
]);

export type PasswordGateDecision = 'allow' | 'redirect' | 'forbid';

/** Decide access before roles, tenant switching or application locals exist. */
export function passwordGateDecision(
  passwordChangeRequired: boolean,
  restrictedSession: boolean,
  appPath: string,
  isApi: boolean,
): PasswordGateDecision {
  if (!passwordChangeRequired && !restrictedSession) return 'allow';
  if (PASSWORD_CHANGE_PATHS.has(appPath)) return 'allow';
  return isApi ? 'forbid' : 'redirect';
}
