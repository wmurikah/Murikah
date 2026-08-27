/**
 * THE resolver. One question, one implementation: who is authorised to perform
 * this workflow stage for this transaction?
 *
 * There is no second copy. The approval preview screen, the live path that
 * assigns a stage instance and the test suite all call `resolveApprovers`. A
 * preview that used its own logic would be worse than no preview, because it
 * would certify a configuration that behaves differently in production.
 *
 * It is pure with respect to the request. It reads configuration and returns a
 * result. It writes nothing, it audits nothing and it creates nothing. The one
 * write in this phase is in ./runtime.ts, which calls this once when a stage
 * instance is created and persists the answer.
 *
 * NO NAMES ANYWHERE
 * Nothing below reads a display name, an email address, a job title, a
 * department or a hard-coded user, role or assignment id to decide authority.
 * Names appear in exactly one place, the plain-language `reason` string, and
 * they are read out of the row for a human to read, never compared against.
 *
 * ================= THE RULES, STATED ONCE AND APPLIED EVERYWHERE ============
 *
 * 1. AN ASSIGNMENT WITH NO AUTHORITY RULE IS ELIGIBLE WITHOUT RESTRICTION.
 *    `approval_authority_rules` is a restriction mechanism. A restriction that
 *    was never configured should not remove authority the assignment already
 *    grants, so an assignment with no live rule for this process matches on
 *    scope and effective date alone, with no amount, currency or product test.
 *    Five of the ten seeded assignments have no rule, and this is what makes
 *    the Uganda sales order resolve to its affiliate approver rather than to
 *    nobody. The administration screens flag a rule-less assignment so an
 *    operator sees the reach they have granted; see `unrestricted` below.
 *
 * 2. A MULTI-GROUP ORDER MATCHES ONLY A RULE THAT CONTAINS EVERY LINE.
 *    A product-restricted rule matches only when *every* line of the
 *    transaction falls inside the restriction. The alternative, deciding from
 *    the line of greatest value, lets an approver whose authority covers fuels
 *    approve an order that also carries lubricants, silently, because the fuel
 *    line happened to be larger. Authority is a containment question, so the
 *    containing rule is the correct one. An order spanning two groups therefore
 *    needs an approver whose rule carries no product restriction, or none at
 *    that tier and the ladder moves on.
 *
 *    A product restriction also needs something to test against: a transaction
 *    with no lines does not satisfy one. "No lines" is not "every line
 *    qualifies"; it is "the restriction cannot be verified", and an unverified
 *    restriction must not pass.
 *
 * 3. LEAD, OPPORTUNITY AND CASE RESOLVE ON ASSIGNMENT AND SCOPE ALONE.
 *    `approval_authority_rules.process_type` permits four values and those
 *    three are not among them, so no rule can name them. The alternative,
 *    treating a CASE as OTHER, means a rule an operator wrote for a genuinely
 *    other process silently restricts case resolution, and the column has one
 *    value for both so nothing can tell them apart afterwards. So for those
 *    three processes rules are not consulted at all: scope and effective dates
 *    decide, which is rule 1 applied to every assignment rather than to some.
 *
 * 4. SPECIFICITY FIRST, THEN PRIORITY, THEN THE ID.
 *    Candidates are gathered per scope tier: BUSINESS_UNIT, AFFILIATE, COUNTRY,
 *    GROUP. The lowest tier that yields at least one eligible approver is the
 *    answer and the ladder stops there. That is what stops a group assignment
 *    replacing a valid local approver, with no special case for the group role.
 *    Within a tier, lower `priority` wins, then lower `rule_priority`, then the
 *    assignment id ascending so the order is total and stable.
 *
 *    A LOWER PRIORITY WINS OUTRIGHT; AN EXACT TIE RETURNS BOTH. Priority is a
 *    tie-break, not a sort key: an assignment at priority 5 beside one at
 *    priority 10 leaves only the 5, because the operator said which they
 *    preferred. Two assignments alike on tier, priority and rule priority are
 *    two genuinely eligible approvers, and dropping one on a coin toss would
 *    hide a configuration the operator should see, so both are returned in a
 *    stable order. The stage's approval mode then decides what to do with two:
 *    ANY_ONE takes either, ALL requires both, SEQUENTIAL and ROUND_ROBIN use
 *    the stable order above.
 *
 *    An assignment admitted under rule 1 or rule 3 has no rule and therefore no
 *    rule priority, and it takes the column's own default of 100 for the
 *    comparison. That is the value it would have had if somebody had written
 *    the rule and left the priority alone, which is the closest thing to "no
 *    preference expressed" the schema offers, and it keeps the ordering total
 *    with no special case for a missing rule.
 *
 * 5. NULL NEVER WIDENS.
 *    A request with no affiliate matches no affiliate-scoped assignment. An
 *    amount of null does not satisfy a rule with a bound. Null on the *rule*
 *    side means "no restriction on this dimension" and does widen, which is the
 *    schema's stated meaning; null on the *request* side means "not known" and
 *    never does.
 *
 * 6. OVERLAPPING ASSIGNMENTS FOR THE SAME PERSON AND ROLE COLLAPSE TO THE
 *    LATEST START. The UNIQUE constraint includes `effective_from`, so one
 *    person may hold two live assignments for one role, which is how a
 *    delegation that has not yet been closed out looks. Both are effective;
 *    counting the person twice would double them in an ALL stage and skew a
 *    round robin. The one with the later `effective_from` wins, because it is
 *    the more recent statement of intent, with lower priority then the id
 *    breaking a same-day tie. The discarded assignment is kept in the trace.
 * ===========================================================================
 */
