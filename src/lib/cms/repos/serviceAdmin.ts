/**
 * Reads and writes for customer service cases.
 *
 * CURRENT STATE ON THE CASE, THE PAST IN THE HISTORY TABLES.
 * `service_cases` holds where a case is now. Every assignment change writes a
 * `case_assignment_history` row and every status change writes a
 * `case_status_history` row, in the same transaction as the change, so the
 * two can never disagree. Business history lives there; `audit_events`
 * records who changed the system; both are written where this file writes.
 *
 * ASSIGNMENT DOES NOT GRANT ACCESS.
 * Scope comes from the Build Prompt 07 resolver alone: business unit on the
 * case, country and affiliate through the account, team through
 * assigned_team_id, OWN through assigned_user_id. Assigning a case to a user
 * whose scope excludes it does not make it visible to them; their name is on
 * the row, the resolver still answers no, and the test proves it. The
 * reconciliation is deliberate: an administrator who assigns across a scope
 * boundary sees the assignee fail to reach the case and fixes the scope,
 * which is the correction that leaves the access model intact.
 *
 * THE STATUS MACHINE IS EXPLICIT.
 * CASE_TRANSITIONS below is the whole rule. Closed does not go to new;
 * reopening is its own controlled action to IN_PROGRESS with a mandatory
 * reason and the MANAGE permission. WAITING_CUSTOMER and WAITING_INTERNAL
 * are recorded faithfully and pause nothing: the SLA engine of phase 15
 * decides what a wait means, and nothing here fakes an SLA value.
 *
 * THE PORTAL BOUNDARY IS A DIFFERENT SHAPE, NOT A FILTER.
 * `portalCommunications` selects `direction <> 'INTERNAL'` in SQL and maps to
 * a portal shape that has no internal fields to leak. An INTERNAL row never
 * enters the result set, so no template needs to remember to hide it.
 */
import type { Client, InStatement } from '@libsql/client/web';
import type { FieldError } from '../../validation.ts';
import { newId, auditEventStmt } from './authRecords.ts';
import { toDbTimestamp } from '../auth/session.ts';
import type { WriteContext } from '../admin/guard.ts';
import { resolveScope, scopePredicate, DENY_ALL, type Predicate } from '../auth/rbac.ts';
import { CASES_VIEW } from '../permissions.ts';
import { NUMBER_PREFIX, withGeneratedNumber } from '../crm/numbering.ts';
import { emitCaseEvent } from '../service/events.ts';

type Stmt = Extract<InStatement, { sql: string }>;

export type WriteResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly kind: 'conflict'; readonly fields: FieldError[] }
  | { readonly ok: false; readonly kind: 'invalid_reference'; readonly fields: FieldError[] }
  | { readonly ok: false; readonly kind: 'not_found' };

const text = (v: unknown): string => String(v ?? '');
const nullableText = (v: unknown): string | null =>
  v === null || v === undefined ? null : String(v);

export const CASE_TYPES = [
  'ENQUIRY',
  'COMPLAINT',
  'REQUEST',
  'INCIDENT',
  'FEEDBACK',
  'COMPLIMENT',
] as const;
export const CASE_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export const CASE_CHANNELS = [
  'EMAIL',
  'PHONE',
  'WHATSAPP',
  'WEB',
  'WALK_IN',
  'SOCIAL',
  'OTHER',
] as const;
/**
 * The communication channel list differs from the case channel list: there is
 * no WALK_IN or SOCIAL here, and there is NOTE. Two constants on purpose.
 */
export const COMMUNICATION_CHANNELS = [
  'EMAIL',
  'PHONE',
  'WHATSAPP',
  'WEB',
  'NOTE',
  'OTHER',
] as const;
export const CASE_STATUSES = [
  'NEW',
  'ASSIGNED',
  'IN_PROGRESS',
  'WAITING_CUSTOMER',
  'WAITING_INTERNAL',
  'RESOLVED',
  'CLOSED',
  'CANCELLED',
] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

/**
 * The transition table, in full. Anything absent is refused. Closed never
 * returns to new; the one road out of CLOSED is the controlled reopen to
 * IN_PROGRESS, gated separately on the MANAGE permission and a reason.
 */
export const CASE_TRANSITIONS: Readonly<Record<CaseStatus, readonly CaseStatus[]>> = {
  NEW: ['ASSIGNED', 'IN_PROGRESS', 'CANCELLED'],
  ASSIGNED: ['IN_PROGRESS', 'WAITING_CUSTOMER', 'WAITING_INTERNAL', 'CANCELLED'],
  IN_PROGRESS: ['WAITING_CUSTOMER', 'WAITING_INTERNAL', 'RESOLVED', 'CANCELLED'],
  WAITING_CUSTOMER: ['IN_PROGRESS', 'RESOLVED', 'CANCELLED'],
  WAITING_INTERNAL: ['IN_PROGRESS', 'RESOLVED', 'CANCELLED'],
  RESOLVED: ['CLOSED', 'IN_PROGRESS'],
  CLOSED: ['IN_PROGRESS'],
  CANCELLED: [],
};

/**
 * What counts as the first response: an OUTBOUND communication on a
 * customer-facing channel. INTERNAL never counts, and an outbound NOTE is a
 * contradiction this constant simply excludes. Phase 15 stops the
 * first-response SLA on exactly this rule, so it lives here, exported, once.
 */
