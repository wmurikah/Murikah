/**
 * Input validation for SLA configuration.
 *
 * Durations arrive as typed text ("30 minutes", "2 hours", "1 business
 * day") and stay text through validation: the repository converts them
 * against the rule's own calendar, because a business day is that calendar's
 * working window and this module does not know it.
 */
import type { FieldError } from '../../validation.ts';
import type { ProfileInput, RuleInput, SlaMonitorQuery } from '../repos/slaAdmin.ts';

export type Validated<T> = { ok: true; value: T } | { ok: false; errors: FieldError[] };

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const clamp = (v: string, max: number): string => (v.length > max ? v.slice(0, max) : v);
const optional = (v: unknown): string | null => (str(v) === '' ? null : str(v));
const bool = (v: unknown): boolean =>
  v === true || v === 1 || v === '1' || v === 'true' || v === 'on';
const body = (raw: unknown): Record<string, unknown> =>
  typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function validateProfile(raw: unknown): Validated<ProfileInput> {
  const input = body(raw);
  const errors: FieldError[] = [];
  const profileName = str(input.profileName);
  const slaType = str(input.slaType);
  const precedenceLevel = Number(str(input.precedenceLevel) || 'NaN');
  const effectiveFrom = str(input.effectiveFrom);

  if (profileName.length < 2) errors.push({ field: 'profileName', message: 'Name the profile.' });
  if (!['INTERNAL', 'EXTERNAL'].includes(slaType)) {
    errors.push({ field: 'slaType', message: 'Internal or external.' });
  }
  if (!Number.isInteger(precedenceLevel) || precedenceLevel < 1 || precedenceLevel > 100) {
    errors.push({
      field: 'precedenceLevel',
      message: 'Precedence is a whole number from 1 to 100.',
    });
  }
  if (!ISO_DATE.test(effectiveFrom)) {
    errors.push({ field: 'effectiveFrom', message: 'Enter the effective date as YYYY-MM-DD.' });
  }
  const effectiveTo = optional(input.effectiveTo);
  if (effectiveTo !== null && !ISO_DATE.test(effectiveTo)) {
    errors.push({
      field: 'effectiveTo',
      message: 'Enter the end date as YYYY-MM-DD, or leave it empty.',
    });
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      profileName: clamp(profileName, 120),
      slaType,
      precedenceLevel,
      accountId: optional(input.accountId),
      segment: optional(input.segment),
      affiliateId: optional(input.affiliateId),
      effectiveFrom,
      effectiveTo,
      active: input.active === undefined ? true : bool(input.active),
    },
  };
}

const RULE_ENTITY_TYPES = [
  'LEAD',
  'OPPORTUNITY',
  'CASE',
  'SALES_ORDER',
  'PURCHASE_ORDER',
  'WORKFLOW_STAGE',
];

export function validateRule(raw: unknown): Validated<RuleInput> {
  const input = body(raw);
  const errors: FieldError[] = [];
  const slaProfileId = str(input.slaProfileId);
  const ruleName = str(input.ruleName);
  const entityType = str(input.entityType);
  const target = str(input.target);
  const businessCalendarId = str(input.businessCalendarId);

  if (slaProfileId === '') errors.push({ field: 'slaProfileId', message: 'Choose a profile.' });
  if (ruleName.length < 2) errors.push({ field: 'ruleName', message: 'Name the rule.' });
  if (!RULE_ENTITY_TYPES.includes(entityType)) {
    errors.push({ field: 'entityType', message: 'Choose what the rule measures.' });
  }
  if (target === '') {
    errors.push({
      field: 'target',
      message: 'Enter the target, for example "2 hours" or "1 business day".',
    });
  }
  if (businessCalendarId === '') {
    errors.push({ field: 'businessCalendarId', message: 'Choose a calendar.' });
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      slaProfileId,
      ruleName: clamp(ruleName, 120),
      entityType,
      stageCode: optional(input.stageCode),
      priority: optional(input.priority),
      target,
      warning: optional(input.warning),
      businessCalendarId,
      businessHoursOnly:
        input.businessHoursOnly === undefined ? true : bool(input.businessHoursOnly),
      pauseAllowed: input.pauseAllowed === undefined ? false : bool(input.pauseAllowed),
      escalationAfter: optional(input.escalationAfter),
      active: input.active === undefined ? true : bool(input.active),
    },
  };
}

export function validateHoliday(
  raw: unknown,
): Validated<{ calendarId: string; holidayDate: string; holidayName: string }> {
  const input = body(raw);
  const errors: FieldError[] = [];
  const calendarId = str(input.calendarId);
  const holidayDate = str(input.holidayDate);
  const holidayName = str(input.holidayName);
  if (calendarId === '') errors.push({ field: 'calendarId', message: 'Choose a calendar.' });
  if (!ISO_DATE.test(holidayDate)) {
    errors.push({ field: 'holidayDate', message: 'Enter the date as YYYY-MM-DD.' });
  }
  if (holidayName.length < 2) errors.push({ field: 'holidayName', message: 'Name the holiday.' });
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { calendarId, holidayDate, holidayName: clamp(holidayName, 120) } };
}

export function readMonitorQuery(params: URLSearchParams): SlaMonitorQuery {
  const page = Number(params.get('page') ?? '1');
  const bucket = params.get('bucket');
  const pick = (key: string): string | null => {
    const value = params.get(key);
    return value === null || value === '' ? null : value;
  };
  return {
    slaType: pick('slaType'),
    entityType: pick('entityType'),
    status: pick('status'),
    bucket:
      bucket === 'at-risk' || bucket === 'breached' || bucket === 'active' || bucket === 'completed'
        ? bucket
        : null,
    page: Number.isFinite(page) && page >= 1 ? Math.trunc(page) : 1,
  };
}
