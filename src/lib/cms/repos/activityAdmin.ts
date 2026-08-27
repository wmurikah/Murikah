/**
 * The shared activity engine.
 *
 * ONE TABLE, SEVEN PARENTS, ONE ACCESS RULE.
 * Every read and write resolves the parent entity through
 * ../crm/entityAccess.ts before anything else happens. An activity id is not
 * an access grant: fetching by id re-resolves access through the parent,
 * every time, so guessing ids earns nothing. There is no lead_notes, no
 * case_notes, no opportunity_calls, and there must never be.
 *
 * ACCOUNT_ID IS DERIVED, NEVER ACCEPTED.
 * The activity's account column comes from the parent entity on the server.
 * That is both a security property (a payload cannot attach a call to a
 * customer it names) and the reason the account timeline cannot double-count:
 * an activity reachable through a lead and through the lead's account is one
 * row with one account_id, found once by one indexed query.
 *
 * THE DUE-TIME RULE, STATED ONCE.
 * Both `scheduled_at` and `next_action_due` exist. The due time is
 * COALESCE(next_action_due, scheduled_at): an explicit follow-up commitment
 * outranks the planned time of the activity itself, and a task with only a
 * scheduled time is due when it was scheduled. DUE_SQL below is that rule,
 * used by My Work here and read by the phase 16 reminders. No other
 * expression of it exists.
 *
 * FIRST CONTACT.
 * A qualifying activity on a lead whose first_contact_at is NULL sets it in
 * the same transaction as the activity insert, exactly as recordFirstContact
 * does, including not walking a later status backwards. QUALIFYING_CONTACT
 * is the exported constant; phase 15 reads the same array. NOTE and TASK are
 * deliberately absent from it: writing yourself a note is not contacting the
 * customer.
 */
import type { Client, InStatement } from '@libsql/client/web';
import type { FieldError } from '../../validation.ts';
import { newId, auditEventStmt } from './authRecords.ts';
import { toDbTimestamp } from '../auth/session.ts';
import type { WriteContext } from '../admin/guard.ts';
import { resolveEntityAccess, type ActivityEntityType } from '../crm/entityAccess.ts';
import { emitLeadEvent } from '../service/events.ts';

type Stmt = Extract<InStatement, { sql: string }>;

export type WriteResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly kind: 'conflict'; readonly fields: FieldError[] }
  | { readonly ok: false; readonly kind: 'invalid_reference'; readonly fields: FieldError[] }
  | { readonly ok: false; readonly kind: 'not_found' };

const text = (v: unknown): string => String(v ?? '');
const nullableText = (v: unknown): string | null =>
  v === null || v === undefined ? null : String(v);

