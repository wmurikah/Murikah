/**
 * Reads and writes for opportunities, pipelines and lost reasons.
 *
 * THE STAGE MOVE IS THE HEART OF THIS FILE, AND IT IS ONE TRANSACTION.
 * `current_stage_id` is never updated alone. The move batch validates the
 * destination, writes the history row with the computed time in the previous
 * stage, updates the opportunity, applies the stage's default probability
 * unless an authorised override was given, closes the record where the stage
 * is a won or lost stage, and audits, all inside one `db.batch(..., 'write')`.
 *
 * CONCURRENCY IS SETTLED INSIDE THE TRANSACTION, NOT BEFORE IT.
 * The caller states the stage it believes the opportunity is in. The UPDATE
 * is conditional on that stage still being current, and the history INSERT
 * writes `to_stage_id` through `CASE WHEN changes() > 0`, so a move that lost
 * the race inserts NULL into a NOT NULL column, the whole batch rolls back,
 * and the loser gets a conflict rather than silently overwriting the winner
 * or leaving a phantom history row. Nothing partial can commit.
 *
 * PROBABILITY IS A FRACTION IN HERE.
 * Everything in this file stores and reads 0 to 1. The percent boundary is
 * ../crm/probability.ts and the validators; see that file for why.
 *
 * PIPELINES ARE NOT VERSIONED, SO CONFIGURATION IS CAUTIOUS.
 * Once a stage is referenced by an opportunity or its history it can be
 * renamed or deactivated but never deleted, and reordering rewrites what
 * history means, so `reorderStages` exists but the admin screen carries the
 * warning. Reordering respects UNIQUE(pipeline_id, sequence_no) by parking
 * every sequence out of range first and then writing the final order, all in
 * one batch: a naive pairwise swap trips the constraint mid-flight.
 */
import type { Client, InStatement } from '@libsql/client/web';
import type { FieldError } from '../../validation.ts';
import { newId, auditEventStmt } from './authRecords.ts';
import { toDbTimestamp } from '../auth/session.ts';
import type { WriteContext } from '../admin/guard.ts';
import { resolveScope, scopePredicate, DENY_ALL, type Predicate } from '../auth/rbac.ts';
import { OPPORTUNITIES_VIEW } from '../permissions.ts';
import { NUMBER_PREFIX, withGeneratedNumber } from '../crm/numbering.ts';
import { scopedAccounts } from './accountAdmin.ts';

type Stmt = Extract<InStatement, { sql: string }>;

export type WriteResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly kind: 'conflict'; readonly fields: FieldError[] }
  | { readonly ok: false; readonly kind: 'invalid_reference'; readonly fields: FieldError[] }
  | { readonly ok: false; readonly kind: 'not_found' };

const text = (v: unknown): string => String(v ?? '');
const nullableText = (v: unknown): string | null =>
  v === null || v === undefined ? null : String(v);
const nullableNumber = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v);

function audit(
  ctx: WriteContext,
  eventType: string,
  entityType: string,
  entityId: string,
  action: string,
  before: unknown,
  after: unknown,
): Stmt {
  return auditEventStmt({
    actorUserId: ctx.actorUserId,
    eventType,
    entityType,
    entityId,
    action,
    beforeJson: before === null ? null : JSON.stringify(before),
    afterJson: after === null ? null : JSON.stringify(after),
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    now: ctx.now,
  }) as Stmt;
}

// ---- Scope ----------------------------------------------------------------

/**
 * Where the scoping columns live. `account_id` is NOT NULL on opportunities,
 * so unlike leads there is no orphan branch to write by hand: country and
 * affiliate always resolve through the account join, and scopePredicate's own
 * IS NOT NULL guards handle an account whose affiliate is genuinely null.
 * There is no team column, so a TEAM scope contributes nothing here.
 */
const OPPORTUNITY_COLUMNS = {
  country: 'a.country_id',
  affiliate: 'a.affiliate_id',
  businessUnit: 'o.business_unit_id',
  owner: 'o.owner_user_id',
} as const;

export async function scopedOpportunities(db: Client, userId: string): Promise<Predicate> {
  const resolution = await resolveScope(db, userId, OPPORTUNITIES_VIEW);
  if (!resolution.granted) return DENY_ALL;
  return scopePredicate(resolution, OPPORTUNITY_COLUMNS);
}

// ---- Row shapes -----------------------------------------------------------

export interface OpportunityRow {
  opportunityId: string;
  opportunityNumber: string;
  leadId: string | null;
  accountId: string;
  accountName: string;
  accountType: string;
  businessUnitId: string | null;
  businessUnitName: string | null;
  pipelineId: string;
  pipelineName: string;
  currentStageId: string;
  currentStageName: string;
  stageSequenceNo: number;
  stageTargetDays: number | null;
  ownerUserId: string;
  ownerName: string;
  title: string;
  estimatedValue: number;
  currencyCode: string;
  /** Stored fraction, 0 to 1. Render through fractionToPercentLabel. */
  probability: number;
  estimatedCloseDate: string | null;
  actualCloseDate: string | null;
  status: 'OPEN' | 'WON' | 'LOST';
  wonAmount: number | null;
  lostReasonId: string | null;
  lostReasonName: string | null;
  lostNotes: string | null;
  createdAt: string;
  updatedAt: string;
  /** When the opportunity entered its current stage, from the history. */
  enteredStageAt: string | null;
}

const OPPORTUNITY_SELECT = `
  SELECT o.opportunity_id, o.opportunity_number, o.lead_id, o.account_id, a.account_name,
         a.account_type, o.business_unit_id, bu.business_unit_name, o.pipeline_id,
         pl.pipeline_name, o.current_stage_id, st.stage_name AS current_stage_name,
         st.sequence_no AS stage_sequence_no, st.target_days AS stage_target_days,
         o.owner_user_id, ou.display_name AS owner_name, o.title, o.estimated_value,
         o.currency_code, o.probability, o.estimated_close_date, o.actual_close_date,
         o.status, o.won_amount, o.lost_reason_id, lr.reason_name AS lost_reason_name,
         o.lost_notes, o.created_at, o.updated_at,
         (SELECT MAX(h.changed_at) FROM opportunity_stage_history h
           WHERE h.opportunity_id = o.opportunity_id) AS entered_stage_at
  FROM opportunities o
  JOIN accounts a ON a.account_id = o.account_id
  JOIN pipelines pl ON pl.pipeline_id = o.pipeline_id
  JOIN pipeline_stages st ON st.pipeline_stage_id = o.current_stage_id
  JOIN users ou ON ou.user_id = o.owner_user_id
  LEFT JOIN business_units bu ON bu.business_unit_id = o.business_unit_id
  LEFT JOIN lost_reasons lr ON lr.lost_reason_id = o.lost_reason_id`;