export const QUALIFYING_FIRST_RESPONSE = {
  direction: 'OUTBOUND',
  channels: ['EMAIL', 'PHONE', 'WHATSAPP', 'WEB', 'OTHER'],
} as const;

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
    entityType: 'CASE',
    entityId,
    action,
    beforeJson: before === null ? null : JSON.stringify(before),
    afterJson: after === null ? null : JSON.stringify(after),
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    now: ctx.now,
  }) as Stmt;
}

// ---- Scope -----------------------------------------------------------------

/**
 * The canonical case scope. src/lib/cms/crm/entityAccess.ts imports this so
 * the activity engine and the case module answer access identically.
 */
export async function scopedCases(db: Client, userId: string): Promise<Predicate> {
  const resolution = await resolveScope(db, userId, CASES_VIEW);
  if (!resolution.granted) return DENY_ALL;
  return scopePredicate(resolution, {
    country: 'a.country_id',
    affiliate: 'a.affiliate_id',
    businessUnit: 'sc.business_unit_id',
    team: 'sc.assigned_team_id',
    owner: 'sc.assigned_user_id',
  });
}

// ---- Row shapes ------------------------------------------------------------

export interface CaseRow {
  caseId: string;
  caseNumber: string;
  accountId: string;
  accountName: string;
  contactId: string | null;
  contactName: string | null;
  businessUnitId: string | null;
  businessUnitName: string | null;
  caseType: string;
  caseCategoryId: string;
  categoryName: string;
  subcategoryName: string;
  priority: string;
  subject: string;
  description: string;
  channel: string;
  status: CaseStatus;
  assignedTeamId: string | null;
  assignedTeamName: string | null;
  assignedUserId: string | null;
  assignedUserName: string | null;
  raisedAt: string;
  firstResponseAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  rootCause: string | null;
  resolutionSummary: string | null;
  createdByUserId: string;
  createdAt: string;
}

const CASE_SELECT = `
  SELECT sc.case_id, sc.case_number, sc.account_id, a.account_name, sc.contact_id,
         ct.full_name AS contact_name, sc.business_unit_id, bu.business_unit_name,
         sc.case_type, sc.case_category_id, cc.category_name, cc.subcategory_name,
         sc.priority, sc.subject, sc.description, sc.channel, sc.status,
         sc.assigned_team_id, tm.team_name AS assigned_team_name, sc.assigned_user_id,
         au.display_name AS assigned_user_name, sc.raised_at, sc.first_response_at,
         sc.resolved_at, sc.closed_at, sc.root_cause, sc.resolution_summary,
         sc.created_by_user_id, sc.created_at
  FROM service_cases sc
  JOIN accounts a ON a.account_id = sc.account_id
  JOIN case_categories cc ON cc.case_category_id = sc.case_category_id
  LEFT JOIN contacts ct ON ct.contact_id = sc.contact_id
  LEFT JOIN business_units bu ON bu.business_unit_id = sc.business_unit_id
  LEFT JOIN teams tm ON tm.team_id = sc.assigned_team_id
  LEFT JOIN users au ON au.user_id = sc.assigned_user_id`;

function toCase(row: Record<string, unknown>): CaseRow {
  return {
    caseId: text(row.case_id),
    caseNumber: text(row.case_number),
    accountId: text(row.account_id),
    accountName: text(row.account_name),
    contactId: nullableText(row.contact_id),
    contactName: nullableText(row.contact_name),
    businessUnitId: nullableText(row.business_unit_id),
    businessUnitName: nullableText(row.business_unit_name),
    caseType: text(row.case_type),
    caseCategoryId: text(row.case_category_id),
    categoryName: text(row.category_name),
    subcategoryName: text(row.subcategory_name),
    priority: text(row.priority),
    subject: text(row.subject),
    description: text(row.description),
    channel: text(row.channel),
    status: text(row.status) as CaseStatus,
    assignedTeamId: nullableText(row.assigned_team_id),
    assignedTeamName: nullableText(row.assigned_team_name),
    assignedUserId: nullableText(row.assigned_user_id),
    assignedUserName: nullableText(row.assigned_user_name),
    raisedAt: text(row.raised_at),
    firstResponseAt: nullableText(row.first_response_at),
    resolvedAt: nullableText(row.resolved_at),
    closedAt: nullableText(row.closed_at),
    rootCause: nullableText(row.root_cause),
    resolutionSummary: nullableText(row.resolution_summary),
    createdByUserId: text(row.created_by_user_id),
    createdAt: text(row.created_at),
  };
}

// ---- List, get, queues ----------------------------------------------------

export const PAGE_SIZE = 25;

export interface CaseQuery {
  readonly search: string;
  readonly caseType: string | null;
  readonly caseCategoryId: string | null;
  readonly priority: string | null;
  readonly status: string | null;
  readonly assignedTeamId: string | null;
  readonly assignedUserId: string | null;
  readonly businessUnitId: string | null;
  readonly accountId: string | null;
  readonly channel: string | null;
  readonly raisedFrom: string | null;
  readonly raisedTo: string | null;
  readonly queue: string | null;
  readonly page: number;
}

/**
 * The queue presets, as WHERE fragments over the already-scoped rows. `mine`
 * needs the caller's id, passed as an argument, never interpolated.
 */
