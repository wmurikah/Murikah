export type MfaRequirement = 'enroll' | 'challenge';

const ENROLL_PATHS = new Set([
  '/mfa/enroll',
  '/api/auth/mfa/enroll/start',
  '/api/auth/mfa/enroll/confirm',
  '/api/auth/logout',
]);
const CHALLENGE_PATHS = new Set(['/mfa/challenge', '/api/auth/mfa/challenge', '/api/auth/logout']);

export function isPrivilegedAuthPath(appPath: string): boolean {
  return (
    appPath === '/admin' ||
    appPath.startsWith('/admin/') ||
    appPath === '/api/admin' ||
    appPath.startsWith('/api/admin/') ||
    appPath === '/api/org/switch'
  );
}

export function requiredMfaStage(input: {
  authStage?: string;
  mandatory: boolean;
  enabled: boolean;
  verifiedAt: number;
  now: number;
  privilegedPath: boolean;
}): MfaRequirement | null {
  if (input.authStage === 'mfa-enroll' || (input.mandatory && !input.enabled)) return 'enroll';
  if (
    input.authStage === 'mfa-challenge' ||
    (input.enabled && input.verifiedAt === 0) ||
    (input.enabled && input.privilegedPath && input.now - input.verifiedAt > 10 * 60)
  ) {
    return 'challenge';
  }
  return null;
}

export function mfaPathAllowed(requirement: MfaRequirement, appPath: string): boolean {
  return (requirement === 'enroll' ? ENROLL_PATHS : CHALLENGE_PATHS).has(appPath);
}