function toOpportunity(row: Record<string, unknown>): OpportunityRow {
  return {
    opportunityId: text(row.opportunity_id),
    opportunityNumber: text(row.opportunity_number),
    leadId: nullableText(row.lead_id),
    accountId: text(row.account_id),
    accountName: text(row.account_name),
    accountType: text(row.account_type),
    businessUnitId: nullableText(row.business_unit_id),
    businessUnitName: nullableText(row.business_unit_name),
    pipelineId: text(row.pipeline_id),
    pipelineName: text(row.pipeline_name),
    currentStageId: text(row.current_stage_id),
    currentStageName: text(row.current_stage_name),
    stageSequenceNo: Number(row.stage_sequence_no ?? 0),
    stageTargetDays: nullableNumber(row.stage_target_days),
    ownerUserId: text(row.owner_user_id),
    ownerName: text(row.owner_name),
    title: text(row.title),
    estimatedValue: Number(row.estimated_value ?? 0),
    currencyCode: text(row.currency_code),
    probability: Number(row.probability ?? 0),
    estimatedCloseDate: nullableText(row.estimated_close_date),
    actualCloseDate: nullableText(row.actual_close_date),
    status: text(row.status) as OpportunityRow['status'],
    wonAmount: nullableNumber(row.won_amount),
    lostReasonId: nullableText(row.lost_reason_id),
    lostReasonName: nullableText(row.lost_reason_name),
    lostNotes: nullableText(row.lost_notes),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
    enteredStageAt: nullableText(row.entered_stage_at),
  };
}

// ---- List, get ------------------------------------------------------------

export const PAGE_SIZE = 25;

export interface OpportunityQuery {
  readonly search: string;
  readonly status: string | null;
  readonly pipelineId: string | null;
  readonly stageId: string | null;
  readonly ownerUserId: string | null;
  readonly businessUnitId: string | null;
  readonly accountId: string | null;
  readonly currencyCode: string | null;
  readonly closeFrom: string | null;
  readonly closeTo: string | null;
  readonly page: number;
}

export interface OpportunityPage {
  items: OpportunityRow[];
  total: number;
  page: number;
  pageSize: number;
}

function queryPredicates(query: OpportunityQuery): { clauses: string[]; args: unknown[] } {
  const clauses: string[] = [];
  const args: unknown[] = [];
  if (query.search !== '') {
    clauses.push(`(o.opportunity_number LIKE ? OR o.title LIKE ? OR a.account_name LIKE ?)`);
    const like = `%${query.search}%`;
    args.push(like, like, like);
  }
  const eq = (column: string, value: string | null) => {
    if (value !== null) {
      clauses.push(`${column} = ?`);
      args.push(value);
    }
  };
  eq('o.status', query.status);
  eq('o.pipeline_id', query.pipelineId);
  eq('o.current_stage_id', query.stageId);
  eq('o.owner_user_id', query.ownerUserId);
  eq('o.business_unit_id', query.businessUnitId);
  eq('o.account_id', query.accountId);
  eq('o.currency_code', query.currencyCode);
  if (query.closeFrom !== null) {
    clauses.push(`o.estimated_close_date >= ?`);
    args.push(query.closeFrom);
  }
  if (query.closeTo !== null) {
    clauses.push(`o.estimated_close_date <= ?`);
    args.push(query.closeTo);
  }
  return { clauses, args };
}

export async function listOpportunities(
  db: Client,
  userId: string,
  query: OpportunityQuery,
): Promise<OpportunityPage> {
  const scope = await scopedOpportunities(db, userId);
  const { clauses, args } = queryPredicates(query);
  const where = [scope.sql, ...clauses].join(' AND ');
  const offset = (query.page - 1) * PAGE_SIZE;

  const [countResult, listResult] = await Promise.all([
    db.execute({
      sql: `SELECT COUNT(*) AS n FROM opportunities o
            JOIN accounts a ON a.account_id = o.account_id WHERE ${where}`,
      args: [...scope.args, ...args] as never[],
    }),
    db.execute({
      sql: `${OPPORTUNITY_SELECT} WHERE ${where}
            ORDER BY o.updated_at DESC, o.opportunity_id LIMIT ? OFFSET ?`,
      args: [...scope.args, ...args, PAGE_SIZE, offset] as never[],
    }),
  ]);

  return {
    items: listResult.rows.map((r) => toOpportunity(r as unknown as Record<string, unknown>)),
    total: Number(countResult.rows[0]?.n ?? 0),
    page: query.page,
    pageSize: PAGE_SIZE,
  };
}

export async function getOpportunity(
  db: Client,
  userId: string,
  opportunityId: string,
): Promise<OpportunityRow | null> {
  const scope = await scopedOpportunities(db, userId);
  const result = await db.execute({
    sql: `${OPPORTUNITY_SELECT} WHERE o.opportunity_id = ? AND ${scope.sql} LIMIT 1`,
    args: [opportunityId, ...scope.args] as never[],
  });
  const row = result.rows[0];
  return row === undefined ? null : toOpportunity(row as unknown as Record<string, unknown>);
}

/** After a write this file has already authorised. Never exported to a route. */
async function getOpportunityUnscoped(
  db: Client,
  opportunityId: string,
): Promise<OpportunityRow | null> {
  const result = await db.execute({
    sql: `${OPPORTUNITY_SELECT} WHERE o.opportunity_id = ? LIMIT 1`,
    args: [opportunityId],
  });
  const row = result.rows[0];
  return row === undefined ? null : toOpportunity(row as unknown as Record<string, unknown>);
}

// ---- Aggregates -----------------------------------------------------------

export interface StageAggregate {
  stageId: string;
  stageName: string;
  sequenceNo: number;
  isWonStage: boolean;
  isLostStage: boolean;
  count: number;
  /** Per currency, because currencies are never summed together. */
  byCurrency: { currencyCode: string; value: number; weighted: number; count: number }[];
}

export interface PipelineSummary {
  pipelineId: string;
  stages: StageAggregate[];
  wonCount: number;
  lostCount: number;
  lostReasons: { lostReasonId: string; reasonName: string; count: number }[];
}

/**
 * The pipeline aggregates, computed server-side with the same scope predicate
 * as the list. Weighted value is estimated_value * probability, with the
 * probability still the stored fraction, and every sum is grouped by currency:
 * KES and USD never meet in one number.
 */
export async function pipelineSummary(
  db: Client,
  userId: string,
  pipelineId: string,
): Promise<PipelineSummary> {
  const scope = await scopedOpportunities(db, userId);
  const [stageRows, valueRows, closedRows, reasonRows] = await Promise.all([
    db.execute({
      sql: `SELECT pipeline_stage_id, stage_name, sequence_no, is_won_stage, is_lost_stage
            FROM pipeline_stages WHERE pipeline_id = ? AND active = 1 ORDER BY sequence_no`,
      args: [pipelineId],
    }),
    db.execute({
      sql: `SELECT o.current_stage_id, o.currency_code, COUNT(*) AS n,
                   SUM(o.estimated_value) AS value,
                   SUM(o.estimated_value * o.probability) AS weighted
            FROM opportunities o
            JOIN accounts a ON a.account_id = o.account_id
            WHERE o.pipeline_id = ? AND o.status = 'OPEN' AND ${scope.sql}
            GROUP BY o.current_stage_id, o.currency_code`,
      args: [pipelineId, ...scope.args] as never[],
    }),
    db.execute({
      sql: `SELECT o.status, COUNT(*) AS n
            FROM opportunities o
            JOIN accounts a ON a.account_id = o.account_id
            WHERE o.pipeline_id = ? AND o.status IN ('WON','LOST') AND ${scope.sql}
            GROUP BY o.status`,
      args: [pipelineId, ...scope.args] as never[],
    }),
    db.execute({
      sql: `SELECT o.lost_reason_id, lr.reason_name, COUNT(*) AS n
            FROM opportunities o
            JOIN accounts a ON a.account_id = o.account_id
            JOIN lost_reasons lr ON lr.lost_reason_id = o.lost_reason_id
            WHERE o.pipeline_id = ? AND o.status = 'LOST' AND ${scope.sql}
            GROUP BY o.lost_reason_id, lr.reason_name ORDER BY n DESC`,
      args: [pipelineId, ...scope.args] as never[],
    }),
  ]);

  const byStage = new Map<string, StageAggregate>();
  for (const raw of stageRows.rows) {
    const row = raw as unknown as Record<string, unknown>;
    byStage.set(text(row.pipeline_stage_id), {
      stageId: text(row.pipeline_stage_id),
      stageName: text(row.stage_name),
      sequenceNo: Number(row.sequence_no ?? 0),
      isWonStage: Number(row.is_won_stage ?? 0) === 1,
      isLostStage: Number(row.is_lost_stage ?? 0) === 1,
      count: 0,
      byCurrency: [],
    });
  }
  for (const raw of valueRows.rows) {
    const row = raw as unknown as Record<string, unknown>;
    const stage = byStage.get(text(row.current_stage_id));
    if (stage === undefined) continue;
    const n = Number(row.n ?? 0);
    stage.count += n;
    stage.byCurrency.push({
      currencyCode: text(row.currency_code),
      value: Number(row.value ?? 0),
      weighted: Number(row.weighted ?? 0),
      count: n,
    });
  }
  let wonCount = 0;
  let lostCount = 0;
  for (const raw of closedRows.rows) {
    const row = raw as unknown as Record<string, unknown>;
    if (text(row.status) === 'WON') wonCount = Number(row.n ?? 0);
    if (text(row.status) === 'LOST') lostCount = Number(row.n ?? 0);
  }
  return {
    pipelineId,
    stages: [...byStage.values()],
    wonCount,
    lostCount,
    lostReasons: reasonRows.rows.map((raw) => {
      const row = raw as unknown as Record<string, unknown>;
      return {
        lostReasonId: text(row.lost_reason_id),
        reasonName: text(row.reason_name),
        count: Number(row.n ?? 0),
      };
    }),
  };
}

