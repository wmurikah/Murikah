/**
 * Input validation for user administration.
 *
 * Written in the style of src/lib/validation.ts and returning its `FieldError`
 * shape, so every form in this product reports a bad field the same way.
 *
 * Two rules here exist because the database will otherwise answer with a
 * constraint error a person cannot act on:
 *
 *   users has `CHECK(status != 'ACTIVE' OR email_verified_at IS NOT NULL)`, so
 *   ACTIVE is not an initial status and is not offered.
 *
 *   user_assignments has a CHECK that forces the location column matching the
 *   level and forces all three NULL for GROUP, so the level decides which
 *   columns are sent and the excluded ones are sent as NULL, never as ''.
 */
import type { FieldError } from '../../validation.ts';

export const USER_TYPES = ['INTERNAL', 'EXTERNAL'] as const;
export const USER_STATUSES = ['INVITED', 'ACTIVE', 'SUSPENDED', 'INACTIVE'] as const;
export const ASSIGNMENT_LEVELS = ['GROUP', 'COUNTRY', 'AFFILIATE', 'BUSINESS_UNIT'] as const;

export type UserType = (typeof USER_TYPES)[number];
export type UserStatus = (typeof USER_STATUSES)[number];
export type AssignmentLevel = (typeof ASSIGNMENT_LEVELS)[number];

/**
 * The statuses a create form may offer.
 *
 * ACTIVE is absent, and not as a matter of taste: the table CHECK refuses an
 * ACTIVE user whose `email_verified_at` is null, and a brand new user has not
 * verified anything. Offering it would produce a constraint error on save.
 */
export const CREATABLE_STATUSES = ['INVITED'] as const;

export type Validated<T> = { ok: true; value: T } | { ok: false; errors: FieldError[] };

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const clamp = (v: string, max: number): string => (v.length > max ? v.slice(0, max) : v);
const optional = (v: unknown): string | null => (str(v) === '' ? null : str(v));
const bool = (v: unknown): boolean =>
  v === true || v === 1 || v === '1' || v === 'true' || v === 'on';
const body = (raw: unknown): Record<string, unknown> =>
  typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};

/** Permissive, like src/lib/validation.ts. The database CHECK is instr(email,'@') > 1. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// ---- users -----------------------------------------------------------------

export interface CreateUserInput {
  userType: UserType;
  firstName: string;
  lastName: string;
  displayName: string;
  email: string;
  employeeNo: string | null;
  phone: string | null;
  timezone: string;
  locale: string;
}

export function validateCreateUser(raw: unknown): Validated<CreateUserInput> {
  const input = body(raw);
  const errors: FieldError[] = [];

  const firstName = str(input.firstName);
  const lastName = str(input.lastName);
  // Lower-cased on the way in. `users.email` is COLLATE NOCASE UNIQUE, so
  // storing one case consistently keeps the stored value and the comparison
  // agreeing, and keeps a recorded audit value comparable.
  const email = str(input.email).toLowerCase();
  const userType = str(input.userType).toUpperCase() || 'INTERNAL';

  if (firstName.length < 1) errors.push({ field: 'firstName', message: 'Enter a first name.' });
  if (lastName.length < 1) errors.push({ field: 'lastName', message: 'Enter a last name.' });
  if (!EMAIL_RE.test(email)) {
    errors.push({ field: 'email', message: 'Enter a valid email address.' });
  }
  if (!USER_TYPES.includes(userType as UserType)) {
    errors.push({ field: 'userType', message: 'Choose a user type.' });
  }
  // A status sent by a caller is refused rather than ignored. Silently
  // downgrading ACTIVE to INVITED would let an administrator believe they had
  // activated somebody.
  const status = str(input.status).toUpperCase();
  if (status !== '' && status !== 'INVITED') {
    errors.push({
      field: 'status',
      message: 'A new user always starts as invited. They become active by verifying their email.',
    });
  }

  if (errors.length > 0) return { ok: false, errors };

  const displayName = str(input.displayName) || `${firstName} ${lastName}`;
  return {
    ok: true,
    value: {
      userType: userType as UserType,
      firstName: clamp(firstName, 80),
      lastName: clamp(lastName, 80),
      displayName: clamp(displayName, 160),
      email: clamp(email, 200),
      employeeNo: optional(input.employeeNo),
      phone: optional(input.phone),
      timezone: str(input.timezone) || 'Africa/Nairobi',
      locale: str(input.locale) || 'en-KE',
    },
  };
}

export interface UpdateUserInput {
  firstName: string;
  lastName: string;
  displayName: string;
  email: string;
  employeeNo: string | null;
  phone: string | null;
  timezone: string;
  locale: string;
  status: UserStatus;
}

export function validateUpdateUser(raw: unknown): Validated<UpdateUserInput> {
  const input = body(raw);
  const first = validateCreateUser({ ...input, status: '' });
  const errors: FieldError[] = first.ok ? [] : [...first.errors];

  const status = str(input.status).toUpperCase();
  if (!USER_STATUSES.includes(status as UserStatus)) {
    errors.push({ field: 'status', message: 'Choose a status.' });
  }

  if (errors.length > 0 || !first.ok) {
    return { ok: false, errors: errors.length > 0 ? errors : [] };
  }
  return { ok: true, value: { ...first.value, status: status as UserStatus } };
}

// ---- assignments -----------------------------------------------------------

export interface AssignmentInput {
  jobTitleId: string;
  departmentId: string;
  level: AssignmentLevel;
  countryId: string | null;
  affiliateId: string | null;
  businessUnitId: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  isPrimary: boolean;
  active: boolean;
}

/**
 * The level decides which location columns are sent, and the rest are NULL.
 *
 * Refused here rather than at the database, because a CHECK violation arrives
 * as "CHECK constraint failed: user_assignments", which tells an administrator
 * nothing. A GROUP assignment carrying an affiliate is a mistake with an
 * obvious message, so it gets one.
 */
