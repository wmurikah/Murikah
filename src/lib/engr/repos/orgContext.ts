/**
 * Acting-organisation resolution, in three access tiers, checked server-side on
 * every request so a client value is never trusted.
 *
 * 1. Platform owner (users.is_platform_owner = 1): the vendor operator. May act
 *    as any organisation in the system, across every customer group, including
 *    tenants that sign up later. OWNER-equivalent in whichever is acting.
 * 2. Group super-admin (OWNER or ADMIN of a group, an organisation with no
 *    parent): may act inside their group or any descendant of it, and never
 *    another customer's data.
 * 3. Ordinary user: bound to their single home organisation, no switching.
 *
 * The requested acting organisation is always validated against the tier's
 * entitlement here, so a stale or tampered cookie can only ever fall back to the
 * home organisation. The acting organisation drives locals.engr.orgId exactly as
 * before, so no workflow query changes.
 */
import type { Client } from '@libsql/client/web';

export interface SwitchOrg {
  id: string;
  name: string;
  slug: string;
  isGroup: boolean;
  /** The parent group id, so a platform owner's list can be grouped. */
  parentId: string | null;
}

export interface ActingContext {
  homeOrgId: string;
  actingOrgId: string;
  actingName: string;
  actingSlug: string;
  isGroupAdmin: boolean;
  isPlatformOwner: boolean;
  switchable: SwitchOrg[];
}

interface OrgRow {
  id: string;
  name: string;
  slug: string;
  parentOrgId: string | null;
}

const toRow = (r: Record<string, unknown>): OrgRow => ({
  id: String(r.id),
  name: String(r.name),
  slug: String(r.slug),
  parentOrgId: r.parent_org_id == null ? null : String(r.parent_org_id),
});
const toEntry = (r: OrgRow): SwitchOrg => ({
  id: r.id,
  name: r.name,
  slug: r.slug,
  isGroup: r.parentOrgId === null,
  parentId: r.parentOrgId,
});

// Whether the signed-in user is the platform owner. Defensive: if the migration
// that adds the column has not been applied, treat as not a platform owner.
async function checkPlatformOwner(db: Client, userId: string): Promise<boolean> {
  try {
    const res = await db.execute({
      sql: `SELECT is_platform_owner FROM users WHERE id = ? LIMIT 1`,
      args: [userId],
    });
    return Number(res.rows[0]?.is_platform_owner ?? 0) === 1;
  } catch {
    return false;
  }
}

// Every organisation in the system (platform owner scope).
async function allOrgs(db: Client): Promise<OrgRow[]> {
  const res = await db.execute({
    sql: `SELECT id, name, slug, parent_org_id FROM organisations
           WHERE deleted_at IS NULL
        ORDER BY (parent_org_id IS NOT NULL), name`,
    args: [],
  });
  return res.rows.map((r) => toRow(r as Record<string, unknown>));
}

// A group and all of its descendants, to any depth (group super-admin scope).
async function groupTree(db: Client, rootId: string): Promise<OrgRow[]> {
  const res = await db.execute({
    sql: `WITH RECURSIVE tree(id) AS (
             SELECT id FROM organisations WHERE id = ? AND deleted_at IS NULL
             UNION
             SELECT o.id FROM organisations o
               JOIN tree t ON o.parent_org_id = t.id
              WHERE o.deleted_at IS NULL
           )
           SELECT o.id, o.name, o.slug, o.parent_org_id
             FROM organisations o JOIN tree ON o.id = tree.id
         ORDER BY (o.parent_org_id IS NOT NULL), o.name`,
    args: [rootId],
  });
  return res.rows.map((r) => toRow(r as Record<string, unknown>));
}

export async function resolveActingContext(
  db: Client,
  homeOrgId: string,
  homeName: string,
  homeSlug: string,
  roleCodes: string[],
  requestedActingId: string | null,
  userId: string,
): Promise<ActingContext> {
  const fallback: ActingContext = {
    homeOrgId,
    actingOrgId: homeOrgId,
    actingName: homeName,
    actingSlug: homeSlug,
    isGroupAdmin: false,
    isPlatformOwner: false,
    switchable: [],
  };

  const platformOwner = await checkPlatformOwner(db, userId);
  const isAdminRole = roleCodes.includes('OWNER') || roleCodes.includes('ADMIN');

  let rows: OrgRow[];
  if (platformOwner) {
    rows = await allOrgs(db);
  } else if (isAdminRole) {
    rows = await groupTree(db, homeOrgId);
    const homeRow = rows.find((r) => r.id === homeOrgId) ?? null;
    // Only the admin of a group root (no parent) may switch; an admin of an
    // ordinary organisation acts inside it alone.
    if (homeRow == null || homeRow.parentOrgId !== null) return fallback;
  } else {
    return fallback;
  }

  const switchable = rows.map(toEntry);
  const chosen =
    requestedActingId && switchable.some((s) => s.id === requestedActingId)
      ? requestedActingId
      : homeOrgId;
  const actingRow =
    rows.find((r) => r.id === chosen) ?? rows.find((r) => r.id === homeOrgId) ?? null;

  return {
    homeOrgId,
    actingOrgId: actingRow?.id ?? homeOrgId,
    actingName: actingRow?.name ?? homeName,
    actingSlug: actingRow?.slug ?? homeSlug,
    // Both tiers get the super-admin chrome (the switcher and the org badge).
    isGroupAdmin: true,
    isPlatformOwner: platformOwner,
    switchable,
  };
}