import type { Client } from '@libsql/client/web';
import {
  carriesAuthorityRules,
  specificityTier,
  type ProcessType,
  type WorkflowScopeType,
} from './model.ts';

/**
 * One line of the transaction, reduced to what authority cares about.
 *
 * The caller reads its own lines and maps them here. This phase does not build
 * sales orders or purchase orders, and the resolver must not learn their table
 * names to do its job: it takes the product dimension of a transaction, not the
 * transaction.
 */
export interface TransactionLine {
  readonly productId?: string | null;
  readonly productCategoryId: string | null;
  readonly productGroupId: string | null;
  /** Used by nothing in rule 2. Carried so a trace can quote it. */
  readonly lineValue?: number | null;
}

export interface ProductDimension {
  readonly categoryIds: readonly string[];
  readonly groupIds: readonly string[];
  /** True when the lines are not all in one group. See rule 2. */
  readonly spansGroups: boolean;
  /** True when there were no lines at all: nothing to test a restriction on. */
  readonly empty: boolean;
}

/** The distinct product dimension of a set of lines. */
export function productDimension(lines: readonly TransactionLine[]): ProductDimension {
  const categoryIds: string[] = [];
  const groupIds: string[] = [];
  for (const line of lines) {
    const category = line.productCategoryId;
    const group = line.productGroupId;
    if (typeof category === 'string' && category !== '' && !categoryIds.includes(category)) {
      categoryIds.push(category);
    }
    if (typeof group === 'string' && group !== '' && !groupIds.includes(group)) {
      groupIds.push(group);
    }
  }
  return {
    categoryIds,
    groupIds,
    spansGroups: groupIds.length > 1,
    empty: lines.length === 0,
  };
}

export interface ResolutionRequest {
  readonly processType: ProcessType;
  /** The workflow role the stage is configured for. Never a role name. */
  readonly workflowRoleId: string;
  readonly countryId: string | null;
  readonly affiliateId: string | null;
  readonly businessUnitId: string | null;
  readonly amount: number | null;
  readonly currencyCode: string | null;
  readonly lines: readonly TransactionLine[];
  /** The day authority is tested against, YYYY-MM-DD. */
  readonly eventDate: string;
}

/** Why a candidate was not eligible. One value per rejected dimension. */
export type RejectionReason =
  | 'scope_mismatch'
  | 'no_rule_matched'
  | 'superseded_by_later_assignment'
  | 'lower_specificity_available'
  | 'outranked_by_priority';

