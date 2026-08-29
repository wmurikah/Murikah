import type { Client } from '@libsql/client/web';

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

export async function classifyIdentityEmail(
  db: Client,
  value: string,
): Promise<EmailPolicy | null> {
  const email = normalizeIdentityEmail(value);
  if (!email) return null;
  const domain = emailDomain(email);
  const result = await db.execute({
    sql: `SELECT policy_type FROM auth_email_domain_policies
          WHERE domain=? AND active=1 LIMIT 1`,
    args: [domain],
  });
  const policy = result.rows[0]?.policy_type;
  if (policy === 'INTERNAL_PROTECTED') return 'INTERNAL_PROTECTED';
  if (policy === 'SELF_REGISTRATION_BLOCKED') return 'CONSUMER';
  return 'CORPORATE';
}
