import { createRemoteJWKSet, importPKCS8, jwtVerify, SignJWT } from 'jose';
import { newOneTimeToken, hashOneTimeToken } from './tokens.ts';

export type IdentityProvider = 'GOOGLE' | 'MICROSOFT' | 'APPLE';
export type OidcPurpose = 'SIGN_IN' | 'REGISTER' | 'LINK';

export interface ProviderConfig {
  clientId: string;
  clientSecret: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  issuer: string | RegExp;
  scope: string;
  responseMode?: string;
}

export async function providerConfig(
  provider: IdentityProvider,
  env: Cloudflare.Env,
): Promise<ProviderConfig> {
  if (provider === 'GOOGLE' && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET)
    return {
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenEndpoint: 'https://oauth2.googleapis.com/token',
      jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
      issuer: ['https://accounts.google.com', 'accounts.google.com'].join('|'),
      scope: 'openid email profile',
    };
  if (provider === 'MICROSOFT' && env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET) {
    const tenant = env.MICROSOFT_TENANT || 'organizations';
    return {
      clientId: env.MICROSOFT_CLIENT_ID,
      clientSecret: env.MICROSOFT_CLIENT_SECRET,
      authorizationEndpoint: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
      tokenEndpoint: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
      jwksUri: 'https://login.microsoftonline.com/common/discovery/v2.0/keys',
      issuer: /^https:\/\/login\.microsoftonline\.com\/[0-9a-f-]+\/v2\.0$/,
      scope: 'openid email profile',
    };
  }
  if (
    provider === 'APPLE' &&
    env.APPLE_CLIENT_ID &&
    env.APPLE_TEAM_ID &&
    env.APPLE_KEY_ID &&
    env.APPLE_PRIVATE_KEY
  ) {
    const key = await importPKCS8(env.APPLE_PRIVATE_KEY.replace(/\\n/g, '\n'), 'ES256');
    const secret = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: env.APPLE_KEY_ID })
      .setIssuer(env.APPLE_TEAM_ID)
      .setSubject(env.APPLE_CLIENT_ID)
      .setAudience('https://appleid.apple.com')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(key);
    return {
      clientId: env.APPLE_CLIENT_ID,
      clientSecret: secret,
      authorizationEndpoint: 'https://appleid.apple.com/auth/authorize',
      tokenEndpoint: 'https://appleid.apple.com/auth/token',
      jwksUri: 'https://appleid.apple.com/auth/keys',
      issuer: 'https://appleid.apple.com',
      scope: 'openid email name',
      responseMode: 'form_post',
    };
  }
  throw new Error(`${provider} identity provider is not configured`);
}

export async function newOidcMaterial(secret: string) {
  const state = newOneTimeToken(),
    nonce = newOneTimeToken(),
    verifier = newOneTimeToken();
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  let binary = '';
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return {
    state,
    nonce,
    verifier,
    challenge: btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
    stateHash: await hashOneTimeToken(state, secret),
    nonceHash: await hashOneTimeToken(nonce, secret),
  };
}

export async function exchangeAndVerify(
  config: ProviderConfig,
  input: { code: string; redirectUri: string; verifier: string; nonceHash: string; secret: string },
) {
  const response = await fetch(config.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code_verifier: input.verifier,
    }),
  });
  if (!response.ok) throw new Error('provider_token_exchange_failed');
  const token = (await response.json()) as { id_token?: string };
  if (!token.id_token) throw new Error('provider_id_token_missing');
  const verified = await jwtVerify(token.id_token, createRemoteJWKSet(new URL(config.jwksUri)), {
    audience: config.clientId,
  });
  const issuer = String(verified.payload.iss ?? '');
  const issuerOk =
    config.issuer instanceof RegExp
      ? config.issuer.test(issuer)
      : config.issuer.includes('|')
        ? config.issuer.split('|').includes(issuer)
        : issuer === config.issuer;
  if (!issuerOk) throw new Error('provider_issuer_invalid');
  if (
    typeof verified.payload.nonce !== 'string' ||
    (await hashOneTimeToken(verified.payload.nonce, input.secret)) !== input.nonceHash
  )
    throw new Error('provider_nonce_invalid');
  return verified.payload;
}
