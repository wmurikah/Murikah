/**
 * System Health, Access Review, Workflow Authority Review, Role Impact and
 * expiring authority: the configuration-review half of the control centre.
 *
 * EVERY CHECK HERE HAS A DEFINED RULE, and the rule is stated beside it. The
 * phase is explicit that no warning may be invented, and the reason is worth
 * keeping in view: a health screen full of judgements nobody can reproduce
 * gets ignored within a fortnight, and then the one real warning is ignored
 * with it. Each check below is a query whose result a reader can check by
 * hand, and each says what it counts and what it does not.
 *
 * NOTHING HERE IS A SCORE. There is no overall health percentage and no
 * traffic light for the system as a whole, because summing unlike checks
 * into one number destroys the only information a reader can act on.
 */
import type { Client } from '@libsql/client/web';
import { toDbTimestamp } from '../auth/session.ts';

const text = (v: unknown): string => String(v ?? '');
const nullableText = (v: unknown): string | null =>
  v === null || v === undefined ? null : String(v);
const count = (v: unknown): number => Number(v ?? 0);

/**
 * How urgently somebody should look, not how bad the system is.
 *
 * BLOCKING means work is stopped or a control is absent right now.
 * ATTENTION means something will stop working or is producing wrong figures.
 * INFORMATION means a reader should know, and nothing is broken.
 */
export type HealthSeverity = 'BLOCKING' | 'ATTENTION' | 'INFORMATION';

export interface HealthCheck {
  readonly key: string;
  readonly title: string;
  /**
   * ONE LINE, ON THE PAGE. What this check looks for, short enough to be read
   * while scanning eight of them.
   *
   * A diagnostic page earns a statement of what each check MEANS in a way an
   * ordinary page does not earn a description: a count with no rule beside it
   * is a number nobody can act on or argue with. But the full wording ran to
   * three clauses, and eight of those stacked down a page is a wall nobody
   * reads, which returns the reader to the same place as no rule at all.
   */
  readonly summary: string;
  /**
   * The full rule, behind the definition control the rest of the application
   * uses. Auditors and whoever is correcting the configuration need the exact
   * predicate; everybody else needs the line above.
   */
  readonly rule: string;
  readonly severity: HealthSeverity;
  readonly count: number;
  /** Up to a handful of examples, so the count is actionable. */
  readonly examples: { id: string; label: string; detail: string | null }[];
  /** Where to go and do something about it. Null where there is no screen. */
  readonly href: string | null;
}

const EXAMPLE_LIMIT = 10;

/**
 * The check that would have caught the missing Uganda authority rule.
 *
 * A workflow stage assigned to a workflow role with nobody holding that role
 * in the stage's scope today means a transaction reaching that stage has no
 * approver. It does not fail loudly: it sits, and somebody notices a week
 * later that nothing has moved.
 *
 * "Today" is the point of the effective-date test. A role assignment that
 * ended last Friday leaves the stage unstaffed from Monday, and the
 * configuration still looks correct to anybody reading the rows without the
 * dates in mind.
 */
async function workflowRolesWithoutApprover(db: Client, today: string): Promise<HealthCheck> {
  const result = await db.execute({
    sql: `SELECT wr.workflow_role_id AS id, wr.role_name AS label,
            wd.workflow_name AS workflow_name, ws.stage_name AS stage_name,
            wd.country_id AS country_id, wd.affiliate_id AS affiliate_id
          FROM workflow_stages ws
          JOIN workflow_definitions wd
            ON wd.workflow_definition_id = ws.workflow_definition_id
          JOIN workflow_roles wr
            ON wr.workflow_role_id = ws.assigned_workflow_role_id
          WHERE ws.assignment_type = 'WORKFLOW_ROLE'
            AND wd.active = 1
            AND (wd.effective_to IS NULL OR wd.effective_to >= ?)
            AND wd.effective_from <= ?
            AND NOT EXISTS (
              SELECT 1 FROM workflow_role_assignments wra
              JOIN users u ON u.user_id = wra.user_id
              WHERE wra.workflow_role_id = wr.workflow_role_id
                AND wra.active = 1
                AND u.status = 'ACTIVE'
                AND wra.effective_from <= ?
                AND (wra.effective_to IS NULL OR wra.effective_to >= ?)
                -- The assignment must also reach the workflow's own scope. A
                -- Kenya-scoped approver does not staff a Uganda stage, and
                -- counting them would be exactly the false reassurance this
                -- check exists to prevent.
                AND (wra.scope_type = 'GROUP'
                     OR (wd.country_id IS NOT NULL AND wra.country_id = wd.country_id)
                     OR (wd.affiliate_id IS NOT NULL AND wra.affiliate_id = wd.affiliate_id)
                     OR (wd.business_unit_id IS NOT NULL
                         AND wra.business_unit_id = wd.business_unit_id))
            )
          ORDER BY wd.workflow_name, ws.sequence_no
          LIMIT ?`,
    args: [today, today, today, today, EXAMPLE_LIMIT] as never[],
  });
  const rows = result.rows.map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    return {
      id: text(row.id),
      label: text(row.label),
      detail: `${text(row.workflow_name)}, stage ${text(row.stage_name)}`,
    };
  });
  return {
    key: 'workflow_roles_without_approver',
    title: 'Workflow roles with no eligible approver',
    summary: 'A stage whose workflow role nobody active can fill.',
    rule: 'An active workflow stage assigned to a workflow role, where no active user holds that role today within the workflow’s own country, affiliate or business unit, and no Group holder exists.',
    severity: 'BLOCKING',
    count: rows.length,
    examples: rows,
    // WORKFLOW ROLES ARE MANAGED ON THE WORKFLOWS PAGE, under its own tab.
    // This used to point at /app/administration/workflow-roles, which has only
    // an [id] route and no index, so the control promised to take somebody to
    // the fix and delivered "Page not found".
    href: '/app/administration/workflows?tab=roles',
  };
}

