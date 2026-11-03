import { SignJWT, jwtVerify } from 'jose';
import { isRegistrationIssuer } from './identityPolicy.ts';

const key = (secret: string) => new TextEncoder().encode(secret);

interface RegistrationIdentity {
  email: string;
  provider: 'GOOGLE' | 'MICROSOFT';
  subject: string;
  providerIssuer: string;
  tenantId: string | null;
}

function validIdentity(input: RegistrationIdentity): boolean {
  return (
    typeof input.email === 'string' &&
    input.email.length > 0 &&
    typeof input.subject === 'string' &&
    input.subject.trim().length > 0 &&
    input.subject.length <= 255 &&
    typeof input.providerIssuer === 'string' &&
    isRegistrationIssuer(input.provider, input.providerIssuer) &&
    (input.tenantId === null ||
      (typeof input.tenantId === 'string' && input.tenantId.length <= 255))
  );
}

export async function createRegistrationGrant(secret: string, input: RegistrationIdentity) {
  if (!validIdentity(input)) throw new Error('invalid_registration_identity');
  return new SignJWT({ ...input })
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
  const identity = {
    email: payload.email,
    provider: payload.provider,
    subject: payload.subject,
    providerIssuer: payload.providerIssuer,
    tenantId: payload.tenantId,
  } as RegistrationIdentity;
  if (
    !validIdentity(identity) ||
    !Number.isInteger(payload.iat) ||
    Number(payload.iat) > Math.floor(Date.now() / 1000)
  )
    throw new Error('invalid_registration_grant');
  return { ...identity, verifiedAt: new Date(Number(payload.iat) * 1000).toISOString() };
}