function queueClause(
  queue: string | null,
  userId: string,
): { sql: string | null; args: unknown[] } {
  switch (queue) {
    case 'mine':
      return { sql: 'sc.assigned_user_id = ?', args: [userId] };
    case 'unassigned':
      return { sql: 'sc.assigned_user_id IS NULL AND sc.assigned_team_id IS NULL', args: [] };
    case 'new':
      return { sql: `sc.status = 'NEW'`, args: [] };
    case 'waiting-customer':
      return { sql: `sc.status = 'WAITING_CUSTOMER'`, args: [] };
    case 'waiting-internal':
      return { sql: `sc.status = 'WAITING_INTERNAL'`, args: [] };
    case 'resolved':
      return { sql: `sc.status = 'RESOLVED'`, args: [] };
    default:
      return { sql: null, args: [] };
  }
}

export async function listCases(
  db: Client,
  userId: string,
  query: CaseQuery,
): Promise<{ items: CaseRow[]; total: number; page: number; pageSize: number }> {
  const scope = await scopedCases(db, userId);
  const clauses: string[] = [scope.sql];
  const args: unknown[] = [...scope.args];
  const eq = (column: string, value: string | null) => {
    if (value !== null) {
      clauses.push(`${column} = ?`);
      args.push(value);
    }
  };
  eq('sc.case_type', query.caseType);
  eq('sc.case_category_id', query.caseCategoryId);
  eq('sc.priority', query.priority);
  eq('sc.status', query.status);
  eq('sc.assigned_team_id', query.assignedTeamId);
  eq('sc.assigned_user_id', query.assignedUserId);
  eq('sc.business_unit_id', query.businessUnitId);
  eq('sc.account_id', query.accountId);
  eq('sc.channel', query.channel);
  if (query.raisedFrom !== null) {
    clauses.push('sc.raised_at >= ?');
    args.push(query.raisedFrom);
  }
  if (query.raisedTo !== null) {
    clauses.push('sc.raised_at <= ?');
    args.push(`${query.raisedTo} 23:59:59`);
  }
  if (query.search !== '') {
    clauses.push(
      '(sc.case_number LIKE ? OR sc.subject LIKE ? OR a.account_name LIKE ? OR ct.full_name LIKE ?)',
    );
    const like = `%${query.search}%`;
    args.push(like, like, like, like);
  }
  const preset = queueClause(query.queue, userId);
  if (preset.sql !== null) {
    clauses.push(preset.sql);
    args.push(...preset.args);
  }
  const where = clauses.join(' AND ');
  const [counted, rows] = await Promise.all([
    db.execute({
      sql: `SELECT COUNT(*) AS n FROM service_cases sc
            JOIN accounts a ON a.account_id = sc.account_id
            LEFT JOIN contacts ct ON ct.contact_id = sc.contact_id
            WHERE ${where}`,
      args: args as never[],
    }),
    db.execute({
      sql: `${CASE_SELECT} WHERE ${where}
            ORDER BY sc.raised_at DESC, sc.case_id LIMIT ? OFFSET ?`,
      args: [...args, PAGE_SIZE, (query.page - 1) * PAGE_SIZE] as never[],
    }),
  ]);
  return {
    items: rows.rows.map((r) => toCase(r as unknown as Record<string, unknown>)),
    total: Number(counted.rows[0]?.n ?? 0),
    page: query.page,
    pageSize: PAGE_SIZE,
  };
}

export async function getCase(db: Client, userId: string, caseId: string): Promise<CaseRow | null> {
  const scope = await scopedCases(db, userId);
  const result = await db.execute({
    sql: `${CASE_SELECT} WHERE sc.case_id = ? AND ${scope.sql} LIMIT 1`,
    args: [caseId, ...scope.args] as never[],
  });
  const row = result.rows[0];
  return row === undefined ? null : toCase(row as unknown as Record<string, unknown>);
}

/** After a write already authorised in this file. Never exported to a route. */
async function getCaseRaw(db: Client, caseId: string): Promise<CaseRow | null> {
  const result = await db.execute({
    sql: `${CASE_SELECT} WHERE sc.case_id = ? LIMIT 1`,
    args: [caseId],
  });
  const row = result.rows[0];
  return row === undefined ? null : toCase(row as unknown as Record<string, unknown>);
}

export interface CaseIndicators {
  newCases: number;
  assignedToMe: number;
  inProgress: number;
  waiting: number;
  resolvedToday: number;
}

/** The five indicators, over the same scope predicate as the list. */
export async function caseIndicators(
  db: Client,
  userId: string,
  now: Date,
): Promise<CaseIndicators> {
  const scope = await scopedCases(db, userId);
  const today = toDbTimestamp(now).slice(0, 10);
  const result = await db.execute({
    sql: `SELECT
            SUM(CASE WHEN sc.status = 'NEW' THEN 1 ELSE 0 END) AS new_cases,
            SUM(CASE WHEN sc.assigned_user_id = ? AND sc.status NOT IN ('RESOLVED','CLOSED','CANCELLED') THEN 1 ELSE 0 END) AS mine,
            SUM(CASE WHEN sc.status = 'IN_PROGRESS' THEN 1 ELSE 0 END) AS in_progress,
            SUM(CASE WHEN sc.status IN ('WAITING_CUSTOMER','WAITING_INTERNAL') THEN 1 ELSE 0 END) AS waiting,
            SUM(CASE WHEN sc.resolved_at >= ? THEN 1 ELSE 0 END) AS resolved_today
          FROM service_cases sc
          JOIN accounts a ON a.account_id = sc.account_id
          WHERE ${scope.sql}`,
    args: [userId, `${today} 00:00:00`, ...scope.args] as never[],
  });
  const row = (result.rows[0] ?? {}) as Record<string, unknown>;
  return {
    newCases: Number(row.new_cases ?? 0),
    assignedToMe: Number(row.mine ?? 0),
    inProgress: Number(row.in_progress ?? 0),
    waiting: Number(row.waiting ?? 0),
    resolvedToday: Number(row.resolved_today ?? 0),
  };
}

