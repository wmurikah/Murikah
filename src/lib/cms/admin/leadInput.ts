/**
 * Input validation for lead management.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * There is no `leadNumber` and no `status`. The number is allocated server-side
 * by ../crm/numbering.ts and a payload cannot choose one; the status moves only
 * through the named transitions in ../repos/leadAdmin.ts, so a caller cannot
 * post their way from NEW to CONVERTED and skip the opportunity.
 *
 * BANT SCORES ARE CHECKED HERE AND AGAIN BY THE DATABASE.
 * `lead_qualifications` carries `CHECK(x BETWEEN 0 AND 5)` on all four columns.
 * The check below is not a substitute for it: it exists so a 6 comes back as a
 * field message on the right input rather than as a constraint failure with
 * nothing to attach it to.
 */
import type { FieldError } from '../../validation.ts';
import type {
  ConvertInput,
  LeadInput,
  LeadQuery,
  LeadSourceInput,
  QualificationInput,
} from '../repos/leadAdmin.ts';

export type Validated<T> = { ok: true; value: T } | { ok: false; errors: FieldError[] };

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const clamp = (v: string, max: number): string => (v.length > max ? v.slice(0, max) : v);
const optional = (v: unknown): string | null => (str(v) === '' ? null : str(v));
const bool = (v: unknown): boolean =>
  v === true || v === 1 || v === '1' || v === 'true' || v === 'on';
const body = (raw: unknown): Record<string, unknown> =>
  typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_STAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/;

function number(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const raw = str(v);
  if (raw === '') return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * What each BANT dimension measures, in the words the screen shows.
 *
 * Four numbers out of five with no explanation is not a qualification screen;
 * it is a form somebody fills in from habit. Exported so the drawer, the detail
 * panel and any later report describe a score the same way.
 */
export const BANT_MEANING: readonly {
  key: 'budgetScore' | 'authorityScore' | 'needScore' | 'timelineScore';
  label: string;
  question: string;
  low: string;
  high: string;
}[] = [
  {
    key: 'budgetScore',
    label: 'Budget',
    question: 'Can they fund this, and is the money identified?',
    low: '0: no budget discussion has happened.',
    high: '5: budget is confirmed and allocated.',
  },
  {
    key: 'authorityScore',
    label: 'Authority',
    question: 'Are we talking to somebody who can decide?',
    low: '0: no decision maker identified.',
    high: '5: the decision maker is engaged directly.',
  },
  {
    key: 'needScore',
    label: 'Need',
    question: 'Is there a real operational need we can meet?',
    low: '0: no articulated need.',
    high: '5: an urgent need we are well placed to serve.',
  },
  {
    key: 'timelineScore',
    label: 'Timeline',
    question: 'Is there a date by which they must act?',
    low: '0: no timeline at all.',
    high: '5: a committed date inside the current quarter.',
  },
];

export function validateLead(raw: unknown, today: string): Validated<LeadInput> {
  const input = body(raw);
  const errors: FieldError[] = [];

  const leadSourceId = str(input.leadSourceId);
  const ownerUserId = str(input.ownerUserId);
  const title = str(input.title);
  const capturedAt = str(input.capturedAt) === '' ? `${today} 00:00:00` : str(input.capturedAt);

  if (leadSourceId === '') {
    // NOT NULL with ON DELETE RESTRICT. Where a lead came from is the one thing
    // about it that cannot be reconstructed later.
    errors.push({ field: 'leadSourceId', message: 'Choose where this lead came from.' });
  }
  if (ownerUserId === '') {
    errors.push({ field: 'ownerUserId', message: 'Choose an owner.' });
  }
  if (title.length < 2) {
    errors.push({ field: 'title', message: 'Enter a short title for the lead.' });
  }
  if (!ISO_STAMP.test(capturedAt) && !ISO_DATE.test(capturedAt)) {
    errors.push({ field: 'capturedAt', message: 'Enter a date and time.' });
  }

  const estimatedVolume = number(input.estimatedVolume);
  const estimatedValue = number(input.estimatedValue);
  if (estimatedVolume !== null && estimatedVolume < 0) {
    errors.push({ field: 'estimatedVolume', message: 'Volume cannot be negative.' });
  }
  if (estimatedValue !== null && estimatedValue < 0) {
    errors.push({ field: 'estimatedValue', message: 'Value cannot be negative.' });
  }

  const currencyCode = optional(input.currencyCode);
  if (currencyCode !== null && !/^[A-Za-z]{3}$/.test(currencyCode)) {
    errors.push({ field: 'currencyCode', message: 'Use a three-letter code, or leave it empty.' });
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      accountId: optional(input.accountId),
      primaryContactId: optional(input.primaryContactId),
      leadSourceId,
      campaignId: optional(input.campaignId),
      businessUnitId: optional(input.businessUnitId),
      ownerUserId,
      title: clamp(title, 200),
      description: optional(input.description),
      // Free text, on purpose. See the note on LeadInput.productInterest.
      productInterest: optional(input.productInterest),
      estimatedVolume,
      estimatedValue,
      currencyCode: currencyCode === null ? null : currencyCode.toUpperCase(),
      capturedAt: ISO_DATE.test(capturedAt) ? `${capturedAt} 00:00:00` : capturedAt,
    },
  };
}

