/**
 * The permission codes this product authorises against, named once.
 *
 * A code is a string in the database's own MODULE.RESOURCE.ACTION form. Naming
 * them here rather than typing the literal at each call site is not tidiness:
 * a mistyped literal is a silent grant failure that looks like a working guard,
 * because `permissions.includes('ADMIN.ORGANISATON.MANAGE')` is false for
 * everybody and refuses everybody, which is indistinguishable from correct
 * behaviour until an administrator complains.
 *
 * These two do not exist in the seeded `permissions` table. They are added by
 * docs/cms/organisation/01_add_organisation_permissions.sql, which the operator
 * runs by hand in the Turso console. Until then every endpoint below refuses
 * every caller, which is the correct direction to fail.
 */

/** Read countries, affiliates, business units, departments and teams. */
export const ORGANISATION_VIEW = 'ADMIN.ORGANISATION.VIEW';

/** Create, edit and deactivate that master data. */
export const ORGANISATION_MANAGE = 'ADMIN.ORGANISATION.MANAGE';

/**
 * MANAGE implies VIEW.
 *
 * Not because the database says so, and it does not: the two rows are
 * independent and a role could be granted MANAGE alone. It is stated here
 * because a workspace that let someone edit a country they could not read would
 * be incoherent, and because the alternative is every read path checking two
 * codes and one of them eventually forgetting.
 */
export function canViewOrganisation(permissions: readonly string[]): boolean {
  return permissions.includes(ORGANISATION_VIEW) || permissions.includes(ORGANISATION_MANAGE);
}

export function canManageOrganisation(permissions: readonly string[]): boolean {
  return permissions.includes(ORGANISATION_MANAGE);
}

/**
 * User administration. Already in the seeded catalogue as PERM-016, already
 * granted to ROLE-ADMIN, so Build Prompt 06 needs no data script.
 */
export const USERS_MANAGE = 'ADMIN.USERS.MANAGE';

export function canManageUsers(permissions: readonly string[]): boolean {
  return permissions.includes(USERS_MANAGE);
}

/**
 * Role and permission administration. Already in the seeded catalogue as
 * PERM-015, already granted to ROLE-ADMIN, so Build Prompt 07 needs no data
 * script either.
 */
export const ROLES_MANAGE = 'ADMIN.ROLES.MANAGE';

export function canManageRoles(permissions: readonly string[]): boolean {
  return permissions.includes(ROLES_MANAGE);
}
