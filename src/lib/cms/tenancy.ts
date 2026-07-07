/**
 * Tenancy for the Hass CMS SaaS.
 *
 * The ported live schema is single-tenant and country-scoped (roles, branding
 * and config key on country_code; there is no tenant column, and no plans or
 * subscriptions tables). This port makes the CMS multi-tenant with Hass as the
 * first tenant: the tenant layer is added by cms/db/migrations (tenants, plans,
 * tenant_subscriptions) and every domain table gains tenant_id as its module is
 * ported. Until then the acting tenant is resolved here as the single seeded
 * Hass tenant, so the foundation is already written against a tenant context and
 * the retrofit is a data change, not a code change.
 *
 * A platform-owner tier may act across tenants; an ordinary staff user is fixed
 * to their tenant; a customer is scoped to their tenant and their own records.
 * Import-free (types and constants only) so it can be reasoned about in one place.
 */

/** The seeded first tenant. */
export const HASS_TENANT_ID = 'hass';
export const HASS_TENANT_NAME = 'Hass';

/** Staff roles that hold the platform-owner tier (cross-tenant), server-side only. */
export const PLATFORM_OWNER_ROLES = ['PLATFORM_OWNER', 'SUPER_ADMIN'];

export interface TenantContext {
  tenantId: string;
  tenantName: string;
  /** True when the acting staff role may act across tenants. */
  isPlatformOwner: boolean;
}

/**
 * The acting tenant for a request. Customers and ordinary staff are fixed to the
 * single Hass tenant; a platform-owner staff role is flagged so a future tenant
 * switcher can widen its scope. This is the one place the single-tenant default
 * is encoded, so adding real tenants is a change here plus the data.
 */
export function resolveTenant(role: string | null): TenantContext {
  const isPlatformOwner = role != null && PLATFORM_OWNER_ROLES.includes(role);
  return { tenantId: HASS_TENANT_ID, tenantName: HASS_TENANT_NAME, isPlatformOwner };
}
