/**
 * The rules the product catalogue holds that the schema does not.
 *
 * `product_groups`, `product_categories` and `products` are permissive tables.
 * They carry no depth limit, no cycle prevention, no requirement that a child
 * sit in its parent's group and no notion of an ancestor's status reaching a
 * descendant. Every one of those is a rule this product enforces, so every one
 * of them is stated here, once, rather than being discovered from four
 * different call sites that disagree.
 */

/**
 * How deep a category tree may go beneath a group.
 *
 * The schema permits any depth: `parent_category_id` is a nullable self
 * reference with nothing bounding the chain. That makes an unbounded tree a
 * rendering problem rather than a data problem, so the interface bounds it.
 *
 * Three, counted from the category directly under a group. The create-product
 * flow walks group, then category, then subcategory, which is two, and the
 * third is one level of headroom for a catalogue that grows a grade beneath a
 * grade. Deeper than that and a cascading selector stops being usable and a
 * tree stops being readable, which is the failure this limit exists to prevent
 * rather than any limit in the database.
 *
 * A category at depth 3 can hold products; it simply cannot hold a child.
 */
export const MAX_CATEGORY_DEPTH = 3;

/**
 * DEACTIVATING A PARENT MAKES ITS WHOLE SUBTREE UNSELECTABLE, AND CHANGES
 * NOTHING ABOUT THE CHILDREN'S OWN STATUS.
 *
 * Selectable for a new record means: this row is active, and every ancestor of
 * it is active. So retiring the LPG group takes its categories and its products
 * out of every new selection, immediately, with one write.
 *
 * The two alternatives were both worse. Cascading `active = 0` down the tree
 * destroys the children's own state, so reactivating the group afterwards
 * cannot restore what was there before, and a category somebody had
 * deliberately retired comes back. Leaving the children selectable under an
 * inactive parent means a product still available in a group that has been
 * retired, which is the bug the deactivation was meant to fix.
 *
 * The administration screens say exactly this, and say how many categories and
 * products a deactivation will reach before it is applied, so the effect is
 * never a surprise. Nothing is hidden from an administrator: the tree still
 * shows the whole subtree, marked as unavailable and with the reason.
 *
 * Historical records are untouched. `ON DELETE RESTRICT` on both parent links
 * means a group with categories and a category with products cannot be
 * removed, and there is no delete verb anywhere in this phase.
 */
export const INACTIVE_ANCESTOR_MAKES_UNSELECTABLE = true;

/**
 * The `WITH RECURSIVE` fragment that computes effective availability.
 *
 * Written once and reused by every read that has to answer "may this be chosen
 * for a new record?", because a second copy of an ancestor walk is a second
 * chance to get the direction wrong, and getting it wrong silently offers a
 * retired product.
 *
 * It yields one row per category with `depth` and `available`, where available
 * means the category and every ancestor of it and its group are all active.
 * Depth starts at 1 for a category sitting directly under a group.
 */
export const CATEGORY_TREE_CTE = `
  WITH RECURSIVE category_tree AS (
    SELECT c.product_category_id, c.product_group_id, c.parent_category_id,
           1 AS depth,
           CASE WHEN c.active = 1 AND g.active = 1 THEN 1 ELSE 0 END AS available
    FROM product_categories c
    JOIN product_groups g ON g.product_group_id = c.product_group_id
    WHERE c.parent_category_id IS NULL
    UNION ALL
    SELECT c.product_category_id, c.product_group_id, c.parent_category_id,
           t.depth + 1,
           CASE WHEN c.active = 1 AND t.available = 1 THEN 1 ELSE 0 END
    FROM product_categories c
    JOIN category_tree t ON t.product_category_id = c.parent_category_id
  )`;

/**
 * Units of measure already in use, offered as suggestions and never as a limit.
 *
 * `products.unit_of_measure` is NOT NULL TEXT with no CHECK, so the database
 * accepts anything. The category's `default_uom` exists to pre-fill the field,
 * not to replace it: a product cannot be saved without a unit, and a catalogue
 * that assumed litres would be wrong the first time somebody added a drum of
 * lubricant sold by the unit.
 *
 * The list the screen offers is read from the categories and products that
 * exist, so it grows with the catalogue rather than being maintained here.
 */
export const UOM_HINT =
  'Pre-filled from the category default where there is one, and always editable. Every product needs a unit.';

/** The audit event types this phase writes. Named once. */
export const CATALOGUE_AUDIT = {
  groupCreated: 'PRODUCT_GROUP_CREATED',
  groupUpdated: 'PRODUCT_GROUP_UPDATED',
  categoryCreated: 'PRODUCT_CATEGORY_CREATED',
  categoryUpdated: 'PRODUCT_CATEGORY_UPDATED',
  productCreated: 'PRODUCT_CREATED',
  productUpdated: 'PRODUCT_UPDATED',
  /**
   * A deactivation is called out separately from an update.
   *
   * It is the change that takes something out of every new transaction, and
   * neither `product_groups` nor `product_categories` carries a timestamp of
   * any kind, so an audit row is the only record that it ever happened. Finding
   * it in a list of ordinary updates is exactly the search somebody makes after
   * a product disappears from a form.
   */
  productDeactivated: 'PRODUCT_DEACTIVATED',
} as const;
