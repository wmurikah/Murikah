import { safeMfaNext } from './mfaGate.ts';

export interface SensitiveActionContext {
  engr?: { mfaEnforced?: boolean; mfaEnabled: boolean; mfaVerifiedAt: number };
}

export type SensitiveActionDecision = 'allow' | 'enroll' | 'challenge';

export function sensitiveActionDecision(
  context: SensitiveActionContext,
  nowSeconds: number,
): SensitiveActionDecision {
  if (context.engr?.mfaEnforced === false) return 'allow';
  if (!context.engr?.mfaEnabled) return 'enroll';
  const verifiedAt = context.engr.mfaVerifiedAt;
  if (
    !Number.isInteger(verifiedAt) ||
    verifiedAt <= 0 ||
    verifiedAt > nowSeconds ||
    nowSeconds - verifiedAt > 10 * 60
  )
    return 'challenge';
  return 'allow';
}

/** Call on the mutation endpoint after authentication and before the write;
 * the endpoint's existing permission check still applies. A browser returns to its same-origin form page after MFA
 * and submits again; JSON clients receive an explicit 403 challenge signal. */
export function requireFreshMfa(
  request: Request,
  context: SensitiveActionContext,
): Response | null {
  const decision = sensitiveActionDecision(context, Math.floor(Date.now() / 1000));
  if (decision === 'allow') return null;
  const destination = decision === 'enroll' ? '/mfa/enroll' : '/mfa/challenge';
  if (!(request.headers.get('accept') ?? '').includes('text/html')) {
    return new Response(
      JSON.stringify({
        error: decision === 'enroll' ? 'mfa_enrollment_required' : 'mfa_required',
        challenge: destination,
      }),
      {
        status: 403,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      },
    );
  }
  const origin = new URL(request.url).origin;
  const referrer = request.headers.get('referer');
  let next = '/';
  if (referrer) {
    try {
      const candidate = new URL(referrer);
      if (candidate.origin === origin) next = safeMfaNext(candidate.pathname, origin);
    } catch {
      // An invalid or cross-origin Referer cannot control the redirect.
    }
  }
  const location =
    decision === 'enroll' ? destination : `${destination}?next=${encodeURIComponent(next)}`;
  return new Response(null, { status: 303, headers: { location, 'cache-control': 'no-store' } });
}