// ---- Create and update ----------------------------------------------------

export interface OpportunityInput {
  accountId: string;
  businessUnitId: string | null;
  pipelineId: string;
  initialStageId: string | null;
  ownerUserId: string;
  title: string;
  estimatedValue: number;
  currencyCode: string;
  /** A fraction 0 to 1, or null to take the stage default. */
  probability: number | null;
  estimatedCloseDate: string | null;
}

/**
 * The destination stage checks shared by create and move: it must exist, be
 * active, belong to the named pipeline, and not be flagged both won and lost.
 * The database permits the both-flags nonsense; nothing downstream of this
 * function does.
 */
async function resolveStage(
  db: Client,
  pipelineId: string,
  stageId: string | null,
  field: string,
): Promise<
  | {
      ok: true;
      stageId: string;
      defaultProbability: number;
      isWon: boolean;
      isLost: boolean;
      stageName: string;
    }
  | { ok: false; fields: FieldError[] }
> {
  const result = await db.execute({
    sql:
      stageId === null
        ? `SELECT pipeline_stage_id, stage_name, default_probability, is_won_stage, is_lost_stage
           FROM pipeline_stages WHERE pipeline_id = ? AND active = 1 ORDER BY sequence_no LIMIT 1`
        : `SELECT pipeline_stage_id, stage_name, default_probability, is_won_stage, is_lost_stage
           FROM pipeline_stages WHERE pipeline_id = ? AND pipeline_stage_id = ? AND active = 1 LIMIT 1`,
    args: stageId === null ? [pipelineId] : [pipelineId, stageId],
  });
  const row = result.rows[0];
  if (row === undefined) {
    return {
      ok: false,
      fields: [
        {
          field,
          message: 'That pipeline has no such active stage. It may belong to another pipeline.',
        },
      ],
    };
  }
  const isWon = Number(row.is_won_stage ?? 0) === 1;
  const isLost = Number(row.is_lost_stage ?? 0) === 1;
  if (isWon && isLost) {
    return {
      ok: false,
      fields: [
        {
          field,
          message:
            'That stage is flagged both won and lost, which is contradictory configuration. Fix the stage before using it.',
        },
      ],
    };
  }
  return {
    ok: true,
    stageId: text(row.pipeline_stage_id),
    stageName: text(row.stage_name),
    defaultProbability: Number(row.default_probability ?? 0),
    isWon,
    isLost,
  };
}

