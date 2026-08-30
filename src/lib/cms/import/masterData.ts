/**
 * Reference records an extract names for the first time, created rather than
 * refused.
 *
 * THE RULE THIS IMPLEMENTS, AND THE ONE IT REPLACES. An upload used to be
 * forbidden from creating an account, so the first real sales order file put
 * all 1,386 of its rows in the unresolved queue: 228 customers and 111
 * products that did not exist yet. Requiring somebody to key 339 records by
 * hand before the first import is not a safeguard, it is a wall. So an
 * entity appearing for the first time is created, MARKED as having come from
 * an import, and LISTED for review. Nothing is silently dropped and nothing
 * is silently guessed.
 *
 * NEVER A USER, AND THAT RULE HAS NOT MOVED. An account and a product are
 * reference records: a code, a name, a category. A user is an identity, with
 * an email, a credential and a permission set, and inventing one is a
 * security decision no spreadsheet gets to make. An unmapped person still
 * becomes an `unresolved_actors` row for an administrator to map by hand.
 *
 * NEVER A VALUE THE FILE DOES NOT CARRY. A created account gets its Oracle
 * code, its name and the country of the batch's affiliate, and nothing else:
 * no credit limit, no credit days, no account manager. Those are commercial
 * decisions, and a zero credit limit invented here would read downstream as a
 * customer who may not trade.
 *
 * THE CATEGORY IS NOT GUESSED, AND THAT IS THE HARD PART. AGO, PMS and
 * JET - A1 are recognisable. GHAS50PG, GHOS13EC, HS-03-208 and OM-01-208 are
 * not, and there are over a hundred of them. The product hierarchy drives the
 * approval rules, so a product filed under the wrong category routes its
 * orders to the wrong approver: a confident wrong answer here is worse than
 * no answer. Everything created lands in an `Unclassified` category under the
 * `Other Products` group and waits for an administrator.
 *
 * HOW ONE IS FOUND AFTERWARDS, WITHOUT A NEW COLUMN. `audit_events` carries
 * it: an ACCOUNT_CREATED or PRODUCT_CREATED row whose entity_id is the record
 * and whose after_json names the batch, the source code and awaitingReview.
 * That is the marker and the queryable trail, and listCreatedFromImport below
 * is the one query the review queue runs.
 *
 * One trail, not two, and deliberately so. record_snapshots would have been
 * the other candidate, but its entity_type CHECK does not list PRODUCT, so it
 * could mark half the records and not the other half; a marker that covers
 * accounts but not products is worse than one that covers both, because a
 * reader cannot tell an unmarked product from a hand-keyed one. `import_rows`
 * separately ties every ORDER row to its batch, as it always did, which is
 * how a created account is traced back to the rows that named it.
 */
import type { Client, InStatement } from '@libsql/client/web';
import { newId } from '../repos/authRecords.ts';
import type { WriteContext } from '../admin/guard.ts';
import { nullIfBlank } from './cells.ts';

type Stmt = Extract<InStatement, { sql: string }>;
const text = (v: unknown): string => String(v ?? '');

/** The audit event types the review queue reads. */
export const ACCOUNT_CREATED = 'ACCOUNT_CREATED';
export const PRODUCT_CREATED = 'PRODUCT_CREATED';
export const ACCOUNT_NAME_MISMATCH = 'ACCOUNT_NAME_MISMATCH';

/** Where an unclassifiable product goes, and the group it hangs under. */
export const UNCLASSIFIED_CATEGORY_CODE = 'UNCLASSIFIED';
export const UNCLASSIFIED_CATEGORY_NAME = 'Unclassified';
export const OTHER_PRODUCTS_GROUP_CODE = 'OTHER';

/**
 * The unit of measure for a product whose file does not state one.
 *
 * Stated rather than guessed from the code, and stated here rather than at a
 * call site, because `products.unit_of_measure` is NOT NULL and something has
 * to go in it. UNIT is the neutral count: it claims no volume and no mass, so
 * it cannot be mistaken for a measurement the source made.
 */