// ---- Create ----------------------------------------------------------------

export interface CaseInput {
  accountId: string;
  contactId: string | null;
  businessUnitId: string | null;
  caseType: string;
  caseCategoryId: string;
  /** Null takes the category default; a value is an authorised override. */
  priority: string | null;
  subject: string;
  description: string;
  channel: string;
  raisedAt: string;
  assignedTeamId: string | null;
  assignedUserId: string | null;
}

export async function createCase(
  db: Client,
  userId: string,
  input: CaseInput,
  ctx: WriteContext,
  /** Whether the caller may override the category's default priority. */
  mayOverridePriority: boolean,
): Promise<WriteResult<CaseRow>> {
  const category = await db.execute({
    sql: `SELECT default_priority FROM case_categories WHERE case_category_id = ? AND active = 1`,
    args: [input.caseCategoryId],
  });
  const categoryRow = category.rows[0];
  if (categoryRow === undefined) {
    return {
      ok: false,
      kind: 'invalid_reference',
      fields: [{ field: 'caseCategoryId', message: 'Choose an active category.' }],
    };
  }
  const defaultPriority = text(categoryRow.default_priority);
  const overridden = input.priority !== null && input.priority !== defaultPriority;
  if (overridden && !mayOverridePriority) {
    return {
      ok: false,
      kind: 'conflict',
      fields: [
        {
          field: 'priority',
          message: `This category defaults to ${defaultPriority}. Changing it needs the case management permission.`,
        },
      ],
    };
  }
  const priority = input.priority ?? defaultPriority;

  if (input.contactId !== null) {
    const contact = await db.execute({
      sql: `SELECT contact_id FROM contacts WHERE contact_id = ? AND account_id = ?`,
      args: [input.contactId, input.accountId],
    });
    if (contact.rows[0] === undefined) {
      return {
        ok: false,
        kind: 'invalid_reference',
        fields: [{ field: 'contactId', message: 'That contact belongs to a different account.' }],
      };
    }
  }

  const caseId = newId('CASE');
  const now = toDbTimestamp(ctx.now);
  const assigned = input.assignedTeamId !== null || input.assignedUserId !== null;
  const status: CaseStatus = assigned ? 'ASSIGNED' : 'NEW';

  try {
    await withGeneratedNumber(NUMBER_PREFIX.case, 'case_number', ctx.now, async (candidate) => {
      const statements: Stmt[] = [
        {
          sql: `INSERT INTO service_cases
                  (case_id, case_number, account_id, contact_id, business_unit_id, case_type,
                   case_category_id, priority, subject, description, channel, status,
                   assigned_team_id, assigned_user_id, raised_at, first_response_at, resolved_at,
                   closed_at, root_cause, resolution_summary, created_by_user_id, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
          args: [
            caseId,
            candidate,
            input.accountId,
            input.contactId,
            input.businessUnitId,
            input.caseType,
            input.caseCategoryId,
            priority,
            input.subject,
            input.description,
            input.channel,
            status,
            input.assignedTeamId,
            input.assignedUserId,
            input.raisedAt,
            ctx.actorUserId,
            now,
          ],
        },
        {
          sql: `INSERT INTO case_status_history
                  (case_status_history_id, case_id, from_status, to_status, changed_by_user_id,
                   changed_at, reason)
                VALUES (?, ?, NULL, ?, ?, ?, 'Case created')`,
          args: [newId('CSH'), caseId, status, ctx.actorUserId, now],
        },
        audit(ctx, 'CASE_CREATED', caseId, 'CREATE', null, {
          caseNumber: candidate,
          accountId: input.accountId,
          caseType: input.caseType,
          priority,
          priorityOverridden: overridden,
          channel: input.channel,
        }),
      ];
      if (assigned) {
        statements.push(
          {
            sql: `INSERT INTO case_assignment_history
                    (case_assignment_id, case_id, from_team_id, from_user_id, to_team_id,
                     to_user_id, assigned_by_user_id, assigned_at, reason)
                  VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, 'Initial assignment')`,
            args: [
              newId('CAH'),
              caseId,
              input.assignedTeamId,
              input.assignedUserId,
              ctx.actorUserId,
              now,
            ],
          },
          audit(ctx, 'CASE_ASSIGNED', caseId, 'ASSIGN', null, {
            toTeamId: input.assignedTeamId,
            toUserId: input.assignedUserId,
          }),
        );
      }
      await db.batch(statements, 'write');
      return candidate;
    });
  } catch (error) {
    if (/FOREIGN KEY constraint failed/i.test(String(error))) {
      return {
        ok: false,
        kind: 'invalid_reference',
        fields: [{ field: 'accountId', message: 'A referenced record does not exist.' }],
      };
    }
    throw error;
  }

  await emitCaseEvent(db, {
    type: 'CASE_CREATED',
    caseId,
    at: ctx.now,
    actorUserId: ctx.actorUserId,
    detail: { priority, caseType: input.caseType },
  });
  if (assigned) {
    await emitCaseEvent(db, {
      type: 'CASE_ASSIGNED',
      caseId,
      at: ctx.now,
      actorUserId: ctx.actorUserId,
      detail: { toTeamId: input.assignedTeamId, toUserId: input.assignedUserId },
    });
  }
  const created = await getCaseRaw(db, caseId);
  return created === null ? { ok: false, kind: 'not_found' } : { ok: true, value: created };
}

// ---- Assignment ------------------------------------------------------------

export async function assignCase(
  db: Client,
  userId: string,
  caseId: string,
  input: { teamId: string | null; userId: string | null; reason: string | null },
  ctx: WriteContext,
): Promise<WriteResult<CaseRow>> {
  const before = await getCase(db, userId, caseId);
  if (before === null) return { ok: false, kind: 'not_found' };
  if (input.teamId === null && input.userId === null) {
    return {
      ok: false,
      kind: 'invalid_reference',
      fields: [{ field: 'userId', message: 'Assign a team, a user, or both.' }],
    };
  }
  const now = toDbTimestamp(ctx.now);
  const becomesAssigned = before.status === 'NEW';
  const statements: Stmt[] = [
    {
      sql: `UPDATE service_cases SET assigned_team_id = ?, assigned_user_id = ?
              ${becomesAssigned ? `, status = 'ASSIGNED'` : ''}
            WHERE case_id = ?`,
      args: [input.teamId, input.userId, caseId],
    },
    {
      // Never overwrite the assignment without the history row: same batch.
      sql: `INSERT INTO case_assignment_history
              (case_assignment_id, case_id, from_team_id, from_user_id, to_team_id, to_user_id,
               assigned_by_user_id, assigned_at, reason)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        newId('CAH'),
        caseId,
        before.assignedTeamId,
        before.assignedUserId,
        input.teamId,
        input.userId,
        ctx.actorUserId,
        now,
        input.reason,
      ],
    },
    audit(
      ctx,
      before.assignedTeamId === null && before.assignedUserId === null
        ? 'CASE_ASSIGNED'
        : 'CASE_REASSIGNED',
      caseId,
      'ASSIGN',
      { teamId: before.assignedTeamId, userId: before.assignedUserId },
      { teamId: input.teamId, userId: input.userId, reason: input.reason },
    ),
  ];
  if (becomesAssigned) {
    statements.push({
      sql: `INSERT INTO case_status_history
              (case_status_history_id, case_id, from_status, to_status, changed_by_user_id,
               changed_at, reason)
            VALUES (?, ?, 'NEW', 'ASSIGNED', ?, ?, 'Assigned')`,
      args: [newId('CSH'), caseId, ctx.actorUserId, now],
    });
  }
  try {
    await db.batch(statements, 'write');
  } catch (error) {
    if (/FOREIGN KEY constraint failed/i.test(String(error))) {
      return {
        ok: false,
        kind: 'invalid_reference',
        fields: [{ field: 'userId', message: 'That team or user does not exist.' }],
      };
    }
    throw error;
  }
  await emitCaseEvent(db, {
    type: 'CASE_ASSIGNED',
    caseId,
    at: ctx.now,
    actorUserId: ctx.actorUserId,
    detail: { toTeamId: input.teamId, toUserId: input.userId },
  });
  const after = await getCaseRaw(db, caseId);
  return after === null ? { ok: false, kind: 'not_found' } : { ok: true, value: after };
}

// ---- Status ----------------------------------------------------------------

export interface StatusChangeInput {
  toStatus: CaseStatus;
  reason: string | null;
  /** Required when the destination is RESOLVED. */
  resolutionSummary: string | null;
  rootCause: string | null;
}

export async function changeCaseStatus(
  db: Client,
  userId: string,
  caseId: string,
  input: StatusChangeInput,
  ctx: WriteContext,
): Promise<WriteResult<CaseRow>> {
  const before = await getCase(db, userId, caseId);
  if (before === null) return { ok: false, kind: 'not_found' };

  const allowed = CASE_TRANSITIONS[before.status] ?? [];
  if (!allowed.includes(input.toStatus)) {
    return {
      ok: false,
      kind: 'conflict',
      fields: [
        {
          field: 'toStatus',
          message: `A case cannot move from ${before.status} to ${input.toStatus}. The permitted moves are: ${allowed.join(', ') || 'none, this status is terminal'}.`,
        },
      ],
    };
  }
  // The reopen: leaving CLOSED or leaving RESOLVED backwards needs a reason.
  const isReopen =
    (before.status === 'CLOSED' || before.status === 'RESOLVED') &&
    input.toStatus === 'IN_PROGRESS';
  if (isReopen && input.reason === null) {
    return {
      ok: false,
      kind: 'invalid_reference',
      fields: [{ field: 'reason', message: 'Reopening needs a reason. It goes in the history.' }],
    };
  }
  if (input.toStatus === 'RESOLVED' && input.resolutionSummary === null) {
    return {
      ok: false,
      kind: 'invalid_reference',
      fields: [
        {
          field: 'resolutionSummary',
          message:
            'Say how it was resolved. The summary is what the customer and the next reader see.',
        },
      ],
    };
  }

  const now = toDbTimestamp(ctx.now);
  const sets: string[] = ['status = ?'];
  const setArgs: unknown[] = [input.toStatus];
  if (input.toStatus === 'RESOLVED') {
    // Resolving sets resolved_at and does NOT set closed_at: resolved means
    // Hass considers it solved, closed means the lifecycle is complete.
    sets.push('resolved_at = ?', 'resolution_summary = ?', 'root_cause = COALESCE(?, root_cause)');
    setArgs.push(now, input.resolutionSummary, input.rootCause);
  }
  if (input.toStatus === 'CLOSED') {
    sets.push('closed_at = ?');
    setArgs.push(now);
  }
  if (isReopen) {
    // A reopened case is live again: the closure stamps come off so the next
    // resolution records its own facts rather than inheriting stale ones.
    sets.push('resolved_at = NULL', 'closed_at = NULL');
  }

  const statements: Stmt[] = [
    {
      sql: `UPDATE service_cases SET ${sets.join(', ')} WHERE case_id = ?`,
      args: [...setArgs, caseId] as never[],
    },
    {
      sql: `INSERT INTO case_status_history
              (case_status_history_id, case_id, from_status, to_status, changed_by_user_id,
               changed_at, reason)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [
        newId('CSH'),
        caseId,
        before.status,
        input.toStatus,
        ctx.actorUserId,
        now,
        input.reason,
      ],
    },
    audit(
      ctx,
      input.toStatus === 'RESOLVED'
        ? 'CASE_RESOLVED'
        : input.toStatus === 'CLOSED'
          ? 'CASE_CLOSED'
          : input.toStatus === 'CANCELLED'
            ? 'CASE_CANCELLED'
            : 'CASE_STATUS_CHANGED',
      caseId,
      'STATUS_CHANGE',
      { status: before.status },
      { status: input.toStatus, reason: input.reason },
    ),
  ];
  await db.batch(statements, 'write');

  await emitCaseEvent(db, {
    type:
      input.toStatus === 'RESOLVED'
        ? 'CASE_RESOLVED'
        : input.toStatus === 'CLOSED'
          ? 'CASE_CLOSED'
          : 'CASE_STATUS_CHANGED',
    caseId,
    at: ctx.now,
    actorUserId: ctx.actorUserId,
    detail: { fromStatus: before.status, toStatus: input.toStatus },
  });
  const after = await getCaseRaw(db, caseId);
  return after === null ? { ok: false, kind: 'not_found' } : { ok: true, value: after };
}

// ---- Communications --------------------------------------------------------

export interface CommunicationRow {
  communicationId: string;
  direction: string;
  channel: string;
  contactId: string | null;
  contactName: string | null;
  userId: string | null;
  userName: string | null;
  subject: string | null;
  messageSummary: string;
  communicatedAt: string;
}

/** What the portal is allowed to know about a communication. No internal
 * author id, no direction beyond what the customer already knows. */
export interface PortalCommunicationRow {
  communicationId: string;
  fromCustomer: boolean;
  channel: string;
  subject: string | null;
  messageSummary: string;
  communicatedAt: string;
}

const COMMUNICATION_SELECT = `
  SELECT cm.communication_id, cm.direction, cm.channel, cm.contact_id,
         ct.full_name AS contact_name, cm.user_id, u.display_name AS user_name,
         cm.subject, cm.message_summary, cm.communicated_at
  FROM case_communications cm
  LEFT JOIN contacts ct ON ct.contact_id = cm.contact_id
  LEFT JOIN users u ON u.user_id = cm.user_id
  WHERE cm.case_id = ?`;

export async function listCommunications(
  db: Client,
  userId: string,
  caseId: string,
): Promise<CommunicationRow[] | null> {
  const found = await getCase(db, userId, caseId);
  if (found === null) return null;
  const result = await db.execute({
    sql: `${COMMUNICATION_SELECT} ORDER BY cm.communicated_at, cm.communication_id`,
    args: [caseId],
  });
  return result.rows.map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    return {
      communicationId: text(row.communication_id),
      direction: text(row.direction),
      channel: text(row.channel),
      contactId: nullableText(row.contact_id),
      contactName: nullableText(row.contact_name),
      userId: nullableText(row.user_id),
      userName: nullableText(row.user_name),
      subject: nullableText(row.subject),
      messageSummary: text(row.message_summary),
      communicatedAt: text(row.communicated_at),
    };
  });
}

/**
 * The portal-safe list. The INTERNAL filter is in the SQL: a row the customer
 * must not see never enters the result set, so no template can forget to hide
 * it and no serialisation can leak it. The shape carries no internal user id
 * and no internal field at all.
 */
export async function portalCommunications(
  db: Client,
  caseId: string,
): Promise<PortalCommunicationRow[]> {
  const result = await db.execute({
    sql: `SELECT cm.communication_id, cm.direction, cm.channel, cm.subject,
                 cm.message_summary, cm.communicated_at
          FROM case_communications cm
          WHERE cm.case_id = ? AND cm.direction <> 'INTERNAL'
          ORDER BY cm.communicated_at, cm.communication_id`,
    args: [caseId],
  });
  return result.rows.map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    return {
      communicationId: text(row.communication_id),
      fromCustomer: text(row.direction) === 'INBOUND',
      channel: text(row.channel),
      subject: nullableText(row.subject),
      messageSummary: text(row.message_summary),
      communicatedAt: text(row.communicated_at),
    };
  });
}

export interface CommunicationInput {
  direction: string;
  channel: string;
  contactId: string | null;
  subject: string | null;
  messageSummary: string;
  communicatedAt: string | null;
}

export async function addCommunication(
  db: Client,
  userId: string,
  caseId: string,
  input: CommunicationInput,
  ctx: WriteContext,
): Promise<WriteResult<CommunicationRow[]>> {
  const before = await getCase(db, userId, caseId);
  if (before === null) return { ok: false, kind: 'not_found' };
  if (input.contactId !== null) {
    const contact = await db.execute({
      sql: `SELECT contact_id FROM contacts WHERE contact_id = ? AND account_id = ?`,
      args: [input.contactId, before.accountId],
    });
    if (contact.rows[0] === undefined) {
      return {
        ok: false,
        kind: 'invalid_reference',
        fields: [{ field: 'contactId', message: 'That contact belongs to a different account.' }],
      };
    }
  }

  const communicationId = newId('COMM');
  const now = toDbTimestamp(ctx.now);
  const at = input.communicatedAt ?? now;
  const qualifies =
    input.direction === QUALIFYING_FIRST_RESPONSE.direction &&
    (QUALIFYING_FIRST_RESPONSE.channels as readonly string[]).includes(input.channel);

  const statements: Stmt[] = [
    {
      sql: `INSERT INTO case_communications
              (communication_id, case_id, direction, channel, contact_id, user_id, subject,
               message_summary, communicated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        communicationId,
        caseId,
        input.direction,
        input.channel,
        input.contactId,
        ctx.actorUserId,
        input.subject,
        input.messageSummary,
        at,
      ],
    },
    audit(ctx, 'CASE_COMMUNICATION_ADDED', caseId, 'COMMUNICATE', null, {
      communicationId,
      direction: input.direction,
      channel: input.channel,
    }),
  ];
  if (qualifies) {
    // First response, in the same transaction, set only while NULL: the first
    // qualifying outbound wins and a later one never moves it. An INTERNAL
    // note reaches neither this branch nor the customer.
    statements.push({
      sql: `UPDATE service_cases SET first_response_at = ?
            WHERE case_id = ? AND first_response_at IS NULL`,
      args: [at, caseId],
    });
  }
  await db.batch(statements, 'write');

  if (qualifies && before.firstResponseAt === null) {
    await emitCaseEvent(db, {
      type: 'CASE_FIRST_RESPONSE',
      caseId,
      at: ctx.now,
      actorUserId: ctx.actorUserId,
      detail: { communicationId, at },
    });
  }
  const list = await listCommunications(db, userId, caseId);
  return { ok: true, value: list ?? [] };
}

// ---- History reads ----------------------------------------------------------

export interface AssignmentHistoryRow {
  fromTeamName: string | null;
  fromUserName: string | null;
  toTeamName: string | null;
  toUserName: string | null;
  assignedByName: string;
  assignedAt: string;
  reason: string | null;
}

export async function listAssignmentHistory(
  db: Client,
  caseId: string,
): Promise<AssignmentHistoryRow[]> {
  const result = await db.execute({
    sql: `SELECT ft.team_name AS from_team_name, fu.display_name AS from_user_name,
                 tt.team_name AS to_team_name, tu.display_name AS to_user_name,
                 ab.display_name AS assigned_by_name, h.assigned_at, h.reason
          FROM case_assignment_history h
          LEFT JOIN teams ft ON ft.team_id = h.from_team_id
          LEFT JOIN users fu ON fu.user_id = h.from_user_id
          LEFT JOIN teams tt ON tt.team_id = h.to_team_id
          LEFT JOIN users tu ON tu.user_id = h.to_user_id
          JOIN users ab ON ab.user_id = h.assigned_by_user_id
          WHERE h.case_id = ? ORDER BY h.assigned_at, h.case_assignment_id`,
    args: [caseId],
  });
  return result.rows.map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    return {
      fromTeamName: nullableText(row.from_team_name),
      fromUserName: nullableText(row.from_user_name),
      toTeamName: nullableText(row.to_team_name),
      toUserName: nullableText(row.to_user_name),
      assignedByName: text(row.assigned_by_name),
      assignedAt: text(row.assigned_at),
      reason: nullableText(row.reason),
    };
  });
}

