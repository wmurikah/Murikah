/**
 * Input validation for job title defaults and for applying them.
 *
 * The same `FieldError` shape as every other form in this product, and the
 * same defence: the server builds the row from named fields, so an extra key
 * in the JSON is inert.
 *
 * THE APPLY PAYLOAD IS THE INTERESTING ONE. It says "give this person the
 * roles their title maps to", and a payload that could name any role at all
 * would be a way to grant anything by calling it a default. So it carries role
 * ids AND the endpoint re-derives the title's real mapping and refuses
 * anything not in it — this file checks the SHAPE, the endpoint checks the
 * CLAIM, and neither trusts the other.
 *
 * A SCOPE IS REQUIRED PER ROLE AND IS NEVER DEFAULTED HERE. Not to GROUP, not
 * to the assignment's level, not to anything: the administrator picks it on
 * screen and it arrives in the payload or the request is invalid. Inferring a
 * scope from a job title is the one thing the whole design is arranged to
 * prevent.
 */
import type { FieldError } from '../../validation.ts';
import { SCOPE_TYPES, type ScopeType } from '../auth/rbac.ts';
import { WORKFLOW_SCOPE_TYPES, type WorkflowScopeType } from '../workflow/model.ts';

export type Validated<T> = { ok: true; value: T } | { ok: false; errors: FieldError[] };

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const optional = (v: unknown): string | null => (str(v) === '' ? null : str(v));
const bool = (v: unknown): boolean =>
  v === true || v === 1 || v === '1' || v === 'true' || v === 'on';
const body = (raw: unknown): Record<string, unknown> =>
  typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};

export interface MappingInput {
  jobTitleId: string;
  targetId: string;
  active: boolean;
}

export function validateMapping(raw: unknown): Validated<MappingInput> {
  const input = body(raw);
  const errors: FieldError[] = [];
  const jobTitleId = str(input.jobTitleId);
  const targetId = str(input.targetId);
  if (jobTitleId === '') errors.push({ field: 'jobTitleId', message: 'Choose a job title.' });
  if (targetId === '') errors.push({ field: 'targetId', message: 'Choose a role.' });
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: { jobTitleId, targetId, active: input.active === undefined ? true : bool(input.active) },
  };
}

export function validateMappingUpdate(raw: unknown): Validated<{ active: boolean }> {
  const input = body(raw);
  if (input.active === undefined) {
    return { ok: false, errors: [{ field: 'active', message: 'Say whether this default is on.' }] };
  }
  return { ok: true, value: { active: bool(input.active) } };
}

export interface JobTitleChangeInput {
  jobTitleId: string;
}

export function validateJobTitleChange(raw: unknown): Validated<JobTitleChangeInput> {
  const jobTitleId = str(body(raw).jobTitleId);
  if (jobTitleId === '') {
    return { ok: false, errors: [{ field: 'jobTitleId', message: 'Choose a job title.' }] };
  }
  return { ok: true, value: { jobTitleId } };
}

/** One access role the administrator confirmed, with the scope they chose for it. */
export interface AppliedRole {
  roleId: string;
  scopeType: ScopeType;
  countryId: string | null;
  affiliateId: string | null;
  businessUnitId: string | null;
  teamId: string | null;
}

/** One workflow role the administrator confirmed, with its own scope. */
export interface AppliedAuthority {
  workflowRoleId: string;
  scopeType: WorkflowScopeType;
  countryId: string | null;
  affiliateId: string | null;
  businessUnitId: string | null;
}

export interface ApplyDefaultsInput {
  jobTitleId: string;
  roles: AppliedRole[];
  authorities: AppliedAuthority[];
}

/**
 * The scope's own target must be present, named by the field that is missing.
 *
 * The two scope CHECKs in the schema say the same thing and would reject the
 * row anyway, with a constraint name rather than a field. Saying it here names
 * the control the administrator has to fill in.
 */