export const DEFAULT_UNIT_OF_MEASURE = 'UNIT';

export interface AccountRequest {
  /** accounts.oracle_customer_code, as text, trimmed. */
  readonly code: string;
  /** CUSTOMER_NAME from the file, or null where the file gives none. */
  readonly name: string | null;
  /** The affiliate whose country the account takes. Null for Group scope. */
  readonly affiliateId: string | null;
}

export interface ProductRequest {
  /** products.product_code, as text, trimmed and upper-cased for matching. */
  readonly code: string;
  /** unit_of_measure from the file where it carries one. */
  readonly unitOfMeasure: string | null;
}

/** One account whose code matched but whose name in the file is different. */
export interface NameMismatch {
  readonly accountId: string;
  readonly code: string;
  readonly storedName: string;
  readonly fileName: string;
}

export interface MasterDataPlan {
  /** Codes that resolve today, mapped to their existing id. */
  readonly existingAccounts: Map<string, string>;
  readonly existingProducts: Map<string, string>;
  /** Codes the extract names that do not exist yet, in file order. */
  readonly accountsToCreate: AccountRequest[];
  readonly productsToCreate: ProductRequest[];
  /** A matched code carrying a different name. Flagged, never overwritten. */
  readonly nameMismatches: NameMismatch[];
}

/** Product codes are matched case-insensitively and space-insensitively. */
export function normaliseProductCode(code: string): string {
  return code
    .toUpperCase()
    .replace(/\s*-\s*/g, '-')
    .trim();
}

/**
 * What an extract would create, WITHOUT creating any of it.
 *
 * This is the preview. It runs at validation, so the counts and the lists can
 * be put in front of a person before a commit: nobody should discover 228 new
 * accounts after the fact, and a preview is only a preview if it can still be
 * stopped.
 */
export async function planMasterData(
  db: Client,
  accounts: readonly AccountRequest[],
  products: readonly ProductRequest[],
): Promise<MasterDataPlan> {
  const [accountRows, productRows] = await Promise.all([
    db.execute(
      `SELECT oracle_customer_code AS code, account_id, account_name FROM accounts
       WHERE oracle_customer_code IS NOT NULL`,
    ),
    db.execute(`SELECT product_code AS code, product_id FROM products`),
  ]);

  const existingAccounts = new Map<string, string>();
  const storedNames = new Map<string, string>();
  for (const raw of accountRows.rows as Record<string, unknown>[]) {
    const code = text(raw.code);
    existingAccounts.set(code, text(raw.account_id));
    storedNames.set(code, text(raw.account_name));
  }
  const existingProducts = new Map<string, string>();
  for (const raw of productRows.rows as Record<string, unknown>[]) {
    // Every product is indexed, active or not: creating a second row for a
    // code that exists but is inactive would break product_code's UNIQUE.
    existingProducts.set(normaliseProductCode(text(raw.code)), text(raw.product_id));
  }

  const accountsToCreate: AccountRequest[] = [];
  const nameMismatches: NameMismatch[] = [];
  const plannedAccounts = new Set<string>();
  for (const request of accounts) {
    const code = request.code.trim();
    if (code === '') continue;
    const existingId = existingAccounts.get(code);
    if (existingId !== undefined) {
      const stored = storedNames.get(code) ?? '';
      const fromFile = nullIfBlank(request.name);
      // A CODE THAT MATCHES WITH A DIFFERENT NAME IS NOT AN UPDATE. A customer
      // renamed in Oracle and a code reused for a different customer look
      // identical from here, and only a person can tell them apart. So the
      // stored name stands and the difference is raised.
      if (fromFile !== null && fromFile !== stored) {
        const already = nameMismatches.some((m) => m.code === code);
        if (!already) {
          nameMismatches.push({
            accountId: existingId,
            code,
            storedName: stored,
            fileName: fromFile,
          });
        }
      }
      continue;
    }
    if (plannedAccounts.has(code)) continue;
    plannedAccounts.add(code);
    accountsToCreate.push({ ...request, code });
  }

  const productsToCreate: ProductRequest[] = [];
  const plannedProducts = new Set<string>();
  for (const request of products) {
    const code = normaliseProductCode(request.code);
    if (code === '') continue;
    if (existingProducts.has(code) || plannedProducts.has(code)) continue;
    plannedProducts.add(code);
    productsToCreate.push({ ...request, code });
  }

  return { existingAccounts, existingProducts, accountsToCreate, productsToCreate, nameMismatches };
}

