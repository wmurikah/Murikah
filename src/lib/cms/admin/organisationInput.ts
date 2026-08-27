/**
 * Input validation for the organisation master data.
 *
 * Written in the style of src/lib/validation.ts and returning its `FieldError`
 * shape, so the marketing forms, the sign-in form and this workspace all report
 * a bad field the same way and the client has one thing to render. Hand-rolled
 * for the same reason that file is: a schema library would be a dependency, and
 * the rules here are a length, a required value and a membership test.
 *
 * Two principles carried over from that file. Accept generously and normalise:
 * a country code is upper-cased rather than refused for being lower-case, and
 * every string is trimmed. Reject only what cannot be used: an empty name
 * cannot, a description of any length can.
 *
 * These rules are the server's, and they are not the only defence. Every one of
 * them is also a database constraint, and the repositories catch the constraint
 * error as well, because validation that runs before a write cannot see a row
 * another request inserted a millisecond ago.
 */
import type { FieldError } from '../../validation.ts';

/** The eight values `teams.team_type` permits, copied from the CHECK. */
export const TEAM_TYPES = [
  'CUSTOMER_SERVICE',
  'SALES',
  'FINANCE',
  'CREDIT',
  'OPERATIONS',
  'PROCUREMENT',
  'MANAGEMENT',
  'OTHER',
] as const;

export type TeamType = (typeof TEAM_TYPES)[number];

export type Validated<T> = { ok: true; value: T } | { ok: false; errors: FieldError[] };

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const clamp = (value: string, max: number): string =>
  value.length > max ? value.slice(0, max) : value;
const optional = (value: unknown): string | null => {
  const text = str(value);
  return text === '' ? null : text;
};
/**
 * A checkbox, a JSON boolean and the 0/1 the database stores all mean the same
 * thing to a person, so all three are accepted rather than one being correct.
 */
const bool = (value: unknown): boolean =>
  value === true || value === 1 || value === '1' || value === 'true' || value === 'on';

const body = (raw: unknown): Record<string, unknown> =>
  typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};

// ---- countries -------------------------------------------------------------

export interface CountryInput {
  iso2: string;
  countryName: string;
  timezone: string;
  currencyCode: string;
  active: boolean;
}

export function validateCountry(raw: unknown): Validated<CountryInput> {
  const input = body(raw);
  const errors: FieldError[] = [];

  // Upper-cased before the length test, so "ke" is corrected rather than
  // rejected, and the value stored always matches the seed's own form.
  const iso2 = str(input.iso2).toUpperCase();
  const countryName = str(input.countryName);
  const timezone = str(input.timezone);
  const currencyCode = str(input.currencyCode).toUpperCase();

  // length(iso2)=2 is a CHECK, so anything else is a 500 rather than a message
  // unless it is caught here.
  if (iso2.length !== 2 || !/^[A-Z]{2}$/.test(iso2)) {
    errors.push({ field: 'iso2', message: 'Enter the two-letter country code, for example KE.' });
  }
  if (countryName.length < 2) {
    errors.push({ field: 'countryName', message: 'Enter the country name.' });
  }
  if (timezone === '') {
    errors.push({ field: 'timezone', message: 'Choose a time zone, for example Africa/Nairobi.' });
  }
  if (!/^[A-Z]{3}$/.test(currencyCode)) {
    errors.push({
      field: 'currencyCode',
      message: 'Enter the three-letter currency code, for example KES.',
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      iso2,
      countryName: clamp(countryName, 120),
      timezone: clamp(timezone, 64),
      currencyCode,
      active: input.active === undefined ? true : bool(input.active),
    },
  };
}

// ---- affiliates ------------------------------------------------------------

export interface AffiliateInput {
  affiliateCode: string;
  affiliateName: string;
  countryId: string;
  active: boolean;
}

export function validateAffiliate(raw: unknown): Validated<AffiliateInput> {
  const input = body(raw);
  const errors: FieldError[] = [];

  const affiliateCode = str(input.affiliateCode).toUpperCase();
  const affiliateName = str(input.affiliateName);
  const countryId = str(input.countryId);

  if (affiliateCode.length < 2) {
    errors.push({ field: 'affiliateCode', message: 'Enter the affiliate code, for example HKE.' });
  }
  if (affiliateName.length < 2) {
    errors.push({ field: 'affiliateName', message: 'Enter the affiliate name.' });
  }
  // No uniqueness test on the name. `affiliates.affiliate_name` is not UNIQUE in
  // the schema, and two affiliates with the same trading name in different
  // countries is a real arrangement, not a mistake to block.
  if (countryId === '') {
    errors.push({ field: 'countryId', message: 'Choose the country this affiliate belongs to.' });
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      affiliateCode: clamp(affiliateCode, 32),
      affiliateName: clamp(affiliateName, 160),
      countryId,
      active: input.active === undefined ? true : bool(input.active),
    },
  };
}