async function usersWithoutAssignment(db: Client, today: string): Promise<HealthCheck> {
  const result = await db.execute({
    sql: `SELECT u.user_id AS id, u.display_name AS label, u.email AS detail
          FROM users u
          WHERE u.user_type = 'INTERNAL' AND u.status = 'ACTIVE'
            AND NOT EXISTS (
              SELECT 1 FROM user_assignments ua
              WHERE ua.user_id = u.user_id AND ua.active = 1
                AND ua.effective_from <= ?
                AND (ua.effective_to IS NULL OR ua.effective_to >= ?))
          ORDER BY u.display_name LIMIT ?`,
    args: [today, today, EXAMPLE_LIMIT] as never[],
  });
  const rows = result.rows.map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    return { id: text(row.id), label: text(row.label), detail: nullableText(row.detail) };
  });
  return {
    key: 'users_without_assignment',
    title: 'Active internal users with no organisational assignment',
    summary: 'An active internal user with no country, affiliate or business unit.',
    rule: 'An ACTIVE INTERNAL user with no active user_assignments row effective today. Such a user has no country, affiliate or business unit, so every scoped query returns nothing for them.',
    severity: 'ATTENTION',
    count: rows.length,
    examples: rows,
    href: '/app/administration/users',
  };
}

async function unresolvedSourceIdentities(db: Client): Promise<HealthCheck> {
  const result = await db.execute({
    sql: `SELECT ua.unresolved_actor_id AS id, ua.external_username AS label,
            ua.affiliate_id AS detail
          FROM unresolved_actors ua
          WHERE ua.status = 'UNRESOLVED'
          ORDER BY ua.external_username LIMIT ?`,
    args: [EXAMPLE_LIMIT] as never[],
  });
  const counted = await db.execute(
    `SELECT COUNT(*) AS n FROM unresolved_actors WHERE status = 'UNRESOLVED'`,
  );
  const rows = result.rows.map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    return {
      id: text(row.id),
      label: text(row.label),
      detail: nullableText(row.detail) === null ? null : `Affiliate ${text(row.detail)}`,
    };
  });
  return {
    key: 'unresolved_source_identities',
    title: 'Unresolved source names from imports',
    summary: 'A name from an extract that is credited to nobody.',
    rule: 'An unresolved_actors row still UNRESOLVED. Until it is mapped, the work that name performed, approvals included, is credited to nobody and is missing from every performance figure.',
    severity: 'ATTENTION',
    count: count((counted.rows[0] as unknown as Record<string, unknown>).n),
    examples: rows,
    href: '/app/data',
  };
}

async function openImportExceptions(db: Client): Promise<HealthCheck> {
  const result = await db.execute({
    sql: `SELECT ir.import_row_id AS id, ir.source_record_key AS label,
            ir.error_message AS detail
          FROM import_rows ir
          WHERE ir.row_status IN ('UNRESOLVED', 'FAILED')
          ORDER BY ir.imported_at DESC LIMIT ?`,
    args: [EXAMPLE_LIMIT] as never[],
  });
  const counted = await db.execute(
    `SELECT COUNT(*) AS n FROM import_rows WHERE row_status IN ('UNRESOLVED', 'FAILED')`,
  );
  const rows = result.rows.map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    return { id: text(row.id), label: text(row.label), detail: nullableText(row.detail) };
  });
  return {
    key: 'open_import_exceptions',
    title: 'Import rows still in exception',
    summary: 'A row the extract carried that the system does not hold.',
    rule: 'An import_rows row with status UNRESOLVED or FAILED. Each is a record the extract carried and the system does not hold, so every count over that data is short by one.',
    severity: 'ATTENTION',
    count: count((counted.rows[0] as unknown as Record<string, unknown>).n),
    examples: rows,
    href: '/app/data',
  };
}

async function slaRulesWithExpiredProfile(db: Client, today: string): Promise<HealthCheck> {
  const result = await db.execute({
    sql: `SELECT sr.sla_rule_id AS id, sr.rule_name AS label,
            sp.profile_name AS profile_name, sp.effective_to AS ended
          FROM sla_rules sr
          JOIN sla_profiles sp ON sp.sla_profile_id = sr.sla_profile_id
          WHERE sr.active = 1
            AND (sp.active = 0 OR (sp.effective_to IS NOT NULL AND sp.effective_to < ?))
          ORDER BY sr.rule_name LIMIT ?`,
    args: [today, EXAMPLE_LIMIT] as never[],
  });
  const rows = result.rows.map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    return {
      id: text(row.id),
      label: text(row.label),
      detail: `Profile ${text(row.profile_name)}${
        nullableText(row.ended) === null ? ' is inactive' : ` ended ${text(row.ended)}`
      }`,
    };
  });
  return {
    key: 'sla_rules_expired_profile',
    title: 'Active SLA rules on an expired or inactive profile',
    summary: 'An active rule whose profile no longer applies.',
    rule: 'An active sla_rules row whose profile is inactive, or whose profile’s effective_to is in the past. The rule looks configured and the profile that would select it no longer applies.',
    severity: 'ATTENTION',
    count: rows.length,
    examples: rows,
    href: '/app/administration/sla',
  };
}