/**
 * The `Unclassified` category, created on first use.
 *
 * Under the existing `Other Products` group, which is where a product that is
 * not fuel, not aviation, not LPG and not a lubricant belongs. Returns its id.
 * Creating it here rather than seeding it keeps this phase free of schema and
 * seed changes, and means an installation that never auto-creates a product
 * never grows the category at all.
 */
export async function ensureUnclassifiedCategory(db: Client): Promise<string> {
  const found = await db.execute({
    sql: `SELECT product_category_id FROM product_categories WHERE category_code = ? LIMIT 1`,
    args: [UNCLASSIFIED_CATEGORY_CODE],
  });
  const existing = found.rows[0]?.product_category_id;
  if (existing !== undefined) return text(existing);

  const group = await db.execute({
    sql: `SELECT product_group_id FROM product_groups WHERE group_code = ? LIMIT 1`,
    args: [OTHER_PRODUCTS_GROUP_CODE],
  });
  const groupId = group.rows[0]?.product_group_id;
  if (groupId === undefined) {
    throw new Error(
      `The '${OTHER_PRODUCTS_GROUP_CODE}' product group is missing, so an unclassified ` +
        `product has nowhere to go. Configure the product groups before importing.`,
    );
  }
  const categoryId = newId('PC');
  await db.batch(
    [
      {
        sql: `INSERT INTO product_categories
                (product_category_id, product_group_id, parent_category_id, category_code,
                 category_name, default_uom, description, active, sort_order)
              VALUES (?, ?, NULL, ?, ?, NULL, ?, 1, 999)`,
        args: [
          categoryId,
          text(groupId),
          UNCLASSIFIED_CATEGORY_CODE,
          UNCLASSIFIED_CATEGORY_NAME,
          'Products created from an import and awaiting classification. ' +
            'The product hierarchy drives approval routing, so nothing is filed here by guess.',
        ],
      },
    ],
    'write',
  );
  return categoryId;
}

export interface CreatedMasterData {
  /** Code to id, for every account and product this created. */
  readonly accounts: Map<string, string>;
  readonly products: Map<string, string>;
  readonly nameMismatches: readonly NameMismatch[];
}

/**
 * Create what the plan says, and leave the trail that makes it findable.
 *
 * Each record is written with its audit event in the SAME batch, so an
 * account can never exist without the event that says where it came from.
 * That matters because the audit event is the only marker: without it the
 * account is indistinguishable from one somebody keyed in by hand.
 */
