import { SignJWT, jwtVerify } from 'jose';
import type { IdentityProvider } from './oidc.ts';

const key = (secret: string) => new TextEncoder().encode(secret);

export async function createRegistrationGrant(
  secret: string,
  input: {
    email: string;
    provider: Exclude<IdentityProvider, 'APPLE'>;
    issuer: string;
    subject: string;
  },
) {
  return new SignJWT(input)
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer('hass-cms')
    .setAudience('customer-registration')
    .setIssuedAt()
    .setExpirationTime('10m')
    .setJti(crypto.randomUUID())
    .sign(key(secret));
}

export async function verifyRegistrationGrant(secret: string, token: string) {
  const { payload } = await jwtVerify(token, key(secret), {
    issuer: 'hass-cms',
    audience: 'customer-registration',
    algorithms: ['HS256'],
  });
  if (
    typeof payload.email !== 'string' ||
    typeof payload.issuer !== 'string' ||
    typeof payload.subject !== 'string' ||
    (payload.provider !== 'GOOGLE' && payload.provider !== 'MICROSOFT')
  )
    throw new Error('invalid_registration_grant');
  return {
    email: payload.email,
    provider: payload.provider as 'GOOGLE' | 'MICROSOFT',
    issuer: payload.issuer,
    subject: payload.subject,
  };
}
