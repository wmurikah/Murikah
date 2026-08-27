/**
 * GET /api/admin/catalogue/hierarchy on cms.murikah.com.
 *
 * The whole catalogue in one call, for the tree and for every cascading
 * selector. One HTTP request, and behind it ONE SQL query: a `UNION ALL` over
 * the three tables with a recursive CTE computing depth and availability, and
 * a single pass assembling the flat rows into the nested shape below.
 *
 * Not one query per node, and not even one per table. A tree assembled by
 * walking the database is the N+1 this endpoint exists to prevent, and it is at
 * its worst exactly when the catalogue is large enough for a tree to matter.
 *
 * THE SHAPE
 *   {
 *     groups: [{ productGroupId, groupCode, groupName, active, sortOrder,
 *                categories: [{ productCategoryId, categoryCode, categoryName,
 *                               defaultUom, active, available, depth,
 *                               children: [ ...same shape, to depth 3... ],
 *                               products: [{ productId, productCode,
 *                                            productName, unitOfMeasure,
 *                                            active, available }] }] }],
 *     counts: { groups, categories, products },
 *     productsOmitted: boolean,
 *     maxDepth: 3
 *   }
 *
 * `available` is the answer to "may this be chosen for a new record?": the row
 * is active and every ancestor of it is active. It is computed in the query, so
 * an ancestor's status reaches its descendants without the caller recomputing
 * anything.
 *
 * AT SCALE
 * Groups and categories always come back: they are what a cascading selector
 * needs and they stay small, because the depth limit bounds the tree and a
 * catalogue with ten thousand products still has tens of groups and hundreds of
 * categories. Products do not: past `PRODUCT_INLINE_LIMIT` they are omitted,
 * `productsOmitted` says so, and the interface loads a category's products from
 * the paginated, server-side-searched /api/admin/products when that category is
 * opened. That is implemented rather than planned, so the behaviour at ten
 * thousand products is the behaviour that ships today.
 */
import type { APIRoute } from 'astro';
import { requireCatalogueManage } from '../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../lib/cms/admin/crudRoute.ts';
import { hierarchy } from '../../../../../lib/cms/repos/catalogueAdmin.ts';
import { methodNotAllowed, ok, serverError } from '../../../../../lib/cms/admin/respond.ts';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const auth = requireCatalogueManage(context);
  if (!auth.ok) return auth.response;

  const connection = await connect();
  if ('response' in connection) return connection.response;
  try {
    return ok(await hierarchy(connection.db));
  } catch (error) {
    return serverError('admin.catalogue.hierarchy', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET');
