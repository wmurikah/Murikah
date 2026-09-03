/**
 * The three product groups of the purchase order chart, mapped from the
 * extract's NATURE column — THE ONE PLACE THIS MAPPING EXISTS.
 *
 *   PRODUCT → Fuel        Fuel covers AGO, PMS and Jet Fuel: the business
 *                          treats ground and aviation fuels as one, so Fuel
 *                          is the merged view.
 *   LUBES   → Lubricants
 *   LPG     → LPG
 *
 * DELIBERATELY NOT `product_groups`. That table holds five rows and separates
 * ground fuels from aviation fuels; the chart's question is asked at the
 * grain the business answers it, which is three. The five-row table keeps its
 * own uses; this mapping never reads it and never writes it.
 *
 * A NATURE value outside the three — or an order the landing rows cannot
 * name — falls to UNGROUPED rather than being silently folded into a group
 * it was never claimed to belong to. On the current extract every row carries
 * one of the three, so the label should never render; if it does, it is a
 * fact about new data worth seeing, not an error.
 */

export const NATURE_GROUPS: Readonly<Record<string, string>> = {
  PRODUCT: 'Fuel',
  LUBES: 'Lubricants',
  LPG: 'LPG',
};

export const PRODUCT_GROUP_LABELS: readonly string[] = [...new Set(Object.values(NATURE_GROUPS))];

export const UNGROUPED = 'Ungrouped';

/**
 * The mapping as a SQL CASE over a nature expression, BUILT from the object
 * above so query and code cannot drift. Keys and labels are compiled in from
 * this module's own literals — nothing user-supplied ever reaches the SQL.
 */
export function natureGroupSql(natureExpression: string): string {
  const arms = Object.entries(NATURE_GROUPS)
    .map(([nature, group]) => `WHEN '${nature}' THEN '${group}'`)
    .join(' ');
  return `CASE ${natureExpression} ${arms} ELSE '${UNGROUPED}' END`;
}