export interface TraceEntry {
  readonly assignmentId: string;
  readonly userId: string;
  readonly displayName: string;
  readonly scopeType: WorkflowScopeType;
  readonly scopeTargetId: string | null;
  readonly priority: number;
  readonly eligible: boolean;
  readonly ruleId: string | null;
  readonly rejection: RejectionReason | null;
  /** Every rule considered for this assignment and why each did or did not fit. */
  readonly ruleNotes: readonly string[];
}

export interface ApproverMatch {
  readonly userId: string;
  readonly displayName: string;
  readonly assignmentId: string;
  readonly scopeType: WorkflowScopeType;
  readonly scopeTargetId: string | null;
  readonly priority: number;
  /** The rule that admitted them, or null when rule 1 or rule 3 applied. */
  readonly ruleId: string | null;
  readonly rulePriority: number | null;
  /** True when no authority rule was consulted or none existed. Rule 1 and 3. */
  readonly unrestricted: boolean;
  /** Plain language, for an administrator. Section 14. */
  readonly reason: string;
}

export type ExceptionReason =
  | 'no_assignment_for_role'
  | 'no_assignment_in_scope'
  | 'no_authority_covers_transaction'
  | 'role_not_found';

export interface ResolutionContext {
  readonly processType: ProcessType;
  readonly workflowRoleId: string;
  readonly workflowRoleCode: string | null;
  readonly countryId: string | null;
  readonly affiliateId: string | null;
  readonly businessUnitId: string | null;
  readonly amount: number | null;
  readonly currencyCode: string | null;
  readonly productGroupIds: readonly string[];
  readonly productCategoryIds: readonly string[];
  readonly eventDate: string;
}

export type Resolution =
  | {
      readonly outcome: 'resolved';
      readonly scopeTier: WorkflowScopeType;
      readonly approvers: readonly ApproverMatch[];
      readonly context: ResolutionContext;
      readonly trace: readonly TraceEntry[];
    }
  | {
      readonly outcome: 'exception';
      readonly reason: ExceptionReason;
      readonly message: string;
      readonly context: ResolutionContext;
      readonly trace: readonly TraceEntry[];
    };

// ---- rows, read straight from configuration --------------------------------

interface AssignmentRow {
  assignmentId: string;
  workflowRoleId: string;
  userId: string;
  displayName: string;
  scopeType: WorkflowScopeType;
  countryId: string | null;
  affiliateId: string | null;
  businessUnitId: string | null;
  priority: number;
  effectiveFrom: string;
  effectiveTo: string | null;
}

interface RuleRow {
  ruleId: string;
  assignmentId: string;
  processType: string;
  currencyCode: string | null;
  minAmount: number | null;
  maxAmount: number | null;
  productGroupId: string | null;
  productCategoryId: string | null;
  rulePriority: number;
}

const text = (v: unknown): string => String(v ?? '');
const nullableText = (v: unknown): string | null =>
  v === null || v === undefined ? null : String(v);
const nullableNumber = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v);

/** `approval_authority_rules.rule_priority` DEFAULT 100. See rule 4. */
const DEFAULT_RULE_PRIORITY = 100;

const SCOPE_LABEL: Record<number, string> = {
  0: 'business unit',
  1: 'affiliate',
  2: 'country',
  3: 'group',
};

/**
 * The scope target the assignment names, or null for GROUP.
 *
 * Read from the column the scope type owns and from no other, because the CHECK
 * on the table guarantees the others are NULL and reading them would invent a
 * target the operator never configured.
 */
function scopeTarget(row: AssignmentRow): string | null {
  switch (row.scopeType) {
    case 'BUSINESS_UNIT':
      return row.businessUnitId;
    case 'AFFILIATE':
      return row.affiliateId;
    case 'COUNTRY':
      return row.countryId;
    case 'GROUP':
      return null;
  }
}

/** Rule 5: the request's value must be present and equal. Null never widens. */
function scopeMatches(row: AssignmentRow, request: ResolutionRequest): boolean {
  switch (row.scopeType) {
    case 'GROUP':
      return true;
    case 'COUNTRY':
      return request.countryId !== null && row.countryId === request.countryId;
    case 'AFFILIATE':
      return request.affiliateId !== null && row.affiliateId === request.affiliateId;
    case 'BUSINESS_UNIT':
      return request.businessUnitId !== null && row.businessUnitId === request.businessUnitId;
  }
}