export async function createOpportunity(
  db: Client,
  userId: string,
  input: OpportunityInput,
  ctx: WriteContext,
): Promise<WriteResult<OpportunityRow>> {
  // The account must exist and sit inside the caller's own customer scope,
  // checked with the Build Prompt 10 predicate rather than a second one, or a
  // salesperson could open a deal against a customer they may not see and
  // thereby learn the customer exists. Absent and out-of-scope produce the
  // same answer on purpose.
  const accountScope = await scopedAccounts(db, userId);
  const account = await db.execute({
    sql: `SELECT a.account_id FROM accounts a WHERE a.account_id = ? AND ${accountScope.sql} LIMIT 1`,
    args: [input.accountId, ...accountScope.args] as never[],
  });
  if (account.rows[0] === undefined) {
    return {
      ok: false,
      kind: 'invalid_reference',
      fields: [{ field: 'accountId', message: 'That account does not exist or is out of scope.' }],
    };
  }

  const stage = await resolveStage(db, input.pipelineId, input.initialStageId, 'initialStageId');
  if (!stage.ok) return { ok: false, kind: 'invalid_reference', fields: stage.fields };

  const opportunityId = newId('OPP');
  const now = toDbTimestamp(ctx.now);
  const probability = input.probability ?? stage.defaultProbability;

  try {
    await withGeneratedNumber(
      NUMBER_PREFIX.opportunity,
      'opportunity_number',
      ctx.now,
      async (candidate) => {
        await db.batch(
          [
            {
              sql: `INSERT INTO opportunities
                      (opportunity_id, opportunity_number, lead_id, account_id, business_unit_id,
                       pipeline_id, current_stage_id, owner_user_id, title, estimated_value,
                       currency_code, probability, estimated_close_date, actual_close_date,
                       status, won_amount, lost_reason_id, lost_notes, created_at, updated_at)
                    VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'OPEN', NULL, NULL, NULL, ?, ?)`,
              args: [
                opportunityId,
                candidate,
                input.accountId,
                input.businessUnitId,
                input.pipelineId,
                stage.stageId,
                input.ownerUserId,
                input.title,
                input.estimatedValue,
                input.currencyCode,
                probability,
                input.estimatedCloseDate,
                now,
                now,
              ],
            },
            {
              sql: `INSERT INTO opportunity_stage_history
                      (stage_history_id, opportunity_id, from_stage_id, to_stage_id,
                       changed_by_user_id, changed_at, duration_in_previous_stage_minutes, reason)
                    VALUES (?, ?, NULL, ?, ?, ?, NULL, 'Opportunity created')`,
              args: [newId('OSH'), opportunityId, stage.stageId, ctx.actorUserId, now],
            },
            audit(ctx, 'OPPORTUNITY_CREATED', 'OPPORTUNITY', opportunityId, 'CREATE', null, {
              opportunityNumber: candidate,
              accountId: input.accountId,
              pipelineId: input.pipelineId,
              stageId: stage.stageId,
              estimatedValue: input.estimatedValue,
              currencyCode: input.currencyCode,
              probability,
            }),
          ],
          'write',
        );
        return candidate;
      },
    );
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

  const created = await getOpportunityUnscoped(db, opportunityId);
  return created === null ? { ok: false, kind: 'not_found' } : { ok: true, value: created };
}

export interface OpportunityPatch {
  title: string;
  businessUnitId: string | null;
  ownerUserId: string;
  estimatedValue: number;
  currencyCode: string;
  estimatedCloseDate: string | null;
}

export async function updateOpportunity(
  db: Client,
  userId: string,
  opportunityId: string,
  patch: OpportunityPatch,
  ctx: WriteContext,
): Promise<WriteResult<OpportunityRow>> {
  const before = await getOpportunity(db, userId, opportunityId);
  if (before === null) return { ok: false, kind: 'not_found' };
  if (before.status !== 'OPEN') {
    return {
      ok: false,
      kind: 'conflict',
      fields: [
        {
          field: 'status',
          message: 'A closed opportunity is history. Its commercial terms are no longer editable.',
        },
      ],
    };
  }

  const now = toDbTimestamp(ctx.now);
  const statements: Stmt[] = [
    {
      sql: `UPDATE opportunities SET title = ?, business_unit_id = ?, owner_user_id = ?,
              estimated_value = ?, currency_code = ?, estimated_close_date = ?, updated_at = ?
            WHERE opportunity_id = ?`,
      args: [
        patch.title,
        patch.businessUnitId,
        patch.ownerUserId,
        patch.estimatedValue,
        patch.currencyCode,
        patch.estimatedCloseDate,
        now,
        opportunityId,
      ],
    },
    audit(
      ctx,
      'OPPORTUNITY_UPDATED',
      'OPPORTUNITY',
      opportunityId,
      'UPDATE',
      {
        title: before.title,
        businessUnitId: before.businessUnitId,
        estimatedValue: before.estimatedValue,
        currencyCode: before.currencyCode,
        estimatedCloseDate: before.estimatedCloseDate,
      },
      {
        title: patch.title,
        businessUnitId: patch.businessUnitId,
        estimatedValue: patch.estimatedValue,
        currencyCode: patch.currencyCode,
        estimatedCloseDate: patch.estimatedCloseDate,
      },
    ),
  ];
  if (patch.ownerUserId !== before.ownerUserId) {
    statements.push(
      audit(
        ctx,
        'OPPORTUNITY_OWNER_CHANGED',
        'OPPORTUNITY',
        opportunityId,
        'REASSIGN',
        { ownerUserId: before.ownerUserId },
        { ownerUserId: patch.ownerUserId },
      ),
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
  const after = await getOpportunityUnscoped(db, opportunityId);
  return after === null ? { ok: false, kind: 'not_found' } : { ok: true, value: after };
}

// ---- The stage move -------------------------------------------------------

export interface StageMoveInput {
  /** The stage the caller believes the opportunity is currently in. */
  expectedStageId: string;
  toStageId: string;
  /** A fraction 0 to 1, or null to take the destination's default. */
  probability: number | null;
  reason: string | null;
  /** Required when the destination is a won stage. */
  wonAmount: number | null;
  actualCloseDate: string | null;
  /** Required when the destination is a lost stage. */
  lostReasonId: string | null;
  lostNotes: string | null;
  /**
   * On a won move for a PROSPECT account: also move the account to CUSTOMER.
   * The caller must hold the accounts permission; the route checks it. The
   * Oracle customer code is untouched, because winning a deal does not create
   * an Oracle master record.
   */
  markAccountCustomer: boolean;
}

export async function moveStage(
  db: Client,
  userId: string,
  opportunityId: string,
  input: StageMoveInput,
  ctx: WriteContext,
): Promise<WriteResult<OpportunityRow>> {
  const before = await getOpportunity(db, userId, opportunityId);
  if (before === null) return { ok: false, kind: 'not_found' };
  if (before.status !== 'OPEN') {
    return {
      ok: false,
      kind: 'conflict',
      fields: [
        {
          field: 'toStageId',
          message: `This opportunity is already ${before.status.toLowerCase()}. Closed records do not move.`,
        },
      ],
    };
  }

  const stage = await resolveStage(db, before.pipelineId, input.toStageId, 'toStageId');
  if (!stage.ok) return { ok: false, kind: 'invalid_reference', fields: stage.fields };
  if (stage.stageId === before.currentStageId) {
    return {
      ok: false,
      kind: 'conflict',
      fields: [{ field: 'toStageId', message: 'The opportunity is already in that stage.' }],
    };
  }

  const fields: FieldError[] = [];
  if (stage.isWon) {
    if (input.wonAmount === null) {
      fields.push({
        field: 'wonAmount',
        message: 'A won deal needs the amount actually won. It may differ from the estimate.',
      });
    }
    if (input.actualCloseDate === null) {
      fields.push({ field: 'actualCloseDate', message: 'A won deal needs its actual close date.' });
    }
  }
  if (stage.isLost) {
    if (input.lostReasonId === null) {
      fields.push({
        field: 'lostReasonId',
        message: 'A lost deal needs a reason from the configured list.',
      });
    }
    if (input.actualCloseDate === null) {
      fields.push({
        field: 'actualCloseDate',
        message: 'A lost deal needs its actual close date.',
      });
    }
  }
  if (fields.length > 0) return { ok: false, kind: 'invalid_reference', fields };

  if (stage.isLost && input.lostReasonId !== null) {
    const reason = await db.execute({
      sql: `SELECT lost_reason_id FROM lost_reasons WHERE lost_reason_id = ? AND active = 1`,
      args: [input.lostReasonId],
    });
    if (reason.rows[0] === undefined) {
      return {
        ok: false,
        kind: 'invalid_reference',
        fields: [{ field: 'lostReasonId', message: 'That lost reason does not exist.' }],
      };
    }
  }

  const now = toDbTimestamp(ctx.now);
  // Time in the previous stage: now minus the moment the last history row was
  // written. Null when there is no history at all, which should not happen for
  // records this module created, but seeded or imported data may lack it and
  // null is the honest answer there, never zero.
  const durationMinutes =
    before.enteredStageAt === null
      ? null
      : Math.max(
          0,
          Math.round((ctx.now.getTime() - Date.parse(`${before.enteredStageAt}Z`)) / 60000),
        );

  const nextStatus = stage.isWon ? 'WON' : stage.isLost ? 'LOST' : 'OPEN';
  const probability = stage.isWon
    ? 1
    : stage.isLost
      ? 0
      : (input.probability ?? stage.defaultProbability);

  const statements: Stmt[] = [
    {
      // Conditional on the stage the caller saw still being current. If a
      // concurrent move won, this affects zero rows and the history insert
      // below aborts the whole batch.
      sql: `UPDATE opportunities SET current_stage_id = ?, probability = ?, status = ?,
              actual_close_date = ?, won_amount = ?, lost_reason_id = ?, lost_notes = ?,
              updated_at = ?
            WHERE opportunity_id = ? AND current_stage_id = ? AND status = 'OPEN'`,
      args: [
        stage.stageId,
        probability,
        nextStatus,
        stage.isWon || stage.isLost ? input.actualCloseDate : before.actualCloseDate,
        stage.isWon ? input.wonAmount : before.wonAmount,
        stage.isLost ? input.lostReasonId : before.lostReasonId,
        stage.isLost ? input.lostNotes : before.lostNotes,
        now,
        opportunityId,
        input.expectedStageId,
      ],
    },
    {
      // `changes()` is the row count of the UPDATE above, inside this same
      // transaction. A lost race makes it 0, the CASE yields NULL, and the
      // NOT NULL constraint on to_stage_id aborts everything: no history row,
      // no audit row, no phantom move. The loser is told the record moved.
      sql: `INSERT INTO opportunity_stage_history
              (stage_history_id, opportunity_id, from_stage_id, to_stage_id,
               changed_by_user_id, changed_at, duration_in_previous_stage_minutes, reason)
            VALUES (?, ?, ?, CASE WHEN changes() > 0 THEN ? ELSE NULL END, ?, ?, ?, ?)`,
      args: [
        newId('OSH'),
        opportunityId,
        before.currentStageId,
        stage.stageId,
        ctx.actorUserId,
        now,
        durationMinutes,
        input.reason,
      ],
    },
    audit(
      ctx,
      'OPPORTUNITY_STAGE_CHANGED',
      'OPPORTUNITY',
      opportunityId,
      'STAGE_CHANGE',
      { stageId: before.currentStageId, probability: before.probability, status: before.status },
      { stageId: stage.stageId, probability, status: nextStatus },
    ),
  ];

  if (stage.isWon) {
    statements.push(
      audit(
        ctx,
        'OPPORTUNITY_WON',
        'OPPORTUNITY',
        opportunityId,
        'WIN',
        { status: before.status },
        { status: 'WON', wonAmount: input.wonAmount, actualCloseDate: input.actualCloseDate },
      ),
    );
    if (input.markAccountCustomer && before.accountType === 'PROSPECT') {
      statements.push(
        {
          // Conditional on the account still being a prospect, and the Oracle
          // code is deliberately not in the SET: a commercial win does not
          // create an Oracle master record.
          sql: `UPDATE accounts SET account_type = 'CUSTOMER', updated_at = ?
                WHERE account_id = ? AND account_type = 'PROSPECT'`,
          args: [now, before.accountId],
        },
        audit(
          ctx,
          'ACCOUNT_TYPE_CHANGED',
          'ACCOUNT',
          before.accountId,
          'TYPE_CHANGE',
          { accountType: 'PROSPECT' },
          { accountType: 'CUSTOMER', trigger: `OPPORTUNITY_WON ${opportunityId}` },
        ),
      );
    }
  }
  if (stage.isLost) {
    statements.push(
      audit(
        ctx,
        'OPPORTUNITY_LOST',
        'OPPORTUNITY',
        opportunityId,
        'LOSE',
        { status: before.status },
        { status: 'LOST', lostReasonId: input.lostReasonId, lostNotes: input.lostNotes },
      ),
    );
  }

  try {
    await db.batch(statements, 'write');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/NOT NULL constraint failed: opportunity_stage_history\.to_stage_id/i.test(message)) {
      return {
        ok: false,
        kind: 'conflict',
        fields: [
          {
            field: 'expectedStageId',
            message:
              'Somebody moved this opportunity while you were looking at it. Reload to see where it is now.',
          },
        ],
      };
    }
    throw error;
  }

  const after = await getOpportunityUnscoped(db, opportunityId);
  return after === null ? { ok: false, kind: 'not_found' } : { ok: true, value: after };
}

// ---- Stage history --------------------------------------------------------

export interface StageHistoryRow {
  stageHistoryId: string;
  fromStageId: string | null;
  fromStageName: string | null;
  toStageId: string;
  toStageName: string;
  changedByName: string;
  changedAt: string;
  durationInPreviousStageMinutes: number | null;
  reason: string | null;
}

export async function listStageHistory(
  db: Client,
  opportunityId: string,
): Promise<StageHistoryRow[]> {
  const result = await db.execute({
    sql: `SELECT h.stage_history_id, h.from_stage_id, fs.stage_name AS from_stage_name,
                 h.to_stage_id, ts.stage_name AS to_stage_name, u.display_name AS changed_by_name,
                 h.changed_at, h.duration_in_previous_stage_minutes, h.reason
          FROM opportunity_stage_history h
          LEFT JOIN pipeline_stages fs ON fs.pipeline_stage_id = h.from_stage_id
          JOIN pipeline_stages ts ON ts.pipeline_stage_id = h.to_stage_id
          JOIN users u ON u.user_id = h.changed_by_user_id
          WHERE h.opportunity_id = ?
          ORDER BY h.changed_at, h.stage_history_id`,
    args: [opportunityId],
  });
  return result.rows.map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    return {
      stageHistoryId: text(row.stage_history_id),
      fromStageId: nullableText(row.from_stage_id),
      fromStageName: nullableText(row.from_stage_name),
      toStageId: text(row.to_stage_id),
      toStageName: text(row.to_stage_name),
      changedByName: text(row.changed_by_name),
      changedAt: text(row.changed_at),
      durationInPreviousStageMinutes: nullableNumber(row.duration_in_previous_stage_minutes),
      reason: nullableText(row.reason),
    };
  });
}

