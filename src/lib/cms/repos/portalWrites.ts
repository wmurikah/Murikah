/**
 * The three things a customer may write, and the checks each one passes.
 *
 * THE CUSTOMER NEVER SELECTS AN ACCOUNT.
 * A case is raised against the account derived from the membership, and the
 * contact is the one the membership names. Nothing in these payloads carries
 * an account or a contact identifier, so there is no field to tamper with.
 *
 * PRIORITY COMES FROM THE CATEGORY.
 * A customer cannot declare an incident critical. If every customer can, the
 * word stops meaning anything and the queue stops being a queue. The
 * category's configured default is the priority, exactly as it is for a case
 * raised by an agent who lacks the override permission.
 *
 * A REPLY RESUMES THE CLOCK THROUGH THE ENGINE.
 * Where the case was waiting on the customer, the reply emits the phase 15
 * domain event and the SLA engine decides what that means. This module does
 * not touch a timer, because there is exactly one implementation of that and
 * it is not here.
 */
import type { Client, InStatement } from '@libsql/client/web';
import { newId } from './authRecords.ts';
import { auditEventStmt } from './authRecords.ts';
import { toDbTimestamp } from '../auth/session.ts';
import { emitCaseEvent } from '../service/events.ts';
import { withGeneratedNumber, NUMBER_PREFIX } from '../crm/numbering.ts';
import type { PortalScope } from '../portal/tenant.ts';

type Stmt = Extract<InStatement, { sql: string }>;
const text = (v: unknown): string => String(v ?? '');

export type PortalWriteResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string; readonly field?: string };

export interface PortalCaseInput {
  /** ENQUIRY, COMPLAINT or REQUEST. A customer raises no other kind. */
  caseType: 'ENQUIRY' | 'COMPLAINT' | 'REQUEST';
  caseCategoryId: string;
  subject: string;
  description: string;
}

export const PORTAL_CASE_TYPES = ['ENQUIRY', 'COMPLAINT', 'REQUEST'] as const;

/**
 * Raise a real service case from the portal.
 *
 * It is a `service_cases` row like any other, with `channel = 'WEB'`, so it
 * reaches the same queues, the same SLA rules and the same analytics as a
 * case raised by telephone. A separate "portal enquiry" concept would have
 * been a second inbox nobody watches.
 */
export async function raisePortalCase(
  db: Client,
  scope: PortalScope,
  input: PortalCaseInput,
  now: Date,
): Promise<PortalWriteResult<{ caseId: string; caseNumber: string }>> {
  if (!(PORTAL_CASE_TYPES as readonly string[]).includes(input.caseType)) {
    return { ok: false, reason: 'Choose a request type.', field: 'caseType' };
  }
  if (input.subject.trim() === '') {
    return { ok: false, reason: 'Tell us what this is about.', field: 'subject' };
  }
  if (input.description.trim() === '') {
    return { ok: false, reason: 'Add a little detail so we can help.', field: 'description' };
  }

  const category = await db.execute({
    sql: `SELECT default_priority FROM case_categories WHERE case_category_id = ? AND active = 1`,
    args: [input.caseCategoryId],
  });
  const categoryRow = category.rows[0];
  if (categoryRow === undefined) {
    return { ok: false, reason: 'Choose what this is about.', field: 'caseCategoryId' };
  }

  const stamp = toDbTimestamp(now);
  const caseId = newId('CASE');
  // The account and the contact come from the membership. There is no field
  // for either in the payload, so there is nothing for a browser to change.
  const accountId = scope.activeAccountId;
  const created = await withGeneratedNumber(
    NUMBER_PREFIX.case,
    'case_number',
    now,
    async (caseNumber: string) => {
      const statements: Stmt[] = [
        {
          sql: `INSERT INTO service_cases
                  (case_id, case_number, account_id, contact_id, business_unit_id, case_type,
                   case_category_id, priority, subject, description, channel, status,
                   assigned_team_id, assigned_user_id, raised_at, created_by_user_id, created_at)
                VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 'WEB', 'NEW', NULL, NULL, ?, ?, ?)`,
          args: [
            caseId,
            caseNumber,
            accountId,
            scope.contactId,
            input.caseType,
            input.caseCategoryId,
            // The category decides. A customer cannot declare a critical incident.
            text(categoryRow.default_priority),
            input.subject.trim().slice(0, 200),
            input.description.trim().slice(0, 4000),
            stamp,
            scope.userId,
            stamp,
          ],
        },
        {
          sql: `INSERT INTO case_status_history
                  (case_status_history_id, case_id, from_status, to_status, changed_by_user_id, changed_at, reason)
                VALUES (?, ?, NULL, 'NEW', ?, ?, 'Raised from the customer portal')`,
          args: [newId('CSH'), caseId, scope.userId, stamp],
        },
        {
          sql: `INSERT INTO case_communications
                  (communication_id, case_id, direction, channel, contact_id, user_id, subject,
                   message_summary, communicated_at)
                VALUES (?, ?, 'INBOUND', 'WEB', ?, NULL, ?, ?, ?)`,
          args: [
            newId('COMM'),
            caseId,
            scope.contactId,
            input.subject.trim().slice(0, 200),
            input.description.trim().slice(0, 4000),
            stamp,
          ],
        },
      ];
      await db.batch(statements, 'write');
      return { caseId, caseNumber };
    },
  );

  // After the commit, never inside it.
  await emitCaseEvent(db, {
    type: 'CASE_CREATED',
    caseId,
    at: now,
    actorUserId: scope.userId,
    detail: { accountId, channel: 'WEB', source: 'PORTAL' },
  });
  return { ok: true, value: created };
}