async function inactiveProductsInUse(db: Client): Promise<HealthCheck> {
  const result = await db.execute({
    sql: `SELECT p.product_id AS id, p.product_name AS label,
            COUNT(op.opportunity_product_id) AS uses
          FROM products p
          JOIN opportunity_products op ON op.product_id = p.product_id
          JOIN opportunities o ON o.opportunity_id = op.opportunity_id
          WHERE p.active = 0 AND o.status = 'OPEN'
          GROUP BY p.product_id, p.product_name
          ORDER BY uses DESC LIMIT ?`,
    args: [EXAMPLE_LIMIT] as never[],
  });
  const rows = result.rows.map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    return {
      id: text(row.id),
      label: text(row.label),
      detail: `On ${count(row.uses)} open opportunities`,
    };
  });
  return {
    key: 'inactive_products_in_use',
    title: 'Deactivated products still on open opportunities',
    summary: 'An open opportunity quoting a withdrawn product.',
    rule: 'A product with active = 0 referenced by an opportunity_products row on an OPEN opportunity. The pipeline is quoting something the catalogue says is withdrawn.',
    severity: 'INFORMATION',
    count: rows.length,
    examples: rows,
    href: '/app/administration/catalogue',
  };
}

async function suspendedPortalMemberships(db: Client): Promise<HealthCheck> {
  const result = await db.execute({
    sql: `SELECT m.portal_membership_id AS id,
            COALESCE(c.full_name, u.display_name) AS label,
            a.account_name AS detail
          FROM customer_portal_memberships m
          JOIN users u ON u.user_id = m.user_id
          JOIN accounts a ON a.account_id = m.account_id
          LEFT JOIN contacts c ON c.contact_id = m.contact_id
          WHERE m.status = 'SUSPENDED'
          ORDER BY a.account_name LIMIT ?`,
    args: [EXAMPLE_LIMIT] as never[],
  });
  const rows = result.rows.map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    return { id: text(row.id), label: text(row.label), detail: nullableText(row.detail) };
  });
  return {
    key: 'suspended_portal_memberships',
    title: 'Suspended portal memberships',
    summary: 'Portal access suspended long enough to look forgotten.',
    rule: 'A customer_portal_memberships row at SUSPENDED. Suspension is meant to be temporary, so a long-standing one is either a decision nobody finished or access somebody expects to have.',
    severity: 'INFORMATION',
    count: rows.length,
    examples: rows,
    href: '/app/operations/customers',
  };
}

async function teamsWithoutManager(db: Client): Promise<HealthCheck> {
  const result = await db.execute({
    sql: `SELECT t.team_id AS id, t.team_name AS label, t.team_type AS detail
          FROM teams t
          WHERE t.active = 1
            AND (t.manager_user_id IS NULL
                 OR NOT EXISTS (SELECT 1 FROM users u
                                WHERE u.user_id = t.manager_user_id AND u.status = 'ACTIVE'))
          ORDER BY t.team_name LIMIT ?`,
    args: [EXAMPLE_LIMIT] as never[],
  });
  const rows = result.rows.map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    return { id: text(row.id), label: text(row.label), detail: `${text(row.detail)} team` };
  });
  return {
    key: 'teams_without_manager',
    title: 'Active teams with no active manager',
    summary: 'An active team whose escalation has nowhere to go.',
    rule: 'An active team whose manager_user_id is null, or names a user who is not ACTIVE. Escalation routes to the team manager, so an unmanaged team is an escalation that goes nowhere.',
    severity: 'ATTENTION',
    count: rows.length,
    examples: rows,
    // TEAMS ARE A TAB ON THE ORGANISATION PAGE. This used to point at
    // /app/administration/organisation/teams, which has only an [id] route and
    // no index, so it 404ed for the same reason as the check above.
    href: '/app/administration/organisation?tab=teams',
  };
}

/**
 * Every check, run together.
 *
 * A check that throws is reported as unavailable rather than as zero. A
 * health screen that silently shows a clean zero because its query failed is
 * worse than one that says it could not run.
 */
export interface SystemHealth {
  checks: HealthCheck[];
  unavailable: { key: string; title: string }[];
  generatedAt: string;
}

