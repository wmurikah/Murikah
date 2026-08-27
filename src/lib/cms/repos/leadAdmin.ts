/**
 * Reads and writes for lead management.
 *
 * A LEAD IS AN EARLY SIGNAL, NOT AN OPPORTUNITY.
 * Qualifying a lead sets its status to QUALIFIED and creates nothing.
 * Converting is a separate, deliberate act that writes an opportunity. Nothing
 * in this file converts automatically, and `convertLead` refuses to run twice.
 *
 * SCOPE COMES FROM THE BUILD PROMPT 07 RESOLVER
 * `resolveScope` and `scopePredicate` are called, never re-implemented.
 * `leads.business_unit_id` exists, unlike `accounts`, so business-unit scope
 * works directly here. Country and affiliate reach a lead through its account
 * where it has one, which is a join rather than a column and is therefore
 * written out explicitly below.
 *
 * A LEAD WITH NO ACCOUNT IS NOT VISIBLE TO EVERYONE.
 * `leads.account_id` is nullable, and a null there must never widen access.
 * `scopedLeads` writes that branch out longhand: a lead with no account is
 * reachable through its owner, its business unit or a GROUP grant, and through
 * nothing else. That is the single most likely thing to get wrong in this file.
 */
import type { Client, InStatement } from '@libsql/client/web';
import type { FieldError } from '../../validation.ts';
import { newId, auditEventStmt } from './authRecords.ts';
import { toDbTimestamp } from '../auth/session.ts';
import type { WriteContext } from '../admin/guard.ts';
import { resolveScope, DENY_ALL, type Predicate } from '../auth/rbac.ts';
import { LEADS_VIEW } from '../permissions.ts';
import { NUMBER_PREFIX, withGeneratedNumber } from '../crm/numbering.ts';
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
const nullableNumber = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v);
const isForeignKey = (e: unknown) =>
  /FOREIGN KEY constraint failed/i.test(e instanceof Error ? e.message : String(e));

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
    entityType: 'LEAD',
    entityId,
    action,
    beforeJson: before === null ? null : JSON.stringify(before),
    afterJson: after === null ? null : JSON.stringify(after),
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    now: ctx.now,
  }) as Stmt;
}

export const LEAD_AUDIT = {
  created: 'LEAD_CREATED',
  updated: 'LEAD_UPDATED',
  ownerChanged: 'LEAD_OWNER_CHANGED',
  contacted: 'LEAD_CONTACTED',
  qualified: 'LEAD_QUALIFIED',
  disqualified: 'LEAD_DISQUALIFIED',
  converted: 'LEAD_CONVERTED',
} as const;

/** `leads.status` CHECK. */
export const LEAD_STATUSES = [
  'NEW',
  'CONTACTED',
  'QUALIFIED',
  'DISQUALIFIED',
  'CONVERTED',
] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

/**
 * Which leads this principal may see.
 *
 * Written out here rather than through `scopePredicate`, because a lead's
 * country and affiliate are not columns on `leads`: they live on the account,
 * and the account is optional. The generic helper takes column names, and there
 * is no column to give it.
 *
 * The branches, and why each is written the way it is:
 *
 *   GROUP          everything. One branch, no join.
 *   BUSINESS_UNIT  `l.business_unit_id IS NOT NULL AND l.business_unit_id IN (...)`.
 *                  The IS NOT NULL is not decoration: without it a lead with no
 *                  business unit would match nothing on a bare IN, which is the
 *                  safe direction, but the explicit form is what makes the
 *                  intent reviewable.
 *   COUNTRY        through the account, and ONLY where the lead has one:
 *                  `l.account_id IS NOT NULL AND EXISTS (... a.country_id IN ...)`.
 *   AFFILIATE      the same shape.
 *   OWN            `l.owner_user_id = ?`. Always available to the owner.
 *
 * A lead with a null `account_id` therefore matches the business unit, owner
 * and group branches, and never the country or affiliate ones. It is not
 * visible to everyone, which is what section 10 requires and what a careless
 * `OR a.country_id IS NULL` would have broken.
 */
export async function scopedLeads(db: Client, userId: string): Promise<Predicate> {
  const resolution = await resolveScope(db, userId, LEADS_VIEW);
  if (!resolution.granted) return DENY_ALL;
  if (resolution.group) return { sql: '1 = 1', args: [] };

  const branches: string[] = [];
  const args: unknown[] = [];

  const values = (type: string, key: 'countryId' | 'affiliateId' | 'businessUnitId'): string[] =>
    resolution.scopes
      .filter((s) => s.scopeType === type)
      .map((s) => s[key])
      .filter((v): v is string => typeof v === 'string' && v !== '');

  const businessUnits = values('BUSINESS_UNIT', 'businessUnitId');
  if (businessUnits.length > 0) {
    branches.push(
      `(l.business_unit_id IS NOT NULL AND l.business_unit_id IN (${businessUnits.map(() => '?').join(', ')}))`,
    );
    args.push(...businessUnits);
  }

  const countries = values('COUNTRY', 'countryId');
  if (countries.length > 0) {
    branches.push(
      `(l.account_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM accounts sa WHERE sa.account_id = l.account_id
            AND sa.country_id IN (${countries.map(() => '?').join(', ')})))`,
    );
    args.push(...countries);
  }

  const affiliates = values('AFFILIATE', 'affiliateId');
  if (affiliates.length > 0) {
    branches.push(
      `(l.account_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM accounts sa WHERE sa.account_id = l.account_id
            AND sa.affiliate_id IS NOT NULL
            AND sa.affiliate_id IN (${affiliates.map(() => '?').join(', ')})))`,
    );
    args.push(...affiliates);
  }

  if (resolution.scopes.some((s) => s.scopeType === 'OWN')) {
    branches.push(`(l.owner_user_id = ?)`);
    args.push(userId);
  }

  // Granted the code, and no scope reaches a lead. Denying is the only safe
  // reading: an absent clause is `WHERE 1=1`.
  if (branches.length === 0) return DENY_ALL;
  return { sql: `(${branches.join(' OR ')})`, args };
}