function scopeErrors(
  prefix: string,
  scopeType: string,
  country: string | null,
  affiliate: string | null,
  unit: string | null,
  team: string | null,
): FieldError[] {
  if (scopeType === 'COUNTRY' && country === null) {
    return [{ field: `${prefix}.countryId`, message: 'Choose the country this covers.' }];
  }
  if (scopeType === 'AFFILIATE' && affiliate === null) {
    return [{ field: `${prefix}.affiliateId`, message: 'Choose the affiliate this covers.' }];
  }
  if (scopeType === 'BUSINESS_UNIT' && unit === null) {
    return [
      { field: `${prefix}.businessUnitId`, message: 'Choose the business unit this covers.' },
    ];
  }
  if (scopeType === 'TEAM' && team === null) {
    return [{ field: `${prefix}.teamId`, message: 'Choose the team this covers.' }];
  }
  return [];
}

export function validateApplyDefaults(raw: unknown): Validated<ApplyDefaultsInput> {
  const input = body(raw);
  const errors: FieldError[] = [];
  const jobTitleId = str(input.jobTitleId);
  if (jobTitleId === '') errors.push({ field: 'jobTitleId', message: 'Choose a job title.' });

  const roles: AppliedRole[] = [];
  for (const [index, entry] of (Array.isArray(input.roles) ? input.roles : []).entries()) {
    const item = body(entry);
    const roleId = str(item.roleId);
    const scopeType = str(item.scopeType).toUpperCase();
    const countryId = optional(item.countryId);
    const affiliateId = optional(item.affiliateId);
    const businessUnitId = optional(item.businessUnitId);
    const teamId = optional(item.teamId);
    if (roleId === '') {
      errors.push({ field: `roles.${index}.roleId`, message: 'Choose a role.' });
      continue;
    }
    if (!(SCOPE_TYPES as readonly string[]).includes(scopeType)) {
      // NOT DEFAULTED. An administrator who left the scope empty is told to
      // choose one; they are not quietly given the widest one that fits.
      errors.push({ field: `roles.${index}.scopeType`, message: 'Choose a data scope.' });
      continue;
    }
    const missing = scopeErrors(
      `roles.${index}`,
      scopeType,
      countryId,
      affiliateId,
      businessUnitId,
      teamId,
    );
    if (missing.length > 0) {
      errors.push(...missing);
      continue;
    }
    roles.push({
      roleId,
      scopeType: scopeType as ScopeType,
      countryId,
      affiliateId,
      businessUnitId,
      teamId,
    });
  }

  const authorities: AppliedAuthority[] = [];
  for (const [index, entry] of (Array.isArray(input.authorities)
    ? input.authorities
    : []
  ).entries()) {
    const item = body(entry);
    const workflowRoleId = str(item.workflowRoleId);
    const scopeType = str(item.scopeType).toUpperCase();
    const countryId = optional(item.countryId);
    const affiliateId = optional(item.affiliateId);
    const businessUnitId = optional(item.businessUnitId);
    if (workflowRoleId === '') {
      errors.push({
        field: `authorities.${index}.workflowRoleId`,
        message: 'Choose a workflow role.',
      });
      continue;
    }
    if (!(WORKFLOW_SCOPE_TYPES as readonly string[]).includes(scopeType)) {
      errors.push({ field: `authorities.${index}.scopeType`, message: 'Choose a scope.' });
      continue;
    }
    const missing = scopeErrors(
      `authorities.${index}`,
      scopeType,
      countryId,
      affiliateId,
      businessUnitId,
      null,
    );
    if (missing.length > 0) {
      errors.push(...missing);
      continue;
    }
    authorities.push({
      workflowRoleId,
      scopeType: scopeType as WorkflowScopeType,
      countryId,
      affiliateId,
      businessUnitId,
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  if (roles.length === 0 && authorities.length === 0) {
    return { ok: false, errors: [{ field: 'roles', message: 'Choose at least one default.' }] };
  }
  return { ok: true, value: { jobTitleId, roles, authorities } };
}