type Check = { ok: true } | { ok: false; note: string };

/** Rule 2, applied to one rule and one transaction. */
function productMatches(rule: RuleRow, dimension: ProductDimension): Check {
  const restricted = rule.productGroupId !== null || rule.productCategoryId !== null;
  if (!restricted) return { ok: true };
  if (dimension.empty) {
    return {
      ok: false,
      note: 'the rule restricts by product and the transaction carries no lines to test',
    };
  }
  if (rule.productGroupId !== null) {
    const outside = dimension.groupIds.filter((id) => id !== rule.productGroupId);
    if (outside.length > 0 || dimension.groupIds.length === 0) {
      const also = outside.length > 0 ? outside.join(', ') : 'no identified group';
      return {
        ok: false,
        note: `the rule covers product group ${rule.productGroupId} and the transaction also carries ${also}`,
      };
    }
  }
  if (rule.productCategoryId !== null) {
    const outside = dimension.categoryIds.filter((id) => id !== rule.productCategoryId);
    if (outside.length > 0 || dimension.categoryIds.length === 0) {
      const also = outside.length > 0 ? outside.join(', ') : 'no identified category';
      return {
        ok: false,
        note: `the rule covers product category ${rule.productCategoryId} and the transaction also carries ${also}`,
      };
    }
  }
  return { ok: true };
}

function amountMatches(rule: RuleRow, amount: number | null): Check {
  const bounded = rule.minAmount !== null || rule.maxAmount !== null;
  if (!bounded) return { ok: true };
  if (amount === null) {
    return { ok: false, note: 'the rule bounds the amount and the transaction carries none' };
  }
  if (rule.minAmount !== null && amount < rule.minAmount) {
    return { ok: false, note: `${amount} is below the rule minimum of ${rule.minAmount}` };
  }
  if (rule.maxAmount !== null && amount > rule.maxAmount) {
    return { ok: false, note: `${amount} exceeds the rule maximum of ${rule.maxAmount}` };
  }
  return { ok: true };
}

function currencyMatches(rule: RuleRow, currency: string | null): Check {
  if (rule.currencyCode === null) return { ok: true };
  if (currency === null) {
    return {
      ok: false,
      note: `the rule is limited to ${rule.currencyCode} and no currency was given`,
    };
  }
  if (currency.toUpperCase() !== rule.currencyCode.toUpperCase()) {
    return { ok: false, note: `the rule is limited to ${rule.currencyCode}, not ${currency}` };
  }
  return { ok: true };
}

/** The sentence an administrator reads. Section 14. */
function explain(
  row: AssignmentRow,
  rule: RuleRow | null,
  request: ResolutionRequest,
  rulesWereConsulted: boolean,
): string {
  const where =
    row.scopeType === 'GROUP'
      ? 'the group'
      : `${row.scopeType.toLowerCase().replace(/_/g, ' ')} ${scopeTarget(row) ?? ''}`.trim();
  const base = `${row.displayName} is the active approver for ${where}, effective on ${request.eventDate}`;
  if (rule === null && rulesWereConsulted) {
    return `${base}, and the assignment carries no authority rule, so it is not restricted by amount, currency or product.`;
  }
  if (rule === null) {
    const process = request.processType.toLowerCase().replace(/_/g, ' ');
    return `${base}, and a ${process} cannot carry an authority rule, so scope and effective dates decide.`;
  }
  const bits: string[] = [];
  if (rule.currencyCode !== null) bits.push(`currency ${rule.currencyCode}`);
  if (rule.minAmount !== null || rule.maxAmount !== null) {
    const low = rule.minAmount === null ? 'any' : String(rule.minAmount);
    const high = rule.maxAmount === null ? 'no ceiling' : String(rule.maxAmount);
    bits.push(`amount from ${low} to ${high}`);
  }
  if (rule.productGroupId !== null) bits.push(`product group ${rule.productGroupId}`);
  if (rule.productCategoryId !== null) bits.push(`product category ${rule.productCategoryId}`);
  const scopeOfRule = bits.length === 0 ? 'no further restriction' : bits.join(', ');
  return `${base}, and the transaction falls within their configured authority (${scopeOfRule}).`;
}