export async function createMasterData(
  db: Client,
  plan: MasterDataPlan,
  batchId: string,
  ctx: WriteContext,
  now: string,
): Promise<CreatedMasterData> {
  const accounts = new Map<string, string>();
  const products = new Map<string, string>();

  const audit = (
    eventType: string,
    entityType: string,
    entityId: string,
    after: unknown,
  ): Stmt => ({
    sql: `INSERT INTO audit_events
            (audit_event_id, actor_user_id, event_type, entity_type, entity_id, action,
             before_json, after_json, ip_address, user_agent, event_at)
          VALUES (?, ?, ?, ?, ?, 'CREATE', NULL, ?, ?, ?, ?)`,
    args: [
      newId('AUD'),
      ctx.actorUserId,
      eventType,
      entityType,
      entityId,
      JSON.stringify(after),
      ctx.ip,
      ctx.userAgent,
      now,
    ],
  });

  // ---- Accounts --------------------------------------------------------------
  if (plan.accountsToCreate.length > 0) {
    // The country comes from the affiliate the row named, resolved once for
    // the whole plan rather than per row.
    const countryByAffiliate = new Map<string, string>();
    const affiliateRows = await db.execute(`SELECT affiliate_id, country_id FROM affiliates`);
    for (const raw of affiliateRows.rows as Record<string, unknown>[]) {
      countryByAffiliate.set(text(raw.affiliate_id), text(raw.country_id));
    }

    const statements: Stmt[] = [];
    for (const request of plan.accountsToCreate) {
      const countryId =
        request.affiliateId === null ? null : (countryByAffiliate.get(request.affiliateId) ?? null);
      if (countryId === null) {
        // accounts.country_id is NOT NULL, so an account whose affiliate names
        // no country cannot be written. It stays unresolved and is reported,
        // rather than being parked in an arbitrary country.
        continue;
      }
      const accountId = newId('ACC');
      accounts.set(request.code, accountId);
      statements.push({
        // NO CREDIT LIMIT, NO CREDIT DAYS, NO ACCOUNT MANAGER: the file
        // carries none of the three, and inventing any of them here would be
        // read downstream as a commercial decision somebody made.
        sql: `INSERT INTO accounts
                (account_id, account_code, account_name, account_type, oracle_customer_code,
                 industry, segment, country_id, affiliate_id, address, phone, email, website,
                 tax_pin, credit_limit, credit_days, account_manager_user_id, customer_since,
                 status, created_at, updated_at)
              VALUES (?, NULL, ?, 'CUSTOMER', ?, NULL, NULL, ?, ?, NULL, NULL, NULL, NULL,
                      NULL, NULL, NULL, NULL, NULL, 'ACTIVE', ?, ?)`,
        args: [
          accountId,
          // The name from the file, or the code where the file gives none: an
          // account_name is NOT NULL and a code is at least true.
          nullIfBlank(request.name) ?? request.code,
          request.code,
          countryId,
          request.affiliateId,
          now,
          now,
        ],
      });
      statements.push(
        audit(ACCOUNT_CREATED, 'ACCOUNT', accountId, {
          importBatchId: batchId,
          oracleCustomerCode: request.code,
          accountName: nullIfBlank(request.name) ?? request.code,
          affiliateId: request.affiliateId,
          countryId,
          createdBy: 'IMPORT',
          awaitingReview: true,
        }),
      );
    }
    for (let start = 0; start < statements.length; start += 200) {
      await db.batch(statements.slice(start, start + 200), 'write');
    }
  }

  // ---- Products --------------------------------------------------------------
  if (plan.productsToCreate.length > 0) {
    const categoryId = await ensureUnclassifiedCategory(db);
    const statements: Stmt[] = [];
    for (const request of plan.productsToCreate) {
      const productId = newId('PROD');
      products.set(request.code, productId);
      statements.push({
        // The code stands in as the name until somebody improves it. A name
        // invented from the code would look like a description of the product
        // and be one nobody wrote.
        sql: `INSERT INTO products
                (product_id, product_code, product_name, product_category_id, unit_of_measure,
                 active, created_at)
              VALUES (?, ?, ?, ?, ?, 1, ?)`,
        args: [
          productId,
          request.code,
          request.code,
          categoryId,
          nullIfBlank(request.unitOfMeasure) ?? DEFAULT_UNIT_OF_MEASURE,
          now,
        ],
      });
      statements.push(
        audit(PRODUCT_CREATED, 'PRODUCT', productId, {
          importBatchId: batchId,
          productCode: request.code,
          productCategoryId: categoryId,
          categoryCode: UNCLASSIFIED_CATEGORY_CODE,
          unitOfMeasure: nullIfBlank(request.unitOfMeasure) ?? DEFAULT_UNIT_OF_MEASURE,
          unitOfMeasureFromFile: nullIfBlank(request.unitOfMeasure) !== null,
          createdBy: 'IMPORT',
          awaitingReview: true,
        }),
      );
    }
    for (let start = 0; start < statements.length; start += 200) {
      await db.batch(statements.slice(start, start + 200), 'write');
    }
  }

  // ---- Name mismatches -------------------------------------------------------
  if (plan.nameMismatches.length > 0) {
    const statements: Stmt[] = plan.nameMismatches.map((mismatch) => ({
      sql: `INSERT INTO audit_events
              (audit_event_id, actor_user_id, event_type, entity_type, entity_id, action,
               before_json, after_json, ip_address, user_agent, event_at)
            VALUES (?, ?, ?, 'ACCOUNT', ?, 'REVIEW', ?, ?, ?, ?, ?)`,
      args: [
        newId('AUD'),
        ctx.actorUserId,
        ACCOUNT_NAME_MISMATCH,
        mismatch.accountId,
        JSON.stringify({ accountName: mismatch.storedName }),
        JSON.stringify({
          importBatchId: batchId,
          oracleCustomerCode: mismatch.code,
          nameInFile: mismatch.fileName,
          storedName: mismatch.storedName,
          // Said explicitly, because the whole point of this event is that
          // the file did NOT win.
          overwritten: false,
          awaitingReview: true,
        }),
        ctx.ip,
        ctx.userAgent,
        now,
      ],
    }));
    for (let start = 0; start < statements.length; start += 200) {
      await db.batch(statements.slice(start, start + 200), 'write');
    }
  }

  return { accounts, products, nameMismatches: plan.nameMismatches };
}

