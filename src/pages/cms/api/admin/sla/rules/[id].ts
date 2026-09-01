/**
 * PATCH /api/admin/sla/rules/{id} on cms.murikah.com.
 */
import type { APIRoute } from 'astro';
import { requireSlaRulesManage, writeContext } from '../../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../../lib/cms/admin/crudRoute.ts';
import { validateRule } from '../../../../../../lib/cms/admin/slaInput.ts';
import { updateRule } from '../../../../../../lib/cms/repos/slaAdmin.ts';
import {
  failure,
  invalid,
  methodNotAllowed,
  ok,
  readJson,
  serverError,
} from '../../../../../../lib/cms/admin/respond.ts';

export const prerender = false;

export const PATCH: APIRoute = async (context) => {
  const auth = requireSlaRulesManage(context);
  if (!auth.ok) return auth.response;
  const parsed = validateRule(await readJson(context.request));
  if (!parsed.ok) return invalid(parsed.errors);
  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    const result = await updateRule(
      connection.db,
      context.params.id ?? '',
      parsed.value,
      writeContext(context.request, auth.principal),
    );
    return result.ok ? ok({ items: result.value }) : failure(result);
  } catch (error) {
    return serverError('admin.sla.rules.update', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('PATCH');