// ---- reading -----------------------------------------------------------------

export interface LeadRow {
  leadId: string;
  leadNumber: string;
  accountId: string | null;
  accountName: string | null;
  primaryContactId: string | null;
  contactName: string | null;
  leadSourceId: string;
  sourceName: string;
  campaignId: string | null;
  campaignName: string | null;
  businessUnitId: string | null;
  businessUnitName: string | null;
  ownerUserId: string;
  ownerName: string;
  title: string;
  description: string | null;
  productInterest: string | null;
  estimatedVolume: number | null;
  estimatedValue: number | null;
  currencyCode: string | null;
  capturedAt: string;
  firstContactAt: string | null;
  status: LeadStatus;
  disqualificationReason: string | null;
  createdByUserId: string;
  createdAt: string;
  /** Set once the lead has been converted. Null otherwise. */
  opportunityId: string | null;
}

const LEAD_SELECT = `
  SELECT l.lead_id, l.lead_number, l.account_id, a.account_name, l.primary_contact_id,
         ct.full_name AS contact_name, l.lead_source_id, ls.source_name, l.campaign_id,
         cp.campaign_name, l.business_unit_id, bu.business_unit_name, l.owner_user_id,
         ou.display_name AS owner_name, l.title, l.description, l.product_interest,
         l.estimated_volume, l.estimated_value, l.currency_code, l.captured_at,
         l.first_contact_at, l.status, l.disqualification_reason, l.created_by_user_id,
         l.created_at,
         (SELECT o.opportunity_id FROM opportunities o WHERE o.lead_id = l.lead_id
           ORDER BY o.opportunity_id LIMIT 1) AS opportunity_id
  FROM leads l
  LEFT JOIN accounts a ON a.account_id = l.account_id
  LEFT JOIN contacts ct ON ct.contact_id = l.primary_contact_id
  JOIN lead_sources ls ON ls.lead_source_id = l.lead_source_id
  LEFT JOIN campaigns cp ON cp.campaign_id = l.campaign_id
  LEFT JOIN business_units bu ON bu.business_unit_id = l.business_unit_id
  JOIN users ou ON ou.user_id = l.owner_user_id`;

function toLead(row: Record<string, unknown>): LeadRow {
  return {
    leadId: text(row.lead_id),
    leadNumber: text(row.lead_number),
    accountId: nullableText(row.account_id),
    accountName: nullableText(row.account_name),
    primaryContactId: nullableText(row.primary_contact_id),
    contactName: nullableText(row.contact_name),
    leadSourceId: text(row.lead_source_id),
    sourceName: text(row.source_name),
    campaignId: nullableText(row.campaign_id),
    campaignName: nullableText(row.campaign_name),
    businessUnitId: nullableText(row.business_unit_id),
    businessUnitName: nullableText(row.business_unit_name),
    ownerUserId: text(row.owner_user_id),
    ownerName: text(row.owner_name),
    title: text(row.title),
    description: nullableText(row.description),
    productInterest: nullableText(row.product_interest),
    estimatedVolume: nullableNumber(row.estimated_volume),
    estimatedValue: nullableNumber(row.estimated_value),
    currencyCode: nullableText(row.currency_code),
    capturedAt: text(row.captured_at),
    firstContactAt: nullableText(row.first_contact_at),
    status: text(row.status) as LeadStatus,
    disqualificationReason: nullableText(row.disqualification_reason),
    createdByUserId: text(row.created_by_user_id),
    createdAt: text(row.created_at),
    opportunityId: nullableText(row.opportunity_id),
  };
}

export const PAGE_SIZE = 25;

export interface LeadQuery {
  readonly search: string;
  readonly status: string | null;
  readonly leadSourceId: string | null;
  readonly ownerUserId: string | null;
  readonly businessUnitId: string | null;
  readonly campaignId: string | null;
  readonly capturedFrom: string | null;
  readonly capturedTo: string | null;
  /** `pending` is `first_contact_at IS NULL`. Deterministic, not a judgement. */
  readonly firstContact: 'all' | 'pending' | 'done';
  readonly page: number;
}

export interface LeadPage {
  items: LeadRow[];
  total: number;
  page: number;
  pageSize: number;
}

function leadFilters(input: LeadQuery, scope: Predicate): { sql: string; args: unknown[] } {
  const where: string[] = [scope.sql];
  const args: unknown[] = [...scope.args];

  if (input.search.trim() !== '') {
    const needle = `%${input.search.trim()}%`;
    where.push(`(l.lead_number LIKE ? COLLATE NOCASE
             OR l.title LIKE ? COLLATE NOCASE
             OR a.account_name LIKE ? COLLATE NOCASE
             OR ct.full_name LIKE ? COLLATE NOCASE)`);
    args.push(needle, needle, needle, needle);
  }
  const eq = (column: string, value: string | null) => {
    if (value === null || value === '') return;
    where.push(`${column} = ?`);
    args.push(value);
  };
  eq('l.status', input.status);
  eq('l.lead_source_id', input.leadSourceId);
  eq('l.owner_user_id', input.ownerUserId);
  eq('l.business_unit_id', input.businessUnitId);
  eq('l.campaign_id', input.campaignId);

  if (input.capturedFrom !== null) {
    where.push(`l.captured_at >= ?`);
    args.push(input.capturedFrom);
  }
  if (input.capturedTo !== null) {
    // Inclusive of the whole day the user chose.
    where.push(`l.captured_at <= ?`);
    args.push(`${input.capturedTo} 23:59:59`);
  }
  if (input.firstContact === 'pending') where.push(`l.first_contact_at IS NULL`);
  if (input.firstContact === 'done') where.push(`l.first_contact_at IS NOT NULL`);

  return { sql: where.join(' AND '), args };
}

