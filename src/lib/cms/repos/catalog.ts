/**
 * Catalogue and pricing, ported from the source product and price-list services.
 * Products are the fuel and lubricant lines; each carries prices across one or
 * more price lists (per country/segment/customer). Scoped within the acting
 * tenant. Every column comes from the typed layer, so a wrong name fails the
 * build.
 */
import type { Client, InArgs } from '@libsql/client/web';
import { C, cols } from '@cms/schema/columns';

const PR = cols(C.products);
const PL = cols(C.price_list);
const PLI = cols(C.price_list_items);

export interface ProductFilters {
  q?: string;
  category?: string;
}

export interface ProductRow {
  productId: string;
  sku: string;
  name: string;
  category: string | null;
  unitOfMeasure: string | null;
  isActive: boolean;
}

export interface PriceRow {
  priceListName: string | null;
  countryCode: string | null;
  currencyCode: string | null;
  unitPrice: number | null;
  minQuantity: number | null;
  discountPercent: number | null;
  taxRate: number | null;
}

export interface PriceListRow {
  priceId: string;
  name: string | null;
  countryCode: string | null;
  currencyCode: string | null;
  status: string | null;
  isDefault: boolean;
  itemCount: number;
}

const s = (v: unknown): string | null => (v == null ? null : String(v));
const num = (v: unknown): number | null => (v == null ? null : Number(v));

/** Products for the catalogue, with optional search and category filters. */
export async function listProducts(
  db: Client,
  filters: ProductFilters = {},
): Promise<ProductRow[]> {
  const args: InArgs = [];
  const where: string[] = [];
  if (filters.q && filters.q.trim()) {
    where.push(`(${PR.sku} LIKE ? OR ${PR.name} LIKE ?)`);
    args.push(`%${filters.q.trim()}%`, `%${filters.q.trim()}%`);
  }
  if (filters.category) {
    where.push(`${PR.category} = ?`);
    args.push(filters.category);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const res = await db.execute({
    sql: `SELECT ${PR.product_id} AS id, ${PR.sku} AS sku, ${PR.name} AS name,
                 ${PR.category} AS category, ${PR.unit_of_measure} AS uom, ${PR.is_active} AS is_active
            FROM products ${clause}
        ORDER BY ${PR.category} ASC, ${PR.name} ASC
           LIMIT 500`,
    args,
  });
  return res.rows.map((r) => ({
    productId: String(r.id),
    sku: String(r.sku ?? r.id),
    name: String(r.name ?? '-'),
    category: s(r.category),
    unitOfMeasure: s(r.uom),
    isActive: Number(r.is_active) === 1,
  }));
}

export type ProductDetail = Record<string, unknown> & { productId: string; name: string };

/** A single product and its price rows across price lists, or null when absent. */
export async function getProduct(
  db: Client,
  id: string,
): Promise<{ product: ProductDetail; prices: PriceRow[] } | null> {
  const res = await db.execute({
    sql: `SELECT * FROM products WHERE ${PR.product_id} = ? LIMIT 1`,
    args: [id],
  });
  const row = res.rows[0];
  if (!row) return null;
  const product = { ...row } as Record<string, unknown>;
  product.productId = String(row.product_id);
  product.name = String(row.name ?? row.product_id);

  const priceRes = await db.execute({
    sql: `SELECT pl.name AS price_list_name, pl.country_code AS country_code,
                 pl.currency_code AS currency_code, ${PLI.unit_price} AS unit_price,
                 ${PLI.min_quantity} AS min_quantity, ${PLI.discount_percent} AS discount_percent,
                 ${PLI.tax_rate} AS tax_rate
            FROM price_list_items pli
            JOIN price_list pl ON pl.price_id = ${PLI.price_list_id}
           WHERE ${PLI.product_id} = ?
        ORDER BY pl.country_code ASC`,
    args: [id],
  });
  const prices: PriceRow[] = priceRes.rows.map((r) => ({
    priceListName: s(r.price_list_name),
    countryCode: s(r.country_code),
    currencyCode: s(r.currency_code),
    unitPrice: num(r.unit_price),
    minQuantity: num(r.min_quantity),
    discountPercent: num(r.discount_percent),
    taxRate: num(r.tax_rate),
  }));
  return { product: product as ProductDetail, prices };
}

/** The price lists, with a count of the products each covers. */
export async function listPriceLists(db: Client): Promise<PriceListRow[]> {
  const res = await db.execute(
    `SELECT ${PL.price_id} AS id, ${PL.name} AS name, ${PL.country_code} AS country_code,
            ${PL.currency_code} AS currency_code, ${PL.status} AS status, ${PL.is_default} AS is_default,
            (SELECT COUNT(*) FROM price_list_items pli WHERE pli.price_list_id = ${PL.price_id}) AS item_count
       FROM price_list
   ORDER BY ${PL.country_code} ASC, ${PL.is_default} DESC`,
  );
  return res.rows.map((r) => ({
    priceId: String(r.id),
    name: s(r.name),
    countryCode: s(r.country_code),
    currencyCode: s(r.currency_code),
    status: s(r.status),
    isDefault: Number(r.is_default) === 1,
    itemCount: Number(r.item_count ?? 0),
  }));
}
