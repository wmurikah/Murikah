/**
 * The authorisation engine: one check, one scope resolver.
 *
 * ONE CHECK
 * `can()` answers whether a principal holds a permission code. It reads the
 * resolved codes on the principal that Build Prompt 04's middleware attached
 * and nothing else. There is no second implementation, no second source of
 * truth, and no code path that decides access from an email address, a display
 * name, a job title, a department or a role id.
 *
 * ONE SCOPE RESOLVER
 * `resolveScope()` answers which records a principal may see for a permission.
 * It returns a description, and `scopePredicate()` turns that description into
 * a SQL fragment the data layer puts in its WHERE clause. It is a predicate and
 * not a filter, deliberately: fetching a country's worth of rows and hiding
 * some in the browser is not authorisation, and neither is fetching them and
 * discarding them on the server.
 *
 * THE RULE FOR `role_permissions.allowed = 0`
 * A row with `allowed = 0` means that role does not grant the code. It is a
 * withholding recorded against that role, not a veto over every other role the
 * person holds.
 *
 * The alternative, a deny that overrides another role's grant, is the stricter
 * reading and it was rejected for one reason: Build Prompt 03's identity
 * resolver already joins `role_permissions` on `allowed = 1`, so a person's
 * resolved permission list is built that way today. Implementing the opposite
 * rule here would put two disagreeing answers in one product, which section 7
 * exists to prevent, and reconciling them means editing authentication code
 * that this batch may not touch. One rule, applied everywhere, beats a stricter
 * rule applied in half the places.
 *
 * The consequence is worth stating rather than hiding: ticking a permission off
 * for one role does not take it away from somebody who also holds it through
 * another. The permission matrix says so where a withheld row exists, so an
 * administrator is never surprised by it. Removing access means removing every
 * grant of it, and the matrix's impact summary is what makes that visible.
 *
 * NEVER WIDEN ACCESS BECAUSE A FIELD IS NULL
 * A record whose `affiliate_id` is null is visible to no affiliate-scoped user.
 * Every scoped branch below is written `column IS NOT NULL AND column IN (...)`,
 * which is one clause longer than it needs to be and is the whole point: a bare
 * `IN` silently returns nothing on a null, and a careless `OR column IS NULL`
 * silently returns everything.
 */
import type { Client } from '@libsql/client/web';

/** The permission code format, used by the resolver, the navigation and tests. */
export type PermissionCode = string;

export const SCOPE_TYPES = [
  'OWN',
  'TEAM',
  'BUSINESS_UNIT',
  'AFFILIATE',
  'COUNTRY',
  'GROUP',
] as const;
export type ScopeType = (typeof SCOPE_TYPES)[number];

export interface Principal {
  readonly userId: string;
  readonly permissions: readonly string[];
}

/** The one check. */
export function can(principal: Principal | null, code: PermissionCode): boolean {
  return principal !== null && principal.permissions.includes(code);
}

export interface ResolvedScope {
  readonly scopeType: ScopeType;
  readonly countryId: string | null;
  readonly affiliateId: string | null;
  readonly businessUnitId: string | null;
  readonly teamId: string | null;
  /** The role the scope arrived through, for the explanation and the audit. */
  readonly roleId: string;
  readonly roleName: string;
}

export interface ScopeResolution {
  readonly userId: string;
  readonly permission: PermissionCode;
  /** False when no live role grants the code at all. */
  readonly granted: boolean;
  readonly scopes: readonly ResolvedScope[];
  /** True when any scope is GROUP: everything the permission covers. */
  readonly group: boolean;
}

/**
 * Which records this principal may see for this permission.
 *
 * The scopes are those attached to the live roles that actually grant the code,
 * not every scope the person holds. A Finance Manager scoped to Kenya and a
 * Sales Executive scoped to OWN are two different answers to two different
 * permissions, and reading them together would give the finance scope to a
 * sales query.
 *
 * A role that records the code with `allowed = 0` contributes nothing here,
 * per the rule at the top of this file.
 */
/**
 * One answer per (client, user, permission), for the life of one request.
 *
 * WHY. This is a pure function of its arguments: the same user and the same
 * code give the same scopes for the whole of a request, and nothing on a
 * dashboard changes a role mid-render. Every metric helper resolves scope
 * before running its own query, so a page that draws forty figures asked this
 * question forty times. Measured on the executive dashboard: 83 round trips
 * for 5 distinct answers, which is a third of the page's entire subrequest
 * budget spent re-reading one row set.
 *
 * KEYED ON THE CLIENT, so the cache lives exactly as long as the request does.
 * `getDb` builds a fresh client per request (Workers are stateless and there
 * is no safe module-level singleton across isolates), and a WeakMap holds the
 * entry only while that client is alive. A role changed between two requests
 * is therefore seen by the second one. A role changed *during* a single render
 * is not, which is the same guarantee the page already had: it resolved every
 * scope from one connection within a few milliseconds either way.
 *
 * The PROMISE is cached rather than the value, so concurrent callers in the
 * same tick share one in-flight query instead of racing to issue several.
 */
