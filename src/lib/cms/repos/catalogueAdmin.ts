/**
 * Reads and writes for the shared product catalogue.
 *
 * ONE PRODUCT MASTER
 * `product_groups`, `product_categories` and `products` are the only product
 * tables in this product, and this is the only module that writes them. Leads,
 * opportunities, quotations, sales orders, purchase orders, SLA analytics,
 * cases and Build Prompt 08's authority rules all read the same ids. There is
 * no per-module product list and there must never be one.
 *
 * IDS ARE STABLE, ALWAYS
 * `approval_authority_rules.product_group_id` and `product_category_id`
 * reference these tables and are both `ON DELETE SET NULL`. So a rename that
 * deleted and reinserted a row would silently strip the product restriction
 * from an authority rule and widen somebody's approval limit, with the audit
 * trail recording only a rename. Every update below is an UPDATE against the
 * existing primary key. Nothing here deletes a row, and there is no DELETE verb
 * anywhere in this phase.
 *
 * EVERY WRITE CARRIES ITS AUDIT ROW IN THE SAME BATCH
 * `product_groups` and `product_categories` have no `created_at` and no
 * `updated_at` at all. A change with no audit row therefore leaves no evidence
 * it ever happened, so the change and its record go out as one
 * `db.batch([...], 'write')`.
 */
import type { Client, InStatement } from '@libsql/client/web';
import type { FieldError } from '../../validation.ts';
import { newId, auditEventStmt } from './authRecords.ts';
import type { WriteContext } from '../admin/guard.ts';
import { CATALOGUE_AUDIT, CATEGORY_TREE_CTE, MAX_CATEGORY_DEPTH } from '../catalogue/model.ts';

type Stmt = Extract<InStatement, { sql: string }>;

export type WriteResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly kind: 'conflict'; readonly fields: FieldError[] }
  | { readonly ok: false; readonly kind: 'invalid_reference'; readonly fields: FieldError[] }
  | { readonly ok: false; readonly kind: 'not_found' };

const text = (v: unknown): string => String(v ?? '');
const nullableText = (v: unknown): string | null =>
  v === null || v === undefined ? null : String(v);
const flag = (v: unknown): boolean => Number(v ?? 0) === 1;
const isUnique = (e: unknown) =>
  /UNIQUE constraint failed/i.test(e instanceof Error ? e.message : String(e));
const isForeignKey = (e: unknown) =>
  /FOREIGN KEY constraint failed/i.test(e instanceof Error ? e.message : String(e));

function audit(
  ctx: WriteContext,
  eventType: string,
  entityType: string,
  entityId: string,
  action: string,
  before: unknown,
  after: unknown,
): Stmt {
  return auditEventStmt({
    actorUserId: ctx.actorUserId,
    eventType,
    entityType,
    entityId,
    action,
    beforeJson: before === null ? null : JSON.stringify(before),
    afterJson: after === null ? null : JSON.stringify(after),
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    now: ctx.now,
  }) as Stmt;
}

// ---- groups ----------------------------------------------------------------

export interface GroupRow {
  productGroupId: string;
  groupCode: string;
  groupName: string;
  description: string | null;
  active: boolean;
  sortOrder: number;
  categoryCount: number;
  productCount: number;
}

const GROUP_SELECT = `
  SELECT g.product_group_id, g.group_code, g.group_name, g.description, g.active, g.sort_order,
         (SELECT COUNT(*) FROM product_categories c
           WHERE c.product_group_id = g.product_group_id) AS category_count,
         (SELECT COUNT(*) FROM products p
           JOIN product_categories c ON c.product_category_id = p.product_category_id
           WHERE c.product_group_id = g.product_group_id) AS product_count
  FROM product_groups g`;

function toGroup(row: Record<string, unknown>): GroupRow {
  return {
    productGroupId: text(row.product_group_id),
    groupCode: text(row.group_code),
    groupName: text(row.group_name),
    description: nullableText(row.description),
    active: flag(row.active),
    sortOrder: Number(row.sort_order ?? 100),
    categoryCount: Number(row.category_count ?? 0),
    productCount: Number(row.product_count ?? 0),
  };
}

export async function listGroups(db: Client): Promise<GroupRow[]> {
  const result = await db.execute(`${GROUP_SELECT} ORDER BY g.sort_order, g.group_name`);
  return result.rows.map((row) => toGroup(row as unknown as Record<string, unknown>));
}

