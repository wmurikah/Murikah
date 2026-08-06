/**
 * Two-step verification policy (Build Prompt 37). Verification itself is
 * universal: every user completes a second factor at sign-in, no role is
 * exempt and there is no opt-out, with email codes as the automatic default
 * that needs no enrolment. The only rule left to configure is who may use an
 * authenticator app instead: per-organisation data in `config` under
 * MFA_AUTHENTICATOR_ROLES. Unset defaults to SUPER_ADMIN, 'ALL' opens the app
 * to every role, 'NONE' keeps every role on email codes, and otherwise the
 * value is a comma-separated list of role codes. The platform owner always
 * qualifies; callers apply that flag themselves, because this module stays
 * import-free so node strips types and unit-tests it directly. The retired
 * MFA_REQUIRED_ROLES key configured who must verify; nothing reads it now.
 */

export const MFA_AUTHENTICATOR_ROLES_KEY = 'MFA_AUTHENTICATOR_ROLES';

/** The default when the organisation has not set a rule. */
export const MFA_AUTHENTICATOR_DEFAULT = 'SUPER_ADMIN';

/** Whether the rule lets this role use an authenticator app instead of email codes. */
export function authenticatorAllowedForRole(
  roleCode: string,
  rule: string | null | undefined,
): boolean {
  const value = (rule ?? '').trim() === '' ? MFA_AUTHENTICATOR_DEFAULT : (rule ?? '').trim();
  const upper = value.toUpperCase();
  if (upper === 'NONE') return false;
  if (upper === 'ALL') return true;
  const allowed = upper.split(',').map((r) => r.trim());
  return allowed.includes(roleCode.trim().toUpperCase());
}
