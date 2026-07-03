/**
 * Acting-organisation resolution.
 *
 * A group super-admin (OWNER or ADMIN whose home organisation is a group, that
 * is one with no parent) may act inside the group itself or any of its direct
 * affiliates (children by parent_org_id). This resolves, from the database and
 * the requested acting id, the organisation the request will actually operate
 * inside, and the set the user may switch between. The acting organisation is
 * always validated here against that set, so a stale or tampered cookie can
 * never widen access: an id outside the entitlement falls back to the home
 * organisation.
 *
 * Only OWNER/ADMIN users need this resolution (an ordinary user cannot switch),
 * so the middleware calls it only for them; everyone else acts inside their home
 * organisation with no query.
 */
import type { Client } from '@libsql/client/web';

export interface SwitchOrg {
  id: string;
  name: string;
  slug: string;
  isGroup: boolean;
}

export interface ActingContext {
  homeOrgId: string;
  actingOrgId: string;
  actingName: string;
  actingSlug: string;
  isGroupAdmin: boolean;
  switchable: SwitchOrg[];
}

interface OrgRow {
  id: string;
  name: string;
  slug: string;
  parentOrgId: string | null;
}

export async function resolveActingContext(
  db: Client,
  homeOrgId: string,
  homeName: string,
  homeSlug: string,
  roleCodes: string[],
  requestedActingId: string | null,
): Promise<ActingContext> {
  // The home organisation and its direct affiliates, in one query.
  const res = await db.execute({
    sql: `SELECT id, name, slug, parent_org_id
            FROM organisations
           WHERE (id = ? OR parent_org_id = ?) AND deleted_at IS NULL
        ORDER BY (parent_org_id IS NOT NULL), name`,
    args: [homeOrgId, homeOrgId],
  });
  const rows: OrgRow[] = res.rows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    slug: String(r.slug),
    parentOrgId: r.parent_org_id == null ? null : String(r.parent_org_id),
  }));

  const homeRow = rows.find((r) => r.id === homeOrgId) ?? null;
  const isHomeGroup = homeRow != null && homeRow.parentOrgId === null;
  const isAdminRole = roleCodes.includes('OWNER') || roleCodes.includes('ADMIN');
  const isGroupAdmin = isHomeGroup && isAdminRole;

  const fallback: ActingContext = {
    homeOrgId,
    actingOrgId: homeOrgId,
    actingName: homeName,
    actingSlug: homeSlug,
    isGroupAdmin: false,
    switchable: [],
  };
  if (!isGroupAdmin || homeRow == null) return fallback;

  const toEntry = (r: OrgRow): SwitchOrg => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    isGroup: r.parentOrgId === null,
  });
  // The group first, then the affiliates (the query already orders this way).
  const switchable = rows.map(toEntry);

  const chosen =
    requestedActingId && switchable.some((s) => s.id === requestedActingId)
      ? requestedActingId
      : homeOrgId;
  const actingRow = rows.find((r) => r.id === chosen) ?? homeRow;

  return {
    homeOrgId,
    actingOrgId: actingRow.id,
    actingName: actingRow.name,
    actingSlug: actingRow.slug,
    isGroupAdmin: true,
    switchable,
  };
}
