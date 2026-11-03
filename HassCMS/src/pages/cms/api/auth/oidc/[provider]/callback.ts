import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getCmsEnv } from '@hasscms/lib/cms/env';
import { getDb } from '@hasscms/lib/cms/db';
import {
  providerConfig,
  exchangeAndVerify,
  type IdentityProvider,
} from '@hasscms/lib/cms/auth/oidc';
import { hashOneTimeToken } from '@hasscms/lib/cms/auth/tokens';
import { consumeOidcTransaction } from '@hasscms/lib/cms/repos/oidcTransactions';
import {
  resolveFederatedUser,
  createFederatedSession,
} from '@hasscms/lib/cms/repos/identityGateway';
import {
  normalizeIdentityEmail,
  classifyIdentityEmail,
} from '@hasscms/lib/cms/auth/identityPolicy';
import { newSessionToken, hashSessionToken, sessionWindow } from '@hasscms/lib/cms/auth/session';
import { serialiseSessionCookie, isSecureRequest } from '@hasscms/lib/cms/auth/cookie';
import { loadIdentity } from '@hasscms/lib/cms/repos/identity';
import { homeFor } from '@hasscms/lib/cms/routes';
import { createRegistrationGrant } from '@hasscms/lib/cms/auth/registrationGrant';

export const prerender = false;
const callback: APIRoute = async ({ params, request, url }) => {
  const provider = String(params.provider ?? '').toUpperCase() as IdentityProvider;
  let purpose = 'SIGN_IN';
  try {
    const data =
        request.method === 'POST' ? new URLSearchParams(await request.text()) : url.searchParams,
      state = data.get('state') ?? '',
      code = data.get('code') ?? '';
    const cmsEnv = getCmsEnv(),
      db = await getDb(cmsEnv),
      txn = await consumeOidcTransaction(
        db,
        await hashOneTimeToken(state, cmsEnv.sessionSecret),
        new Date(),
      );
    if (!txn || txn.provider !== provider || !code) throw new Error('invalid_state');
    purpose = txn.purpose;
    const redirectUri = `${url.origin}/api/auth/oidc/${provider.toLowerCase()}/callback`,
      claims = await exchangeAndVerify(await providerConfig(provider, env), {
        code,
        redirectUri,
        verifier: txn.verifier,
        nonceHash: txn.nonceHash,
        secret: cmsEnv.sessionSecret,
      });
    const email = normalizeIdentityEmail(String(claims.email ?? '')),
      verified = claims.email_verified === true || claims.email_verified === 'true';
    if (!email || !verified) throw new Error('unverified_email');
    const policy = classifyIdentityEmail(email);
    if (txn.purpose === 'REGISTER') {
      if (policy !== 'CORPORATE')
        return Response.redirect(
          new URL(
            `/register?reason=${policy === 'INTERNAL_PROTECTED' ? 'internal' : 'company_email'}`,
            url,
          ),
          303,
        );
      const next = new URL('/register', url);
      next.searchParams.set('verified', '1');
      next.searchParams.set('email', email);
      next.searchParams.set('provider', provider);
      next.searchParams.set(
        'grant',
        await createRegistrationGrant(cmsEnv.sessionSecret, {
          email,
          provider: provider as 'GOOGLE' | 'MICROSOFT',
          subject: typeof claims.sub === 'string' ? claims.sub : '',
          providerIssuer: typeof claims.iss === 'string' ? claims.iss : '',
          tenantId: typeof claims.tid === 'string' ? claims.tid : null,
        }),
      );
      return Response.redirect(next, 303);
    }
    const resolved = await resolveFederatedUser(db, {
      provider,
      issuer: typeof claims.iss === 'string' ? claims.iss : '',
      subject: typeof claims.sub === 'string' ? claims.sub : '',
      email,
      emailVerified: verified,
      tenantId: claims.tid ? String(claims.tid) : null,
      now: new Date(),
    });
    if (resolved.kind !== 'user')
      return Response.redirect(
        new URL(
          `/login?reason=${policy === 'INTERNAL_PROTECTED' ? 'not_provisioned' : 'not_linked'}`,
          url,
        ),
        303,
      );
    const identity = await loadIdentity(db, resolved.userId);
    if (!identity) throw new Error('identity_unavailable');
    const rawToken = newSessionToken(),
      window = sessionWindow(new Date()),
      tokenHash = await hashSessionToken(rawToken, cmsEnv.sessionSecret);
    const created = await createFederatedSession(db, {
      userId: identity.userId,
      federatedIdentityId: resolved.federatedIdentityId,
      provider,
      issuer: typeof claims.iss === 'string' ? claims.iss : '',
      subject: typeof claims.sub === 'string' ? claims.sub : '',
      tokenHash,
      issuedAt: window.issuedAt,
      expiresAt: window.expiresAt,
      ip: request.headers.get('cf-connecting-ip'),
      userAgent: request.headers.get('user-agent'),
      now: new Date(),
    });
    if (!created) throw new Error('identity_ineligible');
    // Response.redirect() has immutable headers; use a mutable response for the session cookie.
    const response = new Response(null, {
      status: 303,
      headers: {
        location: new URL(homeFor(identity.userType, identity.permissions), url).toString(),
      },
    });
    response.headers.append(
      'set-cookie',
      serialiseSessionCookie(rawToken, { secure: isSecureRequest(request), maxAge: window.maxAge }),
    );
    response.headers.set('cache-control', 'no-store');
    return response;
  } catch (error) {
    console.error('[cms.oidc.callback]', error);
    const entry = purpose === 'REGISTER' ? '/register' : '/login';
    return Response.redirect(
      new URL(`${entry}?provider_error=${provider.toLowerCase()}`, url),
      303,
    );
  }
};
export const GET = callback;
export const POST = callback;
