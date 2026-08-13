/**
 * Who a requirement is sent to, and in what capacity (Build Prompt 69).
 *
 * TWO TABLES, TWO QUESTIONS. `requirement_owners` answers "who may upload
 * against this", and it is the access check the submit endpoint runs.
 * `requirement_recipients` answers "who is written to about it", which is a
 * larger set: a depot accountant owes the reconciliations, and their finance
 * manager is copied so they know the request was made. Collapsing the two would
 * mean either that a copy recipient can answer on the unit's behalf, or that
 * there is no way to copy anybody, and both were the reason requests kept
 * happening in email instead.
 *
 * ONE SOURCE OF TRUTH FOR AN ADDRESS. The row names a user and a capacity, and
 * nothing else. The email is resolved by joining `users` at the moment it is
 * needed, so a person who changes their address is written to at the new one:
 * a copy of it on the junction would be right on the day it was written and
 * wrong every day after somebody updated their account. The applied schema
 * carries no `email` column for exactly that reason, and this module reconciles
 * to it.
 *
 * The junction carries its own `organization_id`, so the writes stamp it and
 * the reads still scope through the requirement, which is the tenant boundary
 * the rest of the module uses.
 */
import type { Client, InStatement } from '@libsql/client/web';
import { C, cols } from '@grc/schema/columns';

const RR = cols(C.requirement_recipients);
const R = cols(C.work_paper_requirements);
const U = cols(C.users);

/** What a recipient is here for. */
export const RECIPIENT_ROLE = {
  /** Owes the answer, and is the only one who may upload. */
  OWNER: 'OWNER',
  /** Kept informed, and uploads nothing. */
  CC: 'CC',
} as const;

export type RecipientRole = (typeof RECIPIENT_ROLE)[keyof typeof RECIPIENT_ROLE];

/** A role read from a form or a row, defaulting to OWNER rather than throwing. */
export function recipientRole(raw: string | null | undefined): RecipientRole {
  return String(raw ?? '')
    .trim()
    .toUpperCase() === RECIPIENT_ROLE.CC
    ? RECIPIENT_ROLE.CC
    : RECIPIENT_ROLE.OWNER;
}

export interface Recipient {
  userId: string;
  name: string;
  email: string | null;
  role: RecipientRole;
}

/** Everyone named on a requirement, owners first, then the copy list. */
export async function listRecipients(
  db: Client,
  organizationId: string,
  requirementId: string,
): Promise<Recipient[]> {
  const res = await db.execute({
    // The address comes from `users`, every time it is read. There is nowhere
    // else it could come from, and that is the point.
    sql: `SELECT rr.${RR.user_id} AS user_id, rr.${RR.recipient_role} AS role,
                 COALESCE(u.${U.full_name}, u.${U.email}, rr.${RR.user_id}) AS name,
                 u.${U.email} AS email
            FROM requirement_recipients rr
            JOIN work_paper_requirements r
              ON r.${R.requirement_id} = rr.${RR.requirement_id}
             AND r.${R.organization_id} = ?
            LEFT JOIN users u ON u.${U.user_id} = rr.${RR.user_id}
           WHERE rr.${RR.requirement_id} = ?
        ORDER BY CASE WHEN UPPER(rr.${RR.recipient_role}) = 'CC' THEN 1 ELSE 0 END,
                 name ASC`,
    args: [organizationId, requirementId],
  });
  return res.rows.map((r) => ({
    userId: String(r.user_id),
    name: String(r.name ?? r.user_id),
    email: r.email == null ? null : String(r.email),
    role: recipientRole(r.role == null ? null : String(r.role)),
  }));
}

/**
 * The user ids a requirement's mail goes to, owners and copies alike.
 *
 * One list, because the email is the same email: what was asked for, when it is
 * wanted, and a way in. Telling the copy recipient less than the owner would
 * defeat the point of copying them.
 */
export async function recipientIds(
  db: Client,
  organizationId: string,
  requirementId: string,
): Promise<string[]> {
  const rows = await listRecipients(db, organizationId, requirementId);
  return [...new Set(rows.map((r) => r.userId))];
}

/**
 * Whether this person is named on the requirement at all, in any capacity.
 *
 * This is what lets a copy recipient open the requirement and read it. It is
 * deliberately NOT the check the upload runs: providing the answer is the
 * owner's, and `isRequirementOwner` is what decides that.
 */
export async function isRequirementRecipient(
  db: Client,
  requirementId: string,
  userId: string,
): Promise<boolean> {
  const res = await db.execute({
    sql: `SELECT 1 FROM requirement_recipients
           WHERE ${RR.requirement_id} = ? AND ${RR.user_id} = ? LIMIT 1`,
    args: [requirementId, userId],
  });
  return res.rows.length > 0;
}

/**
 * The insert for one recipient, batchable with the requirement it belongs to.
 *
 * Five columns, which is every column the table has: who, in what capacity,
 * whose organisation, and when. No address is copied here, because the address
 * lives on the user and is joined when it is needed.
 */
export function recipientStatement(
  organizationId: string,
  requirementId: string,
  userId: string,
  role: RecipientRole,
  now: string,
): InStatement {
  return {
    sql: `INSERT INTO requirement_recipients
            (${RR.requirement_id}, ${RR.user_id}, ${RR.recipient_role},
             ${RR.organization_id}, ${RR.created_at})
          VALUES (?, ?, ?, ?, ?)`,
    args: [requirementId, userId, role, organizationId, now],
  };
}
