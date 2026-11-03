const PROTECTED_INTERNAL_DOMAINS = new Set(['hasspetroleum.com']);

const CONSUMER_EMAIL_DOMAINS = new Set([
  'aol.com',
  'gmail.com',
  'googlemail.com',
  'hotmail.com',
  'icloud.com',
  'live.com',
  'me.com',
  'outlook.com',
  'proton.me',
  'protonmail.com',
  'yahoo.com',
]);

export type EmailPolicy = 'INTERNAL_PROTECTED' | 'CONSUMER' | 'CORPORATE';

/** Normalize only ASCII email addresses. Confusable Unicode domains fail closed. */
export function normalizeIdentityEmail(value: string): string | null {
  const email = value.trim().normalize('NFKC').toLowerCase();
  if (
    !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(
      email,
    )
  )
    return null;
  return email;
}

export function emailDomain(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1);
}

export function classifyIdentityEmail(value: string): EmailPolicy | null {
  const email = normalizeIdentityEmail(value);
  if (!email) return null;
  const domain = emailDomain(email);
  if (PROTECTED_INTERNAL_DOMAINS.has(domain)) return 'INTERNAL_PROTECTED';
  if (CONSUMER_EMAIL_DOMAINS.has(domain)) return 'CONSUMER';
  return 'CORPORATE';
}

export function maySelfRegister(value: string): boolean {
  return classifyIdentityEmail(value) === 'CORPORATE';
}

/** Issuer comes from the verified provider token, never from form fields. */
export function isFederatedIssuer(provider: string, issuer: string): boolean {
  if (provider === 'GOOGLE')
    return issuer === 'https://accounts.google.com' || issuer === 'accounts.google.com';
  if (provider === 'APPLE') return issuer === 'https://appleid.apple.com';
  return (
    provider === 'MICROSOFT' &&
    /^https:\/\/login\.microsoftonline\.com\/[0-9a-f-]+\/v2\.0$/.test(issuer)
  );
}

export function isRegistrationIssuer(provider: string, issuer: string): boolean {
  return provider !== 'APPLE' && isFederatedIssuer(provider, issuer);
}