export function validateAssignment(raw: unknown, today: string): Validated<AssignmentInput> {
  const input = body(raw);
  const errors: FieldError[] = [];

  const jobTitleId = str(input.jobTitleId);
  const departmentId = str(input.departmentId);
  const level = str(input.level || input.assignmentLevel).toUpperCase();
  const countryId = optional(input.countryId);
  const affiliateId = optional(input.affiliateId);
  const businessUnitId = optional(input.businessUnitId);
  const effectiveFrom = str(input.effectiveFrom) === '' ? today : str(input.effectiveFrom);
  const effectiveTo = optional(input.effectiveTo);

  // Both are NOT NULL on the table, so neither is optional on the form.
  if (jobTitleId === '') errors.push({ field: 'jobTitleId', message: 'Choose a job title.' });
  if (departmentId === '') errors.push({ field: 'departmentId', message: 'Choose a department.' });
  if (!ASSIGNMENT_LEVELS.includes(level as AssignmentLevel)) {
    errors.push({ field: 'level', message: 'Choose an assignment level.' });
  }
  if (!ISO_DATE.test(effectiveFrom)) {
    errors.push({ field: 'effectiveFrom', message: 'Enter a date as YYYY-MM-DD.' });
  }
  if (effectiveTo !== null && !ISO_DATE.test(effectiveTo)) {
    errors.push({ field: 'effectiveTo', message: 'Enter a date as YYYY-MM-DD.' });
  }
  if (effectiveTo !== null && ISO_DATE.test(effectiveFrom) && effectiveTo < effectiveFrom) {
    errors.push({ field: 'effectiveTo', message: 'The end date cannot be before the start date.' });
  }

  switch (level) {
    case 'GROUP':
      // The CHECK forces all three NULL, so a value in any of them is refused
      // rather than quietly dropped: an administrator who chose an affiliate
      // and got a Group assignment would not know it had been ignored.
      for (const [field, value] of [
        ['countryId', countryId],
        ['affiliateId', affiliateId],
        ['businessUnitId', businessUnitId],
      ] as const) {
        if (value !== null) {
          errors.push({
            field,
            message: 'A Group assignment covers the whole group and carries no location.',
          });
        }
      }
      break;
    case 'COUNTRY':
      if (countryId === null) errors.push({ field: 'countryId', message: 'Choose a country.' });
      break;
    case 'AFFILIATE':
      if (affiliateId === null) {
        errors.push({ field: 'affiliateId', message: 'Choose an affiliate.' });
      }
      break;
    case 'BUSINESS_UNIT':
      if (businessUnitId === null) {
        errors.push({ field: 'businessUnitId', message: 'Choose a business unit.' });
      }
      break;
  }

  if (errors.length > 0) return { ok: false, errors };

  // Only the columns the level uses survive. The others are NULL, not ''.
  const scoped = {
    countryId: level === 'GROUP' ? null : countryId,
    affiliateId: level === 'GROUP' ? null : affiliateId,
    businessUnitId: level === 'GROUP' ? null : businessUnitId,
  };
  return {
    ok: true,
    value: {
      jobTitleId,
      departmentId,
      level: level as AssignmentLevel,
      ...scoped,
      effectiveFrom,
      effectiveTo,
      isPrimary: input.isPrimary === undefined ? true : bool(input.isPrimary),
      active: input.active === undefined ? true : bool(input.active),
    },
  };
}

// ---- job titles ------------------------------------------------------------

export interface JobTitleInput {
  titleName: string;
  departmentId: string | null;
  description: string | null;
  active: boolean;
}

export function validateJobTitle(raw: unknown): Validated<JobTitleInput> {
  const input = body(raw);
  const titleName = str(input.titleName);
  if (titleName.length < 2) {
    return { ok: false, errors: [{ field: 'titleName', message: 'Enter the job title.' }] };
  }
  return {
    ok: true,
    value: {
      titleName: clamp(titleName, 120),
      // Nullable, ON DELETE SET NULL. A title need not sit in a department.
      departmentId: optional(input.departmentId),
      description: optional(input.description),
      active: input.active === undefined ? true : bool(input.active),
    },
  };
}

// ---- source identities -----------------------------------------------------

export interface SourceIdentityInput {
  sourceSystemId: string;
  userId: string;
  externalUsername: string;
  affiliateId: string | null;
  active: boolean;
}

export function validateSourceIdentity(raw: unknown): Validated<SourceIdentityInput> {
  const input = body(raw);
  const errors: FieldError[] = [];

  const sourceSystemId = str(input.sourceSystemId);
  const userId = str(input.userId);
  const externalUsername = str(input.externalUsername);

  if (sourceSystemId === '') {
    errors.push({ field: 'sourceSystemId', message: 'Choose the source system.' });
  }
  // The form selects an existing user and offers no create path. A mapping
  // must never bring a user into existence.
  if (userId === '') errors.push({ field: 'userId', message: 'Choose the person to map to.' });
  if (externalUsername === '') {
    errors.push({ field: 'externalUsername', message: 'Enter the external username.' });
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      sourceSystemId,
      userId,
      externalUsername: clamp(externalUsername, 160),
      affiliateId: optional(input.affiliateId),
      active: input.active === undefined ? true : bool(input.active),
    },
  };
}

/** Today in the `YYYY-MM-DD` form the date columns store. */
export function isoDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}
