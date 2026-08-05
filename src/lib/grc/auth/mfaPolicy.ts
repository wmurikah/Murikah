/**
 * Which roles must sign in with a second factor. The rule is per-organisation
 * data in `config` under MFA_REQUIRED_ROLES: unset defaults to SUPER_ADMIN
 * (the audit's minimum), 'ALL' requires it for every role, 'NONE' disables the
 * requirement, and otherwise the value is a comma-separated list of role
 * codes. Voluntary enrolment is always open regardless of the rule.
 * Import-free, so node strips types and unit-tests this directly.
 */

export const MFA_REQUIRED_ROLES_KEY = 'MFA_REQUIRED_ROLES';

/** The default when the organisation has not set a rule. */
export const MFA_DEFAULT_RULE = 'SUPER_ADMIN';

/** Whether the rule requires a second factor for this role. */
export function mfaRequiredForRole(roleCode: string, rule: string | null | undefined): boolean {
  const value = (rule ?? '').trim() === '' ? MFA_DEFAULT_RULE : (rule ?? '').trim();
  const upper = value.toUpperCase();
  if (upper === 'NONE') return false;
  if (upper === 'ALL') return true;
  const wanted = upper.split(',').map((r) => r.trim());
  return wanted.includes(roleCode.trim().toUpperCase());
}