/**
 * Rule 6, applied before eligibility so a discarded overlap never reaches a
 * tier and never becomes an assignee.
 */
function collapseOverlaps(rows: AssignmentRow[]): {
  kept: AssignmentRow[];
  discarded: AssignmentRow[];
} {
  const best = new Map<string, AssignmentRow>();
  const discarded: AssignmentRow[] = [];
  for (const row of rows) {
    const key = `${row.workflowRoleId} ${row.userId}`;
    const held = best.get(key);
    if (held === undefined) {
      best.set(key, row);
      continue;
    }
    const wins =
      row.effectiveFrom > held.effectiveFrom ||
      (row.effectiveFrom === held.effectiveFrom &&
        (row.priority < held.priority ||
          (row.priority === held.priority && row.assignmentId < held.assignmentId)));
    if (wins) {
      best.set(key, row);
      discarded.push(held);
    } else {
      discarded.push(row);
    }
  }
  return { kept: [...best.values()], discarded };
}

interface Candidate {
  readonly match: ApproverMatch;
  readonly tier: number;
  readonly rulePriority: number;
}

/**
 * Who is authorised to perform this stage for this transaction.
 *
 * Two statements, not one per candidate: the assignments live in this role at
 * this date, then every live rule attached to them. Filtering happens here
 * rather than in SQL because the answer has to explain itself, and a WHERE
 * clause that discards a row leaves nothing to explain with.
 */
