/**
 * Acting-organisation resolution for GRC.
 *
 * Only a platform owner (users.is_platform_owner) may switch the acting
 * organisation, and they may act inside any organisation on the platform. This
 * resolves, from the database and the requested acting id, the organisation the
 * request will actually operate inside, and the set the user may switch between.
 * The acting organisation is always validated here against that set, so a stale
 * or tampered cookie can never widen access: an id outside the set falls back to
 * the home organisation. The middleware calls it only for a platform owner;
 * every other user acts inside their home organisation with no query.
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
  actingOrganizationId: string;
  actingName: string;
  isPlatformOwner: boolean;
  switchable: SwitchOrg[];
}

export async function resolveActingContext(
  db: Client,
  homeOrganizationId: string,
  homeName: string,
  isPlatformOwner: boolean,
  requestedActingId: string | null,
): Promise<ActingContext> {
  const fallback: ActingContext = {
    homeOrganizationId,
    actingOrganizationId: homeOrganizationId,
    actingName: homeName,
    isPlatformOwner: false,
    switchable: [],
  };
  // An ordinary user never switches: they always act inside their home org.
  if (!isPlatformOwner) return fallback;

  // A platform owner may act inside any active organisation on the platform.
  // `organizations` names its label column `org_name` and its active flag
  // `is_active` (there is no `name` or `status` column).
  const res = await db.execute({
    sql: `SELECT ${O.organization_id}, ${O.org_name} FROM organizations
           WHERE ${O.is_active} = 1 ORDER BY ${O.org_name}`,
    args: [],
  });
  const switchable: SwitchOrg[] = res.rows.map((r) => ({
    id: String(r.organization_id),
    name: String(r.org_name),
  }));

  // The requested id is honoured only when it is in the set; otherwise home.
  const chosen =
    requestedActingId && switchable.some((s) => s.id === requestedActingId)
      ? requestedActingId
      : homeOrganizationId;
  const actingRow = switchable.find((s) => s.id === chosen) ?? null;

  return {
    homeOrganizationId,
    actingOrganizationId: actingRow?.id ?? homeOrganizationId,
    actingName: actingRow?.name ?? homeName,
    isPlatformOwner: true,
    switchable,
  };
}