export async function getGroup(db: Client, id: string): Promise<GroupRow | null> {
  const result = await db.execute({
    sql: `${GROUP_SELECT} WHERE g.product_group_id = ? LIMIT 1`,
    args: [id],
  });
  const row = result.rows[0];
  return row === undefined ? null : toGroup(row as unknown as Record<string, unknown>);
}

export interface GroupInput {
  groupCode: string;
  groupName: string;
  description: string | null;
  sortOrder: number;
  active: boolean;
}

export async function createGroup(
  db: Client,
  input: GroupInput,
  ctx: WriteContext,
): Promise<WriteResult<GroupRow>> {
  const id = newId('PG');
  try {
    await db.batch(
      [
        {
          sql: `INSERT INTO product_groups
                  (product_group_id, group_code, group_name, description, active, sort_order)
                VALUES (?, ?, ?, ?, ?, ?)`,
          args: [
            id,
            input.groupCode,
            input.groupName,
            input.description,
            input.active ? 1 : 0,
            input.sortOrder,
          ],
        },
        audit(ctx, CATALOGUE_AUDIT.groupCreated, 'PRODUCT_GROUP', id, 'CREATE', null, input),
      ],
      'write',
    );
  } catch (error) {
    if (isUnique(error)) return { ok: false, kind: 'conflict', fields: [groupConflict(error)] };
    throw error;
  }
  const created = await getGroup(db, id);
  return created === null ? { ok: false, kind: 'not_found' } : { ok: true, value: created };
}

function groupConflict(error: unknown): FieldError {
  const message = error instanceof Error ? error.message : '';
  return /group_code/i.test(message)
    ? { field: 'groupCode', message: 'That group code is already in use.' }
    : { field: 'groupName', message: 'That group name is already in use.' };
}

/**
 * Rename, restyle, reorder or retire a group. Never recreate it.
 *
 * The primary key is not in the SET list and is not in the input. That is the
 * whole of section 9: `approval_authority_rules` points at
 * `product_group_id` with `ON DELETE SET NULL`, so a delete and reinsert would
 * strip the product restriction from every rule that named this group and would
 * widen somebody's approval authority without leaving a trace. An UPDATE cannot
 * do that.
 */
export async function updateGroup(
  db: Client,
  id: string,
  input: GroupInput,
  ctx: WriteContext,
): Promise<WriteResult<GroupRow>> {
  const before = await getGroup(db, id);
  if (before === null) return { ok: false, kind: 'not_found' };
  const deactivating = before.active && !input.active;
  try {
    await db.batch(
      [
        {
          // `group_code` is not updatable. A code is the identifier an operator
          // quotes elsewhere, in an import file or a spreadsheet, and silently
          // repointing it breaks references nothing in this product can see.
          sql: `UPDATE product_groups
                SET group_name = ?, description = ?, active = ?, sort_order = ?
                WHERE product_group_id = ?`,
          args: [input.groupName, input.description, input.active ? 1 : 0, input.sortOrder, id],
        },
        audit(
          ctx,
          deactivating ? CATALOGUE_AUDIT.productDeactivated : CATALOGUE_AUDIT.groupUpdated,
          'PRODUCT_GROUP',
          id,
          deactivating ? 'DEACTIVATE' : 'UPDATE',
          before,
          { ...input, groupCode: before.groupCode },
        ),
      ],
      'write',
    );
  } catch (error) {
    if (isUnique(error)) return { ok: false, kind: 'conflict', fields: [groupConflict(error)] };
    throw error;
  }
  const after = await getGroup(db, id);
  return after === null ? { ok: false, kind: 'not_found' } : { ok: true, value: after };
}

// ---- categories ------------------------------------------------------------

export interface CategoryRow {
  productCategoryId: string;
  productGroupId: string;
  groupName: string;
  groupActive: boolean;
  parentCategoryId: string | null;
  parentCategoryName: string | null;
  categoryCode: string;
  categoryName: string;
  defaultUom: string | null;
  description: string | null;
  active: boolean;
  sortOrder: number;
  /** 1 for a category directly under a group. Bounded by MAX_CATEGORY_DEPTH. */
  depth: number;
  /** Active, and every ancestor active. See ../catalogue/model.ts. */
  available: boolean;
  childCount: number;
  productCount: number;
}

