/**
 * GET and POST /api/admin/products on cms.murikah.com.
 *
 * GET filters, searches and paginates in the database. The query string carries
 * `q`, `availability`, `group`, `category` and `page`; the answer carries the
 * page and the total. A catalogue that grows to ten thousand products is never
 * shipped whole to the browser for a select element to filter, which is the
 * failure this endpoint exists to prevent.
 *
 * Search is case-insensitive by an explicit `COLLATE NOCASE` on each
 * comparison, because `product_code`, `product_name`, `category_name` and
 * `group_name` are declared without it, unlike `users.email`. That makes the
 * behaviour a property of the query rather than of a column definition somebody
 * may change.
 *
 * POST requires a unit of measure. `products.unit_of_measure` is NOT NULL and
 * nothing here defaults it: the category's `default_uom` pre-fills the field in
 * the form and does not replace it, because a drum of lubricant is sold by the
 * unit and a catalogue that assumed litres would be wrong the first time
 * somebody added one.
 */
import type { APIRoute } from 'astro';
import { requireCatalogueManage, writeContext } from '../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../lib/cms/admin/crudRoute.ts';
import { readProductQuery, validateProduct } from '../../../../../lib/cms/admin/catalogueInput.ts';
import { createProduct, listProducts } from '../../../../../lib/cms/repos/catalogueAdmin.ts';
import {
  failure,
  invalid,
  methodNotAllowed,
  ok,
  readJson,
  serverError,
} from '../../../../../lib/cms/admin/respond.ts';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const auth = requireCatalogueManage(context);
  if (!auth.ok) return auth.response;

  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    const page = await listProducts(connection.db, readProductQuery(context.url.searchParams));
    return ok(page);
  } catch (error) {
    return serverError('admin.products.list', error);
  }
};

export const POST: APIRoute = async (context) => {
  const auth = requireCatalogueManage(context);
  if (!auth.ok) return auth.response;

  const parsed = validateProduct(await readJson(context.request));
  if (!parsed.ok) return invalid(parsed.errors);

  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    const result = await createProduct(
      connection.db,
      parsed.value,
      writeContext(context.request, auth.principal),
    );
    return result.ok ? ok(result.value, 201) : failure(result);
  } catch (error) {
    return serverError('admin.products.create', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET or POST');