export async function systemHealth(db: Client, now: Date): Promise<SystemHealth> {
  const today = toDbTimestamp(now).slice(0, 10);
  const runners: { key: string; title: string; run: () => Promise<HealthCheck> }[] = [
    {
      key: 'workflow_roles_without_approver',
      title: 'Workflow roles with no eligible approver',
      run: () => workflowRolesWithoutApprover(db, today),
    },
    {
      key: 'users_without_assignment',
      title: 'Active internal users with no organisational assignment',
      run: () => usersWithoutAssignment(db, today),
    },
    {
      key: 'unresolved_source_identities',
      title: 'Unresolved source names from imports',
      run: () => unresolvedSourceIdentities(db),
    },
    {
      key: 'open_import_exceptions',
      title: 'Import rows still in exception',
      run: () => openImportExceptions(db),
    },
    {
      key: 'sla_rules_expired_profile',
      title: 'Active SLA rules on an expired or inactive profile',
      run: () => slaRulesWithExpiredProfile(db, today),
    },
    {
      key: 'inactive_products_in_use',
      title: 'Deactivated products still on open opportunities',
      run: () => inactiveProductsInUse(db),
    },
    {
      key: 'suspended_portal_memberships',
      title: 'Suspended portal memberships',
      run: () => suspendedPortalMemberships(db),
    },
    {
      key: 'teams_without_manager',
      title: 'Active teams with no active manager',
      run: () => teamsWithoutManager(db),
    },
  ];

  const checks: HealthCheck[] = [];
  const unavailable: { key: string; title: string }[] = [];
  const settled = await Promise.allSettled(runners.map((runner) => runner.run()));
  settled.forEach((outcome, index) => {
    const runner = runners[index] as (typeof runners)[number];
    if (outcome.status === 'fulfilled') checks.push(outcome.value);
    else unavailable.push({ key: runner.key, title: runner.title });
  });

  const order: Record<HealthSeverity, number> = { BLOCKING: 0, ATTENTION: 1, INFORMATION: 2 };
  checks.sort((a, b) => order[a.severity] - order[b.severity] || b.count - a.count);
  return { checks, unavailable, generatedAt: toDbTimestamp(now) };
}

// ---- Access Review ------------------------------------------------------------

/**
 * The screen that exists to make ONE distinction visible.
 *
 * Application access and approval authority are different things and the
 * whole security model rests on the difference. A person may read every
 * sales order in Kenya and approve none of them; another may approve a
 * hundred million shillings of purchase orders and hold one access role.
 * Conflating them is how somebody ends up with authority nobody meant to
 * give, because the grant looked like an ordinary permission.
 *
 * So this shape has two blocks with those two headings, and it is
 * deliberately not one merged list of "what this person can do". The merge
 * is the error.
 */
export interface AccessRoleRow {
  userRoleId: string;
  roleId: string;
  roleName: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  /** The data scopes attached to this role grant. */
  scopes: { scopeType: string; label: string }[];
}

export interface ApprovalAuthorityRow {
  assignmentId: string;
  workflowRoleId: string;
  workflowRoleName: string;
  processType: string | null;
  scopeType: string;
  scopeLabel: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  /** The value bands. Empty means the role approves without an amount rule. */
  rules: {
    ruleId: string;
    processType: string;
    currency: string | null;
    minAmount: number | null;
    maxAmount: number | null;
  }[];
}

export interface AccessReviewRow {
  userId: string;
  displayName: string;
  email: string;
  status: string;
  jobTitle: string | null;
  organisation: string | null;
  /** Block one: what they can open. */
  accessRoles: AccessRoleRow[];
  /** Block two: what they can approve. Never merged with block one. */
  approvalAuthority: ApprovalAuthorityRow[];
}

