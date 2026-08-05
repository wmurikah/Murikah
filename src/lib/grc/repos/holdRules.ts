/**
 * Legal hold coverage, pure and import-free so node strips types and unit-tests
 * this directly.
 *
 * The live `legal_holds` table carries no entity columns of its own: what a hold
 * covers lives in `entity_filter`. This build's convention (documented in
 * grc/docs/schema-assumptions.md) is a JSON object:
 *
 *   {"entity_type": "work_paper", "entity_id": "WP-1"}   one entity
 *   {"entity_type": "work_paper"}                        everything of a type
 *   {}                                                    everything
 *
 * A filter that cannot be parsed is treated as covering everything: a hold is a
 * legal instruction, and failing open on a malformed row would quietly defeat
 * it, so the check fails closed and the operator sees deletions blocked rather
 * than evidence gone.
 */

/** Whether one hold's filter covers the entity. */
export function holdCovers(
  filterRaw: string | null,
  entityType: string,
  entityId: string,
): boolean {
  if (filterRaw == null || filterRaw.trim() === '') return true;
  let parsed: unknown;
  try {
    parsed = JSON.parse(filterRaw);
  } catch {
    return true;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return true;
  const filter = parsed as Record<string, unknown>;
  const type = typeof filter.entity_type === 'string' ? filter.entity_type : null;
  const id = typeof filter.entity_id === 'string' ? filter.entity_id : null;
  if (type != null && type !== entityType) return false;
  if (id != null && id !== entityId) return false;
  return true;
}

/** The filter JSON for a hold over one entity, the write-side of the convention. */
export function holdFilterFor(entityType: string, entityId: string): string {
  return JSON.stringify({ entity_type: entityType, entity_id: entityId });
}
