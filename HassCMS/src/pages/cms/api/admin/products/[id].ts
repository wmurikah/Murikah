/**
 * GET and PATCH /api/admin/products/{id} on cms.murikah.com.
 *
 * GET returns a product whatever its status, so a historical lookup still finds
 * one that has been retired. Deactivation means unavailable for new selection,
 * not gone: `ON DELETE RESTRICT` on `products.product_category_id` already
 * prevents removing a category that has products, and there is no delete verb
 * here either.
 *
 * The `available` flag on the row is the answer to "may this be chosen for a
 * new record?", and it is false when the product is inactive OR when any
 * category above it, or its group, is inactive. Its own `active` flag is
 * reported separately, so an administrator can tell "this product was retired"
 * from "the group it sits in was retired".
 *
 * `product_code` is not updatable, for the same reason a group code is not: it
 * is what an import file and a spreadsheet quote.
 */
import type { APIRoute } from 'astro';
import { requireCatalogueManage, writeContext } from '../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../lib/cms/admin/crudRoute.ts';
import { validateProduct } from '../../../../../lib/cms/admin/catalogueInput.ts';
import { getProduct, updateProduct } from '../../../../../lib/cms/repos/catalogueAdmin.ts';
import {
  failure,
  invalid,
  methodNotAllowed,
  ok,
  readJson,
  serverError,
} from '../../../../../lib/cms/admin/respond.ts';
import { notFound } from '../../../../../lib/cms/errors.ts';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const auth = requireCatalogueManage(context);
  if (!auth.ok) return auth.response;

  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    const product = await getProduct(connection.db, context.params.id ?? '');
    return product === null ? notFound('That product could not be found.') : ok(product);
  } catch (error) {
    return serverError('admin.products.get', error);
  }
};

export const PATCH: APIRoute = async (context) => {
  const auth = requireCatalogueManage(context);
  if (!auth.ok) return auth.response;

  const id = context.params.id ?? '';
  const parsed = validateProduct(await readJson(context.request));
  if (!parsed.ok) return invalid(parsed.errors);

  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    const existing = await getProduct(connection.db, id);
    if (existing === null) return notFound('That product could not be found.');
    const result = await updateProduct(
      connection.db,
      id,
      { ...parsed.value, productCode: existing.productCode },
      writeContext(context.request, auth.principal),
    );
    return result.ok ? ok(result.value) : failure(result);
  } catch (error) {
    return serverError('admin.products.update', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET or PATCH');
