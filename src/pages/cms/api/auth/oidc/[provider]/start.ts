import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getCmsEnv } from '@/lib/cms/env';
import { getDb } from '@/lib/cms/db';
import {
  providerConfig,
  newOidcMaterial,
  type IdentityProvider,
  type OidcPurpose,
} from '@/lib/cms/auth/oidc';
import { createOidcTransaction } from '@/lib/cms/repos/oidcTransactions';
import { clientIp } from '@/lib/http';
import { rateLimit } from '@/lib/rate-limit';

export const prerender = false;
const providers = new Set(['GOOGLE', 'MICROSOFT', 'APPLE']);
export const GET: APIRoute = async ({ params, request, url }) => {
  const provider = String(params.provider ?? '').toUpperCase() as IdentityProvider;
  if (!providers.has(provider)) return new Response('Not found', { status: 404 });
  const purpose = String(url.searchParams.get('purpose') ?? 'SIGN_IN').toUpperCase() as OidcPurpose;
  if (
    !['SIGN_IN', 'REGISTER', 'LINK'].includes(purpose) ||
    (purpose === 'REGISTER' && provider === 'APPLE')
  )
    return new Response('This sign-in option is not available.', { status: 400 });
  const limit = await rateLimit(env.CACHE, `cms-oidc:${clientIp(request)}`, 20, 300);
  if (!limit.ok) return new Response('Try again shortly.', { status: 429 });
  try {
    const cmsEnv = getCmsEnv(),
      config = await providerConfig(provider, env),
      material = await newOidcMaterial(cmsEnv.sessionSecret),
      redirectUri = `${url.origin}/api/auth/oidc/${provider.toLowerCase()}/callback`;
    await createOidcTransaction(await getDb(cmsEnv), {
      provider,
      purpose,
      stateHash: material.stateHash,
      nonceHash: material.nonceHash,
      verifier: material.verifier,
      returnPath: purpose === 'REGISTER' ? '/access-pending' : '/app',
      now: new Date(),
    });
    const target = new URL(config.authorizationEndpoint);
    for (const [key, value] of Object.entries({
      client_id: config.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: config.scope,
      state: material.state,
      nonce: material.nonce,
      code_challenge: material.challenge,
      code_challenge_method: 'S256',
    }))
      target.searchParams.set(key, value);
    if (config.responseMode) target.searchParams.set('response_mode', config.responseMode);
    return Response.redirect(target, 302);
  } catch (error) {
    console.error('[cms.oidc.start]', error);
    return Response.redirect(new URL(`/login?provider_error=${provider.toLowerCase()}`, url), 303);
  }
};
