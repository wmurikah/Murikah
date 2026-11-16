/**
 * MFA is secure-by-default. Only the explicit runtime value `false` disables
 * the second factor; a missing, blank or misspelt binding leaves it enabled.
 */
export function mfaEnabledFromBinding(value: unknown): boolean {
  return !(typeof value === 'string' && value.trim().toLowerCase() === 'false');
}