export async function resolveApprovers(
  db: Client,
  request: ResolutionRequest,
): Promise<Resolution> {
  const dimension = productDimension(request.lines);
  const roleResult = await db.execute({
    sql: `SELECT role_code, active FROM workflow_roles WHERE workflow_role_id = ? LIMIT 1`,
    args: [request.workflowRoleId],
  });
  const role = roleResult.rows[0];
  const context: ResolutionContext = {
    processType: request.processType,
    workflowRoleId: request.workflowRoleId,
    workflowRoleCode: role === undefined ? null : text(role.role_code),
    countryId: request.countryId,
    affiliateId: request.affiliateId,
    businessUnitId: request.businessUnitId,
    amount: request.amount,
    currencyCode: request.currencyCode,
    productGroupIds: dimension.groupIds,
    productCategoryIds: dimension.categoryIds,
    eventDate: request.eventDate,
  };

  if (role === undefined || Number(role.active ?? 0) !== 1) {
    return {
      outcome: 'exception',
      reason: 'role_not_found',
      message: 'That workflow role does not exist or is not active.',
      context,
      trace: [],
    };
  }

  // Effective dating and `active` are in the WHERE clause, not in JavaScript.
  // A row that is not live is not a candidate and has nothing to explain: the
  // trace exists to show why a *live* assignment did or did not carry the
  // transaction, and padding it with every historical row would bury that.
  const assignmentResult = await db.execute({
    sql: `
      SELECT wra.workflow_role_assignment_id, wra.workflow_role_id, wra.user_id,
             wra.scope_type, wra.country_id, wra.affiliate_id, wra.business_unit_id,
             wra.priority, wra.effective_from, wra.effective_to,
             u.display_name
      FROM workflow_role_assignments wra
      JOIN users u ON u.user_id = wra.user_id
      WHERE wra.workflow_role_id = ?
        AND wra.active = 1
        AND u.status = 'ACTIVE'
        AND wra.effective_from <= ?
        AND (wra.effective_to IS NULL OR wra.effective_to >= ?)`,
    args: [request.workflowRoleId, request.eventDate, request.eventDate],
  });

  const assignments: AssignmentRow[] = assignmentResult.rows.map((row) => ({
    assignmentId: text(row.workflow_role_assignment_id),
    workflowRoleId: text(row.workflow_role_id),
    userId: text(row.user_id),
    displayName: text(row.display_name),
    scopeType: text(row.scope_type) as WorkflowScopeType,
    countryId: nullableText(row.country_id),
    affiliateId: nullableText(row.affiliate_id),
    businessUnitId: nullableText(row.business_unit_id),
    priority: Number(row.priority ?? 100),
    effectiveFrom: text(row.effective_from),
    effectiveTo: nullableText(row.effective_to),
  }));

  if (assignments.length === 0) {
    return {
      outcome: 'exception',
      reason: 'no_assignment_for_role',
      message: 'No live assignment exists for that workflow role on that date.',
      context,
      trace: [],
    };
  }

  const { kept, discarded } = collapseOverlaps(assignments);
  const trace: TraceEntry[] = [];
  const note = (
    row: AssignmentRow,
    eligible: boolean,
    ruleId: string | null,
    rejection: RejectionReason | null,
    ruleNotes: string[],
  ) => {
    trace.push({
      assignmentId: row.assignmentId,
      userId: row.userId,
      displayName: row.displayName,
      scopeType: row.scopeType,
      scopeTargetId: scopeTarget(row),
      priority: row.priority,
      eligible,
      ruleId,
      rejection,
      ruleNotes,
    });
  };

  for (const row of discarded) {
    note(row, false, null, 'superseded_by_later_assignment', [
      'a later effective assignment for the same person and workflow role takes precedence',
    ]);
  }

  const inScope = kept.filter((row) => {
    const matched = scopeMatches(row, request);
    if (!matched) note(row, false, null, 'scope_mismatch', []);
    return matched;
  });

  if (inScope.length === 0) {
    return {
      outcome: 'exception',
      reason: 'no_assignment_in_scope',
      message: 'No approver is assigned for that organisational context.',
      context,
      trace,
    };
  }

  // Rule 3: for a process the rule table cannot name, rules are not consulted.
  const consultRules = carriesAuthorityRules(request.processType);
  const rulesByAssignment = new Map<string, RuleRow[]>();
  if (consultRules) {
    const ids = inScope.map((row) => row.assignmentId);
    const placeholders = ids.map(() => '?').join(', ');
    const ruleResult = await db.execute({
      sql: `
        SELECT authority_rule_id, workflow_role_assignment_id, process_type, currency_code,
               min_amount, max_amount, product_group_id, product_category_id, rule_priority
        FROM approval_authority_rules
        WHERE workflow_role_assignment_id IN (${placeholders})
          AND process_type = ?
          AND active = 1
          AND effective_from <= ?
          AND (effective_to IS NULL OR effective_to >= ?)`,
      args: [...ids, request.processType, request.eventDate, request.eventDate],
    });
    for (const row of ruleResult.rows) {
      const rule: RuleRow = {
        ruleId: text(row.authority_rule_id),
        assignmentId: text(row.workflow_role_assignment_id),
        processType: text(row.process_type),
        currencyCode: nullableText(row.currency_code),
        minAmount: nullableNumber(row.min_amount),
        maxAmount: nullableNumber(row.max_amount),
        productGroupId: nullableText(row.product_group_id),
        productCategoryId: nullableText(row.product_category_id),
        rulePriority: Number(row.rule_priority ?? 100),
      };
      const held = rulesByAssignment.get(rule.assignmentId);
      if (held === undefined) rulesByAssignment.set(rule.assignmentId, [rule]);
      else held.push(rule);
    }
  }

  const candidates: Candidate[] = [];

  for (const row of inScope) {
    const rules = rulesByAssignment.get(row.assignmentId) ?? [];

    // Rule 1 and rule 3: nothing restricts this assignment, so it carries the
    // transaction on scope and effective date alone.
    if (!consultRules || rules.length === 0) {
      note(row, true, null, null, [
        consultRules
          ? 'no live authority rule is attached to this assignment, so no amount, currency or product restriction applies'
          : `${request.processType} cannot carry authority rules, so scope and effective dates decide`,
      ]);
      candidates.push({
        tier: specificityTier(row.scopeType),
        rulePriority: DEFAULT_RULE_PRIORITY,
        match: {
          userId: row.userId,
          displayName: row.displayName,
          assignmentId: row.assignmentId,
          scopeType: row.scopeType,
          scopeTargetId: scopeTarget(row),
          priority: row.priority,
          ruleId: null,
          rulePriority: null,
          unrestricted: true,
          reason: explain(row, null, request, consultRules),
        },
      });
      continue;
    }

    // Rules exist. The best matching one admits the assignment; the notes for
    // every rule that did not fit stay in the trace, because "why was this
    // person not offered?" is the question the preview exists to answer.
    const notes: string[] = [];
    let admitted: RuleRow | null = null;
    const ordered = [...rules].sort(
      (a, b) => a.rulePriority - b.rulePriority || a.ruleId.localeCompare(b.ruleId),
    );
    for (const rule of ordered) {
      const checks: Check[] = [
        currencyMatches(rule, request.currencyCode),
        amountMatches(rule, request.amount),
        productMatches(rule, dimension),
      ];
      const failed = checks.find((check): check is { ok: false; note: string } => !check.ok);
      if (failed !== undefined) {
        notes.push(`${rule.ruleId} did not apply: ${failed.note}`);
        continue;
      }
      notes.push(`${rule.ruleId} applies`);
      admitted = rule;
      break;
    }

    if (admitted === null) {
      note(row, false, null, 'no_rule_matched', notes);
      continue;
    }
    note(row, true, admitted.ruleId, null, notes);
    candidates.push({
      tier: specificityTier(row.scopeType),
      rulePriority: admitted.rulePriority,
      match: {
        userId: row.userId,
        displayName: row.displayName,
        assignmentId: row.assignmentId,
        scopeType: row.scopeType,
        scopeTargetId: scopeTarget(row),
        priority: row.priority,
        ruleId: admitted.ruleId,
        rulePriority: admitted.rulePriority,
        unrestricted: false,
        reason: explain(row, admitted, request, true),
      },
    });
  }

  if (candidates.length === 0) {
    return {
      outcome: 'exception',
      reason: 'no_authority_covers_transaction',
      message: 'An approver is assigned for that context, and none has authority for this value.',
      context,
      trace,
    };
  }

  // Rule 4, applied as three successive narrowings rather than as a sort. Each
  // one is a preference the operator expressed, so a candidate that loses it is
  // out, not merely later in the list. What survives all three is an exact tie.
  const tier = Math.min(...candidates.map((candidate) => candidate.tier));
  const atTier = candidates.filter((candidate) => candidate.tier === tier);
  const bestPriority = Math.min(...atTier.map((candidate) => candidate.match.priority));
  const atPriority = atTier.filter((candidate) => candidate.match.priority === bestPriority);
  const bestRulePriority = Math.min(...atPriority.map((candidate) => candidate.rulePriority));
  const winners = atPriority
    .filter((candidate) => candidate.rulePriority === bestRulePriority)
    .sort((a, b) => a.match.assignmentId.localeCompare(b.match.assignmentId));

  const chosen = new Set(winners.map((candidate) => candidate.match.assignmentId));

  // A candidate at a wider tier was eligible on its own terms and lost to a
  // more specific one. The trace says so rather than leaving it marked
  // eligible, because "eligible but not chosen" and "chosen" read identically
  // otherwise, and section 7 is exactly the rule an operator will want to see.
  for (const candidate of candidates) {
    if (chosen.has(candidate.match.assignmentId)) continue;
    const index = trace.findIndex((item) => item.assignmentId === candidate.match.assignmentId);
    const held = index === -1 ? undefined : trace[index];
    if (held === undefined) continue;
    const why =
      candidate.tier !== tier
        ? `a more specific ${SCOPE_LABEL[tier] ?? 'scope'} approver is configured for this context`
        : `another approver at the same scope carries a stronger priority (${bestPriority}, rule priority ${bestRulePriority})`;
    trace[index] = {
      ...held,
      eligible: false,
      rejection: candidate.tier !== tier ? 'lower_specificity_available' : 'outranked_by_priority',
      ruleNotes: [...held.ruleNotes, why],
    };
  }

  const first = winners[0];
  return {
    outcome: 'resolved',
    scopeTier: first === undefined ? 'GROUP' : first.match.scopeType,
    approvers: winners.map((candidate) => candidate.match),
    context,
    trace,
  };
}