// ---- business units --------------------------------------------------------

export interface BusinessUnitInput {
  businessUnitCode: string;
  businessUnitName: string;
  description: string | null;
  active: boolean;
}

export function validateBusinessUnit(raw: unknown): Validated<BusinessUnitInput> {
  const input = body(raw);
  const errors: FieldError[] = [];

  const businessUnitCode = str(input.businessUnitCode).toUpperCase();
  const businessUnitName = str(input.businessUnitName);

  if (businessUnitCode.length < 2) {
    errors.push({
      field: 'businessUnitCode',
      message: 'Enter the business unit code, for example RET.',
    });
  }
  if (businessUnitName.length < 2) {
    errors.push({ field: 'businessUnitName', message: 'Enter the business unit name.' });
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      businessUnitCode: clamp(businessUnitCode, 32),
      businessUnitName: clamp(businessUnitName, 120),
      description: optional(input.description),
      active: input.active === undefined ? true : bool(input.active),
    },
  };
}

// ---- departments -----------------------------------------------------------

export interface DepartmentInput {
  departmentName: string;
  description: string | null;
  active: boolean;
}

export function validateDepartment(raw: unknown): Validated<DepartmentInput> {
  const input = body(raw);
  const departmentName = str(input.departmentName);
  if (departmentName.length < 2) {
    return {
      ok: false,
      errors: [{ field: 'departmentName', message: 'Enter the department name.' }],
    };
  }
  return {
    ok: true,
    value: {
      departmentName: clamp(departmentName, 120),
      description: optional(input.description),
      active: input.active === undefined ? true : bool(input.active),
    },
  };
}

// ---- teams -----------------------------------------------------------------

export interface TeamInput {
  teamName: string;
  teamType: TeamType;
  /** Null is a Group-wide team, which the seeded `Group Finance` demonstrates. */
  affiliateId: string | null;
  businessUnitId: string | null;
  /** Null is a team with no manager, which the phase requires to be creatable. */
  managerUserId: string | null;
  active: boolean;
}

export function validateTeam(raw: unknown): Validated<TeamInput> {
  const input = body(raw);
  const errors: FieldError[] = [];

  const teamName = str(input.teamName);
  const teamType = str(input.teamType).toUpperCase();

  if (teamName.length < 2) {
    errors.push({ field: 'teamName', message: 'Enter the team name.' });
  }
  if (!TEAM_TYPES.includes(teamType as TeamType)) {
    errors.push({ field: 'teamType', message: 'Choose a team type.' });
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      teamName: clamp(teamName, 120),
      teamType: teamType as TeamType,
      // All three are genuinely optional in the schema, all three are nullable
      // here, and none of them is defaulted to something convenient. A team
      // with no affiliate is a Group team, not a team missing its affiliate.
      affiliateId: optional(input.affiliateId),
      businessUnitId: optional(input.businessUnitId),
      managerUserId: optional(input.managerUserId),
      active: input.active === undefined ? true : bool(input.active),
    },
  };
}

// ---- team members ----------------------------------------------------------

/** `YYYY-MM-DD`, the form every date column in this schema stores. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface TeamMemberInput {
  userId: string;
  memberRole: string | null;
  effectiveFrom: string;
}

export function validateTeamMember(raw: unknown, today: string): Validated<TeamMemberInput> {
  const input = body(raw);
  const errors: FieldError[] = [];

  const userId = str(input.userId);
  // Defaulting to today rather than demanding the date, because "add this
  // person to this team" almost always means "from now", and a required field
  // whose answer is nearly always the same is a field that gets filled in
  // wrongly.
  const effectiveFrom = str(input.effectiveFrom) === '' ? today : str(input.effectiveFrom);

  if (userId === '') {
    errors.push({ field: 'userId', message: 'Choose the person to add.' });
  }
  if (!ISO_DATE.test(effectiveFrom)) {
    errors.push({ field: 'effectiveFrom', message: 'Enter a date as YYYY-MM-DD.' });
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    // `member_role` is free text in the schema with no lookup table, so it is
    // not validated against a list here. Inventing one would be a schema
    // decision made in application code.
    value: { userId, memberRole: optional(input.memberRole), effectiveFrom },
  };
}

export interface TeamMemberEndInput {
  effectiveTo: string;
}

export function validateTeamMemberEnd(raw: unknown, today: string): Validated<TeamMemberEndInput> {
  const input = body(raw);
  const effectiveTo = str(input.effectiveTo) === '' ? today : str(input.effectiveTo);
  if (!ISO_DATE.test(effectiveTo)) {
    return {
      ok: false,
      errors: [{ field: 'effectiveTo', message: 'Enter a date as YYYY-MM-DD.' }],
    };
  }
  return { ok: true, value: { effectiveTo } };
}

/** Today in the `YYYY-MM-DD` form the date columns store. */
export function isoDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}