export async function listLeads(db: Client, userId: string, input: LeadQuery): Promise<LeadPage> {
  const scope = await scopedLeads(db, userId);
  const filter = leadFilters(input, scope);
  const page = Math.max(1, input.page);

  const rows = await db.execute({
    sql: `${LEAD_SELECT} WHERE ${filter.sql}
          ORDER BY l.captured_at DESC, l.lead_id LIMIT ? OFFSET ?`,
    args: [...filter.args, PAGE_SIZE, (page - 1) * PAGE_SIZE] as never[],
  });
  const counted = await db.execute({
    sql: `SELECT COUNT(*) AS total FROM leads l
          LEFT JOIN accounts a ON a.account_id = l.account_id
          LEFT JOIN contacts ct ON ct.contact_id = l.primary_contact_id
          WHERE ${filter.sql}`,
    args: filter.args as never[],
  });

  return {
    items: rows.rows.map((row) => toLead(row as unknown as Record<string, unknown>)),
    total: Number(counted.rows[0]?.total ?? 0),
    page,
    pageSize: PAGE_SIZE,
  };
}

/** One lead, or null when it does not exist or is out of scope. */
export async function getLead(db: Client, userId: string, leadId: string): Promise<LeadRow | null> {
  const scope = await scopedLeads(db, userId);
  const result = await db.execute({
    sql: `${LEAD_SELECT} WHERE l.lead_id = ? AND ${scope.sql} LIMIT 1`,
    args: [leadId, ...scope.args] as never[],
  });
  const row = result.rows[0];
  return row === undefined ? null : toLead(row as unknown as Record<string, unknown>);
}

async function getLeadUnscoped(db: Client, leadId: string): Promise<LeadRow | null> {
  const result = await db.execute({
    sql: `${LEAD_SELECT} WHERE l.lead_id = ? LIMIT 1`,
    args: [leadId],
  });
  const row = result.rows[0];
  return row === undefined ? null : toLead(row as unknown as Record<string, unknown>);
}

/**
 * The counts the workspace shows above the list.
 *
 * Every one runs through the same scope predicate as the list, so a card can
 * never report a lead the caller cannot open.
 */
export interface LeadIndicators {
  total: number;
  fresh: number;
  needsFirstContact: number;
  qualified: number;
}

export async function leadIndicators(db: Client, userId: string): Promise<LeadIndicators> {
  const scope = await scopedLeads(db, userId);
  const result = await db.execute({
    sql: `SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN l.status = 'NEW' THEN 1 ELSE 0 END) AS fresh,
            SUM(CASE WHEN l.first_contact_at IS NULL
                      AND l.status NOT IN ('DISQUALIFIED','CONVERTED') THEN 1 ELSE 0 END)
              AS needs_first_contact,
            SUM(CASE WHEN l.status = 'QUALIFIED' THEN 1 ELSE 0 END) AS qualified
          FROM leads l WHERE ${scope.sql}`,
    args: scope.args as never[],
  });
  const row = result.rows[0];
  return {
    total: Number(row?.total ?? 0),
    fresh: Number(row?.fresh ?? 0),
    needsFirstContact: Number(row?.needs_first_contact ?? 0),
    qualified: Number(row?.qualified ?? 0),
  };
}

// ---- creating and editing ----------------------------------------------------

export interface LeadInput {
  accountId: string | null;
  primaryContactId: string | null;
  leadSourceId: string;
  campaignId: string | null;
  businessUnitId: string | null;
  ownerUserId: string;
  title: string;
  description: string | null;
  /**
   * Free text, and it stays free text in this phase.
   *
   * Early interest is uncertain: "AGO bulk supply", "LPG for industrial
   * kitchen". Structured products with quantities belong on the opportunity,
   * through `opportunity_products`. Attaching the catalogue here would force a
   * precision the customer has not given yet.
   */
  productInterest: string | null;
  estimatedVolume: number | null;
  estimatedValue: number | null;
  currencyCode: string | null;
  capturedAt: string;
}

/** A contact must belong to the account it is attached to. */
async function checkContact(
  db: Client,
  accountId: string | null,
  contactId: string | null,
): Promise<FieldError[]> {
  if (contactId === null) return [];
  if (accountId === null) {
    return [{ field: 'primaryContactId', message: 'Choose an account before choosing a contact.' }];
  }
  const result = await db.execute({
    sql: `SELECT account_id FROM contacts WHERE contact_id = ? LIMIT 1`,
    args: [contactId],
  });
  const row = result.rows[0];
  if (row === undefined) {
    return [{ field: 'primaryContactId', message: 'That contact does not exist.' }];
  }
  if (text(row.account_id) !== accountId) {
    return [
      {
        field: 'primaryContactId',
        message: 'That contact belongs to a different account.',
      },
    ];
  }
  return [];
}

