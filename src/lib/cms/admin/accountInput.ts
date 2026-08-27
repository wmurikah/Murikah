/**
 * Input validation for accounts and contacts.
 *
 * The same `FieldError` shape and `Validated<T>` union as every other form.
 *
 * WHAT IS DECIDED HERE, AND WHAT IS NOT
 * Anything decidable from the payload alone: a name is present, a type is one
 * of the three the CHECK permits, a credit figure is not negative, a date looks
 * like a date. Anything needing the database is decided in
 * ../repos/accountAdmin.ts, where the row it depends on can be read: whether
 * the affiliate sits in the chosen country, whether a code is taken.
 *
 * THE PROSPECT RULE
 * An Oracle customer code is never required. A prospect has no Oracle master
 * record yet, and a form that demanded one would force somebody to invent a
 * code to record a company they have not yet sold to. That is how a customer
 * master fills with placeholder codes nobody can reconcile.
 */
import type { FieldError } from '../../validation.ts';
import type { AccountInput, AccountQuery, ContactInput } from '../repos/accountAdmin.ts';

export type Validated<T> = { ok: true; value: T } | { ok: false; errors: FieldError[] };

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const clamp = (v: string, max: number): string => (v.length > max ? v.slice(0, max) : v);
const optional = (v: unknown): string | null => (str(v) === '' ? null : str(v));
const bool = (v: unknown): boolean =>
  v === true || v === 1 || v === '1' || v === 'true' || v === 'on';
const body = (raw: unknown): Record<string, unknown> =>
  typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** `accounts.account_type` CHECK. */
export const ACCOUNT_TYPES = ['PROSPECT', 'CUSTOMER', 'FORMER_CUSTOMER'] as const;
/** `accounts.status` CHECK. */
export const ACCOUNT_STATUSES = ['ACTIVE', 'INACTIVE', 'BLOCKED'] as const;
/** `contacts.preferred_channel` CHECK. */
export const CONTACT_CHANNELS = ['EMAIL', 'PHONE', 'WHATSAPP', 'SMS', 'OTHER'] as const;

/**
 * What each account status means, in the words the screen uses.
 *
 * Written here so the list, the detail panel and the confirmation all say the
 * same thing. `BLOCKED` in particular: it is an account status, and credit is a
 * separate concept carried by `credit_limit` and `credit_days`. Letting
 * `BLOCKED` drift into meaning "credit blocked" would make a commercial
 * decision and an administrative one indistinguishable in the data.
 */
export const STATUS_MEANING: Readonly<Record<string, string>> = {
  ACTIVE: 'Trading normally. Appears in every selector.',
  INACTIVE: 'Dormant. Kept for history and not offered for new records.',
  BLOCKED:
    'Administratively blocked from new business. This is an account status, not a credit decision: credit terms are the credit limit and credit days fields.',
};

/**
 * A number, or null. An empty string is null, never zero.
 *
 * On a credit limit that distinction is the whole meaning: null is "no limit
 * recorded" and zero is "this customer may take no credit at all". Section 0d
 * in one function.
 */
function number(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const raw = str(v);
  if (raw === '') return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

const oneOf = <T extends string>(list: readonly T[], value: string): T | null =>
  (list as readonly string[]).includes(value) ? (value as T) : null;

export function validateAccount(raw: unknown): Validated<AccountInput> {
  const input = body(raw);
  const errors: FieldError[] = [];

  const accountName = str(input.accountName);
  const accountType = oneOf(ACCOUNT_TYPES, str(input.accountType).toUpperCase());
  const countryId = str(input.countryId);
  const status = oneOf(ACCOUNT_STATUSES, str(input.status).toUpperCase() || 'ACTIVE');

  // The three required fields, and only three. Everything else is optional
  // because a real prospect is often a name, a country and a phone number.
  if (accountName.length < 2) {
    errors.push({ field: 'accountName', message: 'Enter the account name.' });
  }
  if (accountType === null) {
    errors.push({ field: 'accountType', message: 'Choose prospect, customer or former customer.' });
  }
  if (countryId === '') {
    errors.push({ field: 'countryId', message: 'Choose the country.' });
  }
  if (status === null) {
    errors.push({ field: 'status', message: 'Choose a status.' });
  }

  const email = optional(input.email);
  if (email !== null && !email.includes('@')) {
    errors.push({ field: 'email', message: 'Enter a valid email address, or leave it empty.' });
  }

  const creditLimit = number(input.creditLimit);
  const creditDays = number(input.creditDays);
  if (creditLimit !== null && creditLimit < 0) {
    errors.push({ field: 'creditLimit', message: 'A credit limit cannot be negative.' });
  }
  if (creditDays !== null && (creditDays < 0 || !Number.isInteger(creditDays))) {
    errors.push({ field: 'creditDays', message: 'Enter a whole number of days, 0 or more.' });
  }

  const customerSince = optional(input.customerSince);
  if (customerSince !== null && !ISO_DATE.test(customerSince)) {
    errors.push({ field: 'customerSince', message: 'Enter a date as YYYY-MM-DD.' });
  }

  if (errors.length > 0 || accountType === null || status === null) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      accountName: clamp(accountName, 200),
      accountType,
      // Never required, for either type. The UNIQUE constraint is what stops a
      // real collision; demanding one up front only produces invented codes.
      accountCode: optional(input.accountCode),
      oracleCustomerCode: optional(input.oracleCustomerCode),
      industry: optional(input.industry),
      segment: optional(input.segment),
      countryId,
      affiliateId: optional(input.affiliateId),
      address: optional(input.address),
      phone: optional(input.phone),
      email,
      website: optional(input.website),
      taxPin: optional(input.taxPin),
      creditLimit,
      creditDays,
      accountManagerUserId: optional(input.accountManagerUserId),
      customerSince,
      status,
    },
  };
}