export interface StatusHistoryRow {
  fromStatus: string | null;
  toStatus: string;
  changedByName: string;
  changedAt: string;
  reason: string | null;
}

export async function listStatusHistory(db: Client, caseId: string): Promise<StatusHistoryRow[]> {
  const result = await db.execute({
    sql: `SELECT h.from_status, h.to_status, u.display_name AS changed_by_name, h.changed_at, h.reason
          FROM case_status_history h
          JOIN users u ON u.user_id = h.changed_by_user_id
          WHERE h.case_id = ? ORDER BY h.changed_at, h.case_status_history_id`,
    args: [caseId],
  });
  return result.rows.map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    return {
      fromStatus: nullableText(row.from_status),
      toStatus: text(row.to_status),
      changedByName: text(row.changed_by_name),
      changedAt: text(row.changed_at),
      reason: nullableText(row.reason),
    };
  });
}

// ---- Survey responses (read only, prepared for later) ------------------------

export interface SurveyResponseRow {
  surveyResponseId: string;
  surveyName: string;
  surveyType: string;
  score: number;
  comments: string | null;
  respondedAt: string;
}

export async function listCaseSurveyResponses(
  db: Client,
  userId: string,
  caseId: string,
): Promise<SurveyResponseRow[] | null> {
  const found = await getCase(db, userId, caseId);
  if (found === null) return null;
  const result = await db.execute({
    sql: `SELECT r.survey_response_id, s.survey_name, s.survey_type, r.score, r.comments, r.responded_at
          FROM survey_responses r
          JOIN customer_surveys s ON s.survey_id = r.survey_id
          WHERE r.case_id = ? ORDER BY r.responded_at`,
    args: [caseId],
  });
  return result.rows.map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    return {
      surveyResponseId: text(row.survey_response_id),
      surveyName: text(row.survey_name),
      surveyType: text(row.survey_type),
      score: Number(row.score ?? 0),
      comments: nullableText(row.comments),
      respondedAt: text(row.responded_at),
    };
  });
}

