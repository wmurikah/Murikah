/**
 * Input validation for opportunities, pipelines and lost reasons.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * No `opportunityNumber`, no `status` and no `probability` as a raw fraction.
 * The number is allocated server-side; the status moves only through
 * `moveStage`, so a caller cannot post their way to WON without a won stage,
 * a close date and an amount; and probability crosses this boundary as a
 * whole percent, converted once by ../crm/probability.ts. A payload carrying
 * `0.8` is refused rather than stored as under one percent.
 */
import type { FieldError } from '../../validation.ts';
import type {
  OpportunityInput,
  OpportunityPatch,
  OpportunityQuery,
  StageMoveInput,
  ProductLineInput,
  PipelineInput,
  StageInput,
  LostReasonInput,
} from '../repos/opportunityAdmin.ts';
import { percentToFraction, isValidPercent } from '../crm/probability.ts';

export type Validated<T> = { ok: true; value: T } | { ok: false; errors: FieldError[] };

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const clamp = (v: string, max: number): string => (v.length > max ? v.slice(0, max) : v);
const optional = (v: unknown): string | null => (str(v) === '' ? null : str(v));
const bool = (v: unknown): boolean =>
  v === true || v === 1 || v === '1' || v === 'true' || v === 'on';
const body = (raw: unknown): Record<string, unknown> =>
  typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function number(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const raw = str(v);
  if (raw === '') return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * A probability from a form: a whole percent, or empty for "take the stage
 * default". Returns the stored fraction, or an error pushed onto `errors`.
 */
function readProbability(v: unknown, errors: FieldError[]): number | null {
  const percent = number(v);
  if (percent === null) return null;
  if (!isValidPercent(percent)) {
    errors.push({
      field: 'probabilityPercent',
      message: 'Enter a probability as a whole percentage from 0 to 100.',
    });
    return null;
  }
  return percentToFraction(percent);
}

function requireDate(v: unknown, field: string, errors: FieldError[]): string | null {
  const value = optional(v);
  if (value !== null && !ISO_DATE.test(value)) {
    errors.push({ field, message: 'Enter a date as YYYY-MM-DD.' });
    return null;
  }
  return value;
}

const CURRENCY = /^[A-Za-z]{3}$/;

export function validateOpportunity(raw: unknown): Validated<OpportunityInput> {
  const input = body(raw);
  const errors: FieldError[] = [];

  const accountId = str(input.accountId);
  const pipelineId = str(input.pipelineId);
  const ownerUserId = str(input.ownerUserId);
  const title = str(input.title);
  const estimatedValue = number(input.estimatedValue);
  const currencyCode = str(input.currencyCode);

  if (accountId === '') errors.push({ field: 'accountId', message: 'Choose an account.' });
  if (pipelineId === '') errors.push({ field: 'pipelineId', message: 'Choose a pipeline.' });
  if (ownerUserId === '') errors.push({ field: 'ownerUserId', message: 'Choose an owner.' });
  if (title.length < 2) errors.push({ field: 'title', message: 'Enter a short title.' });
  if (estimatedValue === null || estimatedValue < 0) {
    errors.push({
      field: 'estimatedValue',
      message: 'Enter the estimated value. The schema requires one on an opportunity.',
    });
  }
  if (!CURRENCY.test(currencyCode)) {
    errors.push({ field: 'currencyCode', message: 'Use a three-letter currency code.' });
  }
  const probability = readProbability(input.probabilityPercent, errors);
  const estimatedCloseDate = requireDate(input.estimatedCloseDate, 'estimatedCloseDate', errors);

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      accountId,
      businessUnitId: optional(input.businessUnitId),
      pipelineId,
      initialStageId: optional(input.initialStageId),
      ownerUserId,
      title: clamp(title, 200),
      estimatedValue: estimatedValue ?? 0,
      currencyCode: currencyCode.toUpperCase(),
      probability,
      estimatedCloseDate,
    },
  };
}

export function validateOpportunityPatch(raw: unknown): Validated<OpportunityPatch> {
  const input = body(raw);
  const errors: FieldError[] = [];

  const title = str(input.title);
  const ownerUserId = str(input.ownerUserId);
  const estimatedValue = number(input.estimatedValue);
  const currencyCode = str(input.currencyCode);

  if (title.length < 2) errors.push({ field: 'title', message: 'Enter a short title.' });
  if (ownerUserId === '') errors.push({ field: 'ownerUserId', message: 'Choose an owner.' });
  if (estimatedValue === null || estimatedValue < 0) {
    errors.push({ field: 'estimatedValue', message: 'Enter the estimated value.' });
  }
  if (!CURRENCY.test(currencyCode)) {
    errors.push({ field: 'currencyCode', message: 'Use a three-letter currency code.' });
  }
  const estimatedCloseDate = requireDate(input.estimatedCloseDate, 'estimatedCloseDate', errors);

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      title: clamp(title, 200),
      businessUnitId: optional(input.businessUnitId),
      ownerUserId,
      estimatedValue: estimatedValue ?? 0,
      currencyCode: currencyCode.toUpperCase(),
      estimatedCloseDate,
    },
  };
}