// ---- Product lines --------------------------------------------------------

export interface ProductLineRow {
  opportunityProductId: string;
  productId: string;
  productName: string;
  productCode: string | null;
  unitOfMeasure: string | null;
  expectedQuantity: number;
  unitPrice: number | null;
  estimatedLineValue: number | null;
}

export interface LineReconciliation {
  /** Sum of the line values that exist. Null when no line carries a value. */
  lineValueSum: number | null;
  linesWithValue: number;
  linesWithoutValue: number;
  /** header estimate minus line sum, null when the sum is null. */
  variance: number | null;
}

export async function listProductLines(
  db: Client,
  opportunityId: string,
): Promise<ProductLineRow[]> {
  const result = await db.execute({
    sql: `SELECT op.opportunity_product_id, op.product_id, p.product_name, p.product_code,
                 p.unit_of_measure, op.expected_quantity, op.unit_price, op.estimated_line_value
          FROM opportunity_products op
          JOIN products p ON p.product_id = op.product_id
          WHERE op.opportunity_id = ?
          ORDER BY p.product_name`,
    args: [opportunityId],
  });
  return result.rows.map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    return {
      opportunityProductId: text(row.opportunity_product_id),
      productId: text(row.product_id),
      productName: text(row.product_name),
      productCode: nullableText(row.product_code),
      unitOfMeasure: nullableText(row.unit_of_measure),
      expectedQuantity: Number(row.expected_quantity ?? 0),
      unitPrice: nullableNumber(row.unit_price),
      estimatedLineValue: nullableNumber(row.estimated_line_value),
    };
  });
}

/**
 * Lines inform, the header decides. The sum of the line values is offered and
 * the variance is shown; the manually agreed commercial estimate is never
 * silently overwritten. A line with no value contributes nothing to the sum
 * and is counted separately, so a partial sum is never mistaken for a total.
 */
export function reconcileLines(headerValue: number, lines: ProductLineRow[]): LineReconciliation {
  const valued = lines.filter((l) => l.estimatedLineValue !== null);
  const lineValueSum =
    valued.length === 0 ? null : valued.reduce((sum, l) => sum + (l.estimatedLineValue ?? 0), 0);
  return {
    lineValueSum,
    linesWithValue: valued.length,
    linesWithoutValue: lines.length - valued.length,
    variance: lineValueSum === null ? null : headerValue - lineValueSum,
  };
}

export interface ProductLineInput {
  productId: string;
  expectedQuantity: number;
  unitPrice: number | null;
  estimatedLineValue: number | null;
}