// ---- Categories -------------------------------------------------------------

export interface CaseCategoryRow {
  caseCategoryId: string;
  categoryName: string;
  subcategoryName: string;
  defaultPriority: string;
  active: boolean;
  usageCount: number;
}

export async function listCaseCategories(db: Client): Promise<CaseCategoryRow[]> {
  const result = await db.execute(
    `SELECT cc.case_category_id, cc.category_name, cc.subcategory_name, cc.default_priority,
            cc.active,
            (SELECT COUNT(*) FROM service_cases sc WHERE sc.case_category_id = cc.case_category_id) AS usage_count
     FROM case_categories cc ORDER BY cc.category_name, cc.subcategory_name`,
  );
  return result.rows.map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    return {
      caseCategoryId: text(row.case_category_id),
      categoryName: text(row.category_name),
      subcategoryName: text(row.subcategory_name),
      defaultPriority: text(row.default_priority),
      active: Number(row.active ?? 0) === 1,
      usageCount: Number(row.usage_count ?? 0),
    };
  });
}

export async function getCaseCategory(db: Client, id: string): Promise<CaseCategoryRow | null> {
  const all = await listCaseCategories(db);
  return all.find((c) => c.caseCategoryId === id) ?? null;
}

export interface CaseCategoryInput {
  categoryName: string;
  subcategoryName: string;
  defaultPriority: string;
  active: boolean;
}

