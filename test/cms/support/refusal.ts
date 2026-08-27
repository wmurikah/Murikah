/**
 * Reading the field messages off a refusal, without lying to the type checker.
 *
 * Every repository in this product refuses a write as a discriminated union:
 * `not_found` carries no field messages, and `invalid`, `invalid_reference` and
 * `conflict` each carry an array of them. A test that writes
 * `if (!result.ok) result.fields[0]` is asking for a property that one arm of
 * that union does not have, which is a type error, and the tempting fixes are
 * both bad: a cast hides the day a refusal really does come back `not_found`,
 * and narrowing with `kind !== 'not_found'` silently skips every assertion in
 * the block when it does.
 *
 * So this asserts the thing the test actually means. "This write was refused
 * with a message about a field" is a claim, it can be false, and when it is
 * false the test should say so rather than pass quietly.
 */
import assert from 'node:assert/strict';

export interface RefusalField {
  field: string;
  message: string;
}

export function refusalFields(refusal: {
  readonly kind: string;
  readonly fields?: readonly RefusalField[];
}): readonly RefusalField[] {
  assert.notEqual(
    refusal.kind,
    'not_found',
    'Expected a refusal carrying field messages, but the record was not found at all.',
  );
  const fields = refusal.fields ?? [];
  assert.equal(fields.length > 0, true, `A ${refusal.kind} refusal carried no field message.`);
  return fields;
}
