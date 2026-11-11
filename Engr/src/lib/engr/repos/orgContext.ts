/**
 * Acting-organisation resolution.
 *
 * Only a platform owner (users.is_platform_owner) may switch the acting
 * organisation, and may act only inside top-level tenant organisations. This
 * resolves, from the database and the requested acting id, the organisation the
 * request will actually operate inside, and the set the user may switch between.
 * The acting organisation is always validated here against that set, so a stale
 * or tampered cookie can never widen access: an id outside the set falls back to
 * the home organisation.
 *
 * Affiliates (organisations.parent_org_id IS NOT NULL) are part of the
 * parent's setup, not independent tenant choices in the switcher. The
 * middleware continues to enforce the original account and role boundaries.
 */
import type { Client } from '@libsql/client/web';

export interface SwitchOrg {
  id: string;
  name: string;
  slug: string;
}

export interface ActingContext {
  homeOrgId: string;
  actingOrgId: string;
  actingName: string;
  actingSlug: string;
  isPlatformOwner: boolean;
  switchable: SwitchOrg[];
}

export async function resolveActingContext(
  db: Client,
  homeOrgId: string,
  homeName: string,
  homeSlug: string,
  isPlatformOwner: boolean,
  requestedActingId: string | null,
): Promise<ActingContext> {
  const fallback: ActingContext = {
    homeOrgId,
    actingOrgId: homeOrgId,
    actingName: homeName,
    actingSlug: homeSlug,
    isPlatformOwner: false,
    switchable: [],
  };
  // An ordinary user never switches: they always act inside their home org.
  if (!isPlatformOwner) return fallback;

  // Only true tenant roots are switchable; affiliate choices belong in setup.
  const res = await db.execute({
    sql: `SELECT id, name, slug FROM organisations
            WHERE parent_org_id IS NULL AND status = 'ACTIVE' AND deleted_at IS NULL
         ORDER BY name`,
    args: [],
  });
  const switchable: SwitchOrg[] = res.rows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    slug: String(r.slug),
  }));

  // The requested id is honoured only when it is in the set; otherwise home.
  const homeParent = await db.execute({
    sql: 'SELECT COALESCE(parent_org_id, id) AS tenant_id FROM organisations WHERE id = ? LIMIT 1',
    args: [homeOrgId],
  });
  const homeTenantId = String(homeParent.rows[0]?.tenant_id ?? homeOrgId);
  const chosen = requestedActingId && switchable.some((s) => s.id === requestedActingId)
    ? requestedActingId
    : homeTenantId;
  const actingRow = switchable.find((s) => s.id === chosen) ?? null;

  return {
    homeOrgId,
    actingOrgId: actingRow?.id ?? homeOrgId,
    actingName: actingRow?.name ?? homeName,
    actingSlug: actingRow?.slug ?? homeSlug,
    isPlatformOwner: true,
    switchable,
  };
}
