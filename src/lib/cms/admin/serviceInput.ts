/**
 * Input validation for customer service.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * No `caseNumber` (allocated server-side), no `firstResponseAt`, no
 * `resolvedAt`, no `closedAt` (all set by the transitions that own them), and
 * no free status write: the transition table in the repository is the only
 * road between statuses.
 */
import type { FieldError } from '../../validation.ts';
import {
  CASE_TYPES,
  CASE_PRIORITIES,
  CASE_CHANNELS,
  CASE_STATUSES,
  COMMUNICATION_CHANNELS,
  type CaseInput,
  type CaseQuery,
  type CaseStatus,
  type StatusChangeInput,
  type CommunicationInput,
  type CaseCategoryInput,
} from '../repos/serviceAdmin.ts';

export type Validated<T> = { ok: true; value: T } | { ok: false; errors: FieldError[] };

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const clamp = (v: string, max: number): string => (v.length > max ? v.slice(0, max) : v);
const optional = (v: unknown): string | null => (str(v) === '' ? null : str(v));
const bool = (v: unknown): boolean =>
  v === true || v === 1 || v === '1' || v === 'true' || v === 'on';
const body = (raw: unknown): Record<string, unknown> =>
  typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
const STAMP = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/;

function stamp(v: unknown, field: string, errors: FieldError[]): string | null {
  const value = optional(v);
  if (value === null) return null;
  if (!STAMP.test(value)) {
    errors.push({ field, message: 'Enter a date, or a date and time.' });
    return null;
  }
  return value.length === 10 ? `${value} 00:00:00` : value.replace('T', ' ');
}

export function validateCase(raw: unknown, today: string): Validated<CaseInput> {
  const input = body(raw);
  const errors: FieldError[] = [];

  const accountId = str(input.accountId);
  const caseType = str(input.caseType);
  const caseCategoryId = str(input.caseCategoryId);
  const subject = str(input.subject);
  const description = str(input.description);
  const channel = str(input.channel);
  const priority = optional(input.priority);

  if (accountId === '') errors.push({ field: 'accountId', message: 'Choose the customer.' });
  if (!(CASE_TYPES as readonly string[]).includes(caseType)) {
    errors.push({ field: 'caseType', message: 'Choose the case type.' });
  }
  if (caseCategoryId === '')
    errors.push({ field: 'caseCategoryId', message: 'Choose a category.' });
  if (priority !== null && !(CASE_PRIORITIES as readonly string[]).includes(priority)) {
    errors.push({ field: 'priority', message: 'That is not a priority.' });
  }
  if (subject.length < 3) errors.push({ field: 'subject', message: 'Give the case a subject.' });
  if (description.length < 3) {
    errors.push({ field: 'description', message: 'Describe what the customer reported.' });
  }
  if (!(CASE_CHANNELS as readonly string[]).includes(channel)) {
    errors.push({ field: 'channel', message: 'Choose how it arrived.' });
  }
  const raisedAt = stamp(input.raisedAt, 'raisedAt', errors) ?? `${today} 00:00:00`;

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      accountId,
      contactId: optional(input.contactId),
      businessUnitId: optional(input.businessUnitId),
      caseType,
      caseCategoryId,
      priority,
      subject: clamp(subject, 200),
      description: clamp(description, 4000),
      channel,
      raisedAt,
      assignedTeamId: optional(input.assignedTeamId),
      assignedUserId: optional(input.assignedUserId),
    },
  };
}

export function validateStatusChange(raw: unknown): Validated<StatusChangeInput> {
  const input = body(raw);
  const toStatus = str(input.toStatus);
  if (!(CASE_STATUSES as readonly string[]).includes(toStatus)) {
    return {
      ok: false,
      errors: [{ field: 'toStatus', message: 'That is not a case status.' }],
    };
  }
  return {
    ok: true,
    value: {
      toStatus: toStatus as CaseStatus,
      reason: optional(input.reason),
      resolutionSummary: optional(input.resolutionSummary),
      rootCause: optional(input.rootCause),
    },
  };
}

export function validateAssignment(
  raw: unknown,
): Validated<{ teamId: string | null; userId: string | null; reason: string | null }> {
  const input = body(raw);
  return {
    ok: true,
    value: {
      teamId: optional(input.teamId),
      userId: optional(input.userId),
      reason: optional(input.reason),
    },
  };
}

export function validateCommunication(raw: unknown): Validated<CommunicationInput> {
  const input = body(raw);
  const errors: FieldError[] = [];
  const direction = str(input.direction);
  const channel = str(input.channel);
  const messageSummary = str(input.messageSummary);
  if (!['INBOUND', 'OUTBOUND', 'INTERNAL'].includes(direction)) {
    errors.push({ field: 'direction', message: 'Inbound, outbound or internal.' });
  }
  if (!(COMMUNICATION_CHANNELS as readonly string[]).includes(channel)) {
    errors.push({
      field: 'channel',
      message:
        'That is not a communication channel. Note that this list differs from the case channel list.',
    });
  }
  if (messageSummary.length < 2) {
    errors.push({ field: 'messageSummary', message: 'Summarise the communication.' });
  }
  const communicatedAt = stamp(input.communicatedAt, 'communicatedAt', errors);
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      direction,
      channel,
      contactId: optional(input.contactId),
      subject: optional(input.subject),
      messageSummary: clamp(messageSummary, 2000),
      communicatedAt,
    },
  };
}

export function validateCaseCategory(raw: unknown): Validated<CaseCategoryInput> {
  const input = body(raw);
  const errors: FieldError[] = [];
  const categoryName = str(input.categoryName);
  const subcategoryName = str(input.subcategoryName);
  const defaultPriority = str(input.defaultPriority);
  if (categoryName.length < 2)
    errors.push({ field: 'categoryName', message: 'Enter the category.' });
  if (subcategoryName.length < 2) {
    errors.push({
      field: 'subcategoryName',
      message: 'Enter the subcategory. Two levels, exactly.',
    });
  }
  if (!(CASE_PRIORITIES as readonly string[]).includes(defaultPriority)) {
    errors.push({ field: 'defaultPriority', message: 'Choose the default priority.' });
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      categoryName: clamp(categoryName, 120),
      subcategoryName: clamp(subcategoryName, 120),
      defaultPriority,
      active: input.active === undefined ? true : bool(input.active),
    },
  };
}

export function readCaseQuery(params: URLSearchParams): CaseQuery {
  const page = Number(params.get('page') ?? '1');
  const pick = (key: string): string | null => {
    const value = params.get(key);
    return value === null || value === '' ? null : value;
  };
  return {
    search: params.get('q') ?? '',
    caseType: pick('type'),
    caseCategoryId: pick('category'),
    priority: pick('priority'),
    status: pick('status'),
    assignedTeamId: pick('team'),
    assignedUserId: pick('user'),
    businessUnitId: pick('unit'),
    accountId: pick('account'),
    channel: pick('channel'),
    raisedFrom: pick('from'),
    raisedTo: pick('to'),
    queue: pick('queue'),
    page: Number.isFinite(page) && page >= 1 ? Math.trunc(page) : 1,
  };
}