export async function addProductLine(
  db: Client,
  userId: string,
  opportunityId: string,
  input: ProductLineInput,
  ctx: WriteContext,
): Promise<WriteResult<ProductLineRow[]>> {
  const opportunity = await getOpportunity(db, userId, opportunityId);
  if (opportunity === null) return { ok: false, kind: 'not_found' };

  // The product must come from the catalogue: existence checked here, and the
  // FOREIGN KEY would refuse it anyway. There is no free-text product line.
  const product = await db.execute({
    sql: `SELECT product_id FROM products WHERE product_id = ? AND active = 1`,
    args: [input.productId],
  });
  if (product.rows[0] === undefined) {
    return {
      ok: false,
      kind: 'invalid_reference',
      fields: [
        {
          field: 'productId',
          message: 'Choose a product from the catalogue. There is no free-text product.',
        },
      ],
    };
  }

  const lineId = newId('OPPPR');
  await db.batch(
    [
      {
        sql: `INSERT INTO opportunity_products
                (opportunity_product_id, opportunity_id, product_id, expected_quantity,
                 unit_price, estimated_line_value)
              VALUES (?, ?, ?, ?, ?, ?)`,
        args: [
          lineId,
          opportunityId,
          input.productId,
          input.expectedQuantity,
          input.unitPrice,
          input.estimatedLineValue,
        ],
      },
      audit(ctx, 'PRODUCT_ADDED', 'OPPORTUNITY', opportunityId, 'PRODUCT_ADD', null, {
        opportunityProductId: lineId,
        productId: input.productId,
        expectedQuantity: input.expectedQuantity,
      }),
    ],
    'write',
  );
  return { ok: true, value: await listProductLines(db, opportunityId) };
}

export async function removeProductLine(
  db: Client,
  userId: string,
  opportunityId: string,
  lineId: string,
  ctx: WriteContext,
): Promise<WriteResult<ProductLineRow[]>> {
  const opportunity = await getOpportunity(db, userId, opportunityId);
  if (opportunity === null) return { ok: false, kind: 'not_found' };
  const line = await db.execute({
    sql: `SELECT opportunity_product_id, product_id, expected_quantity FROM opportunity_products
          WHERE opportunity_product_id = ? AND opportunity_id = ?`,
    args: [lineId, opportunityId],
  });
  const row = line.rows[0];
  if (row === undefined) return { ok: false, kind: 'not_found' };

  await db.batch(
    [
      {
        sql: `DELETE FROM opportunity_products WHERE opportunity_product_id = ?`,
        args: [lineId],
      },
      audit(
        ctx,
        'PRODUCT_REMOVED',
        'OPPORTUNITY',
        opportunityId,
        'PRODUCT_REMOVE',
        {
          opportunityProductId: lineId,
          productId: text(row.product_id),
          expectedQuantity: Number(row.expected_quantity ?? 0),
        },
        null,
      ),
    ],
    'write',
  );
  return { ok: true, value: await listProductLines(db, opportunityId) };
}

// ---- Pipeline administration ----------------------------------------------

export interface PipelineStageRow {
  pipelineStageId: string;
  stageName: string;
  sequenceNo: number;
  /** Stored fraction 0 to 1. */
  defaultProbability: number;
  targetDays: number | null;
  isWonStage: boolean;
  isLostStage: boolean;
  active: boolean;
  /** How many opportunities sit in or have passed through this stage. */
  usageCount: number;
}

export interface PipelineRow {
  pipelineId: string;
  pipelineName: string;
  countryId: string | null;
  affiliateId: string | null;
  active: boolean;
  opportunityCount: number;
  stages: PipelineStageRow[];
  /**
   * Configuration completeness, computed rather than enforced by refusing
   * saves: a pipeline being built up stage by stage is legitimately
   * incomplete, and several seeded pipelines have no stages at all. What is
   * enforced is that an opportunity cannot be created in a pipeline with no
   * active stage, and that no stage is ever both won and lost.
   */
  hasActiveStage: boolean;
  hasWonStage: boolean;
  hasLostStage: boolean;
}

function toStageRow(row: Record<string, unknown>): PipelineStageRow {
  return {
    pipelineStageId: text(row.pipeline_stage_id),
    stageName: text(row.stage_name),
    sequenceNo: Number(row.sequence_no ?? 0),
    defaultProbability: Number(row.default_probability ?? 0),
    targetDays: nullableNumber(row.target_days),
    isWonStage: Number(row.is_won_stage ?? 0) === 1,
    isLostStage: Number(row.is_lost_stage ?? 0) === 1,
    active: Number(row.active ?? 0) === 1,
    usageCount: Number(row.usage_count ?? 0),
  };
}

export async function listPipelines(db: Client): Promise<PipelineRow[]> {
  const [pipelines, stages] = await db.batch(
    [
      `SELECT pl.pipeline_id, pl.pipeline_name, pl.country_id, pl.affiliate_id, pl.active,
              (SELECT COUNT(*) FROM opportunities o WHERE o.pipeline_id = pl.pipeline_id) AS opportunity_count
       FROM pipelines pl ORDER BY pl.pipeline_name`,
      `SELECT s.pipeline_stage_id, s.pipeline_id, s.stage_name, s.sequence_no,
              s.default_probability, s.target_days, s.is_won_stage, s.is_lost_stage, s.active,
              (SELECT COUNT(*) FROM opportunities o WHERE o.current_stage_id = s.pipeline_stage_id)
              + (SELECT COUNT(*) FROM opportunity_stage_history h
                 WHERE h.to_stage_id = s.pipeline_stage_id) AS usage_count
       FROM pipeline_stages s ORDER BY s.pipeline_id, s.sequence_no`,
    ],
    'read',
  );

  const byPipeline = new Map<string, PipelineStageRow[]>();
  for (const raw of stages.rows) {
    const row = raw as unknown as Record<string, unknown>;
    const pipelineId = text(row.pipeline_id);
    const list = byPipeline.get(pipelineId) ?? [];
    list.push(toStageRow(row));
    byPipeline.set(pipelineId, list);
  }

  return pipelines.rows.map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    const pipelineId = text(row.pipeline_id);
    const stageList = byPipeline.get(pipelineId) ?? [];
    const activeStages = stageList.filter((s) => s.active);
    return {
      pipelineId,
      pipelineName: text(row.pipeline_name),
      countryId: nullableText(row.country_id),
      affiliateId: nullableText(row.affiliate_id),
      active: Number(row.active ?? 0) === 1,
      opportunityCount: Number(row.opportunity_count ?? 0),
      stages: stageList,
      hasActiveStage: activeStages.length > 0,
      hasWonStage: activeStages.some((s) => s.isWonStage),
      hasLostStage: activeStages.some((s) => s.isLostStage),
    };
  });
}

export async function getPipeline(db: Client, pipelineId: string): Promise<PipelineRow | null> {
  const all = await listPipelines(db);
  return all.find((p) => p.pipelineId === pipelineId) ?? null;
}

export interface PipelineInput {
  pipelineName: string;
  countryId: string | null;
  affiliateId: string | null;
  active: boolean;
}

const isUnique = (e: unknown, needle: string) =>
  /UNIQUE constraint failed/i.test(e instanceof Error ? e.message : String(e)) &&
  String(e instanceof Error ? e.message : e).includes(needle);