/** One record an import created, or one name it declined to overwrite. */
export interface ImportOrigin {
  readonly entityType: string;
  readonly entityId: string;
  readonly importBatchId: string;
  readonly code: string;
  readonly name: string;
  readonly createdAt: string;
}

/** Everything an import created, newest first, for the review queue. */
export async function listCreatedFromImport(
  db: Client,
  limit = 500,
): Promise<{ accounts: ImportOrigin[]; products: ImportOrigin[]; mismatches: ImportOrigin[] }> {
  const rows = await db.execute({
    sql: `SELECT event_type, entity_type, entity_id, after_json, event_at
          FROM audit_events
          WHERE event_type IN (?, ?, ?)
          ORDER BY event_at DESC, audit_event_id DESC
          LIMIT ?`,
    args: [ACCOUNT_CREATED, PRODUCT_CREATED, ACCOUNT_NAME_MISMATCH, limit],
  });
  const accounts: ImportOrigin[] = [];
  const products: ImportOrigin[] = [];
  const mismatches: ImportOrigin[] = [];
  for (const raw of rows.rows as Record<string, unknown>[]) {
    let after: Record<string, unknown> = {};
    try {
      after = JSON.parse(text(raw.after_json)) as Record<string, unknown>;
    } catch {
      // An unparseable payload must not hide the row: the entity and the
      // event type are still true, and an empty payload renders as blanks.
    }
    const origin: ImportOrigin = {
      entityType: text(raw.entity_type),
      entityId: text(raw.entity_id),
      importBatchId: text(after.importBatchId ?? ''),
      code: text(after.oracleCustomerCode ?? after.productCode ?? ''),
      name: text(after.accountName ?? after.productCode ?? ''),
      createdAt: text(raw.event_at),
    };
    const eventType = text(raw.event_type);
    if (eventType === ACCOUNT_CREATED) accounts.push(origin);
    else if (eventType === PRODUCT_CREATED) products.push(origin);
    else mismatches.push({ ...origin, name: text(after.nameInFile ?? '') });
  }
  return { accounts, products, mismatches };
}