/** A scope row as a person would read it. Null parts are simply absent. */
function scopeLabel(row: Record<string, unknown>): string {
  const type = text(row.scope_type);
  if (type === 'GROUP') return 'Group, every entity';
  if (type === 'OWN') return 'Own records only';
  const parts = [
    nullableText(row.country_name),
    nullableText(row.affiliate_name),
    nullableText(row.business_unit_name),
    nullableText(row.team_name),
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? type : `${type}: ${parts.join(' / ')}`;
}

export async function accessReview(
  db: Client,
  today: string,
  filter: { userId?: string | null; search?: string } = {},
): Promise<AccessReviewRow[]> {
  const clauses = ["u.user_type = 'INTERNAL'"];
  const args: unknown[] = [];
  if (filter.userId != null && filter.userId !== '') {
    clauses.push('u.user_id = ?');
    args.push(filter.userId);
  }
  if (filter.search !== undefined && filter.search.trim() !== '') {
    clauses.push('(u.display_name LIKE ? OR u.email LIKE ?)');
    const like = `%${filter.search.trim()}%`;
    args.push(like, like);
  }

  const users = await db.execute({
    sql: `SELECT u.user_id AS id, u.display_name AS display_name, u.email AS email,
            u.status AS status, jt.title_name AS job_title,
            COALESCE(bu.business_unit_name, af.affiliate_name, c.country_name) AS organisation
          FROM users u
          LEFT JOIN user_assignments ua
            ON ua.user_id = u.user_id AND ua.active = 1 AND ua.is_primary = 1
           AND ua.effective_from <= ? AND (ua.effective_to IS NULL OR ua.effective_to >= ?)
          LEFT JOIN job_titles jt ON jt.job_title_id = ua.job_title_id
          LEFT JOIN business_units bu ON bu.business_unit_id = ua.business_unit_id
          LEFT JOIN affiliates af ON af.affiliate_id = ua.affiliate_id
          LEFT JOIN countries c ON c.country_id = ua.country_id
          WHERE ${clauses.join(' AND ')}
          ORDER BY u.display_name`,
    args: [today, today, ...args] as never[],
  });
  if (users.rows.length === 0) return [];

  const ids = users.rows.map((raw) => text((raw as unknown as Record<string, unknown>).id));
  const placeholders = ids.map(() => '?').join(', ');

  // Three queries for the whole page rather than three per user. The access
  // review is read for a room full of people at a time, and an N+1 here would
  // be a hundred round trips to render one screen.
  const [roles, scopes, authority, rules] = await Promise.all([
    db.execute({
      sql: `SELECT ur.user_role_id AS id, ur.user_id AS user_id, r.role_id AS role_id,
              r.role_name AS role_name, ur.effective_from AS effective_from,
              ur.effective_to AS effective_to
            FROM user_roles ur JOIN access_roles r ON r.role_id = ur.role_id
            WHERE ur.user_id IN (${placeholders}) AND ur.active = 1
            ORDER BY r.role_name`,
      args: ids as never[],
    }),
    db.execute({
      sql: `SELECT s.user_role_id AS user_role_id, s.scope_type AS scope_type,
              c.country_name AS country_name, af.affiliate_name AS affiliate_name,
              bu.business_unit_name AS business_unit_name, t.team_name AS team_name
            FROM user_role_scopes s
            JOIN user_roles ur ON ur.user_role_id = s.user_role_id
            LEFT JOIN countries c ON c.country_id = s.country_id
            LEFT JOIN affiliates af ON af.affiliate_id = s.affiliate_id
            LEFT JOIN business_units bu ON bu.business_unit_id = s.business_unit_id
            LEFT JOIN teams t ON t.team_id = s.team_id
            WHERE ur.user_id IN (${placeholders})`,
      args: ids as never[],
    }),
    db.execute({
      sql: `SELECT wra.workflow_role_assignment_id AS id, wra.user_id AS user_id,
              wr.workflow_role_id AS workflow_role_id, wr.role_name AS role_name,
              wr.process_type AS process_type, wra.scope_type AS scope_type,
              wra.effective_from AS effective_from, wra.effective_to AS effective_to,
              c.country_name AS country_name, af.affiliate_name AS affiliate_name,
              bu.business_unit_name AS business_unit_name, NULL AS team_name
            FROM workflow_role_assignments wra
            JOIN workflow_roles wr ON wr.workflow_role_id = wra.workflow_role_id
            LEFT JOIN countries c ON c.country_id = wra.country_id
            LEFT JOIN affiliates af ON af.affiliate_id = wra.affiliate_id
            LEFT JOIN business_units bu ON bu.business_unit_id = wra.business_unit_id
            WHERE wra.user_id IN (${placeholders}) AND wra.active = 1
            ORDER BY wr.role_name`,
      args: ids as never[],
    }),
    db.execute({
      sql: `SELECT ar.authority_rule_id AS id,
              ar.workflow_role_assignment_id AS assignment_id,
              ar.process_type AS process_type, ar.currency_code AS currency_code,
              ar.min_amount AS min_amount, ar.max_amount AS max_amount
            FROM approval_authority_rules ar
            JOIN workflow_role_assignments wra
              ON wra.workflow_role_assignment_id = ar.workflow_role_assignment_id
            WHERE wra.user_id IN (${placeholders}) AND ar.active = 1
            ORDER BY ar.rule_priority`,
      args: ids as never[],
    }),
  ]);

  const scopesByRole = new Map<string, { scopeType: string; label: string }[]>();
  for (const raw of scopes.rows) {
    const row = raw as unknown as Record<string, unknown>;
    const key = text(row.user_role_id);
    const list = scopesByRole.get(key) ?? [];
    list.push({ scopeType: text(row.scope_type), label: scopeLabel(row) });
    scopesByRole.set(key, list);
  }

  const rulesByAssignment = new Map<string, ApprovalAuthorityRow['rules']>();
  for (const raw of rules.rows) {
    const row = raw as unknown as Record<string, unknown>;
    const key = text(row.assignment_id);
    const list = rulesByAssignment.get(key) ?? [];
    list.push({
      ruleId: text(row.id),
      processType: text(row.process_type),
      currency: nullableText(row.currency_code),
      minAmount: row.min_amount === null ? null : Number(row.min_amount),
      maxAmount: row.max_amount === null ? null : Number(row.max_amount),
    });
    rulesByAssignment.set(key, list);
  }

  const rolesByUser = new Map<string, AccessRoleRow[]>();
  for (const raw of roles.rows) {
    const row = raw as unknown as Record<string, unknown>;
    const key = text(row.user_id);
    const list = rolesByUser.get(key) ?? [];
    list.push({
      userRoleId: text(row.id),
      roleId: text(row.role_id),
      roleName: text(row.role_name),
      effectiveFrom: text(row.effective_from),
      effectiveTo: nullableText(row.effective_to),
      scopes: scopesByRole.get(text(row.id)) ?? [],
    });
    rolesByUser.set(key, list);
  }

  const authorityByUser = new Map<string, ApprovalAuthorityRow[]>();
  for (const raw of authority.rows) {
    const row = raw as unknown as Record<string, unknown>;
    const key = text(row.user_id);
    const list = authorityByUser.get(key) ?? [];
    list.push({
      assignmentId: text(row.id),
      workflowRoleId: text(row.workflow_role_id),
      workflowRoleName: text(row.role_name),
      processType: nullableText(row.process_type),
      scopeType: text(row.scope_type),
      scopeLabel: scopeLabel(row),
      effectiveFrom: text(row.effective_from),
      effectiveTo: nullableText(row.effective_to),
      rules: rulesByAssignment.get(text(row.id)) ?? [],
    });
    authorityByUser.set(key, list);
  }

  return users.rows.map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    const id = text(row.id);
    return {
      userId: id,
      displayName: text(row.display_name),
      email: text(row.email),
      status: text(row.status),
      jobTitle: nullableText(row.job_title),
      organisation: nullableText(row.organisation),
      accessRoles: rolesByUser.get(id) ?? [],
      approvalAuthority: authorityByUser.get(id) ?? [],
    };
  });
}

