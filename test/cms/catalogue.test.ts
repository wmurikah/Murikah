/**
 * The shared product catalogue.
 *
 * Against the operator's own seed, so `AGO`, `PMS`, `LPG` and the lubricants
 * category are the rows this product will actually run against, and the
 * `approval_authority_rules` that reference `PG-FUEL` are the seeded ones.
 *
 * The database is an isolated in-memory one built from the schema DDL, with
 * foreign keys on and every CHECK present. Nothing here points at hass-cms.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refusalFields } from './support/refusal.ts';
import { createTestDb, query, type TestClient } from './support/db.ts';
import { seedHass, SEED } from './support/hassSeed.ts';
import {
  categoryImpact,
  createCategory,
  createGroup,
  createProduct,
  getCategory,
  getGroup,
  getProduct,
  groupImpact,
  hierarchy,
  listCategories,
  listProducts,
  parentChain,
  updateCategory,
  updateGroup,
  updateProduct,
  type CategoryInput,
  type GroupInput,
  type ProductInput,
} from '../../src/lib/cms/repos/catalogueAdmin.ts';
import { MAX_CATEGORY_DEPTH } from '../../src/lib/cms/catalogue/model.ts';
import {
  validateCategory,
  validateGroup,
  validateProduct,
} from '../../src/lib/cms/admin/catalogueInput.ts';

const CTX = {
  actorUserId: SEED.admin,
  ip: '10.0.0.10',
  userAgent: 'HassCMS Test',
  now: new Date('2026-08-27T09:00:00Z'),
} as const;

const db = async (): Promise<TestClient> => {
  const c = createTestDb();
  await seedHass(c);
  return c;
};
const asClient = (c: TestClient) => c as unknown as Parameters<typeof hierarchy>[0];

const group = (over: Partial<GroupInput> = {}): GroupInput => ({
  groupCode: 'BITUMEN',
  groupName: 'Bitumen',
  description: 'Bituminous products',
  sortOrder: 50,
  active: true,
  ...over,
});
const category = (over: Partial<CategoryInput> = {}): CategoryInput => ({
  productGroupId: 'PG-LUB',
  parentCategoryId: null,
  categoryCode: 'ENGINE_OIL',
  categoryName: 'Engine Oil',
  defaultUom: 'LITRE',
  description: null,
  sortOrder: 20,
  active: true,
  ...over,
});
const product = (over: Partial<ProductInput> = {}): ProductInput => ({
  productCode: 'HD40',
  productName: 'Heavy Duty 40 Engine Oil',
  productCategoryId: 'PC-LUBE',
  unitOfMeasure: 'LITRE',
  active: true,
  ...over,
});

const anyQuery = {
  search: '',
  availability: 'all' as const,
  groupId: null,
  categoryId: null,
  page: 1,
};

// ---------------------------------------------------------------------------
// Creating the four kinds of row.
// ---------------------------------------------------------------------------

test('a group, a category, a nested category and a product are created through the repository', async () => {
  const c = await db();

  const madeGroup = await createGroup(asClient(c), group(), CTX);
  assert.equal(madeGroup.ok, true);
  if (!madeGroup.ok) return;

  const madeCategory = await createCategory(
    asClient(c),
    category({ productGroupId: madeGroup.value.productGroupId, categoryCode: 'PENETRATION' }),
    CTX,
  );
  assert.equal(madeCategory.ok, true);
  if (!madeCategory.ok) return;
  assert.equal(madeCategory.value.depth, 1);

  const nested = await createCategory(
    asClient(c),
    category({
      productGroupId: madeGroup.value.productGroupId,
      parentCategoryId: madeCategory.value.productCategoryId,
      categoryCode: 'PEN_60_70',
      categoryName: 'Penetration 60/70',
    }),
    CTX,
  );
  assert.equal(nested.ok, true);
  if (!nested.ok) return;
  assert.equal(nested.value.depth, 2);
  assert.equal(nested.value.parentCategoryName, 'Engine Oil');

  const madeProduct = await createProduct(
    asClient(c),
    product({
      productCode: 'BIT6070',
      productName: 'Bitumen 60/70',
      productCategoryId: nested.value.productCategoryId,
      unitOfMeasure: 'TONNE',
    }),
    CTX,
  );
  assert.equal(madeProduct.ok, true);
  if (!madeProduct.ok) return;
  assert.equal(madeProduct.value.groupName, 'Bitumen');
  assert.equal(madeProduct.value.available, true);

  const rows = query(
    c,
    `SELECT product_id, product_code, unit_of_measure FROM products WHERE product_code = 'BIT6070'`,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.unit_of_measure, 'TONNE');
  c.close();
});

test('AGO, PMS and LPG exist as commodities and a lubricant grade sits beneath a category, with no schema change', async () => {
  const c = await db();

  // The three commodities are seeded, each in its own category.
  const commodities = query(
    c,
    `SELECT p.product_code, c.category_code, g.group_code
     FROM products p
     JOIN product_categories c ON c.product_category_id = p.product_category_id
     JOIN product_groups g ON g.product_group_id = c.product_group_id
     WHERE p.product_code IN ('AGO','PMS','LPG') ORDER BY p.product_code`,
  );
  assert.deepEqual(
    commodities.map((r) => `${r.product_code} in ${r.category_code} of ${r.group_code}`),
    ['AGO in AGO of FUELS', 'LPG in LPG of LPG', 'PMS in PMS of FUELS'],
  );

  // An item-level grade beneath an Engine Oil category beneath the Lubricants
  // group. Two category levels and a product, all in the same three tables.
  const engineOil = await createCategory(
    asClient(c),
    category({ productGroupId: 'PG-LUB', parentCategoryId: 'PC-LUBE' }),
    CTX,
  );
  assert.equal(engineOil.ok, true);
  if (!engineOil.ok) return;

  const grade = await createProduct(
    asClient(c),
    product({
      productCode: 'HASSGOLD_15W40',
      productName: 'Hass Gold 15W-40',
      productCategoryId: engineOil.value.productCategoryId,
      unitOfMeasure: 'LITRE',
    }),
    CTX,
  );
  assert.equal(grade.ok, true);
  if (!grade.ok) return;
  assert.equal(grade.value.categoryName, 'Engine Oil');
  assert.equal(grade.value.groupName, 'Lubricants');
  c.close();
});

// ---------------------------------------------------------------------------
// The uniqueness rules, and the one that is not there.
// ---------------------------------------------------------------------------

test('a duplicate group code is a field message, not a 500', async () => {
  const c = await db();
  const first = await createGroup(asClient(c), group(), CTX);
  assert.equal(first.ok, true);
  const second = await createGroup(asClient(c), group({ groupName: 'Bitumen products' }), CTX);
  assert.equal(second.ok, false);
  if (!second.ok) {
    assert.equal(second.kind, 'conflict');
    assert.equal(second.fields[0]?.field, 'groupCode');
  }
  c.close();
});

test('a duplicate category code is refused even under a different group, and the message says the code is global', async () => {
  const c = await db();

  // `PC-AGO` is seeded under the Fuels group with the code AGO. Reusing that
  // code under Lubricants is refused: the constraint is on the table, not on
  // the group.
  const clash = await createCategory(
    asClient(c),
    category({ productGroupId: 'PG-LUB', categoryCode: 'AGO', categoryName: 'Automotive Gas Oil' }),
    CTX,
  );
  assert.equal(clash.ok, false);
  if (!clash.ok) {
    assert.equal(clash.kind, 'conflict');
    assert.equal(clash.fields[0]?.field, 'categoryCode');
    assert.match(String(clash.fields[0]?.message), /unique across every group, not per group/);
  }
  c.close();
});

test('two groups may hold a category with the same name, because the database does not forbid it', async () => {
  const c = await db();
  const first = await createCategory(
    asClient(c),
    category({ productGroupId: 'PG-FUEL', categoryCode: 'DIESEL_A', categoryName: 'Diesel' }),
    CTX,
  );
  const second = await createCategory(
    asClient(c),
    category({ productGroupId: 'PG-LUB', categoryCode: 'DIESEL_B', categoryName: 'Diesel' }),
    CTX,
  );
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  c.close();
});

test('a duplicate product code is a field message', async () => {
  const c = await db();
  const clash = await createProduct(asClient(c), product({ productCode: 'AGO' }), CTX);
  assert.equal(clash.ok, false);
  if (!clash.ok) {
    assert.equal(clash.kind, 'conflict');
    assert.equal(clash.fields[0]?.field, 'productCode');
  }
  c.close();
});

// ---------------------------------------------------------------------------
// The rules the schema does not enforce.
// ---------------------------------------------------------------------------

test('a subcategory whose group differs from its parent is refused', async () => {
  const c = await db();

  // `PC-AGO` sits in the Fuels group. Making a Lubricants category its child is
  // something the database would accept: `product_group_id` is NOT NULL on the
  // child and nothing relates it to the parent's.
  const wrong = await createCategory(
    asClient(c),
    category({ productGroupId: 'PG-LUB', parentCategoryId: 'PC-AGO', categoryCode: 'MIXED' }),
    CTX,
  );
  assert.equal(wrong.ok, false);
  if (!wrong.ok) {
    assert.equal(wrong.kind, 'invalid_reference');
    assert.equal(wrong.fields[0]?.field, 'productGroupId');
    assert.match(String(wrong.fields[0]?.message), /same product group as its parent/);
  }

  // The same insert straight into the table is accepted, which is what makes
  // the application rule necessary rather than decorative.
  await c.execute({
    sql: `INSERT INTO product_categories
            (product_category_id, product_group_id, parent_category_id, category_code,
             category_name, default_uom, description, active, sort_order)
          VALUES ('PC-RAW','PG-LUB','PC-AGO','RAW','Raw',NULL,NULL,1,100)`,
    args: [],
  });
  assert.equal(
    query(c, `SELECT COUNT(*) AS n FROM product_categories WHERE product_category_id='PC-RAW'`)[0]
      ?.n,
    1,
  );
  c.close();
});

test('a category cannot be its own parent', async () => {
  const c = await db();
  const existing = await getCategory(asClient(c), 'PC-LUBE');
  assert.notEqual(existing, null);
  if (existing === null) return;

  const direct = await updateCategory(
    asClient(c),
    'PC-LUBE',
    category({
      productGroupId: existing.productGroupId,
      parentCategoryId: 'PC-LUBE',
      categoryCode: existing.categoryCode,
      categoryName: existing.categoryName,
    }),
    CTX,
  );
  assert.equal(direct.ok, false);
  if (!direct.ok) {
    const fields = refusalFields(direct);
    assert.equal(fields[0]?.field, 'parentCategoryId');
    assert.match(String(fields[0]?.message), /cannot be its own parent/);
  }
  c.close();
});

test('an indirect cycle is refused, and the parent chain walk shows why', async () => {
  const c = await db();

  // A → B → C, all in one group.
  const a = await createCategory(
    asClient(c),
    category({ productGroupId: 'PG-LUB', categoryCode: 'CYC_A', categoryName: 'A' }),
    CTX,
  );
  assert.equal(a.ok, true);
  if (!a.ok) return;
  const b = await createCategory(
    asClient(c),
    category({
      productGroupId: 'PG-LUB',
      parentCategoryId: a.value.productCategoryId,
      categoryCode: 'CYC_B',
      categoryName: 'B',
    }),
    CTX,
  );
  assert.equal(b.ok, true);
  if (!b.ok) return;
  const d = await createCategory(
    asClient(c),
    category({
      productGroupId: 'PG-LUB',
      parentCategoryId: b.value.productCategoryId,
      categoryCode: 'CYC_C',
      categoryName: 'C',
    }),
    CTX,
  );
  assert.equal(d.ok, true);
  if (!d.ok) return;

  // The chain, as the check reads it: C, then B, then A.
  const chain = await parentChain(asClient(c), d.value.productCategoryId);
  assert.deepEqual(
    chain.map((entry) => entry.code),
    ['CYC_C', 'CYC_B', 'CYC_A'],
  );

  // Now make A a child of C. The database would accept it and the tree would
  // close into a loop.
  const cycle = await updateCategory(
    asClient(c),
    a.value.productCategoryId,
    category({
      productGroupId: 'PG-LUB',
      parentCategoryId: d.value.productCategoryId,
      categoryCode: 'CYC_A',
      categoryName: 'A',
    }),
    CTX,
  );
  assert.equal(cycle.ok, false);
  if (!cycle.ok) {
    const fields = refusalFields(cycle);
    assert.equal(fields[0]?.field, 'parentCategoryId');
    assert.match(String(fields[0]?.message), /ancestor of itself/);
  }

  // A is still where it was.
  const unchanged = await getCategory(asClient(c), a.value.productCategoryId);
  assert.equal(unchanged?.parentCategoryId, null);
  c.close();
});

test('the tree stops at the depth the interface can render', async () => {
  const c = await db();
  let parent: string | null = null;
  for (let level = 1; level <= MAX_CATEGORY_DEPTH; level++) {
    const made = await createCategory(
      asClient(c),
      category({
        productGroupId: 'PG-LUB',
        parentCategoryId: parent,
        categoryCode: `DEPTH_${level}`,
        categoryName: `Level ${level}`,
      }),
      CTX,
    );
    assert.equal(made.ok, true, `level ${level} should be allowed`);
    if (!made.ok) return;
    assert.equal(made.value.depth, level);
    parent = made.value.productCategoryId;
  }

  const tooDeep = await createCategory(
    asClient(c),
    category({
      productGroupId: 'PG-LUB',
      parentCategoryId: parent,
      categoryCode: 'DEPTH_TOO_FAR',
      categoryName: 'One too many',
    }),
    CTX,
  );
  assert.equal(tooDeep.ok, false);
  if (!tooDeep.ok) {
    assert.match(
      String(refusalFields(tooDeep)[0]?.message),
      new RegExp(`${MAX_CATEGORY_DEPTH} levels deep`),
    );
  }

  // A category at the deepest level still takes products; it simply takes no
  // children.
  const deepest = await createProduct(
    asClient(c),
    product({ productCode: 'DEEP1', productCategoryId: parent ?? '' }),
    CTX,
  );
  assert.equal(deepest.ok, true);
  c.close();
});

test('a product without a unit of measure is refused with a field message', () => {
  const missing = validateProduct({
    productCode: 'NOUOM',
    productName: 'No unit',
    productCategoryId: 'PC-LUBE',
  });
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(missing.errors[0]?.field, 'unitOfMeasure');
    assert.match(String(missing.errors[0]?.message), /LITRE, KG or UNIT/);
  }

  // And no default is invented. A unit that was given is the one that is used.
  const given = validateProduct({
    productCode: 'HASUOM',
    productName: 'Has a unit',
    productCategoryId: 'PC-LUBE',
    unitOfMeasure: 'drum',
  });
  assert.equal(given.ok, true);
  if (given.ok) assert.equal(given.value.unitOfMeasure, 'DRUM');
});

test('the validators refuse what they can decide from the payload alone', () => {
  assert.equal(validateGroup({ groupCode: 'X' }).ok, false);
  assert.equal(validateGroup({ groupCode: 'FUELS', groupName: 'F', sortOrder: -1 }).ok, false);
  assert.equal(validateCategory({ categoryCode: 'AGO', categoryName: 'Diesel' }).ok, false);

  // A code is normalised the way the seeded codes are written, so a catalogue
  // does not end up holding AGO, ago and A G O as three distinct codes.
  const normalised = validateGroup({ groupCode: 'heavy fuels', groupName: 'Heavy Fuels' });
  assert.equal(normalised.ok, true);
  if (normalised.ok) assert.equal(normalised.value.groupCode, 'HEAVY_FUELS');
});

// ---------------------------------------------------------------------------
// Ids are stable. Section 9.
// ---------------------------------------------------------------------------

test('renaming a group keeps its id and leaves every referencing authority rule untouched', async () => {
  const c = await db();

  // The seeded rules that restrict by the Fuels group.
  const before = query(
    c,
    `SELECT authority_rule_id, product_group_id FROM approval_authority_rules
     WHERE product_group_id = 'PG-FUEL' ORDER BY authority_rule_id`,
  );
  assert.deepEqual(
    before.map((r) => r.authority_rule_id),
    ['AAR-001', 'AAR-002'],
  );

  const original = await getGroup(asClient(c), 'PG-FUEL');
  assert.equal(original?.groupName, 'Ground Fuels');

  const renamed = await updateGroup(
    asClient(c),
    'PG-FUEL',
    group({
      groupCode: 'FUELS',
      groupName: 'Ground Fuels and Diesel',
      description: original?.description ?? null,
      sortOrder: original?.sortOrder ?? 10,
      active: true,
    }),
    CTX,
  );
  assert.equal(renamed.ok, true);
  if (!renamed.ok) return;

  // The id did not move.
  assert.equal(renamed.value.productGroupId, 'PG-FUEL');
  assert.equal(renamed.value.groupName, 'Ground Fuels and Diesel');
  assert.equal(query(c, `SELECT COUNT(*) AS n FROM product_groups`)[0]?.n, 5);

  // And every rule still points at it. A delete and reinsert would have set
  // these to NULL, silently widening two approval limits.
  const after = query(
    c,
    `SELECT authority_rule_id, product_group_id FROM approval_authority_rules
     WHERE product_group_id = 'PG-FUEL' ORDER BY authority_rule_id`,
  );
  assert.deepEqual(after, before);
  assert.equal(
    query(c, `SELECT COUNT(*) AS n FROM approval_authority_rules WHERE product_group_id IS NULL`)[0]
      ?.n,
    3,
  );
  c.close();
});

test('renaming a category keeps its id, and a category rule keeps its reference', async () => {
  const c = await db();
  await c.execute({
    sql: `UPDATE approval_authority_rules SET product_category_id = 'PC-AGO' WHERE authority_rule_id = 'AAR-002'`,
    args: [],
  });

  const before = await getCategory(asClient(c), 'PC-AGO');
  assert.notEqual(before, null);
  if (before === null) return;

  const renamed = await updateCategory(
    asClient(c),
    'PC-AGO',
    category({
      productGroupId: before.productGroupId,
      parentCategoryId: before.parentCategoryId,
      categoryCode: before.categoryCode,
      categoryName: 'Automotive Gas Oil (Diesel)',
      defaultUom: before.defaultUom,
      sortOrder: before.sortOrder,
    }),
    CTX,
  );
  assert.equal(renamed.ok, true);
  if (renamed.ok) assert.equal(renamed.value.productCategoryId, 'PC-AGO');

  assert.equal(
    query(
      c,
      `SELECT product_category_id FROM approval_authority_rules WHERE authority_rule_id='AAR-002'`,
    )[0]?.product_category_id,
    'PC-AGO',
  );
  c.close();
});

// ---------------------------------------------------------------------------
// Deactivation, and what it reaches.
// ---------------------------------------------------------------------------

test('an inactive product is out of new selection and still present in a historical lookup', async () => {
  const c = await db();
  const retired = await updateProduct(
    asClient(c),
    'PROD-LUBE',
    product({
      productCode: 'LUBES',
      productName: 'Lubricants',
      productCategoryId: 'PC-LUBE',
      unitOfMeasure: 'UNIT',
      active: false,
    }),
    CTX,
  );
  assert.equal(retired.ok, true);

  const selectable = await listProducts(asClient(c), { ...anyQuery, availability: 'available' });
  assert.equal(
    selectable.items.some((p) => p.productId === 'PROD-LUBE'),
    false,
  );

  // The historical lookup still finds it, with its status legible.
  const historical = await getProduct(asClient(c), 'PROD-LUBE');
  assert.notEqual(historical, null);
  assert.equal(historical?.productName, 'Lubricants');
  assert.equal(historical?.active, false);
  assert.equal(historical?.available, false);

  const audit = query(
    c,
    `SELECT event_type, action, actor_user_id FROM audit_events WHERE event_type = 'PRODUCT_DEACTIVATED'`,
  );
  assert.equal(audit.length, 1);
  assert.equal(audit[0]?.action, 'DEACTIVATE');
  assert.equal(audit[0]?.actor_user_id, SEED.admin);
  c.close();
});

test('retiring a group makes its whole subtree unselectable and changes no child status', async () => {
  const c = await db();

  const impact = await groupImpact(asClient(c), 'PG-FUEL');
  assert.equal(impact.categories, 2);
  assert.equal(impact.products, 2);
  assert.equal(impact.authorityRules, 2);

  const retired = await updateGroup(
    asClient(c),
    'PG-FUEL',
    group({ groupCode: 'FUELS', groupName: 'Ground Fuels', sortOrder: 10, active: false }),
    CTX,
  );
  assert.equal(retired.ok, true);

  // The products are unselectable.
  const selectable = await listProducts(asClient(c), { ...anyQuery, availability: 'available' });
  assert.equal(
    selectable.items.some((p) => p.productGroupId === 'PG-FUEL'),
    false,
  );
  const ago = await getProduct(asClient(c), 'PROD-AGO');
  assert.equal(ago?.available, false);

  // And their own flag is untouched, so reactivating the group restores exactly
  // what was there rather than a flattened version of it.
  assert.equal(ago?.active, true);
  assert.equal(
    query(c, `SELECT active FROM product_categories WHERE product_category_id='PC-AGO'`)[0]?.active,
    1,
  );

  const categories = await listCategories(asClient(c));
  const fuelCategory = categories.find((entry) => entry.productCategoryId === 'PC-AGO');
  assert.equal(fuelCategory?.active, true);
  assert.equal(fuelCategory?.available, false);

  // Reactivating restores the subtree.
  const restored = await updateGroup(
    asClient(c),
    'PG-FUEL',
    group({ groupCode: 'FUELS', groupName: 'Ground Fuels', sortOrder: 10, active: true }),
    CTX,
  );
  assert.equal(restored.ok, true);
  assert.equal((await getProduct(asClient(c), 'PROD-AGO'))?.available, true);
  c.close();
});

test('retiring a nested category reaches its own subtree and nothing else', async () => {
  const c = await db();
  const parent = await createCategory(
    asClient(c),
    category({ productGroupId: 'PG-LUB', parentCategoryId: 'PC-LUBE', categoryCode: 'ENGINE' }),
    CTX,
  );
  assert.equal(parent.ok, true);
  if (!parent.ok) return;
  const child = await createCategory(
    asClient(c),
    category({
      productGroupId: 'PG-LUB',
      parentCategoryId: parent.value.productCategoryId,
      categoryCode: 'ENGINE_15W40',
      categoryName: '15W-40',
    }),
    CTX,
  );
  assert.equal(child.ok, true);
  if (!child.ok) return;
  const made = await createProduct(
    asClient(c),
    product({ productCode: 'HG15W40', productCategoryId: child.value.productCategoryId }),
    CTX,
  );
  assert.equal(made.ok, true);
  if (!made.ok) return;

  const impact = await categoryImpact(asClient(c), parent.value.productCategoryId);
  assert.equal(impact.categories, 1);
  assert.equal(impact.products, 1);

  const retired = await updateCategory(
    asClient(c),
    parent.value.productCategoryId,
    category({
      productGroupId: 'PG-LUB',
      parentCategoryId: 'PC-LUBE',
      categoryCode: 'ENGINE',
      active: false,
    }),
    CTX,
  );
  assert.equal(retired.ok, true);

  assert.equal((await getProduct(asClient(c), made.value.productId))?.available, false);
  // The sibling category and the seeded lubricants product are untouched.
  assert.equal((await getProduct(asClient(c), 'PROD-LUBE'))?.available, true);
  c.close();
});

// ---------------------------------------------------------------------------
// The hierarchy, in one query.
// ---------------------------------------------------------------------------

test('the hierarchy returns the whole tree in one call, with depth and availability computed', async () => {
  const c = await db();
  const nested = await createCategory(
    asClient(c),
    category({ productGroupId: 'PG-LUB', parentCategoryId: 'PC-LUBE', categoryCode: 'ENGINE' }),
    CTX,
  );
  assert.equal(nested.ok, true);
  if (!nested.ok) return;
  await createProduct(
    asClient(c),
    product({ productCode: 'HG15W40', productCategoryId: nested.value.productCategoryId }),
    CTX,
  );

  const tree = await hierarchy(asClient(c));
  assert.equal(tree.counts.groups, 5);
  assert.equal(tree.counts.categories, 6);
  assert.equal(tree.counts.products, 6);
  assert.equal(tree.productsOmitted, false);
  assert.equal(tree.maxDepth, MAX_CATEGORY_DEPTH);

  const lubricants = tree.groups.find((g) => g.groupCode === 'LUBRICANTS');
  assert.notEqual(lubricants, undefined);
  const top = lubricants?.categories[0];
  assert.equal(top?.categoryCode, 'LUBRICANTS');
  assert.equal(top?.depth, 1);
  assert.equal(top?.children.length, 1);
  assert.equal(top?.children[0]?.categoryCode, 'ENGINE');
  assert.equal(top?.children[0]?.depth, 2);
  assert.equal(top?.children[0]?.products[0]?.productCode, 'HG15W40');

  // Groups are ordered by their sort order, which is the column the screen
  // exposes and edits rather than decoration.
  assert.deepEqual(
    tree.groups.map((g) => g.groupCode),
    ['FUELS', 'AVIATION', 'LPG', 'LUBRICANTS', 'OTHER'],
  );

  // An inactive group's descendants come back marked unavailable, computed in
  // the same query rather than by the caller.
  await updateGroup(
    asClient(c),
    'PG-LUB',
    group({ groupCode: 'LUBRICANTS', groupName: 'Lubricants', sortOrder: 40, active: false }),
    CTX,
  );
  const after = await hierarchy(asClient(c));
  const retired = after.groups.find((g) => g.groupCode === 'LUBRICANTS');
  assert.equal(retired?.categories[0]?.available, false);
  assert.equal(retired?.categories[0]?.children[0]?.available, false);
  assert.equal(retired?.categories[0]?.children[0]?.products[0]?.available, false);
  // And their own flags are unchanged.
  assert.equal(retired?.categories[0]?.active, true);
  c.close();
});

// ---------------------------------------------------------------------------
// Search.
// ---------------------------------------------------------------------------

test('search matches product code, product name, category and group, in either case', async () => {
  const c = await db();
  const codes = async (search: string) =>
    (await listProducts(asClient(c), { ...anyQuery, search })).items.map((p) => p.productCode);

  // By product code, lower case against an upper-case column.
  assert.deepEqual(await codes('ago'), ['AGO']);
  // By product name.
  assert.deepEqual(await codes('premium motor'), ['PMS']);
  // By category, upper case against a mixed-case column.
  assert.deepEqual((await codes('AVIATION')).sort(), ['JET-A1']);
  // By group.
  assert.deepEqual((await codes('ground fuels')).sort(), ['AGO', 'PMS']);
  // By group code.
  assert.deepEqual((await codes('LuBrIcAnTs')).sort(), ['LUBES']);

  // Filtering and paging happen in the database, not in the browser.
  const filtered = await listProducts(asClient(c), { ...anyQuery, groupId: 'PG-FUEL' });
  assert.equal(filtered.total, 2);
  assert.equal(filtered.items.length, 2);
  c.close();
});

// ---------------------------------------------------------------------------
// Audit.
// ---------------------------------------------------------------------------

test('every catalogue audit event type is written, with an actor and both states', async () => {
  const c = await db();

  const madeGroup = await createGroup(asClient(c), group(), CTX);
  assert.equal(madeGroup.ok, true);
  if (!madeGroup.ok) return;
  await updateGroup(
    asClient(c),
    madeGroup.value.productGroupId,
    group({ groupName: 'Bitumen and asphalt' }),
    CTX,
  );

  const madeCategory = await createCategory(
    asClient(c),
    category({ productGroupId: madeGroup.value.productGroupId, categoryCode: 'PENETRATION' }),
    CTX,
  );
  assert.equal(madeCategory.ok, true);
  if (!madeCategory.ok) return;
  await updateCategory(
    asClient(c),
    madeCategory.value.productCategoryId,
    category({
      productGroupId: madeGroup.value.productGroupId,
      categoryCode: 'PENETRATION',
      categoryName: 'Penetration grades',
    }),
    CTX,
  );

  const madeProduct = await createProduct(
    asClient(c),
    product({ productCode: 'BIT6070', productCategoryId: madeCategory.value.productCategoryId }),
    CTX,
  );
  assert.equal(madeProduct.ok, true);
  if (!madeProduct.ok) return;
  await updateProduct(
    asClient(c),
    madeProduct.value.productId,
    product({
      productCode: 'BIT6070',
      productName: 'Bitumen 60/70 renamed',
      productCategoryId: madeCategory.value.productCategoryId,
    }),
    CTX,
  );
  await updateProduct(
    asClient(c),
    madeProduct.value.productId,
    product({
      productCode: 'BIT6070',
      productName: 'Bitumen 60/70 renamed',
      productCategoryId: madeCategory.value.productCategoryId,
      active: false,
    }),
    CTX,
  );

  const written = query(c, `SELECT DISTINCT event_type FROM audit_events ORDER BY event_type`).map(
    (r) => String(r.event_type),
  );
  for (const expected of [
    'PRODUCT_GROUP_CREATED',
    'PRODUCT_GROUP_UPDATED',
    'PRODUCT_CATEGORY_CREATED',
    'PRODUCT_CATEGORY_UPDATED',
    'PRODUCT_CREATED',
    'PRODUCT_UPDATED',
    'PRODUCT_DEACTIVATED',
  ]) {
    assert.equal(written.includes(expected), true, `${expected} was not written`);
  }

  // An update carries both states, so what changed is readable.
  const update = query(
    c,
    `SELECT actor_user_id, entity_type, entity_id, before_json, after_json FROM audit_events
     WHERE event_type = 'PRODUCT_GROUP_UPDATED' LIMIT 1`,
  )[0];
  assert.equal(update?.actor_user_id, SEED.admin);
  assert.equal(update?.entity_type, 'PRODUCT_GROUP');
  assert.equal(update?.entity_id, madeGroup.value.productGroupId);
  assert.match(String(update?.before_json), /Bitumen/);
  assert.match(String(update?.after_json), /Bitumen and asphalt/);

  // A create has no before state, which is honest rather than an empty object.
  const create = query(
    c,
    `SELECT before_json FROM audit_events WHERE event_type = 'PRODUCT_CREATED' LIMIT 1`,
  )[0];
  assert.equal(create?.before_json, null);

  assert.equal(
    query(c, `SELECT COUNT(*) AS n FROM audit_events WHERE actor_user_id IS NULL`)[0]?.n,
    0,
  );
  c.close();
});

test('nothing in the catalogue deletes a row, and the database refuses one anyway', async () => {
  const c = await db();

  // ON DELETE RESTRICT on both parent links. This is why there is no delete
  // verb: the operation would fail even if one existed.
  await assert.rejects(
    async () =>
      c.execute({ sql: `DELETE FROM product_groups WHERE product_group_id = 'PG-FUEL'`, args: [] }),
    /FOREIGN KEY constraint failed/,
  );
  await assert.rejects(
    async () =>
      c.execute({
        sql: `DELETE FROM product_categories WHERE product_category_id = 'PC-AGO'`,
        args: [],
      }),
    /FOREIGN KEY constraint failed/,
  );
  c.close();
});