export async function createLead(
  db: Client,
  input: LeadInput,
  ctx: WriteContext,
): Promise<WriteResult<LeadRow>> {
  const problems = await checkContact(db, input.accountId, input.primaryContactId);
  if (problems.length > 0) return { ok: false, kind: 'invalid_reference', fields: problems };

  const id = newId('LEAD');
  try {
    const leadNumber = await withGeneratedNumber(
      NUMBER_PREFIX.lead,
      'lead_number',
      ctx.now,
      async (candidate) => {
        await db.batch(
          [
            {
              sql: `INSERT INTO leads
                      (lead_id, lead_number, account_id, primary_contact_id, lead_source_id,
                       campaign_id, business_unit_id, owner_user_id, title, description,
                       product_interest, estimated_volume, estimated_value, currency_code,
                       captured_at, first_contact_at, status, disqualification_reason,
                       created_by_user_id, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'NEW', NULL, ?, ?)`,
              args: [
                id,
                candidate,
                input.accountId,
                input.primaryContactId,
                input.leadSourceId,
                input.campaignId,
                input.businessUnitId,
                input.ownerUserId,
                input.title,
                input.description,
                input.productInterest,
                input.estimatedVolume,
                input.estimatedValue,
                input.currencyCode,
                input.capturedAt,
                ctx.actorUserId,
                toDbTimestamp(ctx.now),
              ],
            },
            audit(ctx, LEAD_AUDIT.created, id, 'CREATE', null, {
              ...input,
              leadNumber: candidate,
            }),
          ],
          'write',
        );
        return candidate;
      },
    );
    void leadNumber;
  } catch (error) {
    if (isForeignKey(error)) {
      return {
        ok: false,
        kind: 'invalid_reference',
        fields: [
          {
            field: 'leadSourceId',
            message:
              'That source, account, contact, campaign, business unit or owner does not exist.',
          },
        ],
      };
    }
    throw error;
  }
  const created = await getLeadUnscoped(db, id);
  if (created !== null) {
    // After the commit: a failed SLA consumer must never unmake a lead.
    await emitLeadEvent(db, {
      type: 'LEAD_CREATED',
      leadId: id,
      at: ctx.now,
      actorUserId: ctx.actorUserId,
      detail: { accountId: created.accountId },
    });
  }
  return created === null ? { ok: false, kind: 'not_found' } : { ok: true, value: created };
}

export async function updateLead(
  db: Client,
  userId: string,
  leadId: string,
  input: LeadInput,
  ctx: WriteContext,
): Promise<WriteResult<LeadRow>> {
  const before = await getLead(db, userId, leadId);
  if (before === null) return { ok: false, kind: 'not_found' };

  const problems = await checkContact(db, input.accountId, input.primaryContactId);
  if (problems.length > 0) return { ok: false, kind: 'invalid_reference', fields: problems };

  const statements: Stmt[] = [
    {
      // `lead_number`, `status` and `created_by_user_id` are not in the SET
      // list. The number is allocated once, the status moves only through the
      // named transitions below, and who logged it is history.
      sql: `UPDATE leads
            SET account_id = ?, primary_contact_id = ?, lead_source_id = ?, campaign_id = ?,
                business_unit_id = ?, owner_user_id = ?, title = ?, description = ?,
                product_interest = ?, estimated_volume = ?, estimated_value = ?,
                currency_code = ?, captured_at = ?
            WHERE lead_id = ?`,
      args: [
        input.accountId,
        input.primaryContactId,
        input.leadSourceId,
        input.campaignId,
        input.businessUnitId,
        input.ownerUserId,
        input.title,
        input.description,
        input.productInterest,
        input.estimatedVolume,
        input.estimatedValue,
        input.currencyCode,
        input.capturedAt,
        leadId,
      ],
    },
    audit(ctx, LEAD_AUDIT.updated, leadId, 'UPDATE', before, input),
  ];

  if (before.ownerUserId !== input.ownerUserId) {
    statements.push(
      audit(
        ctx,
        LEAD_AUDIT.ownerChanged,
        leadId,
        'OWNER_CHANGE',
        {
          ownerUserId: before.ownerUserId,
        },
        { ownerUserId: input.ownerUserId },
      ),
    );
  }

  try {
    await db.batch(statements, 'write');
  } catch (error) {
    if (isForeignKey(error)) {
      return {
        ok: false,
        kind: 'invalid_reference',
        fields: [{ field: 'ownerUserId', message: 'That reference does not exist.' }],
      };
    }
    throw error;
  }
  const after = await getLeadUnscoped(db, leadId);
  return after === null ? { ok: false, kind: 'not_found' } : { ok: true, value: after };
}

/**
 * Record the first contact, once.
 *
 * Sets `first_contact_at` only when it is NULL, in the statement itself rather
 * than after a read, so two simultaneous calls cannot both write and the second
 * cannot move the timestamp later. A lead already contacted is not an error;
 * the answer says nothing changed.
 *
 * Moves NEW to CONTACTED. It does not touch a lead that is already QUALIFIED,
 * DISQUALIFIED or CONVERTED, because those are later states and recording a
 * belated first contact must not walk one of them backwards.
 *
 * NO SLA CLOCK STARTS HERE. Phase 15 owns that, and it reads this timestamp.
 */