export function validateContact(raw: unknown): Validated<ContactInput> {
  const input = body(raw);
  const errors: FieldError[] = [];

  const fullName = str(input.fullName);
  if (fullName.length < 2) {
    errors.push({ field: 'fullName', message: 'Enter the contact name.' });
  }

  const email = optional(input.email);
  if (email !== null && !email.includes('@')) {
    errors.push({ field: 'email', message: 'Enter a valid email address, or leave it empty.' });
  }

  const rawChannel = str(input.preferredChannel).toUpperCase();
  const preferredChannel = rawChannel === '' ? null : oneOf(CONTACT_CHANNELS, rawChannel);
  if (rawChannel !== '' && preferredChannel === null) {
    errors.push({ field: 'preferredChannel', message: 'Choose a channel, or leave it empty.' });
  }

  // A channel the contact has no address for is a promise the interface cannot
  // keep: a "preferred: WhatsApp" card with no WhatsApp number renders a button
  // that does nothing.
  const phone = optional(input.phone);
  const whatsapp = optional(input.whatsapp);
  if (preferredChannel === 'EMAIL' && email === null) {
    errors.push({
      field: 'email',
      message: 'Email is the preferred channel, so an address is needed.',
    });
  }
  if ((preferredChannel === 'PHONE' || preferredChannel === 'SMS') && phone === null) {
    errors.push({ field: 'phone', message: 'That preferred channel needs a phone number.' });
  }
  if (preferredChannel === 'WHATSAPP' && whatsapp === null && phone === null) {
    errors.push({
      field: 'whatsapp',
      message: 'WhatsApp is the preferred channel, so a number is needed.',
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      fullName: clamp(fullName, 200),
      jobTitle: optional(input.jobTitle),
      email,
      phone,
      whatsapp,
      preferredChannel,
      isPrimary: bool(input.isPrimary),
      active: input.active === undefined ? true : bool(input.active),
    },
  };
}

/** The account list's filters, read from the query string. */
export function readAccountQuery(params: URLSearchParams): AccountQuery {
  const page = Number(params.get('page') ?? '1');
  const sortRaw = params.get('sort');
  const pick = (key: string): string | null => {
    const value = params.get(key);
    return value === null || value === '' ? null : value;
  };
  return {
    search: params.get('q') ?? '',
    accountType: pick('type'),
    status: pick('status'),
    countryId: pick('country'),
    affiliateId: pick('affiliate'),
    segment: pick('segment'),
    accountManagerUserId: pick('manager'),
    page: Number.isFinite(page) && page >= 1 ? Math.trunc(page) : 1,
    sort: sortRaw === 'created' || sortRaw === 'updated' ? sortRaw : 'name',
  };
}

export interface DuplicateCheckInput {
  accountName: string;
  oracleCustomerCode: string | null;
  taxPin: string | null;
  email: string | null;
  phone: string | null;
}

export function validateDuplicateCheck(raw: unknown): Validated<DuplicateCheckInput> {
  const input = body(raw);
  const accountName = str(input.accountName);
  if (accountName.length < 2) {
    return { ok: false, errors: [{ field: 'accountName', message: 'Enter the account name.' }] };
  }
  return {
    ok: true,
    value: {
      accountName,
      oracleCustomerCode: optional(input.oracleCustomerCode),
      taxPin: optional(input.taxPin),
      email: optional(input.email),
      phone: optional(input.phone),
    },
  };
}