// ---- Workflow Authority Review ------------------------------------------------

export interface AuthorityReviewRow {
  assignmentId: string;
  workflowRoleId: string;
  workflowRoleName: string;
  processType: string | null;
  userId: string;
  displayName: string;
  userStatus: string;
  scopeType: string;
  scopeLabel: string;
  countryId: string | null;
  affiliateId: string | null;
  businessUnitId: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  /** True where the assignment is in force on the date asked about. */
  effectiveToday: boolean;
  ruleCount: number;
  rules: ApprovalAuthorityRow['rules'];
}

export interface AuthorityFilter {
  processType?: string | null;
  countryId?: string | null;
  affiliateId?: string | null;
  businessUnitId?: string | null;
  userId?: string | null;
  /** Only assignments in force on this date. Defaults to everything. */
  effectiveOn?: string | null;
}

/**
 * Who can approve this today.
 *
 * ONE QUERY, and the acceptance criterion is that it answers "who can approve
 * Kenya sales order finance today" without a second one. So the process type,
 * the geography and the date are all clauses here rather than a filter
 * applied to a general list in TypeScript afterwards, which would have made
 * the answer depend on how many rows the first query happened to return.
 *
 * A GROUP assignment matches every geography, which is what Group means. A
 * country assignment matches its own country and the affiliates inside it,
 * because a country approver approves that country's affiliates: that is the
 * hierarchy the scope resolver uses and this reads it the same way.
 */
export async function authorityReview(
  db: Client,
  filter: AuthorityFilter = {},
): Promise<AuthorityReviewRow[]> {
  const clauses = ['wra.active = 1'];
  const args: unknown[] = [];

  if (filter.processType != null && filter.processType !== '') {
    // The workflow role's own process, or a rule naming that process. A role
    // with a null process_type is general and matches, because a null there
    // means "not restricted", not "restricted to nothing".
    clauses.push(`(wr.process_type IS NULL OR wr.process_type = ?
                   OR EXISTS (SELECT 1 FROM approval_authority_rules ar2
                              WHERE ar2.workflow_role_assignment_id = wra.workflow_role_assignment_id
                                AND ar2.active = 1 AND ar2.process_type = ?))`);
    args.push(filter.processType, filter.processType);
  }
  if (filter.countryId != null && filter.countryId !== '') {
    clauses.push(`(wra.scope_type = 'GROUP' OR wra.country_id = ?
                   OR EXISTS (SELECT 1 FROM affiliates af2
                              WHERE af2.affiliate_id = wra.affiliate_id AND af2.country_id = ?))`);
    args.push(filter.countryId, filter.countryId);
  }
  if (filter.affiliateId != null && filter.affiliateId !== '') {
    clauses.push(`(wra.scope_type = 'GROUP' OR wra.affiliate_id = ?
                   OR EXISTS (SELECT 1 FROM affiliates af3
                              WHERE af3.affiliate_id = ? AND af3.country_id = wra.country_id))`);
    args.push(filter.affiliateId, filter.affiliateId);
  }
  if (filter.businessUnitId != null && filter.businessUnitId !== '') {
    clauses.push(`(wra.business_unit_id = ? OR wra.business_unit_id IS NULL)`);
    args.push(filter.businessUnitId);
  }
  if (filter.userId != null && filter.userId !== '') {
    clauses.push('wra.user_id = ?');
    args.push(filter.userId);
  }
  if (filter.effectiveOn != null && filter.effectiveOn !== '') {
    clauses.push('wra.effective_from <= ? AND (wra.effective_to IS NULL OR wra.effective_to >= ?)');
    args.push(filter.effectiveOn, filter.effectiveOn);
  }

  const today = filter.effectiveOn ?? null;
  const result = await db.execute({
    sql: `SELECT wra.workflow_role_assignment_id AS id, wra.user_id AS user_id,
            wr.workflow_role_id AS workflow_role_id, wr.role_name AS role_name,
            wr.process_type AS process_type, wra.scope_type AS scope_type,
            wra.country_id AS country_id, wra.affiliate_id AS affiliate_id,
            wra.business_unit_id AS business_unit_id,
            wra.effective_from AS effective_from, wra.effective_to AS effective_to,
            u.display_name AS display_name, u.status AS user_status,
            c.country_name AS country_name, af.affiliate_name AS affiliate_name,
            bu.business_unit_name AS business_unit_name, NULL AS team_name,
            (SELECT COUNT(*) FROM approval_authority_rules ar
              WHERE ar.workflow_role_assignment_id = wra.workflow_role_assignment_id
                AND ar.active = 1) AS rule_count
          FROM workflow_role_assignments wra
          JOIN workflow_roles wr ON wr.workflow_role_id = wra.workflow_role_id
          JOIN users u ON u.user_id = wra.user_id
          LEFT JOIN countries c ON c.country_id = wra.country_id
          LEFT JOIN affiliates af ON af.affiliate_id = wra.affiliate_id
          LEFT JOIN business_units bu ON bu.business_unit_id = wra.business_unit_id
          WHERE ${clauses.join(' AND ')}
          ORDER BY wr.role_name, u.display_name`,
    args: args as never[],
  });
  if (result.rows.length === 0) return [];

  const assignmentIds = result.rows.map((raw) =>
    text((raw as unknown as Record<string, unknown>).id),
  );
  const rules = await db.execute({
    sql: `SELECT ar.authority_rule_id AS id, ar.workflow_role_assignment_id AS assignment_id,
            ar.process_type AS process_type, ar.currency_code AS currency_code,
            ar.min_amount AS min_amount, ar.max_amount AS max_amount
          FROM approval_authority_rules ar
          WHERE ar.workflow_role_assignment_id IN (${assignmentIds.map(() => '?').join(', ')})
            AND ar.active = 1
          ORDER BY ar.rule_priority`,
    args: assignmentIds as never[],
  });
  const rulesByAssignment = new Map<string, ApprovalAuthorityRow['rules']>();
  for (const raw of rules.rows) {
    const row = raw as unknown as Record<string, unknown>;
    const key = text(row.assignment_id);
    const list = rulesByAssignment.get(key) ?? [];
    list.push({
      ruleId: text(row.id),
      processType: text(row.process_type),
      currency: nullableText(row.currency_code),
      minAmount: row.min_amount === null ? null : Number(row.min_amount),
      maxAmount: row.max_amount === null ? null : Number(row.max_amount),
    });
    rulesByAssignment.set(key, list);
  }

  return result.rows.map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    const id = text(row.id);
    const from = text(row.effective_from);
    const to = nullableText(row.effective_to);
    return {
      assignmentId: id,
      workflowRoleId: text(row.workflow_role_id),
      workflowRoleName: text(row.role_name),
      processType: nullableText(row.process_type),
      userId: text(row.user_id),
      displayName: text(row.display_name),
      userStatus: text(row.user_status),
      scopeType: text(row.scope_type),
      scopeLabel: scopeLabel(row),
      countryId: nullableText(row.country_id),
      affiliateId: nullableText(row.affiliate_id),
      businessUnitId: nullableText(row.business_unit_id),
      effectiveFrom: from,
      effectiveTo: to,
      effectiveToday: today === null ? true : from <= today && (to === null || to >= today),
      ruleCount: count(row.rule_count),
      rules: rulesByAssignment.get(id) ?? [],
    };
  });
}

