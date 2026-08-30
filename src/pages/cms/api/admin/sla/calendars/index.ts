/**
 * GET /api/admin/sla/calendars, POST adds a holiday.
 *
 * The five calendars are seeded and their working windows are read here;
 * holidays are the part an administrator actually maintains year to year.
 */
import type { APIRoute } from 'astro';
import { requireSlaRulesManage, writeContext } from '../../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../../lib/cms/admin/crudRoute.ts';
import { validateHoliday } from '../../../../../../lib/cms/admin/slaInput.ts';
import { addHoliday, listCalendars } from '../../../../../../lib/cms/repos/slaAdmin.ts';
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
  const connection = await connect();
  if ('response' in connection) return connection.response;
  try {
    return ok({ items: await listCalendars(connection.db) });
  } catch (error) {
    return serverError('admin.sla.calendars.list', error);
  }
};

export const POST: APIRoute = async (context) => {
  const auth = requireSlaRulesManage(context);
  if (!auth.ok) return auth.response;
  const parsed = validateHoliday(await readJson(context.request));
  if (!parsed.ok) return invalid(parsed.errors);
  const connection = await connect();
  if ('response' in connection) return connection.response;
  try {
    const result = await addHoliday(
      connection.db,
      parsed.value.calendarId,
      parsed.value.holidayDate,
      parsed.value.holidayName,
      writeContext(context.request, auth.principal),
    );
    return result.ok ? ok({ items: result.value }) : failure(result);
  } catch (error) {
    return serverError('admin.sla.calendars.holiday', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET or POST');