const isUnique = (e: unknown) =>
  /UNIQUE constraint failed/i.test(e instanceof Error ? e.message : String(e));

export async function createCaseCategory(
  db: Client,
  input: CaseCategoryInput,
  ctx: WriteContext,
): Promise<WriteResult<CaseCategoryRow>> {
  const id = newId('CC');
  try {
    await db.batch(
      [
        {
          sql: `INSERT INTO case_categories
                  (case_category_id, category_name, subcategory_name, default_priority, active)
                VALUES (?, ?, ?, ?, ?)`,
          args: [
            id,
            input.categoryName,
            input.subcategoryName,
            input.defaultPriority,
            input.active ? 1 : 0,
          ],
        },
        audit(ctx, 'CASE_UPDATED', id, 'CATEGORY_CREATE', null, input),
      ],
      'write',
    );
  } catch (error) {
    if (isUnique(error)) {
      return {
        ok: false,
        kind: 'conflict',
        fields: [
          {
            field: 'subcategoryName',
            message: 'That category and subcategory pair already exists.',
          },
        ],
      };
    }
    throw error;
  }
  const created = await getCaseCategory(db, id);
  return created === null ? { ok: false, kind: 'not_found' } : { ok: true, value: created };
}

export async function updateCaseCategory(
  db: Client,
  id: string,
  input: CaseCategoryInput,
  ctx: WriteContext,
): Promise<WriteResult<CaseCategoryRow>> {
  const before = await getCaseCategory(db, id);
  if (before === null) return { ok: false, kind: 'not_found' };
  try {
    await db.batch(
      [
        {
          sql: `UPDATE case_categories SET category_name = ?, subcategory_name = ?,
                  default_priority = ?, active = ?
                WHERE case_category_id = ?`,
          args: [
            input.categoryName,
            input.subcategoryName,
            input.defaultPriority,
            input.active ? 1 : 0,
            id,
          ],
        },
        audit(
          ctx,
          'CASE_UPDATED',
          id,
          'CATEGORY_UPDATE',
          {
            categoryName: before.categoryName,
            subcategoryName: before.subcategoryName,
            defaultPriority: before.defaultPriority,
            active: before.active,
          },
          input,
        ),
      ],
      'write',
    );
  } catch (error) {
    if (isUnique(error)) {
      return {
        ok: false,
        kind: 'conflict',
        fields: [
          {
            field: 'subcategoryName',
            message: 'That category and subcategory pair already exists.',
          },
        ],
      };
    }
    throw error;
  }
  const after = await getCaseCategory(db, id);
  return after === null ? { ok: false, kind: 'not_found' } : { ok: true, value: after };
}

