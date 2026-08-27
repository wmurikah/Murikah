/**
 * The internal side of the customer portal: who from this customer can sign
 * in, and in what state.
 *
 * The reads live here rather than in portalWrites.ts because they answer a
 * different question for a different reader. portalWrites.ts is what an
 * administrator does; this is what they look at first, and mixing the two
 * would put a query with no tenant scope next to a write that has one.
 *
 * THE ACCOUNT SCOPE IS NOT ENFORCED HERE. It cannot be: an internal user's
 * visibility is the BP07 scope over accounts, not a portal membership, and
 * re-deriving it in this module would be a second implementation of the rule
 * that matters most. Every caller resolves the account through
 * `getAccount(db, userId, accountId)` first, which returns null for an
 * account outside the caller's scope, and only then asks these functions
 * about it.
 */
import type { Client } from '@libsql/client/web';

const text = (v: unknown): string => String(v ?? '');
const nullableText = (v: unknown): string | null =>
  v === null || v === undefined ? null : String(v);

export interface PortalMembershipRow {
  membershipId: string;
  userId: string;
  contactId: string | null;
  contactName: string;
  email: string | null;
  status: 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'REVOKED';
  invitedAt: string | null;
  activatedAt: string | null;
  /** Null where they have never signed in. NEVER shown as a zero or a date. */
  lastAccessAt: string | null;
}

/**
 * Every membership on one account, whatever its state.
 *
 * A revoked membership stays in the list. Removing it from view would leave
 * an administrator unable to tell "this person never had access" from "we
 * took their access away in March", and those are different answers to the
 * question somebody is about to ask.
 */
export async function listMemberships(
  db: Client,
  accountId: string,
): Promise<PortalMembershipRow[]> {
  const result = await db.execute({
    sql: `SELECT m.portal_membership_id AS id, m.user_id AS user_id, m.contact_id AS contact_id,
            COALESCE(c.full_name, u.display_name) AS contact_name, u.email AS email,
            m.status AS status, m.invited_at AS invited_at, m.activated_at AS activated_at,
            m.last_access_at AS last_access_at
          FROM customer_portal_memberships m
          JOIN users u ON u.user_id = m.user_id
          LEFT JOIN contacts c ON c.contact_id = m.contact_id
          WHERE m.account_id = ?
          ORDER BY CASE m.status
              WHEN 'ACTIVE' THEN 0 WHEN 'INVITED' THEN 1 WHEN 'SUSPENDED' THEN 2 ELSE 3 END,
            COALESCE(c.full_name, u.display_name)`,
    args: [accountId],
  });
  return result.rows.map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    return {
      membershipId: text(row.id),
      userId: text(row.user_id),
      contactId: nullableText(row.contact_id),
      contactName: text(row.contact_name),
      email: nullableText(row.email),
      status: text(row.status) as PortalMembershipRow['status'],
      invitedAt: nullableText(row.invited_at),
      activatedAt: nullableText(row.activated_at),
      lastAccessAt: nullableText(row.last_access_at),
    };
  });
}

export interface InvitableContact {
  contactId: string;
  fullName: string;
  email: string | null;
  /** Why this contact cannot be invited, or null when they can be. */
  blockedReason: string | null;
}

/**
 * The account's active contacts, each with the reason they cannot be invited
 * where there is one.
 *
 * A CONTACT WITH NO EMAIL IS LISTED AND EXPLAINED, not silently dropped. An
 * administrator looking for a name that is not in a picker has no way to
 * tell a missing email from a missing contact from a bug, and the difference
 * takes one sentence to state.
 *
 * A contact who already holds a membership is listed the same way, because
 * the answer to "why can I not invite Grace" is "Grace already has access",
 * which is the useful thing to say.
 */
export async function invitableContacts(
  db: Client,
  accountId: string,
): Promise<InvitableContact[]> {
  const result = await db.execute({
    sql: `SELECT c.contact_id AS id, c.full_name AS name, c.email AS email,
            (SELECT m.status FROM customer_portal_memberships m
              WHERE m.contact_id = c.contact_id AND m.account_id = c.account_id
              LIMIT 1) AS membership_status,
            (SELECT u.user_type FROM users u WHERE u.email = c.email LIMIT 1) AS user_type
          FROM contacts c
          WHERE c.account_id = ? AND c.active = 1
          ORDER BY c.is_primary DESC, c.full_name`,
    args: [accountId],
  });
  return result.rows.map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    const email = nullableText(row.email);
    const membership = nullableText(row.membership_status);
    const userType = nullableText(row.user_type);
    let blockedReason: string | null = null;
    if (email === null || email.trim() === '') {
      blockedReason = 'No email address on the contact';
    } else if (userType === 'INTERNAL') {
      // An employee is never converted. The write refuses it as well; saying
      // so here means nobody has to find that out by trying.
      blockedReason = 'That email belongs to an employee';
    } else if (membership === 'ACTIVE' || membership === 'INVITED') {
      blockedReason = membership === 'ACTIVE' ? 'Already has access' : 'Already invited';
    }
    return {
      contactId: text(row.id),
      fullName: text(row.name),
      email,
      blockedReason,
    };
  });
}

/**
 * The roles a portal membership may carry.
 *
 * DERIVED, NOT HARD-CODED. A role qualifies when it grants at least one
 * permission and every permission it grants is in the PORTAL module. Naming
 * ROLE-PORTAL in a query would work today and would quietly offer an
 * internal role the moment somebody adds a second external one, or hide the
 * new one, and neither failure announces itself.
 *
 * An inactive role is not offered. A role with no permissions at all is not
 * offered either: it would satisfy "nothing outside PORTAL" vacuously and
 * grant a customer a sign-in that can see nothing.
 */
export async function portalRoles(db: Client): Promise<{ roleId: string; roleName: string }[]> {
  const result = await db.execute({
    sql: `SELECT r.role_id, r.role_name FROM access_roles r
          WHERE r.active = 1
            AND EXISTS (SELECT 1 FROM role_permissions rp
                        WHERE rp.role_id = r.role_id AND rp.allowed = 1)
            AND NOT EXISTS (
              SELECT 1 FROM role_permissions rp
              JOIN permissions p ON p.permission_id = rp.permission_id
              WHERE rp.role_id = r.role_id AND rp.allowed = 1 AND p.module_name <> 'PORTAL')
          ORDER BY r.role_name`,
    args: [],
  });
  return result.rows.map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    return { roleId: text(row.role_id), roleName: text(row.role_name) };
  });
}