const CATEGORY_SELECT = `
  ${CATEGORY_TREE_CTE}
  SELECT c.product_category_id, c.product_group_id, g.group_name, g.active AS group_active,
         c.parent_category_id, p.category_name AS parent_name, c.category_code,
         c.category_name, c.default_uom, c.description, c.active, c.sort_order,
         t.depth, t.available,
         (SELECT COUNT(*) FROM product_categories k
           WHERE k.parent_category_id = c.product_category_id) AS child_count,
         (SELECT COUNT(*) FROM products pr
           WHERE pr.product_category_id = c.product_category_id) AS product_count
  FROM product_categories c
  JOIN product_groups g ON g.product_group_id = c.product_group_id
  JOIN category_tree t ON t.product_category_id = c.product_category_id
  LEFT JOIN product_categories p ON p.product_category_id = c.parent_category_id`;

function toCategory(row: Record<string, unknown>): CategoryRow {
  return {
    productCategoryId: text(row.product_category_id),
    productGroupId: text(row.product_group_id),
    groupName: text(row.group_name),
    groupActive: flag(row.group_active),
    parentCategoryId: nullableText(row.parent_category_id),
    parentCategoryName: nullableText(row.parent_name),
    categoryCode: text(row.category_code),
    categoryName: text(row.category_name),
    defaultUom: nullableText(row.default_uom),
    description: nullableText(row.description),
    active: flag(row.active),
    sortOrder: Number(row.sort_order ?? 100),
    depth: Number(row.depth ?? 1),
    available: flag(row.available),
    childCount: Number(row.child_count ?? 0),
    productCount: Number(row.product_count ?? 0),
  };
}

export async function listCategories(db: Client): Promise<CategoryRow[]> {
  const result = await db.execute(
    `${CATEGORY_SELECT} ORDER BY g.sort_order, g.group_name, t.depth, c.sort_order, c.category_name`,
  );
  return result.rows.map((row) => toCategory(row as unknown as Record<string, unknown>));
}

export async function getCategory(db: Client, id: string): Promise<CategoryRow | null> {
  const result = await db.execute({
    sql: `${CATEGORY_SELECT} WHERE c.product_category_id = ? LIMIT 1`,
    args: [id],
  });
  const row = result.rows[0];
  return row === undefined ? null : toCategory(row as unknown as Record<string, unknown>);
}

export interface CategoryInput {
  productGroupId: string;
  parentCategoryId: string | null;
  categoryCode: string;
  categoryName: string;
  defaultUom: string | null;
  description: string | null;
  sortOrder: number;
  active: boolean;
}

/**
 * The parent chain of a category, nearest ancestor first.
 *
 * Read as rows rather than computed, because the two rules that need it are
 * about what is actually stored: a child must sit in its parent's group, and a
 * category must not become its own ancestor. Both are checked against the chain
 * as the database holds it at the moment of the write.
 */
export async function parentChain(
  db: Client,
  categoryId: string,
): Promise<{ categoryId: string; groupId: string; code: string }[]> {
  const chain: { categoryId: string; groupId: string; code: string }[] = [];
  let cursor: string | null = categoryId;
  // Bounded by the depth limit plus a margin, so a cycle that somehow reached
  // the table cannot spin this function for ever while it is being diagnosed.
  for (let step = 0; step < MAX_CATEGORY_DEPTH + 5 && cursor !== null; step++) {
    const result = await db.execute({
      sql: `SELECT product_category_id, product_group_id, parent_category_id, category_code
            FROM product_categories WHERE product_category_id = ? LIMIT 1`,
      args: [cursor],
    });
    const row = result.rows[0];
    if (row === undefined) break;
    chain.push({
      categoryId: text(row.product_category_id),
      groupId: text(row.product_group_id),
      code: text(row.category_code),
    });
    cursor = nullableText(row.parent_category_id);
    if (chain.some((entry) => entry.categoryId === cursor)) break;
  }
  return chain;
}

/**
 * The three rules the self-referencing foreign key does not enforce.
 *
 * A category is stored with its own `product_group_id` even when it has a
 * parent, and `parent_category_id` is an ordinary nullable self reference. So
 * the database will happily accept a child in a different group from its
 * parent, a category that is its own parent, and a cycle of any length. All
 * three are wrong, and all three are refused here.
 *
 * `movingId` is the category being edited, absent on a create. It is what makes
 * the cycle check possible: a cycle exists exactly when the proposed parent's
 * ancestor chain already contains the category being moved.
 */
