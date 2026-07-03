/**
 * Self-serve signup: create a fresh customer tenant on a trial.
 *
 * A visitor gives their name, work email, password and company. If any existing
 * user already has an email at that email's domain, signup is blocked and they
 * are pointed at their administrator, so one company is never fragmented into
 * duplicate tenants. Otherwise a new top-level organisation is created (a fresh
 * customer, no parent), with the signer as OWNER and a TRIALING subscription on
 * the TRIAL plan, all in one transaction. Email is enforced globally unique to
 * match the index. The new organisation appears to the platform owner
 * automatically, since it is a new tenant.
 */
import type { Client } from '@libsql/client/web';
import { hashPassword } from '@engr/auth/password';

const newId = (): string => crypto.randomUUID().replace(/-/g, '');
const TRIAL_DAYS = 14;

function isUniqueViolation(err: unknown): boolean {
  const text = String(err instanceof Error ? err.message : err);
  return text.includes('UNIQUE') || text.includes('SQLITE_CONSTRAINT');
}

export type SignupResult =
  | { ok: true; orgId: string; userId: string; orgSlug: string; orgName: string }
  | { ok: false; code: 'invalid' | 'domain' | 'conflict'; message: string; domain?: string };

export interface SignupInput {
  fullName: string;
  email: string;
  password: string;
  companyName: string;
}

// A url-safe slug from a company name; empty input falls back to "org".
function slugify(text: string): string {
  const base = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base || 'org';
}

// Extract the domain from an email address (the part after the last @).
function domainOf(email: string): string {
  const at = email.lastIndexOf('@');
  return at === -1 ? '' : email.slice(at + 1);
}

// Find a free slug: base, then base-2, base-3, and finally a random suffix.
async function uniqueSlug(db: Client, base: string): Promise<string> {
  for (let i = 0; i < 12; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    const res = await db.execute({
      sql: `SELECT 1 FROM organisations WHERE slug = ? LIMIT 1`,
      args: [candidate],
    });
    if (res.rows.length === 0) return candidate;
  }
  return `${base}-${newId().slice(0, 6)}`;
}

export async function createTrialTenant(db: Client, input: SignupInput): Promise<SignupResult> {
  const fullName = input.fullName.trim();
  const email = input.email.trim().toLowerCase();
  const companyName = input.companyName.trim();
  const password = input.password;

  if (!fullName) return { ok: false, code: 'invalid', message: 'Your name is required.' };
  if (!email || !email.includes('@') || email.startsWith('@') || email.endsWith('@'))
    return { ok: false, code: 'invalid', message: 'A valid work email is required.' };
  if (password.length < 8)
    return { ok: false, code: 'invalid', message: 'Use a password of at least 8 characters.' };
  if (!companyName) return { ok: false, code: 'invalid', message: 'A company name is required.' };

  const domain = domainOf(email);

  // One company, one tenant: block a second signup on a domain already in use.
  const existing = await db.execute({
    sql: `SELECT 1 FROM users
           WHERE substr(email, instr(email, '@') + 1) = ? AND deleted_at IS NULL
           LIMIT 1`,
    args: [domain],
  });
  if (existing.rows.length > 0) {
    return {
      ok: false,
      code: 'domain',
      domain,
      message: `An account for ${domain} already exists. Ask your administrator to invite you.`,
    };
  }

  const slug = await uniqueSlug(db, slugify(companyName));
  const passwordHash = await hashPassword(password);
  const orgId = newId();
  const userId = newId();
  const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * 86400000).toISOString();

  // The shared OWNER system role and the TRIAL plan, read before the write.
  const [ownerRole, trialPlan] = await Promise.all([
    db.execute({
      sql: `SELECT id FROM roles WHERE code = 'OWNER' AND org_id IS NULL LIMIT 1`,
      args: [],
    }),
    db.execute({ sql: `SELECT id FROM plans WHERE code = 'TRIAL' LIMIT 1`, args: [] }),
  ]);
  const ownerRoleId = ownerRole.rows[0] ? String(ownerRole.rows[0].id) : null;
  const trialPlanId = trialPlan.rows[0] ? String(trialPlan.rows[0].id) : null;
  if (!ownerRoleId)
    return { ok: false, code: 'invalid', message: 'The service is not fully configured yet.' };

  const tx = await db.transaction('write');
  try {
    // A fresh top-level customer tenant (no parent).
    await tx.execute({
      sql: `INSERT INTO organisations (id, name, slug, status) VALUES (?, ?, ?, 'ACTIVE')`,
      args: [orgId, companyName, slug],
    });
    await tx.execute({
      sql: `INSERT INTO users (id, org_id, full_name, email, password_hash, status)
            VALUES (?, ?, ?, ?, ?, 'ACTIVE')`,
      args: [userId, orgId, fullName, email, passwordHash],
    });
    await tx.execute({
      sql: `INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)`,
      args: [userId, ownerRoleId],
    });
    if (trialPlanId) {
      await tx.execute({
        sql: `INSERT INTO subscriptions (id, org_id, plan_id, status, trial_ends_at)
              VALUES (?, ?, ?, 'TRIALING', ?)`,
        args: [newId(), orgId, trialPlanId, trialEndsAt],
      });
    }
    await tx.execute({
      sql: `INSERT INTO audit_logs (org_id, actor_user_id, action, entity_type, entity_id, after_json)
            VALUES (?, ?, 'org.signup', 'organisation', ?, ?)`,
      args: [orgId, userId, orgId, JSON.stringify({ slug, name: companyName, domain })],
    });
    await tx.commit();
    return { ok: true, orgId, userId, orgSlug: slug, orgName: companyName };
  } catch (err) {
    await tx.rollback();
    if (isUniqueViolation(err))
      return {
        ok: false,
        code: 'conflict',
        message: 'That email or company is already registered.',
      };
    throw err;
  }
}