export function validateQualification(raw: unknown): Validated<QualificationInput> {
  const input = body(raw);
  const errors: FieldError[] = [];
  const scores: Record<string, number> = {};

  for (const dimension of BANT_MEANING) {
    const value = number(input[dimension.key]);
    if (value === null || !Number.isInteger(value) || value < 0 || value > 5) {
      errors.push({
        field: dimension.key,
        message: `Score ${dimension.label.toLowerCase()} from 0 to 5.`,
      });
      continue;
    }
    scores[dimension.key] = value;
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      budgetScore: scores.budgetScore ?? 0,
      authorityScore: scores.authorityScore ?? 0,
      needScore: scores.needScore ?? 0,
      timelineScore: scores.timelineScore ?? 0,
      qualificationNotes: optional(input.qualificationNotes),
    },
  };
}

export interface DisqualifyInput {
  reason: string;
}

/**
 * A disqualification needs a reason, and the reason is free text.
 *
 * No configurable reason table exists for leads, unlike `lost_reasons` for
 * opportunities. Hard-coding a list here would invent a taxonomy the business
 * has not agreed, and every lead disqualified under it would have to be
 * recoded when the real list arrives. Suggestions belong in the interface.
 */
export function validateDisqualify(raw: unknown): Validated<DisqualifyInput> {
  const reason = str(body(raw).reason);
  if (reason.length < 3) {
    return {
      ok: false,
      errors: [{ field: 'reason', message: 'Say why this lead is being disqualified.' }],
    };
  }
  return { ok: true, value: { reason: clamp(reason, 500) } };
}

export function validateConvert(raw: unknown): Validated<ConvertInput> {
  const input = body(raw);
  const errors: FieldError[] = [];

  const pipelineId = str(input.pipelineId);
  if (pipelineId === '') errors.push({ field: 'pipelineId', message: 'Choose a pipeline.' });

  const estimatedCloseDate = optional(input.estimatedCloseDate);
  if (estimatedCloseDate !== null && !ISO_DATE.test(estimatedCloseDate)) {
    errors.push({ field: 'estimatedCloseDate', message: 'Enter a date as YYYY-MM-DD.' });
  }

  const estimatedValue = number(input.estimatedValue);
  if (estimatedValue !== null && estimatedValue < 0) {
    errors.push({ field: 'estimatedValue', message: 'Value cannot be negative.' });
  }

  const currencyCode = optional(input.currencyCode);
  if (currencyCode !== null && !/^[A-Za-z]{3}$/.test(currencyCode)) {
    errors.push({ field: 'currencyCode', message: 'Use a three-letter code, or leave it empty.' });
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      pipelineId,
      initialStageId: optional(input.initialStageId),
      ownerUserId: optional(input.ownerUserId),
      title: optional(input.title),
      estimatedValue,
      currencyCode: currencyCode === null ? null : currencyCode.toUpperCase(),
      estimatedCloseDate,
    },
  };
}

export function validateLeadSource(raw: unknown): Validated<LeadSourceInput> {
  const input = body(raw);
  const sourceName = str(input.sourceName);
  if (sourceName.length < 2) {
    return { ok: false, errors: [{ field: 'sourceName', message: 'Enter the source name.' }] };
  }
  return {
    ok: true,
    value: {
      sourceName: clamp(sourceName, 120),
      description: optional(input.description),
      active: input.active === undefined ? true : bool(input.active),
    },
  };
}

export function readLeadQuery(params: URLSearchParams): LeadQuery {
  const page = Number(params.get('page') ?? '1');
  const contact = params.get('firstContact');
  const pick = (key: string): string | null => {
    const value = params.get(key);
    return value === null || value === '' ? null : value;
  };
  return {
    search: params.get('q') ?? '',
    status: pick('status'),
    leadSourceId: pick('source'),
    ownerUserId: pick('owner'),
    businessUnitId: pick('unit'),
    campaignId: pick('campaign'),
    capturedFrom: pick('from'),
    capturedTo: pick('to'),
    firstContact: contact === 'pending' || contact === 'done' ? contact : 'all',
    page: Number.isFinite(page) && page >= 1 ? Math.trunc(page) : 1,
  };
}