export async function createPipeline(
  db: Client,
  input: PipelineInput,
  ctx: WriteContext,
): Promise<WriteResult<PipelineRow>> {
  const pipelineId = newId('PIPE');
  try {
    await db.batch(
      [
        {
          sql: `INSERT INTO pipelines (pipeline_id, pipeline_name, country_id, affiliate_id, active, created_at)
                VALUES (?, ?, ?, ?, ?, ?)`,
          args: [
            pipelineId,
            input.pipelineName,
            input.countryId,
            input.affiliateId,
            input.active ? 1 : 0,
            toDbTimestamp(ctx.now),
          ],
        },
        audit(ctx, 'PIPELINE_CREATED', 'PIPELINE', pipelineId, 'CREATE', null, input),
      ],
      'write',
    );
  } catch (error) {
    if (isUnique(error, 'pipeline_name')) {
      return {
        ok: false,
        kind: 'conflict',
        fields: [{ field: 'pipelineName', message: 'A pipeline with that name already exists.' }],
      };
    }
    if (/FOREIGN KEY constraint failed/i.test(String(error))) {
      return {
        ok: false,
        kind: 'invalid_reference',
        fields: [{ field: 'countryId', message: 'That country or affiliate does not exist.' }],
      };
    }
    throw error;
  }
  const created = await getPipeline(db, pipelineId);
  return created === null ? { ok: false, kind: 'not_found' } : { ok: true, value: created };
}

export async function updatePipeline(
  db: Client,
  pipelineId: string,
  input: PipelineInput,
  ctx: WriteContext,
): Promise<WriteResult<PipelineRow>> {
  const before = await getPipeline(db, pipelineId);
  if (before === null) return { ok: false, kind: 'not_found' };
  try {
    await db.batch(
      [
        {
          sql: `UPDATE pipelines SET pipeline_name = ?, country_id = ?, affiliate_id = ?, active = ?
                WHERE pipeline_id = ?`,
          args: [
            input.pipelineName,
            input.countryId,
            input.affiliateId,
            input.active ? 1 : 0,
            pipelineId,
          ],
        },
        audit(
          ctx,
          'PIPELINE_UPDATED',
          'PIPELINE',
          pipelineId,
          'UPDATE',
          {
            pipelineName: before.pipelineName,
            countryId: before.countryId,
            affiliateId: before.affiliateId,
            active: before.active,
          },
          input,
        ),
      ],
      'write',
    );
  } catch (error) {
    if (isUnique(error, 'pipeline_name')) {
      return {
        ok: false,
        kind: 'conflict',
        fields: [{ field: 'pipelineName', message: 'A pipeline with that name already exists.' }],
      };
    }
    throw error;
  }
  const after = await getPipeline(db, pipelineId);
  return after === null ? { ok: false, kind: 'not_found' } : { ok: true, value: after };
}

export interface StageInput {
  stageName: string;
  /** Stored fraction 0 to 1, converted from a percent by the validator. */
  defaultProbability: number;
  targetDays: number | null;
  isWonStage: boolean;
  isLostStage: boolean;
  active: boolean;
}

/** The one rule the database does not enforce and this module always does. */
function refuseWonAndLost(input: StageInput): FieldError[] {
  if (input.isWonStage && input.isLostStage) {
    return [
      {
        field: 'isLostStage',
        message:
          'A stage cannot be both won and lost. The database would permit it; this application does not.',
      },
    ];
  }
  return [];
}