async function checkParent(
  db: Client,
  input: CategoryInput,
  movingId: string | null,
): Promise<FieldError[]> {
  if (input.parentCategoryId === null) return [];

  if (movingId !== null && input.parentCategoryId === movingId) {
    return [
      { field: 'parentCategoryId', message: 'A category cannot be its own parent category.' },
    ];
  }

  const chain = await parentChain(db, input.parentCategoryId);
  const parent = chain[0];
  if (parent === undefined) {
    return [{ field: 'parentCategoryId', message: 'That parent category does not exist.' }];
  }

  if (parent.groupId !== input.productGroupId) {
    return [
      {
        field: 'productGroupId',
        message: 'A subcategory must sit in the same product group as its parent.',
      },
    ];
  }

  // The indirect cycle. Walking the proposed parent's ancestors and finding the
  // category being moved means saving would close the loop.
  if (movingId !== null && chain.some((entry) => entry.categoryId === movingId)) {
    return [
      {
        field: 'parentCategoryId',
        message:
          'That would make the category an ancestor of itself. Choose a parent from outside its own subtree.',
      },
    ];
  }

  if (chain.length >= MAX_CATEGORY_DEPTH) {
    return [
      {
        field: 'parentCategoryId',
        message: `Categories go ${MAX_CATEGORY_DEPTH} levels deep beneath a group. That parent is already at the deepest level.`,
      },
    ];
  }
  return [];
}

function categoryConflict(): FieldError {
  return {
    field: 'categoryCode',
    // The constraint is on the whole table, not on the group, and the message
    // says so: an administrator who has just checked their own group and found
    // the code free cannot otherwise interpret the refusal.
    message:
      'That category code is already used somewhere in the catalogue. Codes are unique across every group, not per group.',
  };
}