/**
 * A customer reply. INBOUND, channel WEB, and where the case was waiting on
 * them it emits the status change so the engine can resume its clock.
 */
export async function replyToPortalCase(
  db: Client,
  scope: PortalScope,
  caseId: string,
  message: string,
  now: Date,
): Promise<PortalWriteResult<{ communicationId: string }>> {
  if (message.trim() === '') {
    return { ok: false, reason: 'Type a message first.', field: 'message' };
  }
  // The same tenant check as every read: an id from a browser names nothing
  // until this query has found it inside the caller's own accounts.
  const found = await db.execute({
    sql: `SELECT sc.case_id, sc.status FROM service_cases sc
          WHERE sc.case_id = ? AND sc.account_id IN (${scope.accountIds.map(() => '?').join(', ')})
          LIMIT 1`,
    args: [caseId, ...scope.accountIds],
  });
  const row = found.rows[0] as Record<string, unknown> | undefined;
  // Not found and not yours are the same answer.
  if (row === undefined) return { ok: false, reason: 'not_found' };

  const stamp = toDbTimestamp(now);
  const communicationId = newId('COMM');
  const wasWaiting = text(row.status) === 'WAITING_CUSTOMER';
  const statements: Stmt[] = [
    {
      sql: `INSERT INTO case_communications
              (communication_id, case_id, direction, channel, contact_id, user_id, subject,
               message_summary, communicated_at)
            VALUES (?, ?, 'INBOUND', 'WEB', ?, NULL, NULL, ?, ?)`,
      args: [communicationId, caseId, scope.contactId, message.trim().slice(0, 4000), stamp],
    },
  ];
  if (wasWaiting) {
    // The customer has answered, so the case is ours again.
    statements.push(
      {
        sql: `UPDATE service_cases SET status = 'IN_PROGRESS' WHERE case_id = ? AND status = 'WAITING_CUSTOMER'`,
        args: [caseId],
      },
      {
        sql: `INSERT INTO case_status_history
                (case_status_history_id, case_id, from_status, to_status, changed_by_user_id, changed_at, reason)
              VALUES (?, ?, 'WAITING_CUSTOMER', 'IN_PROGRESS', ?, ?, 'Customer replied from the portal')`,
        args: [newId('CSH'), caseId, scope.userId, stamp],
      },
    );
  }
  await db.batch(statements, 'write');

  if (wasWaiting) {
    // The phase 15 engine decides what resuming means. Nothing here touches
    // a timer, because there is one implementation of that and it is not here.
    await emitCaseEvent(db, {
      type: 'CASE_STATUS_CHANGED',
      caseId,
      at: now,
      actorUserId: scope.userId,
      detail: {
        fromStatus: 'WAITING_CUSTOMER',
        toStatus: 'IN_PROGRESS',
        communicationId,
        source: 'PORTAL',
      },
    });
  }
  return { ok: true, value: { communicationId } };
}

/**
 * Answer a survey, once.
 *
 * THE DATABASE ENFORCES ONCE, NOT A DISABLED BUTTON.
 * `survey_invitations.survey_response_id` is UNIQUE and the invitation is
 * unique per (survey, case, contact). A second submission therefore fails on
 * a constraint, which this catches and reports as "already answered" rather
 * than crashing. A button that hides itself is a courtesy; the constraint is
 * the control.
 */
