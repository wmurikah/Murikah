/**
 * Acting-organisation resolution for GRC.
 *
 * The platform owner (Murikah Labs) and an instance admin are different kinds of
 * user, and this module draws the line. An instance admin, and every other
 * ordinary role, is pinned to their home organisation: they never switch, and no
 * query runs here. The platform owner is pinned to nothing. They have no default
 * instance at all: until they select one, the acting organisation is null and
 * they are on the all-instances view. Selecting an instance sets the acting
 * organisation; leaving clears it back to null.
 *
 * The acting organisation is always validated here against the set the owner may
 * enter, so a stale or tampered cookie can never widen access, and an id outside
 * the set resolves to no instance rather than silently falling back to the home
 * organisation. The middleware calls this only for a platform owner.
 */
import type { Client } from '@libsql/client/web';
import { C, cols } from '@grc/schema/columns';

const O = cols(C.organizations);

export interface SwitchOrg {
  id: string;
  name: string;
}

export interface ActingContext {
  homeOrganizationId: string;
  /** The instance being acted inside, or null when a platform owner has selected none. */
  actingOrganizationId: string | null;
  /** The acting instance's name, or null when none is selected. */
  actingName: string | null;
  isPlatformOwner: boolean;
  switchable: SwitchOrg[];
}

/** Every active organisation on the platform, the set an owner may enter. */
export async function listInstances(db: Client): Promise<SwitchOrg[]> {
  // `organizations` names its label column `org_name` and its active flag
  // `is_active` (there is no `name` or `status` column).
  const res = await db.execute({
    sql: `SELECT ${O.organization_id}, ${O.org_name} FROM organizations
           WHERE ${O.is_active} = 1 ORDER BY ${O.org_name}`,
    args: [],
  });
  return res.rows.map((r) => ({
    id: String(r.organization_id),
    name: String(r.org_name),
  }));
}

export async function resolveActingContext(
  db: Client,
  homeOrganizationId: string,
  homeName: string,
  isPlatformOwner: boolean,
  requestedActingId: string | null,
): Promise<ActingContext> {
  // An ordinary user never switches: they are pinned to their home organisation.
  if (!isPlatformOwner) {
    return {
      homeOrganizationId,
      actingOrganizationId: homeOrganizationId,
      actingName: homeName,
      isPlatformOwner: false,
      switchable: [],
    };
  }

  // A platform owner may enter any active organisation on the platform, and is
  // inside none of them until they choose. The requested id is honoured only
  // when it is in the set; anything else means no instance is acting, never a
  // quiet fall back to the owner's home organisation.
  const switchable = await listInstances(db);
  const chosen = requestedActingId
    ? (switchable.find((s) => s.id === requestedActingId) ?? null)
    : null;

  return {
    homeOrganizationId,
    actingOrganizationId: chosen?.id ?? null,
    actingName: chosen?.name ?? null,
    isPlatformOwner: true,
    switchable,
  };
}
