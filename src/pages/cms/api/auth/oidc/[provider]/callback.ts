import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getCmsEnv } from '@/lib/cms/env';
import { getDb } from '@/lib/cms/db';
import { providerConfig, exchangeAndVerify, type IdentityProvider } from '@/lib/cms/auth/oidc';
import { hashOneTimeToken } from '@/lib/cms/auth/tokens';
import { consumeOidcTransaction } from '@/lib/cms/repos/oidcTransactions';
import { resolveFederatedUser } from '@/lib/cms/repos/identityGateway';
import { normalizeIdentityEmail, classifyIdentityEmail } from '@/lib/cms/auth/identityPolicy';
import {
  createSessionStmt,
  newId,
  touchLastLoginStmt,
  auditEventStmt,
} from '@/lib/cms/repos/authRecords';
import { newSessionToken, hashSessionToken, sessionWindow } from '@/lib/cms/auth/session';
import { serialiseSessionCookie, isSecureRequest } from '@/lib/cms/auth/cookie';
import { loadIdentity } from '@/lib/cms/repos/identity';
import { homeFor } from '@/lib/cms/routes';
import { createRegistrationGrant } from '@/lib/cms/auth/registrationGrant';

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
          subject: String(claims.sub),
        }),
      );
      return Response.redirect(next, 303);
    }
    const resolved = await resolveFederatedUser(db, {
      provider,
      subject: String(claims.sub),
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
    await db.batch(
      [
        createSessionStmt({
          sessionId: newId('ASESS'),
          userId: identity.userId,
          tokenHash,
          issuedAt: window.issuedAt,
          expiresAt: window.expiresAt,
          ip: request.headers.get('cf-connecting-ip'),
          userAgent: request.headers.get('user-agent'),
        }),
        touchLastLoginStmt(identity.userId, new Date()),
        auditEventStmt({
          actorUserId: identity.userId,
          eventType: 'FEDERATED_LOGIN_SUCCESS',
          entityType: 'users',
          entityId: identity.userId,
          action: 'LOGIN',
          afterJson: JSON.stringify({ provider }),
          ip: request.headers.get('cf-connecting-ip'),
          userAgent: request.headers.get('user-agent'),
          now: new Date(),
        }),
      ],
      'write',
    );
    const response = Response.redirect(
      new URL(homeFor(identity.userType, identity.permissions), url),
      303,
    );
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
