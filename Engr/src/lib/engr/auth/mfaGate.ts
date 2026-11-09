export type MfaRequirement = 'enroll' | 'challenge';

const ENROLL_PATHS = new Set([
  '/mfa/enroll',
  '/api/auth/mfa/enroll/start',
  '/api/auth/mfa/enroll/confirm',
  '/api/auth/logout',
]);
const CHALLENGE_PATHS = new Set(['/mfa/challenge', '/api/auth/mfa/challenge', '/api/auth/logout']);

/** A grant to make a consequential decision requires an authenticator even when
 * the holder is not an OWNER or ADMIN. This uses live grants from the database. */
const SENSITIVE_PERMISSIONS = new Set([
  'requests.accept',
  'requests.reject',
  'workorder.assign',
  'workorder.cancel',
  'rfq.release',
  'rfq.award',
  'quotes.select',
  'lpo.approve',
  'lpo.issue',
  'lpo.cancel',
  'lpo.close',
  'cost.approve',
  'bill.approve.engineering',
  'bill.approve.finance',
  'payment.record',
  'payment.reverse',
  'users.assign_roles',
  'users.reset_password',
  'users.suspend',
  'roles.manage',
  'org.manage',
]);

export function hasSensitiveGrant(perms: readonly string[]): boolean {
  return perms.some((permission) => SENSITIVE_PERMISSIONS.has(permission));
}

/** Defense in depth at the routing boundary. Mutation handlers also invoke
 * requireFreshMfa so a newly added route cannot rely on middleware alone. */
export function isSensitiveMutationPath(appPath: string, method: string): boolean {
  if (method !== 'POST' && method !== 'PUT' && method !== 'PATCH' && method !== 'DELETE')
    return false;
  return (
    /^\/api\/(?:admin\/(?:users|roles)|org\/switch|payments)$/.test(appPath) ||
    /^\/api\/payments\/[^/]+\/reverse$/.test(appPath) ||
    /^\/api\/requests\/[^/]+\/(?:accept|reject|assign-contractor)$/.test(appPath) ||
    /^\/api\/rfqs\/[^/]+\/(?:release|award|procurement-decision)$/.test(appPath) ||
    /^\/api\/lpos\/[^/]+\/(?:approve|issue|cancel|close|mileage\/decision)$/.test(appPath) ||
    /^\/api\/(?:costs|bills)\/[^/]+\/decision$/.test(appPath) ||
    /^\/api\/workorders\/[^/]+\/cancel$/.test(appPath)
  );
}

const ALLOWED_NEXT_SECTIONS = [
  '/admin',
  '/requests',
  '/rfqs',
  '/lpos',
  '/mileage',
  '/costs',
  '/bills',
  '/payments',
  '/procurement',
  '/workorders',
];

/** The MFA form's next field is untrusted, even when it originated in our UI. */
export function safeMfaNext(value: string, publicOrigin: string): string {
  if (
    !value.startsWith('/') ||
    value.startsWith('//') ||
    /\\|%2f|%5c|[\u0000-\u001f\u007f]/i.test(value)
  )
    return '/';
  try {
    const base = new URL(publicOrigin);
    const target = new URL(value, base);
    if (target.origin !== base.origin || target.username || target.password) return '/';
    if (
      target.pathname !== '/' &&
      !ALLOWED_NEXT_SECTIONS.some(
        (section) => target.pathname === section || target.pathname.startsWith(`${section}/`),
      )
    )
      return '/';
    return `${target.pathname}${target.search}`;
  } catch {
    return '/';
  }
}

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
  enforced?: boolean;
  mandatory: boolean;
  enabled: boolean;
  verifiedAt: number;
  now: number;
  privilegedPath: boolean;
}): MfaRequirement | null {
  if (input.enforced === false) return null;
  if (input.authStage === 'mfa-enroll' || (input.mandatory && !input.enabled)) return 'enroll';
  if (
    input.authStage === 'mfa-challenge' ||
    (input.enabled && (input.verifiedAt <= 0 || input.verifiedAt > input.now)) ||
    (input.enabled && input.privilegedPath && input.now - input.verifiedAt > 10 * 60)
  ) {
    return 'challenge';
  }
  return null;
}

export function mfaPathAllowed(requirement: MfaRequirement, appPath: string): boolean {
  return (requirement === 'enroll' ? ENROLL_PATHS : CHALLENGE_PATHS).has(appPath);
}