export async function createCategory(
  db: Client,
  input: CategoryInput,
  ctx: WriteContext,
): Promise<WriteResult<CategoryRow>> {
  const problems = await checkParent(db, input, null);
  if (problems.length > 0) return { ok: false, kind: 'invalid_reference', fields: problems };

  const id = newId('PC');
  try {
    await db.batch(
      [
        {
          sql: `INSERT INTO product_categories
                  (product_category_id, product_group_id, parent_category_id, category_code,
                   category_name, default_uom, description, active, sort_order)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            id,
            input.productGroupId,
            input.parentCategoryId,
            input.categoryCode,
            input.categoryName,
            input.defaultUom,
            input.description,
            input.active ? 1 : 0,
            input.sortOrder,
          ],
        },
        audit(ctx, CATALOGUE_AUDIT.categoryCreated, 'PRODUCT_CATEGORY', id, 'CREATE', null, input),
      ],
      'write',
    );
  } catch (error) {
    if (isUnique(error)) return { ok: false, kind: 'conflict', fields: [categoryConflict()] };
    if (isForeignKey(error)) {
      return {
        ok: false,
        kind: 'invalid_reference',
        fields: [{ field: 'productGroupId', message: 'That group or parent does not exist.' }],
      };
    }
    throw error;
  }
  const created = await getCategory(db, id);
  return created === null ? { ok: false, kind: 'not_found' } : { ok: true, value: created };
}

export async function updateCategory(
  db: Client,
  id: string,
  input: CategoryInput,
  ctx: WriteContext,
): Promise<WriteResult<CategoryRow>> {
  const before = await getCategory(db, id);
  if (before === null) return { ok: false, kind: 'not_found' };

  const problems = await checkParent(db, input, id);
  if (problems.length > 0) return { ok: false, kind: 'invalid_reference', fields: problems };

  const deactivating = before.active && !input.active;
  try {
    await db.batch(
      [
        {
          // The primary key and the code stay put. See the note on updateGroup:
          // an authority rule referencing this category must still reference it
          // afterwards.
          sql: `UPDATE product_categories
                SET product_group_id = ?, parent_category_id = ?, category_name = ?,
                    default_uom = ?, description = ?, active = ?, sort_order = ?
                WHERE product_category_id = ?`,
          args: [
            input.productGroupId,
            input.parentCategoryId,
            input.categoryName,
            input.defaultUom,
            input.description,
            input.active ? 1 : 0,
            input.sortOrder,
            id,
          ],
        },
        audit(
          ctx,
          deactivating ? CATALOGUE_AUDIT.productDeactivated : CATALOGUE_AUDIT.categoryUpdated,
          'PRODUCT_CATEGORY',
          id,
          deactivating ? 'DEACTIVATE' : 'UPDATE',
          before,
          { ...input, categoryCode: before.categoryCode },
        ),
      ],
      'write',
    );
  } catch (error) {
    if (isUnique(error)) return { ok: false, kind: 'conflict', fields: [categoryConflict()] };
    if (isForeignKey(error)) {
      return {
        ok: false,
        kind: 'invalid_reference',
        fields: [{ field: 'productGroupId', message: 'That group or parent does not exist.' }],
      };
    }
    throw error;
  }
  const after = await getCategory(db, id);
  return after === null ? { ok: false, kind: 'not_found' } : { ok: true, value: after };
}

// ---- products --------------------------------------------------------------

export interface ProductRow {
  productId: string;
  productCode: string;
  productName: string;
  productCategoryId: string;
  categoryName: string;
  categoryCode: string;
  productGroupId: string;
  groupName: string;
  unitOfMeasure: string;
  active: boolean;
  /** Active, and every ancestor category and the group active. */
  available: boolean;
  createdAt: string;
}

const PRODUCT_SELECT = `
  ${CATEGORY_TREE_CTE}
  SELECT p.product_id, p.product_code, p.product_name, p.product_category_id,
         c.category_name, c.category_code, c.product_group_id, g.group_name,
         p.unit_of_measure, p.active, p.created_at,
         CASE WHEN p.active = 1 AND t.available = 1 THEN 1 ELSE 0 END AS available
  FROM products p
  JOIN product_categories c ON c.product_category_id = p.product_category_id
  JOIN product_groups g ON g.product_group_id = c.product_group_id
  JOIN category_tree t ON t.product_category_id = p.product_category_id`;

function toProduct(row: Record<string, unknown>): ProductRow {
  return {
    productId: text(row.product_id),
    productCode: text(row.product_code),
    productName: text(row.product_name),
    productCategoryId: text(row.product_category_id),
    categoryName: text(row.category_name),
    categoryCode: text(row.category_code),
    productGroupId: text(row.product_group_id),
    groupName: text(row.group_name),
    unitOfMeasure: text(row.unit_of_measure),
    active: flag(row.active),
    available: flag(row.available),
    createdAt: text(row.created_at),
  };
}

export const PAGE_SIZE = 25;

export interface ProductQuery {
  /** Matched against product code, product name, category and group. */
  readonly search: string;
  /** `all` includes products that cannot be chosen for a new record. */
  readonly availability: 'all' | 'available' | 'unavailable';
  readonly groupId: string | null;
  readonly categoryId: string | null;
  readonly page: number;
}

export interface ProductPage {
  items: ProductRow[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * Products, filtered and paginated in the database.
 *
 * SEARCH IS CASE-INSENSITIVE BY AN EXPLICIT COLLATION.
 * `product_code`, `product_name`, `category_name` and `group_name` are declared
 * without `COLLATE NOCASE`, unlike `users.email`, so `LIKE` on them is
 * case-sensitive for anything outside ASCII folding and cannot be relied on.
 * Each comparison below therefore carries `COLLATE NOCASE` explicitly, which
 * makes the behaviour a property of the query rather than of a column
 * definition somebody may change.
 *
 * The filtering and the paging happen here and not in the browser. A catalogue
 * that grows to ten thousand products must not be shipped whole to a form so
 * that a select element can filter it.
 */
export async function listProducts(db: Client, input: ProductQuery): Promise<ProductPage> {
  const where: string[] = [];
  const args: unknown[] = [];

  if (input.search.trim() !== '') {
    const needle = `%${input.search.trim()}%`;
    where.push(`(p.product_code LIKE ? COLLATE NOCASE
             OR p.product_name LIKE ? COLLATE NOCASE
             OR c.category_code LIKE ? COLLATE NOCASE
             OR c.category_name LIKE ? COLLATE NOCASE
             OR g.group_code LIKE ? COLLATE NOCASE
             OR g.group_name LIKE ? COLLATE NOCASE)`);
    args.push(needle, needle, needle, needle, needle, needle);
  }
  if (input.groupId !== null) {
    where.push(`c.product_group_id = ?`);
    args.push(input.groupId);
  }
  if (input.categoryId !== null) {
    where.push(`p.product_category_id = ?`);
    args.push(input.categoryId);
  }
  if (input.availability === 'available') {
    where.push(`p.active = 1 AND t.available = 1`);
  } else if (input.availability === 'unavailable') {
    where.push(`(p.active = 0 OR t.available = 0)`);
  }

  const clause = where.length === 0 ? '' : ` WHERE ${where.join(' AND ')}`;
  const page = Math.max(1, input.page);
  const offset = (page - 1) * PAGE_SIZE;

  const rows = await db.execute({
    sql: `${PRODUCT_SELECT}${clause}
          ORDER BY g.sort_order, g.group_name, c.sort_order, c.category_name, p.product_name
          LIMIT ? OFFSET ?`,
    args: [...args, PAGE_SIZE, offset] as never[],
  });
  const counted = await db.execute({
    sql: `${CATEGORY_TREE_CTE}
          SELECT COUNT(*) AS total
          FROM products p
          JOIN product_categories c ON c.product_category_id = p.product_category_id
          JOIN product_groups g ON g.product_group_id = c.product_group_id
          JOIN category_tree t ON t.product_category_id = p.product_category_id${clause}`,
    args: args as never[],
  });

  return {
    items: rows.rows.map((row) => toProduct(row as unknown as Record<string, unknown>)),
    total: Number(counted.rows[0]?.total ?? 0),
    page,
    pageSize: PAGE_SIZE,
  };
}

export async function getProduct(db: Client, id: string): Promise<ProductRow | null> {
  const result = await db.execute({
    sql: `${PRODUCT_SELECT} WHERE p.product_id = ? LIMIT 1`,
    args: [id],
  });
  const row = result.rows[0];
  return row === undefined ? null : toProduct(row as unknown as Record<string, unknown>);
}

export interface ProductInput {
  productCode: string;
  productName: string;
  productCategoryId: string;
  unitOfMeasure: string;
  active: boolean;
}

export async function createProduct(
  db: Client,
  input: ProductInput,
  ctx: WriteContext,
): Promise<WriteResult<ProductRow>> {
  const id = newId('PROD');
  try {
    await db.batch(
      [
        {
          sql: `INSERT INTO products
                  (product_id, product_code, product_name, product_category_id,
                   unit_of_measure, active, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)`,
          args: [
            id,
            input.productCode,
            input.productName,
            input.productCategoryId,
            input.unitOfMeasure,
            input.active ? 1 : 0,
            ctx.now.toISOString().slice(0, 19).replace('T', ' '),
          ],
        },
        audit(ctx, CATALOGUE_AUDIT.productCreated, 'PRODUCT', id, 'CREATE', null, input),
      ],
      'write',
    );
  } catch (error) {
    if (isUnique(error)) {
      return {
        ok: false,
        kind: 'conflict',
        fields: [{ field: 'productCode', message: 'That product code is already in use.' }],
      };
    }
    if (isForeignKey(error)) {
      return {
        ok: false,
        kind: 'invalid_reference',
        fields: [{ field: 'productCategoryId', message: 'That category does not exist.' }],
      };
    }
    throw error;
  }
  const created = await getProduct(db, id);
  return created === null ? { ok: false, kind: 'not_found' } : { ok: true, value: created };
}

export async function updateProduct(
  db: Client,
  id: string,
  input: ProductInput,
  ctx: WriteContext,
): Promise<WriteResult<ProductRow>> {
  const before = await getProduct(db, id);
  if (before === null) return { ok: false, kind: 'not_found' };
  const deactivating = before.active && !input.active;
  try {
    await db.batch(
      [
        {
          sql: `UPDATE products
                SET product_name = ?, product_category_id = ?, unit_of_measure = ?, active = ?
                WHERE product_id = ?`,
          args: [
            input.productName,
            input.productCategoryId,
            input.unitOfMeasure,
            input.active ? 1 : 0,
            id,
          ],
        },
        audit(
          ctx,
          deactivating ? CATALOGUE_AUDIT.productDeactivated : CATALOGUE_AUDIT.productUpdated,
          'PRODUCT',
          id,
          deactivating ? 'DEACTIVATE' : 'UPDATE',
          before,
          { ...input, productCode: before.productCode },
        ),
      ],
      'write',
    );
  } catch (error) {
    if (isForeignKey(error)) {
      return {
        ok: false,
        kind: 'invalid_reference',
        fields: [{ field: 'productCategoryId', message: 'That category does not exist.' }],
      };
    }
    throw error;
  }
  const after = await getProduct(db, id);
  return after === null ? { ok: false, kind: 'not_found' } : { ok: true, value: after };
}

// ---- the hierarchy ---------------------------------------------------------

export interface HierarchyProduct {
  productId: string;
  productCode: string;
  productName: string;
  unitOfMeasure: string;
  active: boolean;
  available: boolean;
}

export interface HierarchyCategory {
  productCategoryId: string;
  categoryCode: string;
  categoryName: string;
  defaultUom: string | null;
  active: boolean;
  available: boolean;
  depth: number;
  children: HierarchyCategory[];
  products: HierarchyProduct[];
}

export interface HierarchyGroup {
  productGroupId: string;
  groupCode: string;
  groupName: string;
  active: boolean;
  sortOrder: number;
  categories: HierarchyCategory[];
}

export interface Hierarchy {
  groups: HierarchyGroup[];
  counts: { groups: number; categories: number; products: number };
  /**
   * True when the catalogue is large enough that products were left out and
   * must be fetched per category through /api/admin/products instead.
   */
  productsOmitted: boolean;
  maxDepth: number;
}

/**
 * The whole catalogue in ONE query.
 *
 * A `UNION ALL` over the three tables, not one statement per table and
 * emphatically not one per node: a tree assembled by walking the database is
 * the N+1 this endpoint exists to prevent, and it is at its worst exactly when
 * the catalogue is large enough for the tree to matter.
 *
 * The rows come back flat with a `kind` discriminator and are assembled into
 * the nested shape below in one pass. The `available` flag is computed by the
 * recursive CTE, so an ancestor's status reaches its descendants in the same
 * query rather than being recomputed by the caller.
 *
 * AT TEN THOUSAND PRODUCTS
 * Groups and categories stay: they are the part a cascading selector needs and
 * they stay small, because the depth limit bounds the tree and a catalogue with
 * ten thousand products still has tens of groups and hundreds of categories.
 * The products do not: past PRODUCT_INLINE_LIMIT they are omitted, the payload
 * says so, and the interface loads a category's products from the paginated,
 * server-side-searched /api/admin/products when that category is opened. That
 * is implemented here, not left as a plan, so the behaviour at scale is the
 * behaviour that ships.
 */
export const PRODUCT_INLINE_LIMIT = 500;

export async function hierarchy(db: Client): Promise<Hierarchy> {
  const result = await db.execute(`
    ${CATEGORY_TREE_CTE}
    SELECT 'group' AS kind, g.product_group_id AS id, NULL AS parent_id,
           g.product_group_id AS group_id, g.group_code AS code, g.group_name AS name,
           NULL AS uom, g.active AS active, 1 AS available, 0 AS depth, g.sort_order AS sort_order
    FROM product_groups g
    UNION ALL
    SELECT 'category', c.product_category_id, c.parent_category_id, c.product_group_id,
           c.category_code, c.category_name, c.default_uom, c.active, t.available, t.depth,
           c.sort_order
    FROM product_categories c
    JOIN category_tree t ON t.product_category_id = c.product_category_id
    UNION ALL
    SELECT 'product', p.product_id, p.product_category_id, c.product_group_id,
           p.product_code, p.product_name, p.unit_of_measure, p.active,
           CASE WHEN p.active = 1 AND t.available = 1 THEN 1 ELSE 0 END, t.depth + 1, 100
    FROM products p
    JOIN product_categories c ON c.product_category_id = p.product_category_id
    JOIN category_tree t ON t.product_category_id = p.product_category_id
    ORDER BY kind, sort_order, name`);

  const groups = new Map<string, HierarchyGroup>();
  const categories = new Map<string, HierarchyCategory>();
  const categoryRows: { id: string; parentId: string | null; groupId: string }[] = [];
  const productRows: { parentId: string; product: HierarchyProduct }[] = [];

  for (const raw of result.rows) {
    const row = raw as unknown as Record<string, unknown>;
    const kind = text(row.kind);
    if (kind === 'group') {
      groups.set(text(row.id), {
        productGroupId: text(row.id),
        groupCode: text(row.code),
        groupName: text(row.name),
        active: flag(row.active),
        sortOrder: Number(row.sort_order ?? 100),
        categories: [],
      });
    } else if (kind === 'category') {
      categories.set(text(row.id), {
        productCategoryId: text(row.id),
        categoryCode: text(row.code),
        categoryName: text(row.name),
        defaultUom: nullableText(row.uom),
        active: flag(row.active),
        available: flag(row.available),
        depth: Number(row.depth ?? 1),
        children: [],
        products: [],
      });
      categoryRows.push({
        id: text(row.id),
        parentId: nullableText(row.parent_id),
        groupId: text(row.group_id),
      });
    } else {
      productRows.push({
        parentId: text(row.parent_id),
        product: {
          productId: text(row.id),
          productCode: text(row.code),
          productName: text(row.name),
          unitOfMeasure: text(row.uom),
          active: flag(row.active),
          available: flag(row.available),
        },
      });
    }
  }

  // Categories first, parents before children, so a child always finds its
  // parent already in the map. The CTE ordered by depth, and the sort above
  // keeps that within the category block.
  for (const entry of [...categoryRows].sort((a, b) => {
    const left = categories.get(a.id)?.depth ?? 1;
    const right = categories.get(b.id)?.depth ?? 1;
    return left - right;
  })) {
    const node = categories.get(entry.id);
    if (node === undefined) continue;
    if (entry.parentId === null) groups.get(entry.groupId)?.categories.push(node);
    else categories.get(entry.parentId)?.children.push(node);
  }

  const productsOmitted = productRows.length > PRODUCT_INLINE_LIMIT;
  if (!productsOmitted) {
    for (const entry of productRows) categories.get(entry.parentId)?.products.push(entry.product);
  }

  return {
    groups: [...groups.values()].sort(
      (a, b) => a.sortOrder - b.sortOrder || a.groupName.localeCompare(b.groupName),
    ),
    counts: {
      groups: groups.size,
      categories: categories.size,
      products: productRows.length,
    },
    productsOmitted,
    maxDepth: MAX_CATEGORY_DEPTH,
  };
}

/**
 * What a deactivation will reach, counted before it is applied.
 *
 * Section 8: an administrator must be told what is affected and how many
 * records reference it, rather than discovering afterwards that retiring a
 * group took forty products out of every order form.
 */
export interface DeactivationImpact {
  categories: number;
  products: number;
  authorityRules: number;
}

export async function groupImpact(db: Client, groupId: string): Promise<DeactivationImpact> {
  const result = await db.execute({
    sql: `SELECT
            (SELECT COUNT(*) FROM product_categories c WHERE c.product_group_id = ?) AS categories,
            (SELECT COUNT(*) FROM products p
              JOIN product_categories c ON c.product_category_id = p.product_category_id
              WHERE c.product_group_id = ?) AS products,
            (SELECT COUNT(*) FROM approval_authority_rules ar
              WHERE ar.product_group_id = ?) AS rules`,
    args: [groupId, groupId, groupId],
  });
  const row = result.rows[0];
  return {
    categories: Number(row?.categories ?? 0),
    products: Number(row?.products ?? 0),
    authorityRules: Number(row?.rules ?? 0),
  };
}

export async function categoryImpact(db: Client, categoryId: string): Promise<DeactivationImpact> {
  const result = await db.execute({
    sql: `${CATEGORY_TREE_CTE},
          subtree AS (
            SELECT product_category_id FROM product_categories WHERE product_category_id = ?
            UNION ALL
            SELECT c.product_category_id FROM product_categories c
            JOIN subtree s ON s.product_category_id = c.parent_category_id
          )
          SELECT
            (SELECT COUNT(*) - 1 FROM subtree) AS categories,
            (SELECT COUNT(*) FROM products p
              WHERE p.product_category_id IN (SELECT product_category_id FROM subtree)) AS products,
            (SELECT COUNT(*) FROM approval_authority_rules ar
              WHERE ar.product_category_id IN (SELECT product_category_id FROM subtree)) AS rules`,
    args: [categoryId],
  });
  const row = result.rows[0];
  return {
    categories: Number(row?.categories ?? 0),
    products: Number(row?.products ?? 0),
    authorityRules: Number(row?.rules ?? 0),
  };
}

/** Units of measure already in use, offered as suggestions. */
export async function knownUnits(db: Client): Promise<string[]> {
  const result = await db.execute(
    `SELECT DISTINCT unit_of_measure AS uom FROM products WHERE unit_of_measure <> ''
     UNION
     SELECT DISTINCT default_uom FROM product_categories WHERE default_uom IS NOT NULL
     ORDER BY uom`,
  );
  return result.rows.map((row) => text((row as unknown as Record<string, unknown>).uom));
}