export async function recordFirstContact(
  db: Client,
  userId: string,
  leadId: string,
  ctx: WriteContext,
): Promise<WriteResult<LeadRow>> {
  const before = await getLead(db, userId, leadId);
  if (before === null) return { ok: false, kind: 'not_found' };

  const now = toDbTimestamp(ctx.now);
  await db.batch(
    [
      {
        sql: `UPDATE leads SET first_contact_at = ?
              WHERE lead_id = ? AND first_contact_at IS NULL`,
        args: [now, leadId],
      },
      {
        sql: `UPDATE leads SET status = 'CONTACTED'
              WHERE lead_id = ? AND status = 'NEW'`,
        args: [leadId],
      },
      audit(
        ctx,
        LEAD_AUDIT.contacted,
        leadId,
        'FIRST_CONTACT',
        {
          firstContactAt: before.firstContactAt,
          status: before.status,
        },
        { firstContactAt: before.firstContactAt ?? now },
      ),
    ],
    'write',
  );
  const after = await getLeadUnscoped(db, leadId);
  if (after !== null && before.firstContactAt === null) {
    await emitLeadEvent(db, {
      type: 'LEAD_CONTACTED',
      leadId,
      at: ctx.now,
      actorUserId: ctx.actorUserId,
      detail: { at: after.firstContactAt },
    });
  }
  return after === null ? { ok: false, kind: 'not_found' } : { ok: true, value: after };
}

// ---- BANT qualification --------------------------------------------------------

export interface QualificationInput {
  budgetScore: number;
  authorityScore: number;
  needScore: number;
  timelineScore: number;
  qualificationNotes: string | null;
}

export interface QualificationRow extends QualificationInput {
  qualificationId: string;
  leadId: string;
  qualifiedByUserId: string;
  qualifiedByName: string;
  qualifiedAt: string;
  total: number;
}

export async function getQualification(
  db: Client,
  leadId: string,
): Promise<QualificationRow | null> {
  const result = await db.execute({
    sql: `SELECT q.qualification_id, q.lead_id, q.budget_score, q.authority_score,
                 q.need_score, q.timeline_score, q.qualification_notes,
                 q.qualified_by_user_id, u.display_name, q.qualified_at
          FROM lead_qualifications q
          JOIN users u ON u.user_id = q.qualified_by_user_id
          WHERE q.lead_id = ? ORDER BY q.qualified_at DESC LIMIT 1`,
    args: [leadId],
  });
  const raw = result.rows[0];
  if (raw === undefined) return null;
  const row = raw as unknown as Record<string, unknown>;
  const budgetScore = Number(row.budget_score ?? 0);
  const authorityScore = Number(row.authority_score ?? 0);
  const needScore = Number(row.need_score ?? 0);
  const timelineScore = Number(row.timeline_score ?? 0);
  return {
    qualificationId: text(row.qualification_id),
    leadId: text(row.lead_id),
    budgetScore,
    authorityScore,
    needScore,
    timelineScore,
    qualificationNotes: nullableText(row.qualification_notes),
    qualifiedByUserId: text(row.qualified_by_user_id),
    qualifiedByName: text(row.display_name),
    qualifiedAt: text(row.qualified_at),
    total: budgetScore + authorityScore + needScore + timelineScore,
  };
}

/**
 * Qualify a lead. This does NOT convert it.
 *
 * The status becomes QUALIFIED and nothing else happens. Conversion is a
 * separate, deliberate action with its own permission pair, because a lead that
 * looks promising and a lead somebody has decided to pursue commercially are
 * different facts, and collapsing them means every qualified lead silently
 * becomes a pipeline entry.
 */