// ---- Role Impact --------------------------------------------------------------

export interface RoleImpact {
  roleId: string;
  roleName: string;
  description: string | null;
  active: boolean;
  isSystemRole: boolean;
  permissions: { permissionId: string; code: string; description: string | null }[];
  /** Who holds it, with the scope each grant carries. */
  holders: {
    userId: string;
    displayName: string;
    email: string;
    status: string;
    effectiveFrom: string;
    effectiveTo: string | null;
    scopes: { scopeType: string; label: string }[];
  }[];
}

/**
 * What a role grants and who currently holds it, in one place.
 *
 * The reason this screen exists is in the phase text: nobody should have to
 * search user by user to answer "who would be affected if I changed this
 * role". Somebody about to add a permission to a role needs to see the
 * fifteen people it reaches before they add it, not afterwards.
 */
export async function roleImpact(db: Client, roleId: string): Promise<RoleImpact | null> {
  const role = await db.execute({
    sql: `SELECT role_id, role_name, description, active, is_system_role
          FROM access_roles WHERE role_id = ? LIMIT 1`,
    args: [roleId],
  });
  const head = role.rows[0] as Record<string, unknown> | undefined;
  if (head === undefined) return null;

  const [permissions, holders, scopes] = await Promise.all([
    db.execute({
      sql: `SELECT p.permission_id AS id,
              p.module_name || '.' || p.resource_name || '.' || p.action_name AS code,
              p.description AS description
            FROM role_permissions rp JOIN permissions p ON p.permission_id = rp.permission_id
            WHERE rp.role_id = ? AND rp.allowed = 1
            ORDER BY p.module_name, p.resource_name, p.action_name`,
      args: [roleId],
    }),
    db.execute({
      sql: `SELECT ur.user_role_id AS user_role_id, u.user_id AS user_id,
              u.display_name AS display_name, u.email AS email, u.status AS status,
              ur.effective_from AS effective_from, ur.effective_to AS effective_to
            FROM user_roles ur JOIN users u ON u.user_id = ur.user_id
            WHERE ur.role_id = ? AND ur.active = 1
            ORDER BY u.display_name`,
      args: [roleId],
    }),
    db.execute({
      sql: `SELECT s.user_role_id AS user_role_id, s.scope_type AS scope_type,
              c.country_name AS country_name, af.affiliate_name AS affiliate_name,
              bu.business_unit_name AS business_unit_name, t.team_name AS team_name
            FROM user_role_scopes s
            JOIN user_roles ur ON ur.user_role_id = s.user_role_id
            LEFT JOIN countries c ON c.country_id = s.country_id
            LEFT JOIN affiliates af ON af.affiliate_id = s.affiliate_id
            LEFT JOIN business_units bu ON bu.business_unit_id = s.business_unit_id
            LEFT JOIN teams t ON t.team_id = s.team_id
            WHERE ur.role_id = ? AND ur.active = 1`,
      args: [roleId],
    }),
  ]);

  const scopesByRole = new Map<string, { scopeType: string; label: string }[]>();
  for (const raw of scopes.rows) {
    const row = raw as unknown as Record<string, unknown>;
    const key = text(row.user_role_id);
    const list = scopesByRole.get(key) ?? [];
    list.push({ scopeType: text(row.scope_type), label: scopeLabel(row) });
    scopesByRole.set(key, list);
  }

  return {
    roleId: text(head.role_id),
    roleName: text(head.role_name),
    description: nullableText(head.description),
    active: Number(head.active) === 1,
    isSystemRole: Number(head.is_system_role) === 1,
    permissions: permissions.rows.map((raw) => {
      const row = raw as unknown as Record<string, unknown>;
      return {
        permissionId: text(row.id),
        code: text(row.code),
        description: nullableText(row.description),
      };
    }),
    holders: holders.rows.map((raw) => {
      const row = raw as unknown as Record<string, unknown>;
      return {
        userId: text(row.user_id),
        displayName: text(row.display_name),
        email: text(row.email),
        status: text(row.status),
        effectiveFrom: text(row.effective_from),
        effectiveTo: nullableText(row.effective_to),
        scopes: scopesByRole.get(text(row.user_role_id)) ?? [],
      };
    }),
  };
}