const scopeCache = new WeakMap<Client, Map<string, Promise<ScopeResolution>>>();

export async function resolveScope(
  db: Client,
  userId: string,
  permission: PermissionCode,
): Promise<ScopeResolution> {
  // ONLY A BATCHING CLIENT IS CACHED, and that restriction is the whole safety
  // argument.
  //
  // A batching client (src/lib/cms/batching.ts) is handed out by a read-only
  // analytics render, which issues no writes at all, so no role can change
  // underneath it. Everything else, the RBAC administration endpoints
  // included, gets a plain client and resolves afresh every time, exactly as
  // before: those paths DO grant a role and then re-read the scope in the same
  // request, and a cache there would answer with what was true before the
  // grant. `test/cms/rbac.test.ts` proves that case, and it should.
  //
  // Each section holds its own wrapper around one underlying client, so the
  // cache keys on the root rather than the wrapper; otherwise five sections
  // would ask the same question five times.
  const root = (db as unknown as Record<symbol, unknown>)[Symbol.for('cms.rootClient')] as
    | Client
    | undefined;
  if (root === undefined) return resolveScopeUncached(db, userId, permission);

  const key = `${userId}\u0000${permission}`;
  let perClient = scopeCache.get(root);
  if (perClient === undefined) {
    perClient = new Map();
    scopeCache.set(root, perClient);
  }
  const cached = perClient.get(key);
  if (cached !== undefined) return cached;
  const pending = resolveScopeUncached(db, userId, permission);
  perClient.set(key, pending);
  // A failed resolution must not be remembered: the next attempt in the same
  // request should ask again rather than replay the error.
  void pending.catch(() => perClient.delete(key));
  return pending;
}

async function resolveScopeUncached(
  db: Client,
  userId: string,
  permission: PermissionCode,
): Promise<ScopeResolution> {
  const [moduleName, resourceName, actionName] = permission.split('.');
  const result = await db.execute({
    sql: `
      SELECT DISTINCT s.scope_type, s.country_id, s.affiliate_id, s.business_unit_id, s.team_id,
             ar.role_id, ar.role_name
      FROM user_roles ur
      JOIN access_roles ar ON ar.role_id = ur.role_id AND ar.active = 1
      JOIN role_permissions rp ON rp.role_id = ur.role_id AND rp.allowed = 1
      JOIN permissions p ON p.permission_id = rp.permission_id
      LEFT JOIN user_role_scopes s ON s.user_role_id = ur.user_role_id
      WHERE ur.user_id = ?
        AND ur.active = 1
        AND ur.effective_from <= date('now')
        AND (ur.effective_to IS NULL OR ur.effective_to >= date('now'))
        AND p.module_name = ? AND p.resource_name = ? AND p.action_name = ?`,
    args: [userId, moduleName ?? '', resourceName ?? '', actionName ?? ''],
  });

  const scopes: ResolvedScope[] = [];
  let granted = false;
  for (const row of result.rows) {
    granted = true;
    // A role that grants the code with no scope row attached is a grant with no
    // reach. It is recorded as granted, so the caller can tell "no permission"
    // from "permission with nothing in scope", and it contributes no branch.
    const scopeType =
      row.scope_type === null || row.scope_type === undefined ? null : String(row.scope_type);
    if (scopeType === null) continue;
    scopes.push({
      scopeType: scopeType as ScopeType,
      countryId: row.country_id === null ? null : String(row.country_id),
      affiliateId: row.affiliate_id === null ? null : String(row.affiliate_id),
      businessUnitId: row.business_unit_id === null ? null : String(row.business_unit_id),
      teamId: row.team_id === null ? null : String(row.team_id),
      roleId: String(row.role_id),
      roleName: String(row.role_name),
    });
  }
  return {
    userId,
    permission,
    granted,
    scopes,
    group: scopes.some((s) => s.scopeType === 'GROUP'),
  };
}

/**
 * The columns a table offers for scoping.
 *
 * A module names the columns it actually has. Anything absent is a dimension
 * that module does not support, and a scope of that kind then contributes
 * nothing rather than being approximated into something wider.
 */