export async function qualifyLead(
  db: Client,
  userId: string,
  leadId: string,
  input: QualificationInput,
  ctx: WriteContext,
): Promise<WriteResult<LeadRow>> {
  const before = await getLead(db, userId, leadId);
  if (before === null) return { ok: false, kind: 'not_found' };
  if (before.status === 'CONVERTED') {
    return {
      ok: false,
      kind: 'conflict',
      fields: [{ field: 'status', message: 'That lead has already been converted.' }],
    };
  }

  const qualificationId = newId('LQ');
  await db.batch(
    [
      {
        sql: `INSERT INTO lead_qualifications
                (qualification_id, lead_id, budget_score, authority_score, need_score,
                 timeline_score, qualification_notes, qualified_by_user_id, qualified_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          qualificationId,
          leadId,
          input.budgetScore,
          input.authorityScore,
          input.needScore,
          input.timelineScore,
          input.qualificationNotes,
          ctx.actorUserId,
          toDbTimestamp(ctx.now),
        ],
      },
      {
        sql: `UPDATE leads SET status = 'QUALIFIED' WHERE lead_id = ?`,
        args: [leadId],
      },
      audit(
        ctx,
        LEAD_AUDIT.qualified,
        leadId,
        'QUALIFY',
        { status: before.status },
        {
          status: 'QUALIFIED',
          ...input,
          total: input.budgetScore + input.authorityScore + input.needScore + input.timelineScore,
        },
      ),
    ],
    'write',
  );
  const after = await getLeadUnscoped(db, leadId);
  return after === null ? { ok: false, kind: 'not_found' } : { ok: true, value: after };
}

/**
 * Disqualify a lead, with a reason, preserving everything.
 *
 * The lead, its qualification and its history all stay. Nothing is deleted, and
 * the status is reversible by a later edit if the customer comes back.
 */
export async function disqualifyLead(
  db: Client,
  userId: string,
  leadId: string,
  reason: string,
  ctx: WriteContext,
): Promise<WriteResult<LeadRow>> {
  const before = await getLead(db, userId, leadId);
  if (before === null) return { ok: false, kind: 'not_found' };
  if (before.status === 'CONVERTED') {
    return {
      ok: false,
      kind: 'conflict',
      fields: [
        {
          field: 'status',
          message: 'That lead has been converted, so it cannot be disqualified.',
        },
      ],
    };
  }

  await db.batch(
    [
      {
        sql: `UPDATE leads SET status = 'DISQUALIFIED', disqualification_reason = ?
              WHERE lead_id = ?`,
        args: [reason, leadId],
      },
      audit(
        ctx,
        LEAD_AUDIT.disqualified,
        leadId,
        'DISQUALIFY',
        {
          status: before.status,
          disqualificationReason: before.disqualificationReason,
        },
        { status: 'DISQUALIFIED', disqualificationReason: reason },
      ),
    ],
    'write',
  );
  const after = await getLeadUnscoped(db, leadId);
  return after === null ? { ok: false, kind: 'not_found' } : { ok: true, value: after };
}

// ---- conversion ----------------------------------------------------------------

export interface ConvertInput {
  pipelineId: string;
  /** Optional: the initial stage. Defaults to the pipeline's lowest sequence. */
  initialStageId: string | null;
  ownerUserId: string | null;
  title: string | null;
  estimatedValue: number | null;
  currencyCode: string | null;
  estimatedCloseDate: string | null;
}

export interface ConvertResult {
  leadId: string;
  opportunityId: string;
  opportunityNumber: string;
  /** True when the lead was already converted and this call changed nothing. */
  alreadyConverted: boolean;
}

export type ConvertOutcome =
  | { readonly ok: true; readonly value: ConvertResult }
  | { readonly ok: false; readonly kind: 'not_found' }
  | { readonly ok: false; readonly kind: 'conflict'; readonly fields: FieldError[] }
  | { readonly ok: false; readonly kind: 'invalid_reference'; readonly fields: FieldError[] };

/**
 * Convert a lead to an opportunity, exactly once.
 *
 * IDEMPOTENCY, AND THE KEY IT TURNS ON
 * `opportunities.lead_id` is the key. Before anything is written, this reads
 * for an existing opportunity carrying this `lead_id`; if one is there the call
 * returns it with `alreadyConverted: true` and writes nothing at all. So a
 * double-clicked button produces one opportunity and two identical answers,
 * rather than two opportunities.
 *
 * That read-then-write has a window, and the window is closed by the second
 * guard rather than by luck: the lead's own status moves to CONVERTED inside
 * the same batch, and the UPDATE is conditional on it not being CONVERTED
 * already. Two racing transactions therefore serialise on the lead row, and the
 * loser's UPDATE matches nothing.
 *
 * WHAT HAPPENS, ATOMICALLY, IN ONE BATCH
 *   1. the opportunity, carrying `lead_id`
 *   2. the first `opportunity_stage_history` row, with a null from-stage
 *   3. the lead's status to CONVERTED
 *   4. the audit row
 * A failure at any point rolls back all four.
 *
 * AN OPPORTUNITY REQUIRES AN ACCOUNT.
 * `opportunities.account_id` is NOT NULL, so a lead with no account cannot be
 * converted. It is refused with a field message naming the account, not a
 * foreign key error, and the interface's answer is to pick or create one first.
 */
export async function convertLead(
  db: Client,
  userId: string,
  leadId: string,
  input: ConvertInput,
  ctx: WriteContext,
): Promise<ConvertOutcome> {
  const lead = await getLead(db, userId, leadId);
  if (lead === null) return { ok: false, kind: 'not_found' };

  // Already converted: return the existing opportunity, write nothing.
  const existing = await db.execute({
    sql: `SELECT opportunity_id, opportunity_number FROM opportunities
          WHERE lead_id = ? ORDER BY opportunity_id LIMIT 1`,
    args: [leadId],
  });
  const already = existing.rows[0];
  if (already !== undefined) {
    return {
      ok: true,
      value: {
        leadId,
        opportunityId: text(already.opportunity_id),
        opportunityNumber: text(already.opportunity_number),
        alreadyConverted: true,
      },
    };
  }

  if (lead.accountId === null) {
    return {
      ok: false,
      kind: 'invalid_reference',
      fields: [
        {
          field: 'accountId',
          message:
            'An opportunity needs an account. Choose or create one on the lead before converting.',
        },
      ],
    };
  }
  if (lead.status === 'DISQUALIFIED') {
    return {
      ok: false,
      kind: 'conflict',
      fields: [
        { field: 'status', message: 'That lead is disqualified. Reopen it before converting.' },
      ],
    };
  }

  // `opportunities.estimated_value` and `currency_code` are NOT NULL, unlike
  // the lead's, which are honestly nullable because early interest is
  // uncertain. So a value and a currency must exist by conversion time, from
  // the payload or from the lead. Refusing here with a field message is the
  // difference between a form asking for the number and a 500 from the
  // constraint. Requiring a real figure at this boundary is not inventing a
  // number: the person converting is being asked to commit to one.
  const valueFields: FieldError[] = [];
  if ((input.estimatedValue ?? lead.estimatedValue) === null) {
    valueFields.push({
      field: 'estimatedValue',
      message: 'An opportunity needs an estimated value. The lead never had one, so enter it now.',
    });
  }
  if ((input.currencyCode ?? lead.currencyCode) === null) {
    valueFields.push({
      field: 'currencyCode',
      message: 'An opportunity needs a currency. The lead never had one, so choose it now.',
    });
  }
  if (valueFields.length > 0) {
    return { ok: false, kind: 'invalid_reference', fields: valueFields };
  }

  // The initial stage: the one asked for, or the pipeline's lowest sequence.
  const stageResult = await db.execute({
    sql:
      input.initialStageId === null
        ? `SELECT pipeline_stage_id, default_probability FROM pipeline_stages
           WHERE pipeline_id = ? AND active = 1 ORDER BY sequence_no LIMIT 1`
        : `SELECT pipeline_stage_id, default_probability FROM pipeline_stages
           WHERE pipeline_id = ? AND pipeline_stage_id = ? LIMIT 1`,
    args:
      input.initialStageId === null ? [input.pipelineId] : [input.pipelineId, input.initialStageId],
  });
  const stage = stageResult.rows[0];
  if (stage === undefined) {
    return {
      ok: false,
      kind: 'invalid_reference',
      fields: [
        {
          field: 'initialStageId',
          message: 'That pipeline has no active stage, or the stage belongs to another pipeline.',
        },
      ],
    };
  }

  const opportunityId = newId('OPP');
  const now = toDbTimestamp(ctx.now);
  const owner = input.ownerUserId ?? lead.ownerUserId;

  try {
    const opportunityNumber = await withGeneratedNumber(
      NUMBER_PREFIX.opportunity,
      'opportunity_number',
      ctx.now,
      async (candidate) => {
        const result = await db.batch(
          [
            {
              sql: `INSERT INTO opportunities
                      (opportunity_id, opportunity_number, lead_id, account_id, business_unit_id,
                       pipeline_id, current_stage_id, owner_user_id, title, estimated_value,
                       currency_code, probability, estimated_close_date, actual_close_date,
                       status, won_amount, lost_reason_id, lost_notes, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'OPEN', NULL, NULL, NULL, ?, ?)`,
              args: [
                opportunityId,
                candidate,
                leadId,
                lead.accountId,
                lead.businessUnitId,
                input.pipelineId,
                text(stage.pipeline_stage_id),
                owner,
                input.title ?? lead.title,
                input.estimatedValue ?? lead.estimatedValue,
                input.currencyCode ?? lead.currencyCode,
                nullableNumber(stage.default_probability) ?? 0,
                input.estimatedCloseDate,
                now,
                now,
              ],
            },
            {
              // The first history row. `from_stage_id` is null because there is
              // no previous stage, and `duration_in_previous_stage_minutes` is
              // null for the same reason: there was no previous stage to spend
              // time in. Zero would claim it moved instantly.
              sql: `INSERT INTO opportunity_stage_history
                      (stage_history_id, opportunity_id, from_stage_id, to_stage_id,
                       changed_by_user_id, changed_at, duration_in_previous_stage_minutes, reason)
                    VALUES (?, ?, NULL, ?, ?, ?, NULL, ?)`,
              args: [
                newId('OSH'),
                opportunityId,
                text(stage.pipeline_stage_id),
                ctx.actorUserId,
                now,
                `Converted from lead ${lead.leadNumber}`,
              ],
            },
            {
              // Conditional on the lead not already being converted. This is
              // what closes the window between the read above and this write:
              // the loser of a race updates no row.
              sql: `UPDATE leads SET status = 'CONVERTED'
                    WHERE lead_id = ? AND status <> 'CONVERTED'`,
              args: [leadId],
            },
            audit(
              ctx,
              LEAD_AUDIT.converted,
              leadId,
              'CONVERT',
              { status: lead.status },
              {
                status: 'CONVERTED',
                opportunityId,
                opportunityNumber: candidate,
                pipelineId: input.pipelineId,
                initialStageId: text(stage.pipeline_stage_id),
              },
            ),
          ],
          'write',
        );
        // The third statement is the conditional lead update. Zero rows means
        // another transaction converted this lead first.
        const leadUpdated = Number(result[2]?.rowsAffected ?? 0);
        if (leadUpdated === 0) {
          throw new Error('LEAD_ALREADY_CONVERTED');
        }
        return candidate;
      },
    );

    return {
      ok: true,
      value: { leadId, opportunityId, opportunityNumber, alreadyConverted: false },
    };
  } catch (error) {
    if (error instanceof Error && error.message === 'LEAD_ALREADY_CONVERTED') {
      const raced = await db.execute({
        sql: `SELECT opportunity_id, opportunity_number FROM opportunities
              WHERE lead_id = ? ORDER BY opportunity_id LIMIT 1`,
        args: [leadId],
      });
      const row = raced.rows[0];
      if (row !== undefined) {
        return {
          ok: true,
          value: {
            leadId,
            opportunityId: text(row.opportunity_id),
            opportunityNumber: text(row.opportunity_number),
            alreadyConverted: true,
          },
        };
      }
      return {
        ok: false,
        kind: 'conflict',
        fields: [{ field: 'status', message: 'That lead has already been converted.' }],
      };
    }
    if (isForeignKey(error)) {
      return {
        ok: false,
        kind: 'invalid_reference',
        fields: [{ field: 'pipelineId', message: 'That pipeline or owner does not exist.' }],
      };
    }
    throw error;
  }
}

// ---- lead sources ----------------------------------------------------------------

export interface LeadSourceRow {
  leadSourceId: string;
  sourceName: string;
  description: string | null;
  active: boolean;
  leadCount: number;
}

export async function listLeadSources(db: Client): Promise<LeadSourceRow[]> {
  const result = await db.execute(
    `SELECT ls.lead_source_id, ls.source_name, ls.description, ls.active,
            (SELECT COUNT(*) FROM leads l WHERE l.lead_source_id = ls.lead_source_id) AS lead_count
     FROM lead_sources ls ORDER BY ls.source_name`,
  );
  return result.rows.map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    return {
      leadSourceId: text(row.lead_source_id),
      sourceName: text(row.source_name),
      description: nullableText(row.description),
      active: Number(row.active ?? 0) === 1,
      leadCount: Number(row.lead_count ?? 0),
    };
  });
}

export async function getLeadSource(db: Client, id: string): Promise<LeadSourceRow | null> {
  const all = await listLeadSources(db);
  return all.find((s) => s.leadSourceId === id) ?? null;
}

export interface LeadSourceInput {
  sourceName: string;
  description: string | null;
  active: boolean;
}

export async function createLeadSource(
  db: Client,
  input: LeadSourceInput,
  ctx: WriteContext,
): Promise<WriteResult<LeadSourceRow>> {
  const id = newId('LS');
  try {
    await db.batch(
      [
        {
          sql: `INSERT INTO lead_sources (lead_source_id, source_name, description, active)
                VALUES (?, ?, ?, ?)`,
          args: [id, input.sourceName, input.description, input.active ? 1 : 0],
        },
        auditEventStmt({
          actorUserId: ctx.actorUserId,
          eventType: 'LEAD_SOURCE_CREATED',
          entityType: 'LEAD_SOURCE',
          entityId: id,
          action: 'CREATE',
          beforeJson: null,
          afterJson: JSON.stringify(input),
          ip: ctx.ip,
          userAgent: ctx.userAgent,
          now: ctx.now,
        }) as Stmt,
      ],
      'write',
    );
  } catch (error) {
    if (/UNIQUE constraint failed/i.test(error instanceof Error ? error.message : '')) {
      return {
        ok: false,
        kind: 'conflict',
        fields: [{ field: 'sourceName', message: 'That source name is already in use.' }],
      };
    }
    throw error;
  }
  const created = await getLeadSource(db, id);
  return created === null ? { ok: false, kind: 'not_found' } : { ok: true, value: created };
}

/**
 * Rename or deactivate a source. Never remove one.
 *
 * `leads.lead_source_id` is ON DELETE RESTRICT, so a source with history cannot
 * be deleted anyway, and there is no delete verb here. Deactivating takes it out
 * of new selection and leaves every historical lead pointing at it.
 */
export async function updateLeadSource(
  db: Client,
  id: string,
  input: LeadSourceInput,
  ctx: WriteContext,
): Promise<WriteResult<LeadSourceRow>> {
  const before = await getLeadSource(db, id);
  if (before === null) return { ok: false, kind: 'not_found' };
  try {
    await db.batch(
      [
        {
          sql: `UPDATE lead_sources SET source_name = ?, description = ?, active = ?
                WHERE lead_source_id = ?`,
          args: [input.sourceName, input.description, input.active ? 1 : 0, id],
        },
        auditEventStmt({
          actorUserId: ctx.actorUserId,
          eventType: 'LEAD_SOURCE_UPDATED',
          entityType: 'LEAD_SOURCE',
          entityId: id,
          action: 'UPDATE',
          beforeJson: JSON.stringify(before),
          afterJson: JSON.stringify(input),
          ip: ctx.ip,
          userAgent: ctx.userAgent,
          now: ctx.now,
        }) as Stmt,
      ],
      'write',
    );
  } catch (error) {
    if (/UNIQUE constraint failed/i.test(error instanceof Error ? error.message : '')) {
      return {
        ok: false,
        kind: 'conflict',
        fields: [{ field: 'sourceName', message: 'That source name is already in use.' }],
      };
    }
    throw error;
  }
  const after = await getLeadSource(db, id);
  return after === null ? { ok: false, kind: 'not_found' } : { ok: true, value: after };
}

// ---- selection lists --------------------------------------------------------------

export interface Option {
  id: string;
  label: string;
  parentId?: string | null;
}

export interface LeadOptions {
  sources: Option[];
  campaigns: Option[];
  businessUnits: Option[];
  owners: Option[];
  pipelines: Option[];
}

export async function leadOptions(db: Client): Promise<LeadOptions> {
  const [sources, campaigns, businessUnits, owners, pipelines] = await db.batch(
    [
      `SELECT lead_source_id AS id, source_name AS label FROM lead_sources WHERE active = 1
        ORDER BY source_name`,
      `SELECT campaign_id AS id, campaign_name AS label FROM campaigns
        WHERE status = 'ACTIVE' ORDER BY campaign_name`,
      `SELECT business_unit_id AS id, business_unit_name AS label FROM business_units
        WHERE active = 1 ORDER BY business_unit_name`,
      `SELECT user_id AS id, display_name AS label FROM users
        WHERE status = 'ACTIVE' AND user_type = 'INTERNAL' ORDER BY display_name`,
      `SELECT pipeline_id AS id, pipeline_name AS label, affiliate_id AS parent FROM pipelines
        WHERE active = 1 ORDER BY pipeline_name`,
    ],
    'read',
  );
  const options = (result: { rows: Record<string, unknown>[] }): Option[] =>
    result.rows.map((row) => ({
      id: text(row.id),
      label: text(row.label),
      parentId: row.parent === undefined ? null : nullableText(row.parent),
    }));
  return {
    sources: options(sources as unknown as { rows: Record<string, unknown>[] }),
    campaigns: options(campaigns as unknown as { rows: Record<string, unknown>[] }),
    businessUnits: options(businessUnits as unknown as { rows: Record<string, unknown>[] }),
    owners: options(owners as unknown as { rows: Record<string, unknown>[] }),
    pipelines: options(pipelines as unknown as { rows: Record<string, unknown>[] }),
  };
}

/**
 * Days since capture, as a fact.
 *
 * "7 days since capture", never "stale" and never "late". No configurable
 * threshold exists yet, so any judgement would be this file's opinion rather
 * than the organisation's policy. "Needs first contact" is different and is
 * allowed, because it is deterministic: `first_contact_at IS NULL`.
 */
export function ageInDays(capturedAt: string, now: Date): number {
  const captured = new Date(capturedAt.replace(' ', 'T') + 'Z');
  if (Number.isNaN(captured.getTime())) return 0;
  return Math.max(0, Math.floor((now.getTime() - captured.getTime()) / 86_400_000));
}