// ---- Expiring authority -------------------------------------------------------

export interface ExpiringAuthority {
  assignmentId: string;
  kind: 'APPROVAL_AUTHORITY' | 'ACCESS_ROLE';
  userId: string;
  displayName: string;
  roleName: string;
  scopeLabel: string;
  effectiveTo: string;
  daysRemaining: number;
}

/**
 * Effective-dated grants ending soon.
 *
 * NOTHING IS EXTENDED AUTOMATICALLY, and there is no function in this module
 * that could. An expiry date is somebody's decision about how long a person
 * should hold an authority, and quietly renewing it because a transaction
 * needed an approver would defeat the reason for dating it at all. This
 * reports, and a person decides.
 *
 * Approval authority and access roles are both reported and are labelled
 * differently, because losing the ability to open a screen and losing the
 * ability to approve a payment are not the same problem.
 */
export async function expiringAuthority(
  db: Client,
  now: Date,
  withinDays = 30,
): Promise<ExpiringAuthority[]> {
  const today = toDbTimestamp(now).slice(0, 10);
  const horizon = new Date(now);
  horizon.setUTCDate(horizon.getUTCDate() + withinDays);
  const limit = toDbTimestamp(horizon).slice(0, 10);

  const [authority, roles] = await Promise.all([
    db.execute({
      sql: `SELECT wra.workflow_role_assignment_id AS id, wra.user_id AS user_id,
              u.display_name AS display_name, wr.role_name AS role_name,
              wra.scope_type AS scope_type, wra.effective_to AS effective_to,
              c.country_name AS country_name, af.affiliate_name AS affiliate_name,
              bu.business_unit_name AS business_unit_name, NULL AS team_name
            FROM workflow_role_assignments wra
            JOIN workflow_roles wr ON wr.workflow_role_id = wra.workflow_role_id
            JOIN users u ON u.user_id = wra.user_id
            LEFT JOIN countries c ON c.country_id = wra.country_id
            LEFT JOIN affiliates af ON af.affiliate_id = wra.affiliate_id
            LEFT JOIN business_units bu ON bu.business_unit_id = wra.business_unit_id
            WHERE wra.active = 1 AND wra.effective_to IS NOT NULL
              AND wra.effective_to >= ? AND wra.effective_to <= ?
            ORDER BY wra.effective_to`,
      args: [today, limit] as never[],
    }),
    db.execute({
      sql: `SELECT ur.user_role_id AS id, ur.user_id AS user_id,
              u.display_name AS display_name, r.role_name AS role_name,
              'ACCESS' AS scope_type, ur.effective_to AS effective_to,
              NULL AS country_name, NULL AS affiliate_name,
              NULL AS business_unit_name, NULL AS team_name
            FROM user_roles ur
            JOIN access_roles r ON r.role_id = ur.role_id
            JOIN users u ON u.user_id = ur.user_id
            WHERE ur.active = 1 AND ur.effective_to IS NOT NULL
              AND ur.effective_to >= ? AND ur.effective_to <= ?
            ORDER BY ur.effective_to`,
      args: [today, limit] as never[],
    }),
  ]);

  const days = (endDate: string): number => {
    const end = Date.parse(`${endDate}T00:00:00Z`);
    const start = Date.parse(`${today}T00:00:00Z`);
    return Number.isNaN(end) || Number.isNaN(start)
      ? 0
      : Math.max(0, Math.round((end - start) / 86400000));
  };

  const map = (rows: readonly unknown[], kind: ExpiringAuthority['kind']): ExpiringAuthority[] =>
    rows.map((raw) => {
      const row = raw as Record<string, unknown>;
      const to = text(row.effective_to);
      return {
        assignmentId: text(row.id),
        kind,
        userId: text(row.user_id),
        displayName: text(row.display_name),
        roleName: text(row.role_name),
        scopeLabel: kind === 'ACCESS_ROLE' ? 'Application access' : scopeLabel(row),
        effectiveTo: to,
        daysRemaining: days(to),
      };
    });

  return [...map(authority.rows, 'APPROVAL_AUTHORITY'), ...map(roles.rows, 'ACCESS_ROLE')].sort(
    (a, b) => a.daysRemaining - b.daysRemaining || a.displayName.localeCompare(b.displayName),
  );
}
