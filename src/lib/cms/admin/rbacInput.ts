/**
 * Input validation for role and permission administration.
 *
 * The same `FieldError` shape as every other form in this product.
 *
 * The thing this file exists to do, beyond checking a name is present, is to
 * refuse fields the caller is not entitled to set. `is_system_role` is the
 * obvious one: it is not in `RoleInput`, it is not read, and a payload carrying
 * it changes nothing. That is the shape of the defence throughout: the server
 * builds the row from named fields, so an extra key in the JSON is inert rather
 * than dangerous.
 */
import type { FieldError } from '../../validation.ts';
import { SCOPE_TYPES, type ScopeType } from '../auth/rbac.ts';
import type { ScopeInput } from '../repos/rbacAdmin.ts';

export type Validated<T> = { ok: true; value: T } | { ok: false; errors: FieldError[] };

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const clamp = (v: string, max: number): string => (v.length > max ? v.slice(0, max) : v);
const optional = (v: unknown): string | null => (str(v) === '' ? null : str(v));
const bool = (v: unknown): boolean =>
  v === true || v === 1 || v === '1' || v === 'true' || v === 'on';
const body = (raw: unknown): Record<string, unknown> =>
  typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface RoleInput {
  roleName: string;
  description: string | null;
  active: boolean;
}

export function validateRole(raw: unknown): Validated<RoleInput> {
  const input = body(raw);
  const roleName = str(input.roleName);
  if (roleName.length < 2) {
    return { ok: false, errors: [{ field: 'roleName', message: 'Enter the role name.' }] };
  }
  // `isSystemRole` is deliberately absent from the returned value. A caller may
  // send it; nothing reads it.
  return {
    ok: true,
    value: {
      roleName: clamp(roleName, 120),
      description: optional(input.description),
      active: input.active === undefined ? true : bool(input.active),
    },
  };
}

export interface PermissionChangeInput {
  permissionId: string;
  granted: boolean;
}

export function validatePermissionChanges(raw: unknown): Validated<PermissionChangeInput[]> {
  const input = body(raw);
  const list = Array.isArray(input.permissions) ? input.permissions : null;
  if (list === null) {
    return {
      ok: false,
      errors: [{ field: 'permissions', message: 'Send the permissions to set.' }],
    };
  }
  const changes: PermissionChangeInput[] = [];
  for (const entry of list) {
    const item = body(entry);
    const permissionId = str(item.permissionId);
    if (permissionId === '') continue;
    changes.push({ permissionId, granted: bool(item.granted) });
  }
  return { ok: true, value: changes };
}

function validateScopes(raw: unknown): Validated<ScopeInput[]> {
  const list = Array.isArray(raw) ? raw : [];
  const scopes: ScopeInput[] = [];
  for (const entry of list) {
    const item = body(entry);
    const scopeType = str(item.scopeType).toUpperCase();
    if (!SCOPE_TYPES.includes(scopeType as ScopeType)) {
      return { ok: false, errors: [{ field: 'scopes', message: 'Choose a scope type.' }] };
    }
    // Every target is carried through and the repository decides which the
    // scope type keeps. Sending NULL rather than '' for the excluded columns is
    // what the CHECK on user_role_scopes requires.
    scopes.push({
      scopeType: scopeType as ScopeType,
      countryId: optional(item.countryId),
      affiliateId: optional(item.affiliateId),
      businessUnitId: optional(item.businessUnitId),
      teamId: optional(item.teamId),
    });
  }
  return { ok: true, value: scopes };
}

export interface UserRoleInput {
  roleId: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  active: boolean;
  scopes: ScopeInput[];
}

export function validateUserRole(raw: unknown, today: string): Validated<UserRoleInput> {
  const input = body(raw);
  const errors: FieldError[] = [];

  const roleId = str(input.roleId);
  const effectiveFrom = str(input.effectiveFrom) === '' ? today : str(input.effectiveFrom);
  const effectiveTo = optional(input.effectiveTo);

  if (roleId === '') errors.push({ field: 'roleId', message: 'Choose a role.' });
  if (!ISO_DATE.test(effectiveFrom)) {
    errors.push({ field: 'effectiveFrom', message: 'Enter a date as YYYY-MM-DD.' });
  }
  if (effectiveTo !== null && !ISO_DATE.test(effectiveTo)) {
    errors.push({ field: 'effectiveTo', message: 'Enter a date as YYYY-MM-DD.' });
  }
  if (effectiveTo !== null && ISO_DATE.test(effectiveFrom) && effectiveTo < effectiveFrom) {
    errors.push({ field: 'effectiveTo', message: 'The end date cannot be before the start date.' });
  }

  const scopes = validateScopes(input.scopes);
  if (!scopes.ok) errors.push(...scopes.errors);
  if (errors.length > 0) return { ok: false, errors };

  // A user id sent in the payload is not read. The person a role is assigned to
  // comes from the path, and the person doing the assigning comes from the
  // session, so neither is a value the browser can choose.
  return {
    ok: true,
    value: {
      roleId,
      effectiveFrom,
      effectiveTo,
      active: input.active === undefined ? true : bool(input.active),
      scopes: scopes.ok ? scopes.value : [],
    },
  };
}

export interface UserRoleUpdateInput {
  effectiveTo: string | null;
  active: boolean;
  scopes: ScopeInput[] | null;
}

export function validateUserRoleUpdate(raw: unknown): Validated<UserRoleUpdateInput> {
  const input = body(raw);
  const effectiveTo = optional(input.effectiveTo);
  if (effectiveTo !== null && !ISO_DATE.test(effectiveTo)) {
    return {
      ok: false,
      errors: [{ field: 'effectiveTo', message: 'Enter a date as YYYY-MM-DD.' }],
    };
  }
  // Scopes absent means leave them alone; scopes present, even empty, means
  // replace them with what was sent. An absent key and an empty array are
  // different intentions and are treated differently.
  const scopes = input.scopes === undefined ? null : validateScopes(input.scopes);
  if (scopes !== null && !scopes.ok) return { ok: false, errors: scopes.errors };
  return {
    ok: true,
    value: {
      effectiveTo,
      active: input.active === undefined ? true : bool(input.active),
      scopes: scopes === null ? null : scopes.value,
    },
  };
}
