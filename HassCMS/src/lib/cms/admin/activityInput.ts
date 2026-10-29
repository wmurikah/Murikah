/**
 * Input validation for the shared activity engine.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * No `accountId`: the server derives it from the parent entity, so a payload
 * cannot attach a call to a customer it merely names. No new activity types:
 * the CHECK constraint would refuse them, and so does this file, with a field
 * message rather than a constraint failure.
 */
import type { FieldError } from '../../validation.ts';
import {
  ACTIVITY_TYPES,
  type ActivityInput,
  type ActivityPatch,
  type ActivityQuery,
  type ActivityType,
} from '../repos/activityAdmin.ts';
import { ACTIVITY_ENTITY_TYPES } from '../crm/entityAccess.ts';

export type Validated<T> = { ok: true; value: T } | { ok: false; errors: FieldError[] };

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const clamp = (v: string, max: number): string => (v.length > max ? v.slice(0, max) : v);
const optional = (v: unknown): string | null => (str(v) === '' ? null : str(v));
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
  // A bare date means the whole day; midnight anchors it deterministically.
  return value.length === 10 ? `${value} 00:00:00` : value.replace('T', ' ');
}

export function validateActivity(raw: unknown): Validated<ActivityInput> {
  const input = body(raw);
  const errors: FieldError[] = [];

  const entityType = str(input.entityType);
  const entityId = str(input.entityId);
  const activityType = str(input.activityType);
  const ownerUserId = str(input.ownerUserId);
  const summary = str(input.summary);

  if (!(ACTIVITY_ENTITY_TYPES as readonly string[]).includes(entityType)) {
    errors.push({ field: 'entityType', message: 'That is not a supported record type.' });
  }
  if (entityId === '') errors.push({ field: 'entityId', message: 'Name the record.' });
  if (!(ACTIVITY_TYPES as readonly string[]).includes(activityType)) {
    errors.push({
      field: 'activityType',
      message: 'That is not one of the eleven activity types. No new types can be added here.',
    });
  }
  if (ownerUserId === '') errors.push({ field: 'ownerUserId', message: 'Choose an owner.' });
  if (summary.length < 2) errors.push({ field: 'summary', message: 'Say what happened, briefly.' });

  const scheduledAt = stamp(input.scheduledAt, 'scheduledAt', errors);
  const completedAt = stamp(input.completedAt, 'completedAt', errors);
  const nextActionDue = stamp(input.nextActionDue, 'nextActionDue', errors);

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      entityType,
      entityId,
      activityType: activityType as ActivityType,
      contactId: optional(input.contactId),
      ownerUserId,
      summary: clamp(summary, 300),
      notes: optional(input.notes),
      scheduledAt,
      completedAt,
      outcome: optional(input.outcome),
      nextAction: optional(input.nextAction),
      nextActionDue,
    },
  };
}

export function validateActivityPatch(raw: unknown): Validated<ActivityPatch> {
  const input = body(raw);
  const errors: FieldError[] = [];
  const summary = str(input.summary);
  if (summary.length < 2) errors.push({ field: 'summary', message: 'Say what happened, briefly.' });
  const scheduledAt = stamp(input.scheduledAt, 'scheduledAt', errors);
  const nextActionDue = stamp(input.nextActionDue, 'nextActionDue', errors);
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      summary: clamp(summary, 300),
      notes: optional(input.notes),
      outcome: optional(input.outcome),
      nextAction: optional(input.nextAction),
      nextActionDue,
      scheduledAt,
    },
  };
}

export function readActivityQuery(params: URLSearchParams): ActivityQuery {
  const page = Number(params.get('page') ?? '1');
  const state = params.get('state');
  const pick = (key: string): string | null => {
    const value = params.get(key);
    return value === null || value === '' ? null : value;
  };
  return {
    activityType: pick('type'),
    ownerUserId: pick('owner'),
    state: state === 'open' || state === 'completed' ? state : 'all',
    from: pick('from'),
    to: pick('to'),
    search: params.get('q') ?? '',
    page: Number.isFinite(page) && page >= 1 ? Math.trunc(page) : 1,
  };
}