export async function addStage(
  db: Client,
  pipelineId: string,
  input: StageInput,
  ctx: WriteContext,
): Promise<WriteResult<PipelineRow>> {
  const pipeline = await getPipeline(db, pipelineId);
  if (pipeline === null) return { ok: false, kind: 'not_found' };
  const contradiction = refuseWonAndLost(input);
  if (contradiction.length > 0) return { ok: false, kind: 'conflict', fields: contradiction };

  // Appended at the end. Position is changed by reorderStages, deliberately a
  // separate action with its own warning, not a side effect of adding.
  const nextSequence =
    pipeline.stages.reduce((max, stage) => Math.max(max, stage.sequenceNo), 0) + 1;
  const stageId = newId('PST');
  try {
    await db.batch(
      [
        {
          sql: `INSERT INTO pipeline_stages
                  (pipeline_stage_id, pipeline_id, stage_name, sequence_no, default_probability,
                   target_days, is_won_stage, is_lost_stage, active)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            stageId,
            pipelineId,
            input.stageName,
            nextSequence,
            input.defaultProbability,
            input.targetDays,
            input.isWonStage ? 1 : 0,
            input.isLostStage ? 1 : 0,
            input.active ? 1 : 0,
          ],
        },
        audit(ctx, 'PIPELINE_UPDATED', 'PIPELINE', pipelineId, 'STAGE_ADD', null, {
          stageId,
          ...input,
          sequenceNo: nextSequence,
        }),
      ],
      'write',
    );
  } catch (error) {
    if (isUnique(error, 'stage_name')) {
      return {
        ok: false,
        kind: 'conflict',
        fields: [
          { field: 'stageName', message: 'That pipeline already has a stage with this name.' },
        ],
      };
    }
    if (isUnique(error, 'sequence_no')) {
      return {
        ok: false,
        kind: 'conflict',
        fields: [
          {
            field: 'stageName',
            message: 'The stage order changed underneath you. Reload and try again.',
          },
        ],
      };
    }
    throw error;
  }
  const after = await getPipeline(db, pipelineId);
  return after === null ? { ok: false, kind: 'not_found' } : { ok: true, value: after };
}

export async function updateStage(
  db: Client,
  stageId: string,
  input: StageInput,
  ctx: WriteContext,
): Promise<WriteResult<PipelineRow>> {
  const found = await db.execute({
    sql: `SELECT pipeline_id, stage_name, default_probability, target_days, is_won_stage,
                 is_lost_stage, active
          FROM pipeline_stages WHERE pipeline_stage_id = ?`,
    args: [stageId],
  });
  const row = found.rows[0];
  if (row === undefined) return { ok: false, kind: 'not_found' };
  const pipelineId = text(row.pipeline_id);
  const contradiction = refuseWonAndLost(input);
  if (contradiction.length > 0) return { ok: false, kind: 'conflict', fields: contradiction };

  try {
    await db.batch(
      [
        {
          sql: `UPDATE pipeline_stages SET stage_name = ?, default_probability = ?, target_days = ?,
                  is_won_stage = ?, is_lost_stage = ?, active = ?
                WHERE pipeline_stage_id = ?`,
          args: [
            input.stageName,
            input.defaultProbability,
            input.targetDays,
            input.isWonStage ? 1 : 0,
            input.isLostStage ? 1 : 0,
            input.active ? 1 : 0,
            stageId,
          ],
        },
        audit(
          ctx,
          'PIPELINE_UPDATED',
          'PIPELINE',
          pipelineId,
          'STAGE_UPDATE',
          {
            stageName: text(row.stage_name),
            defaultProbability: Number(row.default_probability ?? 0),
            targetDays: nullableNumber(row.target_days),
            isWonStage: Number(row.is_won_stage ?? 0) === 1,
            isLostStage: Number(row.is_lost_stage ?? 0) === 1,
            active: Number(row.active ?? 0) === 1,
          },
          { stageId, ...input },
        ),
      ],
      'write',
    );
  } catch (error) {
    if (isUnique(error, 'stage_name')) {
      return {
        ok: false,
        kind: 'conflict',
        fields: [
          { field: 'stageName', message: 'That pipeline already has a stage with this name.' },
        ],
      };
    }
    throw error;
  }
  const after = await getPipeline(db, pipelineId);
  return after === null ? { ok: false, kind: 'not_found' } : { ok: true, value: after };
}

/**
 * Reorder the stages of one pipeline to exactly the order given.
 *
 * UNIQUE(pipeline_id, sequence_no) means a naive pairwise renumbering can
 * collide mid-flight: setting stage B to 2 while stage A still holds 2 is
 * refused whatever the eventual state would have been. So the whole reorder
 * is one batch in two passes: every stage is first parked at its target
 * position plus a large offset, clear of any live value, then written to its
 * final position. Both passes commit together or not at all.
 *
 * The offset is derived from the current maximum rather than hard-coded, so a
 * pipeline whose sequences already reach the thousands still cannot collide.
 */
export async function reorderStages(
  db: Client,
  pipelineId: string,
  orderedStageIds: string[],
  ctx: WriteContext,
): Promise<WriteResult<PipelineRow>> {
  const pipeline = await getPipeline(db, pipelineId);
  if (pipeline === null) return { ok: false, kind: 'not_found' };

  const known = new Set(pipeline.stages.map((s) => s.pipelineStageId));
  if (
    orderedStageIds.length !== known.size ||
    orderedStageIds.some((id) => !known.has(id)) ||
    new Set(orderedStageIds).size !== orderedStageIds.length
  ) {
    return {
      ok: false,
      kind: 'invalid_reference',
      fields: [
        {
          field: 'orderedStageIds',
          message:
            'The order must name every stage of this pipeline exactly once. The stages may have changed; reload.',
        },
      ],
    };
  }

  const offset = pipeline.stages.reduce((max, s) => Math.max(max, s.sequenceNo), 0) + 1000;
  const park: Stmt[] = orderedStageIds.map((stageId, index) => ({
    sql: `UPDATE pipeline_stages SET sequence_no = ? WHERE pipeline_stage_id = ? AND pipeline_id = ?`,
    args: [offset + index + 1, stageId, pipelineId],
  }));
  const settle: Stmt[] = orderedStageIds.map((stageId, index) => ({
    sql: `UPDATE pipeline_stages SET sequence_no = ? WHERE pipeline_stage_id = ? AND pipeline_id = ?`,
    args: [index + 1, stageId, pipelineId],
  }));

  await db.batch(
    [
      ...park,
      ...settle,
      audit(
        ctx,
        'PIPELINE_UPDATED',
        'PIPELINE',
        pipelineId,
        'STAGE_REORDER',
        { order: pipeline.stages.map((s) => s.pipelineStageId) },
        { order: orderedStageIds },
      ),
    ],
    'write',
  );
  const after = await getPipeline(db, pipelineId);
  return after === null ? { ok: false, kind: 'not_found' } : { ok: true, value: after };
}

// ---- Lost reasons ----------------------------------------------------------

export interface LostReasonRow {
  lostReasonId: string;
  reasonName: string;
  category: string;
  description: string | null;
  active: boolean;
  /** How many lost opportunities carry this reason. */
  usageCount: number;
}

export async function listLostReasons(db: Client): Promise<LostReasonRow[]> {
  const result = await db.execute(
    `SELECT lr.lost_reason_id, lr.reason_name, lr.category, lr.description, lr.active,
            (SELECT COUNT(*) FROM opportunities o WHERE o.lost_reason_id = lr.lost_reason_id) AS usage_count
     FROM lost_reasons lr ORDER BY lr.category, lr.reason_name`,
  );
  return result.rows.map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    return {
      lostReasonId: text(row.lost_reason_id),
      reasonName: text(row.reason_name),
      category: text(row.category),
      description: nullableText(row.description),
      active: Number(row.active ?? 0) === 1,
      usageCount: Number(row.usage_count ?? 0),
    };
  });
}

export async function getLostReason(db: Client, id: string): Promise<LostReasonRow | null> {
  const all = await listLostReasons(db);
  return all.find((r) => r.lostReasonId === id) ?? null;
}

export interface LostReasonInput {
  reasonName: string;
  category: string;
  description: string | null;
  active: boolean;
}

export async function createLostReason(
  db: Client,
  input: LostReasonInput,
  ctx: WriteContext,
): Promise<WriteResult<LostReasonRow>> {
  const id = newId('LR');
  try {
    await db.batch(
      [
        {
          sql: `INSERT INTO lost_reasons (lost_reason_id, reason_name, category, description, active)
                VALUES (?, ?, ?, ?, ?)`,
          args: [id, input.reasonName, input.category, input.description, input.active ? 1 : 0],
        },
        audit(ctx, 'LOST_REASON_CREATED', 'LOST_REASON', id, 'CREATE', null, input),
      ],
      'write',
    );
  } catch (error) {
    if (isUnique(error, 'reason_name')) {
      return {
        ok: false,
        kind: 'conflict',
        fields: [{ field: 'reasonName', message: 'A lost reason with that name already exists.' }],
      };
    }
    throw error;
  }
  const created = await getLostReason(db, id);
  return created === null ? { ok: false, kind: 'not_found' } : { ok: true, value: created };
}

export async function updateLostReason(
  db: Client,
  id: string,
  input: LostReasonInput,
  ctx: WriteContext,
): Promise<WriteResult<LostReasonRow>> {
  const before = await getLostReason(db, id);
  if (before === null) return { ok: false, kind: 'not_found' };
  try {
    await db.batch(
      [
        {
          sql: `UPDATE lost_reasons SET reason_name = ?, category = ?, description = ?, active = ?
                WHERE lost_reason_id = ?`,
          args: [input.reasonName, input.category, input.description, input.active ? 1 : 0, id],
        },
        audit(
          ctx,
          'LOST_REASON_UPDATED',
          'LOST_REASON',
          id,
          'UPDATE',
          {
            reasonName: before.reasonName,
            category: before.category,
            description: before.description,
            active: before.active,
          },
          input,
        ),
      ],
      'write',
    );
  } catch (error) {
    if (isUnique(error, 'reason_name')) {
      return {
        ok: false,
        kind: 'conflict',
        fields: [{ field: 'reasonName', message: 'A lost reason with that name already exists.' }],
      };
    }
    throw error;
  }
  const after = await getLostReason(db, id);
  return after === null ? { ok: false, kind: 'not_found' } : { ok: true, value: after };
}

// ---- Options for forms -----------------------------------------------------

export interface Option {
  id: string;
  label: string;
  parentId?: string | null;
}

export interface OpportunityOptions {
  pipelines: Option[];
  businessUnits: Option[];
  owners: Option[];
  currencies: string[];
  lostReasons: Option[];
  products: Option[];
}

export async function opportunityOptions(db: Client): Promise<OpportunityOptions> {
  const [pipelines, businessUnits, owners, currencies, lostReasons, products] = await db.batch(
    [
      `SELECT pipeline_id AS id, pipeline_name AS label FROM pipelines WHERE active = 1
       ORDER BY pipeline_name`,
      `SELECT business_unit_id AS id, business_unit_name AS label FROM business_units
       WHERE active = 1 ORDER BY business_unit_name`,
      `SELECT user_id AS id, display_name AS label FROM users
       WHERE status = 'ACTIVE' AND user_type = 'INTERNAL' ORDER BY display_name`,
      `SELECT DISTINCT currency_code AS code FROM opportunities ORDER BY currency_code`,
      `SELECT lost_reason_id AS id, reason_name AS label FROM lost_reasons WHERE active = 1
       ORDER BY reason_name`,
      `SELECT product_id AS id, product_name AS label FROM products WHERE active = 1
       ORDER BY product_name`,
    ],
    'read',
  );
  const opts = (rows: { rows: unknown[] }): Option[] =>
    (rows.rows as Record<string, unknown>[]).map((r) => ({
      id: text(r.id),
      label: text(r.label),
    }));
  return {
    pipelines: opts(pipelines),
    businessUnits: opts(businessUnits),
    owners: opts(owners),
    currencies: (currencies.rows as Record<string, unknown>[]).map((r) => text(r.code)),
    lostReasons: opts(lostReasons),
    products: opts(products),
  };
}
