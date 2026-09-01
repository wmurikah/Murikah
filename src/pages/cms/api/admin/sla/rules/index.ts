/**
 * GET and POST /api/admin/sla/rules on cms.murikah.com.
 *
 * Durations arrive as typed text and are converted against the rule's own
 * calendar in the repository, so "1 business day" means that calendar's
 * working window. The stored minutes come back in the response, shown beside
 * whatever the administrator typed.
 */
import type { APIRoute } from 'astro';
import { requireSlaRulesManage, writeContext } from '../../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../../lib/cms/admin/crudRoute.ts';
import { validateRule } from '../../../../../../lib/cms/admin/slaInput.ts';
import { createRule, listRules } from '../../../../../../lib/cms/repos/slaAdmin.ts';
import {
  failure,
  invalid,
  methodNotAllowed,
  ok,
  readJson,
  serverError,
} from '../../../../../../lib/cms/admin/respond.ts';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const auth = requireSlaRulesManage(context);
  if (!auth.ok) return auth.response;
  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    return ok({ items: await listRules(connection.db) });
  } catch (error) {
    return serverError('admin.sla.rules.list', error);
  }
};

export const POST: APIRoute = async (context) => {
  const auth = requireSlaRulesManage(context);
  if (!auth.ok) return auth.response;
  const parsed = validateRule(await readJson(context.request));
  if (!parsed.ok) return invalid(parsed.errors);
  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    const result = await createRule(
      connection.db,
      parsed.value,
      writeContext(context.request, auth.principal),
    );
    return result.ok ? ok({ items: result.value }) : failure(result);
  } catch (error) {
    return serverError('admin.sla.rules.create', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET or POST');