export function validateStageMove(raw: unknown): Validated<StageMoveInput> {
  const input = body(raw);
  const errors: FieldError[] = [];

  const expectedStageId = str(input.expectedStageId);
  const toStageId = str(input.toStageId);
  if (expectedStageId === '') {
    errors.push({
      field: 'expectedStageId',
      message: 'State the stage you believe the opportunity is in, so a stale move is refused.',
    });
  }
  if (toStageId === '')
    errors.push({ field: 'toStageId', message: 'Choose the destination stage.' });

  const probability = readProbability(input.probabilityPercent, errors);
  const wonAmount = number(input.wonAmount);
  if (wonAmount !== null && wonAmount < 0) {
    errors.push({ field: 'wonAmount', message: 'The won amount cannot be negative.' });
  }
  const actualCloseDate = requireDate(input.actualCloseDate, 'actualCloseDate', errors);

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      expectedStageId,
      toStageId,
      probability,
      reason: optional(input.reason),
      wonAmount,
      actualCloseDate,
      lostReasonId: optional(input.lostReasonId),
      lostNotes: optional(input.lostNotes),
      markAccountCustomer: bool(input.markAccountCustomer),
    },
  };
}

export function validateProductLine(raw: unknown): Validated<ProductLineInput> {
  const input = body(raw);
  const errors: FieldError[] = [];

  const productId = str(input.productId);
  const expectedQuantity = number(input.expectedQuantity);
  if (productId === '') {
    errors.push({ field: 'productId', message: 'Choose a product from the catalogue.' });
  }
  if (expectedQuantity === null || expectedQuantity < 0) {
    errors.push({ field: 'expectedQuantity', message: 'Enter the expected quantity.' });
  }
  const unitPrice = number(input.unitPrice);
  if (unitPrice !== null && unitPrice < 0) {
    errors.push({ field: 'unitPrice', message: 'The unit price cannot be negative.' });
  }
  const estimatedLineValue = number(input.estimatedLineValue);
  if (estimatedLineValue !== null && estimatedLineValue < 0) {
    errors.push({ field: 'estimatedLineValue', message: 'The line value cannot be negative.' });
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      productId,
      expectedQuantity: expectedQuantity ?? 0,
      unitPrice,
      estimatedLineValue,
    },
  };
}

export function validatePipeline(raw: unknown): Validated<PipelineInput> {
  const input = body(raw);
  const errors: FieldError[] = [];
  const pipelineName = str(input.pipelineName);
  if (pipelineName.length < 2) {
    errors.push({ field: 'pipelineName', message: 'Enter a pipeline name.' });
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      pipelineName: clamp(pipelineName, 120),
      countryId: optional(input.countryId),
      affiliateId: optional(input.affiliateId),
      active: input.active === undefined ? true : bool(input.active),
    },
  };
}

export function validateStage(raw: unknown): Validated<StageInput> {
  const input = body(raw);
  const errors: FieldError[] = [];

  const stageName = str(input.stageName);
  if (stageName.length < 2) errors.push({ field: 'stageName', message: 'Enter a stage name.' });

  // The default probability is required on a stage: the column is NOT NULL
  // and the stage default is what a move applies when nobody overrides.
  const percent = number(input.defaultProbabilityPercent);
  let defaultProbability = 0;
  if (percent === null || !isValidPercent(percent)) {
    errors.push({
      field: 'defaultProbabilityPercent',
      message: 'Enter the default probability as a whole percentage from 0 to 100.',
    });
  } else {
    defaultProbability = percentToFraction(percent);
  }

  const targetDays = number(input.targetDays);
  if (targetDays !== null && (targetDays < 0 || !Number.isInteger(targetDays))) {
    errors.push({ field: 'targetDays', message: 'Target days is a whole number of days.' });
  }

  const isWonStage = bool(input.isWonStage);
  const isLostStage = bool(input.isLostStage);
  if (isWonStage && isLostStage) {
    errors.push({
      field: 'isLostStage',
      message: 'A stage cannot be both won and lost.',
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      stageName: clamp(stageName, 120),
      defaultProbability,
      targetDays,
      isWonStage,
      isLostStage,
      active: input.active === undefined ? true : bool(input.active),
    },
  };
}

export function validateStageOrder(raw: unknown): Validated<string[]> {
  const input = body(raw);
  const list = Array.isArray(input.orderedStageIds) ? input.orderedStageIds : null;
  if (list === null || list.length === 0 || list.some((v) => typeof v !== 'string' || v === '')) {
    return {
      ok: false,
      errors: [
        { field: 'orderedStageIds', message: 'Send the full stage order as a list of ids.' },
      ],
    };
  }
  return { ok: true, value: list as string[] };
}

export function validateLostReason(raw: unknown): Validated<LostReasonInput> {
  const input = body(raw);
  const errors: FieldError[] = [];
  const reasonName = str(input.reasonName);
  const category = str(input.category);
  if (reasonName.length < 2) errors.push({ field: 'reasonName', message: 'Enter the reason.' });
  if (category.length < 2) {
    errors.push({
      field: 'category',
      message: 'Enter a category, for example Commercial or Customer.',
    });
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      reasonName: clamp(reasonName, 120),
      category: clamp(category, 60),
      description: optional(input.description),
      active: input.active === undefined ? true : bool(input.active),
    },
  };
}

export function readOpportunityQuery(params: URLSearchParams): OpportunityQuery {
  const page = Number(params.get('page') ?? '1');
  const pick = (key: string): string | null => {
    const value = params.get(key);
    return value === null || value === '' ? null : value;
  };
  return {
    search: params.get('q') ?? '',
    status: pick('status'),
    pipelineId: pick('pipeline'),
    stageId: pick('stage'),
    ownerUserId: pick('owner'),
    businessUnitId: pick('unit'),
    accountId: pick('account'),
    currencyCode: pick('currency'),
    closeFrom: pick('closeFrom'),
    closeTo: pick('closeTo'),
    page: Number.isFinite(page) && page >= 1 ? Math.trunc(page) : 1,
  };
}