export const ACTIVITY_TYPES = [
  'CALL',
  'EMAIL',
  'WHATSAPP',
  'MEETING',
  'VISIT',
  'QUOTATION',
  'PROPOSAL',
  'FOLLOW_UP',
  'NOTE',
  'TASK',
  'OTHER',
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

/**
 * The activity types that count as actually contacting the customer. Phase 15
 * stops the lead first-contact SLA on exactly this set, so it lives in one
 * exported constant and never inline in a query.
 */
export const QUALIFYING_CONTACT: readonly ActivityType[] = [
  'CALL',
  'EMAIL',
  'WHATSAPP',
  'MEETING',
  'VISIT',
];

/** The due-time rule. One SQL fragment, used everywhere a due time is read. */
export const DUE_SQL = 'COALESCE(act.next_action_due, act.scheduled_at)';

function audit(
  ctx: WriteContext,
  eventType: string,
  entityId: string,
  action: string,
  before: unknown,
  after: unknown,
): Stmt {
  return auditEventStmt({
    actorUserId: ctx.actorUserId,
    eventType,
    entityType: 'ACTIVITY',
    entityId,
    action,
    beforeJson: before === null ? null : JSON.stringify(before),
    afterJson: after === null ? null : JSON.stringify(after),
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    now: ctx.now,
  }) as Stmt;
}

export interface ActivityRow {
  activityId: string;
  entityType: ActivityEntityType;
  entityId: string;
  accountId: string | null;
  accountName: string | null;
  contactId: string | null;
  contactName: string | null;
  activityType: ActivityType;
  ownerUserId: string;
  ownerName: string;
  summary: string;
  notes: string | null;
  scheduledAt: string | null;
  completedAt: string | null;
  outcome: string | null;
  nextAction: string | null;
  nextActionDue: string | null;
  createdAt: string;
  /** COALESCE(next_action_due, scheduled_at), the one due-time rule. */
  dueAt: string | null;
}

const ACTIVITY_SELECT = `
  SELECT act.activity_id, act.entity_type, act.entity_id, act.account_id,
         a.account_name, act.contact_id, ct.full_name AS contact_name,
         act.activity_type, act.owner_user_id, ou.display_name AS owner_name,
         act.summary, act.notes, act.scheduled_at, act.completed_at, act.outcome,
         act.next_action, act.next_action_due, act.created_at,
         ${DUE_SQL} AS due_at
  FROM activities act
  LEFT JOIN accounts a ON a.account_id = act.account_id
  LEFT JOIN contacts ct ON ct.contact_id = act.contact_id
  JOIN users ou ON ou.user_id = act.owner_user_id`;

function toActivity(row: Record<string, unknown>): ActivityRow {
  return {
    activityId: text(row.activity_id),
    entityType: text(row.entity_type) as ActivityEntityType,
    entityId: text(row.entity_id),
    accountId: nullableText(row.account_id),
    accountName: nullableText(row.account_name),
    contactId: nullableText(row.contact_id),
    contactName: nullableText(row.contact_name),
    activityType: text(row.activity_type) as ActivityType,
    ownerUserId: text(row.owner_user_id),
    ownerName: text(row.owner_name),
    summary: text(row.summary),
    notes: nullableText(row.notes),
    scheduledAt: nullableText(row.scheduled_at),
    completedAt: nullableText(row.completed_at),
    outcome: nullableText(row.outcome),
    nextAction: nullableText(row.next_action),
    nextActionDue: nullableText(row.next_action_due),
    createdAt: text(row.created_at),
    dueAt: nullableText(row.due_at),
  };
}

export const PAGE_SIZE = 25;

// ---- Create ----------------------------------------------------------------

export interface ActivityInput {
  entityType: string;
  entityId: string;
  activityType: ActivityType;
  contactId: string | null;
  ownerUserId: string;
  summary: string;
  notes: string | null;
  scheduledAt: string | null;
  /** Set when the activity is recorded after the fact, which is the common case. */
  completedAt: string | null;
  outcome: string | null;
  nextAction: string | null;
  nextActionDue: string | null;
}

export async function createActivity(
  db: Client,
  userId: string,
  input: ActivityInput,
  ctx: WriteContext,
): Promise<WriteResult<ActivityRow>> {
  // The whole polymorphic control, before anything is written: type known,
  // row exists, caller in scope. An unknown type, a missing row and an
  // out-of-scope row are all the same refusal on purpose.
  const access = await resolveEntityAccess(db, userId, input.entityType, input.entityId);
  if (!access.ok) {
    return {
      ok: false,
      kind: 'invalid_reference',
      fields: [
        { field: 'entityId', message: 'That record does not exist or is outside your scope.' },
      ],
    };
  }

  // A contact belongs to exactly one account. The account here is the one the
  // ENTITY derives, so a contact of some other account cannot be attached
  // whatever ids the payload carries.
  if (input.contactId !== null) {
    if (access.accountId === null) {
      return {
        ok: false,
        kind: 'invalid_reference',
        fields: [
          {
            field: 'contactId',
            message: 'This record has no customer account, so no contact can be attached.',
          },
        ],
      };
    }
    const contact = await db.execute({
      sql: `SELECT contact_id FROM contacts WHERE contact_id = ? AND account_id = ? LIMIT 1`,
      args: [input.contactId, access.accountId],
    });
    if (contact.rows[0] === undefined) {
      return {
        ok: false,
        kind: 'invalid_reference',
        fields: [{ field: 'contactId', message: 'That contact belongs to a different account.' }],
      };
    }
  }

  const activityId = newId('ACT');
  const now = toDbTimestamp(ctx.now);
  const statements: Stmt[] = [
    {
      sql: `INSERT INTO activities
              (activity_id, entity_type, entity_id, account_id, contact_id, activity_type,
               owner_user_id, summary, notes, scheduled_at, completed_at, outcome,
               next_action, next_action_due, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        activityId,
        input.entityType,
        input.entityId,
        access.accountId,
        input.contactId,
        input.activityType,
        input.ownerUserId,
        input.summary,
        input.notes,
        input.scheduledAt,
        input.completedAt,
        input.outcome,
        input.nextAction,
        input.nextActionDue,
        now,
      ],
    },
    audit(ctx, 'ACTIVITY_CREATED', activityId, 'CREATE', null, {
      entityType: input.entityType,
      entityId: input.entityId,
      activityType: input.activityType,
      summary: input.summary,
    }),
  ];

  // First contact, in the same transaction as the activity insert. Both
  // updates are conditional exactly as recordFirstContact's are, so a
  // belated qualifying contact never moves an existing stamp and never walks
  // a QUALIFIED or CONVERTED lead backwards. A NOTE or TASK adds none of
  // this: writing yourself a note is not contacting the customer.
  if (input.entityType === 'LEAD' && QUALIFYING_CONTACT.includes(input.activityType)) {
    statements.push(
      {
        sql: `UPDATE leads SET first_contact_at = ?
              WHERE lead_id = ? AND first_contact_at IS NULL`,
        args: [input.completedAt ?? now, input.entityId],
      },
      {
        sql: `UPDATE leads SET status = 'CONTACTED'
              WHERE lead_id = ? AND status = 'NEW' AND first_contact_at IS NOT NULL`,
        args: [input.entityId],
      },
      auditEventStmt({
        actorUserId: ctx.actorUserId,
        eventType: 'LEAD_CONTACTED',
        entityType: 'LEAD',
        entityId: input.entityId,
        action: 'FIRST_CONTACT',
        beforeJson: null,
        afterJson: JSON.stringify({ throughActivity: activityId }),
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        now: ctx.now,
      }) as Stmt,
    );
  }

  try {
    await db.batch(statements, 'write');
  } catch (error) {
    if (/FOREIGN KEY constraint failed/i.test(String(error))) {
      return {
        ok: false,
        kind: 'invalid_reference',
        fields: [{ field: 'ownerUserId', message: 'A referenced record does not exist.' }],
      };
    }
    throw error;
  }
  const created = await getActivityRaw(db, activityId);
  if (
    created !== null &&
    input.entityType === 'LEAD' &&
    QUALIFYING_CONTACT.includes(input.activityType)
  ) {
    // Emitted whether or not this particular activity was the first: the SLA
    // stop is idempotent, so a later contact stops nothing twice.
    await emitLeadEvent(db, {
      type: 'LEAD_CONTACTED',
      leadId: input.entityId,
      at: ctx.now,
      actorUserId: ctx.actorUserId,
      detail: { at: input.completedAt ?? toDbTimestamp(ctx.now) },
    });
  }
  return created === null ? { ok: false, kind: 'not_found' } : { ok: true, value: created };
}

// ---- Read -------------------------------------------------------------------

/** The bare row, without access resolution. Never exported to a route. */
async function getActivityRaw(db: Client, activityId: string): Promise<ActivityRow | null> {
  const result = await db.execute({
    sql: `${ACTIVITY_SELECT} WHERE act.activity_id = ? LIMIT 1`,
    args: [activityId],
  });
  const row = result.rows[0];
  return row === undefined ? null : toActivity(row as unknown as Record<string, unknown>);
}

/**
 * One activity, by id, for a caller. The row is fetched and then access is
 * resolved through its PARENT, so an activity id gains nobody a record their
 * scope withholds: not by guessing, not from a stale notification.
 */
export async function getActivity(
  db: Client,
  userId: string,
  activityId: string,
): Promise<ActivityRow | null> {
  const row = await getActivityRaw(db, activityId);
  if (row === null) return null;
  const access = await resolveEntityAccess(db, userId, row.entityType, row.entityId);
  return access.ok ? row : null;
}

export interface ActivityQuery {
  readonly activityType: string | null;
  readonly ownerUserId: string | null;
  readonly state: 'all' | 'open' | 'completed';
  readonly from: string | null;
  readonly to: string | null;
  readonly search: string;
  readonly page: number;
}

function activityFilters(query: ActivityQuery): { clauses: string[]; args: unknown[] } {
  const clauses: string[] = [];
  const args: unknown[] = [];
  if (query.activityType !== null) {
    clauses.push('act.activity_type = ?');
    args.push(query.activityType);
  }
  if (query.ownerUserId !== null) {
    clauses.push('act.owner_user_id = ?');
    args.push(query.ownerUserId);
  }
  if (query.state === 'open') clauses.push('act.completed_at IS NULL');
  if (query.state === 'completed') clauses.push('act.completed_at IS NOT NULL');
  if (query.from !== null) {
    clauses.push('act.created_at >= ?');
    args.push(query.from);
  }
  if (query.to !== null) {
    clauses.push('act.created_at <= ?');
    args.push(`${query.to} 23:59:59`);
  }
  if (query.search !== '') {
    clauses.push('(act.summary LIKE ? OR act.notes LIKE ?)');
    args.push(`%${query.search}%`, `%${query.search}%`);
  }
  return { clauses, args };
}

export interface ActivityPage {
  items: ActivityRow[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * The timeline of one entity. Access to the parent is resolved first; the
 * query itself then needs no scope predicate because the parent gate is the
 * scope, and every activity on it hangs off the parent the caller may see.
 */
export async function listEntityActivities(
  db: Client,
  userId: string,
  entityType: string,
  entityId: string,
  query: ActivityQuery,
): Promise<ActivityPage | null> {
  const access = await resolveEntityAccess(db, userId, entityType, entityId);
  if (!access.ok) return null;
  const { clauses, args } = activityFilters(query);
  const where = ['act.entity_type = ?', 'act.entity_id = ?', ...clauses].join(' AND ');
  const baseArgs = [entityType, entityId, ...args];
  const [counted, rows] = await Promise.all([
    db.execute({
      sql: `SELECT COUNT(*) AS n FROM activities act WHERE ${where}`,
      args: baseArgs as never[],
    }),
    db.execute({
      sql: `${ACTIVITY_SELECT} WHERE ${where}
            ORDER BY COALESCE(act.completed_at, act.scheduled_at, act.created_at) DESC,
                     act.activity_id LIMIT ? OFFSET ?`,
      args: [...baseArgs, PAGE_SIZE, (query.page - 1) * PAGE_SIZE] as never[],
    }),
  ]);
  return {
    items: rows.rows.map((r) => toActivity(r as unknown as Record<string, unknown>)),
    total: Number(counted.rows[0]?.n ?? 0),
    page: query.page,
    pageSize: PAGE_SIZE,
  };
}

/**
 * The account timeline: everything recorded against this customer, whether
 * directly or through its leads, opportunities, cases and orders. One row per
 * activity by construction, because account_id is derived at creation; the
 * caller can verify the absence of double counting by comparing this count
 * with the list.
 */
export async function listAccountActivities(
  db: Client,
  userId: string,
  accountId: string,
  query: ActivityQuery,
): Promise<ActivityPage | null> {
  const access = await resolveEntityAccess(db, userId, 'ACCOUNT', accountId);
  if (!access.ok) return null;
  const { clauses, args } = activityFilters(query);
  const where = ['act.account_id = ?', ...clauses].join(' AND ');
  const baseArgs = [accountId, ...args];
  const [counted, rows] = await Promise.all([
    db.execute({
      sql: `SELECT COUNT(*) AS n FROM activities act WHERE ${where}`,
      args: baseArgs as never[],
    }),
    db.execute({
      sql: `${ACTIVITY_SELECT} WHERE ${where}
            ORDER BY COALESCE(act.completed_at, act.scheduled_at, act.created_at) DESC,
                     act.activity_id LIMIT ? OFFSET ?`,
      args: [...baseArgs, PAGE_SIZE, (query.page - 1) * PAGE_SIZE] as never[],
    }),
  ]);
  return {
    items: rows.rows.map((r) => toActivity(r as unknown as Record<string, unknown>)),
    total: Number(counted.rows[0]?.n ?? 0),
    page: query.page,
    pageSize: PAGE_SIZE,
  };
}

// ---- My Work ----------------------------------------------------------------

export interface MyWork {
  /** Not completed, due time passed. */
  overdue: ActivityRow[];
  /** Not completed, due ahead or no due time at all (sorted last). */
  upcoming: ActivityRow[];
  /** Completed in the last seven days. */
  recentlyCompleted: ActivityRow[];
  /** All completed, ever, as a count. The list above is the recent slice. */
  completedTotal: number;
}

/**
 * The four sections, derived from timestamps with no status column. Overdue
 * and upcoming split on DUE_SQL against the caller's now; an open activity
 * with no due time at all is shown under upcoming after the dated ones,
 * because hiding it would lose the row and calling it overdue would invent a
 * deadline nobody set.
 */
export async function myWork(db: Client, userId: string, now: Date): Promise<MyWork> {
  const stamp = toDbTimestamp(now);
  const weekAgo = toDbTimestamp(new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000));
  const [overdue, upcoming, recent, completedCount] = await db.batch(
    [
      {
        sql: `${ACTIVITY_SELECT}
              WHERE act.owner_user_id = ? AND act.completed_at IS NULL
                AND ${DUE_SQL} IS NOT NULL AND ${DUE_SQL} < ?
              ORDER BY ${DUE_SQL} LIMIT 50`,
        args: [userId, stamp],
      },
      {
        sql: `${ACTIVITY_SELECT}
              WHERE act.owner_user_id = ? AND act.completed_at IS NULL
                AND (${DUE_SQL} IS NULL OR ${DUE_SQL} >= ?)
              ORDER BY ${DUE_SQL} IS NULL, ${DUE_SQL} LIMIT 50`,
        args: [userId, stamp],
      },
      {
        sql: `${ACTIVITY_SELECT}
              WHERE act.owner_user_id = ? AND act.completed_at >= ?
              ORDER BY act.completed_at DESC LIMIT 50`,
        args: [userId, weekAgo],
      },
      {
        sql: `SELECT COUNT(*) AS n FROM activities act
              WHERE act.owner_user_id = ? AND act.completed_at IS NOT NULL`,
        args: [userId],
      },
    ],
    'read',
  );
  const map = (result: { rows: unknown[] }) =>
    (result.rows as Record<string, unknown>[]).map(toActivity);
  return {
    overdue: map(overdue),
    upcoming: map(upcoming),
    recentlyCompleted: map(recent),
    completedTotal: Number((completedCount.rows[0] as Record<string, unknown>)?.n ?? 0),
  };
}

// ---- Update, complete, reassign ---------------------------------------------

export interface ActivityPatch {
  summary: string;
  notes: string | null;
  outcome: string | null;
  nextAction: string | null;
  nextActionDue: string | null;
  scheduledAt: string | null;
}

export async function updateActivity(
  db: Client,
  userId: string,
  activityId: string,
  patch: ActivityPatch,
  ctx: WriteContext,
): Promise<WriteResult<ActivityRow>> {
  const before = await getActivity(db, userId, activityId);
  if (before === null) return { ok: false, kind: 'not_found' };
  await db.batch(
    [
      {
        sql: `UPDATE activities SET summary = ?, notes = ?, outcome = ?, next_action = ?,
                next_action_due = ?, scheduled_at = ?
              WHERE activity_id = ?`,
        args: [
          patch.summary,
          patch.notes,
          patch.outcome,
          patch.nextAction,
          patch.nextActionDue,
          patch.scheduledAt,
          activityId,
        ],
      },
      audit(
        ctx,
        'ACTIVITY_UPDATED',
        activityId,
        'UPDATE',
        {
          summary: before.summary,
          notes: before.notes,
          outcome: before.outcome,
          nextAction: before.nextAction,
          nextActionDue: before.nextActionDue,
          scheduledAt: before.scheduledAt,
        },
        patch,
      ),
    ],
    'write',
  );
  const after = await getActivityRaw(db, activityId);
  return after === null ? { ok: false, kind: 'not_found' } : { ok: true, value: after };
}

/**
 * Completion sets completed_at once. Completing an already completed activity
 * is answered with the row as it stands rather than moving the timestamp:
 * when the work was done is a fact, and a second click is not new work.
 */
export async function completeActivity(
  db: Client,
  userId: string,
  activityId: string,
  outcome: string | null,
  ctx: WriteContext,
): Promise<WriteResult<ActivityRow>> {
  const before = await getActivity(db, userId, activityId);
  if (before === null) return { ok: false, kind: 'not_found' };
  if (before.completedAt !== null) return { ok: true, value: before };
  const now = toDbTimestamp(ctx.now);
  await db.batch(
    [
      {
        sql: `UPDATE activities SET completed_at = ?, outcome = COALESCE(?, outcome)
              WHERE activity_id = ? AND completed_at IS NULL`,
        args: [now, outcome, activityId],
      },
      audit(
        ctx,
        'ACTIVITY_COMPLETED',
        activityId,
        'COMPLETE',
        { completedAt: null },
        {
          completedAt: now,
          outcome,
        },
      ),
    ],
    'write',
  );
  const after = await getActivityRaw(db, activityId);
  return after === null ? { ok: false, kind: 'not_found' } : { ok: true, value: after };
}

export async function reassignActivity(
  db: Client,
  userId: string,
  activityId: string,
  newOwnerUserId: string,
  ctx: WriteContext,
): Promise<WriteResult<ActivityRow>> {
  const before = await getActivity(db, userId, activityId);
  if (before === null) return { ok: false, kind: 'not_found' };
  try {
    await db.batch(
      [
        {
          sql: `UPDATE activities SET owner_user_id = ? WHERE activity_id = ?`,
          args: [newOwnerUserId, activityId],
        },
        audit(
          ctx,
          'ACTIVITY_REASSIGNED',
          activityId,
          'REASSIGN',
          { ownerUserId: before.ownerUserId },
          { ownerUserId: newOwnerUserId },
        ),
      ],
      'write',
    );
  } catch (error) {
    if (/FOREIGN KEY constraint failed/i.test(String(error))) {
      return {
        ok: false,
        kind: 'invalid_reference',
        fields: [{ field: 'ownerUserId', message: 'That user does not exist.' }],
      };
    }
    throw error;
  }
  const after = await getActivityRaw(db, activityId);
  return after === null ? { ok: false, kind: 'not_found' } : { ok: true, value: after };
}