export async function answerPortalSurvey(
  db: Client,
  scope: PortalScope,
  invitationId: string,
  score: number,
  comments: string | null,
  now: Date,
): Promise<PortalWriteResult<{ surveyResponseId: string }>> {
  if (!Number.isInteger(score) || score < 0 || score > 10) {
    return { ok: false, reason: 'Choose a score from 0 to 10.', field: 'score' };
  }
  const found = await db.execute({
    sql: `SELECT si.survey_invitation_id, si.survey_id, si.case_id, si.contact_id,
            si.account_id, si.survey_response_id
          FROM survey_invitations si
          WHERE si.survey_invitation_id = ?
            AND si.account_id IN (${scope.accountIds.map(() => '?').join(', ')})
          LIMIT 1`,
    args: [invitationId, ...scope.accountIds],
  });
  const row = found.rows[0] as Record<string, unknown> | undefined;
  if (row === undefined) return { ok: false, reason: 'not_found' };
  if (row.survey_response_id !== null) {
    return { ok: false, reason: 'This survey has already been answered. Thank you.' };
  }

  const stamp = toDbTimestamp(now);
  const surveyResponseId = newId('SRESP');
  try {
    await db.batch(
      [
        {
          sql: `INSERT INTO survey_responses
                  (survey_response_id, survey_id, case_id, account_id, contact_id, score,
                   comments, responded_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            surveyResponseId,
            text(row.survey_id),
            row.case_id === null ? null : text(row.case_id),
            text(row.account_id),
            row.contact_id === null ? null : text(row.contact_id),
            score,
            comments === null || comments.trim() === '' ? null : comments.trim().slice(0, 2000),
            stamp,
          ],
        },
        {
          // The UNIQUE column is what makes a second answer impossible. A
          // concurrent submission fails here and is handled below.
          sql: `UPDATE survey_invitations SET survey_response_id = ?
                WHERE survey_invitation_id = ? AND survey_response_id IS NULL`,
          args: [surveyResponseId, invitationId],
        },
      ],
      'write',
    );
  } catch (error) {
    if (/UNIQUE constraint failed/i.test(String(error))) {
      return { ok: false, reason: 'This survey has already been answered. Thank you.' };
    }
    throw error;
  }
  return { ok: true, value: { surveyResponseId } };
}

// ---- Membership administration, on the internal side -------------------------

export type MembershipResult =
  | { ok: true; membershipId: string; userId: string }
  | { ok: false; reason: string; field?: string };

export const PORTAL_AUDIT = {
  invited: 'PORTAL_USER_INVITED',
  activated: 'PORTAL_USER_ACTIVATED',
  suspended: 'PORTAL_MEMBERSHIP_SUSPENDED',
  revoked: 'PORTAL_MEMBERSHIP_REVOKED',
} as const;

/**
 * A contact's `full_name` as the first and last name a user record needs.
 *
 * `contacts` stores one name and `users` stores two, so something has to
 * decide. The first token is the first name and the remainder is the family
 * name, which is right for the great majority of Kenyan and East African
 * names as they are entered here; a single-token name uses that token for
 * both rather than storing an empty string in a NOT NULL column. The display
 * name is always the contact's own full name, unaltered, so whatever the
 * split does the person's name is shown exactly as somebody typed it.
 */
export function splitContactName(fullName: string): {
  first: string;
  last: string;
  display: string;
} {
  const display = fullName.trim();
  const parts = display.split(/\s+/).filter((part) => part !== '');
  if (parts.length === 0) return { first: 'Portal', last: 'User', display: 'Portal User' };
  if (parts.length === 1) {
    return { first: parts[0] as string, last: parts[0] as string, display };
  }
  return { first: parts[0] as string, last: parts.slice(1).join(' '), display };
}

/**
 * Invite a contact to the portal.
 *
 * AN INTERNAL EMPLOYEE IS NEVER CONVERTED. `user_type` is checked and an
 * INTERNAL user is refused outright: an employee who could also sign in as a
 * customer would carry their internal permissions into a surface built on
 * the assumption that nobody there has any.
 *
 * A CONTACT WITH NO EMAIL CANNOT BE INVITED, and the interface says so
 * rather than failing quietly. Every user needs an email; the contact stays
 * perfectly valid, only the invitation is unavailable until somebody adds
 * one.
 */
export async function invitePortalUser(
  db: Client,
  actorUserId: string,
  input: { contactId: string; accountId: string; portalRoleId: string },
  now: Date,
  ip: string | null,
  userAgent: string | null,
): Promise<MembershipResult> {
  const contact = await db.execute({
    sql: `SELECT c.contact_id, c.account_id, c.email, c.full_name
          FROM contacts c WHERE c.contact_id = ?`,
    args: [input.contactId],
  });
  const contactRow = contact.rows[0] as Record<string, unknown> | undefined;
  if (contactRow === undefined) return { ok: false, reason: 'That contact does not exist.' };
  if (text(contactRow.account_id) !== input.accountId) {
    return { ok: false, reason: 'That contact does not belong to this account.' };
  }
  const email = contactRow.email === null ? '' : text(contactRow.email);
  if (email.trim() === '') {
    return {
      ok: false,
      field: 'email',
      reason:
        'This contact has no email address, and every portal user needs one. Add an email to the contact first; the contact itself is fine as it is.',
    };
  }

  const existingUser = await db.execute({
    sql: `SELECT user_id, user_type, status FROM users WHERE email = ?`,
    args: [email],
  });
  const userRow = existingUser.rows[0] as Record<string, unknown> | undefined;
  if (userRow !== undefined && text(userRow.user_type) === 'INTERNAL') {
    return {
      ok: false,
      reason:
        'That email belongs to an internal employee, and an employee is never converted into a portal customer.',
    };
  }

  const stamp = toDbTimestamp(now);
  const names = splitContactName(text(contactRow.full_name));
  const userId = userRow === undefined ? newId('USR') : text(userRow.user_id);
  const membershipId = newId('CPM');
  const statements: Stmt[] = [];
  if (userRow === undefined) {
    statements.push({
      sql: `INSERT INTO users
              (user_id, user_type, employee_no, first_name, last_name, display_name, email,
               status, email_verified_at, created_at, updated_at)
            VALUES (?, 'EXTERNAL', NULL, ?, ?, ?, ?, 'INVITED', NULL, ?, ?)`,
      args: [userId, names.first, names.last, names.display, email, stamp, stamp],
    });
  }
  statements.push(
    {
      sql: `INSERT INTO customer_portal_memberships
              (portal_membership_id, user_id, account_id, contact_id, portal_role_id, status,
               invited_at, invited_by_user_id, created_at)
            VALUES (?, ?, ?, ?, ?, 'INVITED', ?, ?, ?)
            ON CONFLICT(user_id, account_id) DO UPDATE SET
              status = 'INVITED', invited_at = excluded.invited_at,
              invited_by_user_id = excluded.invited_by_user_id`,
      args: [
        membershipId,
        userId,
        input.accountId,
        input.contactId,
        input.portalRoleId,
        stamp,
        actorUserId,
        stamp,
      ],
    },
    auditEventStmt({
      actorUserId,
      eventType: PORTAL_AUDIT.invited,
      entityType: 'PORTAL_MEMBERSHIP',
      entityId: membershipId,
      action: 'INVITE',
      beforeJson: null,
      afterJson: JSON.stringify({ accountId: input.accountId, contactId: input.contactId }),
      ip,
      userAgent,
      now,
    }) as Stmt,
  );
  await db.batch(statements, 'write');
  return { ok: true, membershipId, userId };
}

/** Suspend or revoke a membership. Both are audited; neither deletes a user. */
export async function setMembershipStatus(
  db: Client,
  actorUserId: string,
  membershipId: string,
  status: 'ACTIVE' | 'SUSPENDED' | 'REVOKED',
  now: Date,
  ip: string | null,
  userAgent: string | null,
): Promise<MembershipResult> {
  const found = await db.execute({
    sql: `SELECT portal_membership_id, user_id, status FROM customer_portal_memberships
          WHERE portal_membership_id = ?`,
    args: [membershipId],
  });
  const row = found.rows[0] as Record<string, unknown> | undefined;
  if (row === undefined) return { ok: false, reason: 'That membership does not exist.' };

  const eventType =
    status === 'SUSPENDED'
      ? PORTAL_AUDIT.suspended
      : status === 'REVOKED'
        ? PORTAL_AUDIT.revoked
        : PORTAL_AUDIT.activated;
  await db.batch(
    [
      {
        sql: `UPDATE customer_portal_memberships
              SET status = ?, activated_at = CASE WHEN ? = 'ACTIVE' THEN ? ELSE activated_at END
              WHERE portal_membership_id = ?`,
        args: [status, status, toDbTimestamp(now), membershipId],
      },
      auditEventStmt({
        actorUserId,
        eventType,
        entityType: 'PORTAL_MEMBERSHIP',
        entityId: membershipId,
        action: status,
        beforeJson: JSON.stringify({ status: text(row.status) }),
        afterJson: JSON.stringify({ status }),
        ip,
        userAgent,
        now,
      }) as Stmt,
    ],
    'write',
  );
  return { ok: true, membershipId, userId: text(row.user_id) };
}
