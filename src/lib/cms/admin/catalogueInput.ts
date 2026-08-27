/**
 * Input validation for the product catalogue.
 *
 * The same `FieldError` shape and `Validated<T>` union as every other form in
 * this product.
 *
 * WHAT IS CHECKED HERE, AND WHAT IS CHECKED IN THE REPOSITORY
 * Anything decidable from the payload alone is decided here: a code is present,
 * a name is present, a sort order is a non-negative whole number, a product
 * carries a unit of measure. Anything that needs the database is decided in
 * ../repos/catalogueAdmin.ts, where the row it depends on can actually be read:
 * a category's parent chain, whether a code is taken, whether a child's group
 * matches its parent's.
 *
 * The split matters because the second kind cannot be done correctly here.
 * A validator that checked uniqueness by reading a row would still race the
 * insert, and the database's own constraint is the only check that cannot.
 */
import type { FieldError } from '../../validation.ts';
import type {
  CategoryInput,
  GroupInput,
  ProductInput,
  ProductQuery,
} from '../repos/catalogueAdmin.ts';

export type Validated<T> = { ok: true; value: T } | { ok: false; errors: FieldError[] };

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const clamp = (v: string, max: number): string => (v.length > max ? v.slice(0, max) : v);
const optional = (v: unknown): string | null => (str(v) === '' ? null : str(v));
const bool = (v: unknown): boolean =>
  v === true || v === 1 || v === '1' || v === 'true' || v === 'on';
const body = (raw: unknown): Record<string, unknown> =>
  typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};

function sortOrder(v: unknown): number {
  if (v === undefined || v === null || str(v) === '') return 100;
  const parsed = Number(typeof v === 'number' ? v : str(v));
  return Number.isFinite(parsed) ? Math.trunc(parsed) : Number.NaN;
}

/**
 * A code, normalised the way the seeded codes are written.
 *
 * Upper case, spaces to underscores. Not because the database insists, it does
 * not, but because a catalogue holding `AGO`, `ago` and `A G O` as three
 * distinct codes is a catalogue nobody can search, and the uniqueness
 * constraint would not object to any of them.
 */
const code = (v: unknown): string => str(v).toUpperCase().replace(/\s+/g, '_');

export function validateGroup(raw: unknown): Validated<GroupInput> {
  const input = body(raw);
  const errors: FieldError[] = [];

  const groupCode = code(input.groupCode);
  const groupName = str(input.groupName);
  const order = sortOrder(input.sortOrder);

  if (groupCode.length < 2) {
    errors.push({ field: 'groupCode', message: 'Enter the group code.' });
  }
  if (groupName.length < 2) {
    errors.push({ field: 'groupName', message: 'Enter the group name.' });
  }
  if (!Number.isFinite(order) || order < 0) {
    errors.push({ field: 'sortOrder', message: 'Enter a whole number of 0 or more.' });
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      groupCode: clamp(groupCode, 60),
      groupName: clamp(groupName, 160),
      description: optional(input.description),
      sortOrder: order,
      active: input.active === undefined ? true : bool(input.active),
    },
  };
}

export function validateCategory(raw: unknown): Validated<CategoryInput> {
  const input = body(raw);
  const errors: FieldError[] = [];

  const productGroupId = str(input.productGroupId);
  const categoryCode = code(input.categoryCode);
  const categoryName = str(input.categoryName);
  const order = sortOrder(input.sortOrder);

  if (productGroupId === '') {
    errors.push({ field: 'productGroupId', message: 'Choose the product group.' });
  }
  if (categoryCode.length < 2) {
    errors.push({ field: 'categoryCode', message: 'Enter the category code.' });
  }
  if (categoryName.length < 2) {
    errors.push({ field: 'categoryName', message: 'Enter the category name.' });
  }
  if (!Number.isFinite(order) || order < 0) {
    errors.push({ field: 'sortOrder', message: 'Enter a whole number of 0 or more.' });
  }

  // `category_name` carries no uniqueness constraint, and none is added here.
  // Two groups may both hold a category named Diesel; the code is the
  // identifier, and inventing a rule the database does not have would refuse a
  // catalogue the operator is entitled to build.

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      productGroupId,
      parentCategoryId: optional(input.parentCategoryId),
      categoryCode: clamp(categoryCode, 60),
      categoryName: clamp(categoryName, 160),
      defaultUom: optional(input.defaultUom),
      description: optional(input.description),
      sortOrder: order,
      active: input.active === undefined ? true : bool(input.active),
    },
  };
}

export function validateProduct(raw: unknown): Validated<ProductInput> {
  const input = body(raw);
  const errors: FieldError[] = [];

  const productCode = code(input.productCode);
  const productName = str(input.productName);
  const productCategoryId = str(input.productCategoryId);
  const unitOfMeasure = str(input.unitOfMeasure).toUpperCase();

  if (productCode.length < 2) {
    errors.push({ field: 'productCode', message: 'Enter the product code.' });
  }
  if (productName.length < 2) {
    errors.push({ field: 'productName', message: 'Enter the product name.' });
  }
  if (productCategoryId === '') {
    // A product attaches to a category, never to a group. The group is reached
    // through the category and its parent chain.
    errors.push({ field: 'productCategoryId', message: 'Choose the category.' });
  }
  if (unitOfMeasure === '') {
    // NOT NULL in the schema, and not defaulted to litres here. A drum of
    // lubricant is sold by the unit, and a catalogue that guessed would be
    // wrong the first time somebody added one.
    errors.push({
      field: 'unitOfMeasure',
      message: 'Enter the unit this product is measured in, such as LITRE, KG or UNIT.',
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      productCode: clamp(productCode, 60),
      productName: clamp(productName, 160),
      productCategoryId,
      unitOfMeasure: clamp(unitOfMeasure, 30),
      active: input.active === undefined ? true : bool(input.active),
    },
  };
}

/** The product list's filters, read from the query string. */
export function readProductQuery(params: URLSearchParams): ProductQuery {
  const availability = params.get('availability');
  const page = Number(params.get('page') ?? '1');
  return {
    search: params.get('q') ?? '',
    availability:
      availability === 'available' || availability === 'unavailable' ? availability : 'all',
    groupId:
      params.get('group') === null || params.get('group') === '' ? null : params.get('group'),
    categoryId:
      params.get('category') === null || params.get('category') === ''
        ? null
        : params.get('category'),
    page: Number.isFinite(page) && page >= 1 ? Math.trunc(page) : 1,
  };
}