export interface ScopedColumns {
  readonly country?: string;
  readonly affiliate?: string;
  readonly businessUnit?: string;
  /** Absent on a module with no team ownership. See TEAM below. */
  readonly team?: string;
  /** The column holding the user who owns or is assigned the record. */
  readonly owner?: string;
}

export interface Predicate {
  readonly sql: string;
  readonly args: unknown[];
}

/** Denies everything. Returned when nothing grants, and used as the base case. */
export const DENY_ALL: Predicate = { sql: '1 = 0', args: [] };
export const ALLOW_ALL: Predicate = { sql: '1 = 1', args: [] };

/**
 * The scope resolution, as a SQL predicate.
 *
 * Multiple scopes UNION. A user scoped to Kenya and Uganda sees both, which is
 * an OR of the two branches and not an intersection and not the narrower one.
 *
 * A TEAM scope on a module with no team ownership contributes nothing, and the
 * decision is deliberate: the alternatives are to widen it to the person's
 * whole affiliate, which grants access nobody configured, or to fall back to
 * OWN, which quietly changes what the administrator asked for. Contributing
 * nothing is visible in the result, and an administrator who scoped a role to a
 * team for a module that has no teams sees no rows and asks why, which is the
 * outcome that gets the configuration corrected.
 */
export function scopePredicate(resolution: ScopeResolution, columns: ScopedColumns): Predicate {
  if (!resolution.granted) return DENY_ALL;
  if (resolution.group) return ALLOW_ALL;

  const branches: string[] = [];
  const args: unknown[] = [];

  const inList = (column: string | undefined, values: string[]) => {
    if (column === undefined || values.length === 0) return;
    // `IS NOT NULL` before the membership test. A null column must never match,
    // and a bare IN would silently return nothing while an OR ... IS NULL would
    // silently return everything.
    const placeholders = values.map(() => '?').join(', ');
    branches.push(`(${column} IS NOT NULL AND ${column} IN (${placeholders}))`);
    args.push(...values);
  };

  const gather = (type: ScopeType, key: keyof ResolvedScope): string[] =>
    resolution.scopes
      .filter((s) => s.scopeType === type)
      .map((s) => s[key])
      .filter((v): v is string => typeof v === 'string' && v !== '');

  inList(columns.country, gather('COUNTRY', 'countryId'));
  inList(columns.affiliate, gather('AFFILIATE', 'affiliateId'));
  inList(columns.businessUnit, gather('BUSINESS_UNIT', 'businessUnitId'));
  inList(columns.team, gather('TEAM', 'teamId'));

  if (resolution.scopes.some((s) => s.scopeType === 'OWN') && columns.owner !== undefined) {
    branches.push(`(${columns.owner} IS NOT NULL AND ${columns.owner} = ?)`);
    args.push(resolution.userId);
  }

  // Nothing contributed a branch: the person holds the permission and it
  // reaches no record. Denying is the only safe reading.
  if (branches.length === 0) return DENY_ALL;
  return { sql: `(${branches.join(' OR ')})`, args };
}

/**
 * Whether one particular record is in scope.
 *
 * Expressed as the same predicate against the row's own key, so a single-record
 * read and a list read cannot drift apart. A direct fetch by id that checked
 * anything else would be the hole section 16 exists to close.
 */
export function scopedRowSql(
  table: string,
  keyColumn: string,
  predicate: Predicate,
): { sql: string; args: unknown[] } {
  return {
    sql: `SELECT 1 FROM ${table} WHERE ${keyColumn} = ? AND ${predicate.sql} LIMIT 1`,
    args: predicate.args,
  };
}

/**
 * A plain-language account of why a principal sees what they see.
 *
 * Shown to an administrator diagnosing a configuration, and nowhere else. It
 * names roles and scopes, never a query.
 */
export function explainScope(resolution: ScopeResolution): string {
  if (!resolution.granted) return `No live role grants ${resolution.permission}.`;
  if (resolution.group) {
    const via = resolution.scopes.find((s) => s.scopeType === 'GROUP');
    return `Group access to ${resolution.permission}, through ${via?.roleName ?? 'a role'}.`;
  }
  if (resolution.scopes.length === 0) {
    return `${resolution.permission} is granted, and no data scope is attached, so it reaches no records.`;
  }
  const parts = resolution.scopes.map((s) => {
    const target = s.countryId ?? s.affiliateId ?? s.businessUnitId ?? s.teamId;
    const where =
      s.scopeType === 'OWN'
        ? 'their own records'
        : `${s.scopeType.toLowerCase().replace(/_/g, ' ')} ${target}`;
    return `${where}, through ${s.roleName}`;
  });
  return `${resolution.permission} covers ${parts.join('; and ')}.`;
}