// ---- Form options ------------------------------------------------------------

export interface ServiceOptions {
  categories: { id: string; label: string; defaultPriority: string }[];
  teams: { id: string; label: string }[];
  users: { id: string; label: string }[];
  businessUnits: { id: string; label: string }[];
}

export async function serviceOptions(db: Client): Promise<ServiceOptions> {
  const [categories, teams, users, businessUnits] = await db.batch(
    [
      `SELECT case_category_id AS id, category_name || ' / ' || subcategory_name AS label,
              default_priority FROM case_categories WHERE active = 1
       ORDER BY category_name, subcategory_name`,
      `SELECT team_id AS id, team_name AS label FROM teams WHERE active = 1 ORDER BY team_name`,
      `SELECT user_id AS id, display_name AS label FROM users
       WHERE status = 'ACTIVE' AND user_type = 'INTERNAL' ORDER BY display_name`,
      `SELECT business_unit_id AS id, business_unit_name AS label FROM business_units
       WHERE active = 1 ORDER BY business_unit_name`,
    ],
    'read',
  );
  const opts = (rows: { rows: unknown[] }) =>
    (rows.rows as Record<string, unknown>[]).map((r) => ({
      id: text(r.id),
      label: text(r.label),
    }));
  return {
    categories: (categories.rows as Record<string, unknown>[]).map((r) => ({
      id: text(r.id),
      label: text(r.label),
      defaultPriority: text(r.default_priority),
    })),
    teams: opts(teams),
    users: opts(users),
    businessUnits: opts(businessUnits),
  };
}
