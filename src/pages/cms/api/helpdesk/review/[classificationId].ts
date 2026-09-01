/**
 * POST /api/helpdesk/review/:classificationId.
 *
 * A person's decision on one suggestion: accept it, correct it, or reject it.
 * This is the only path from a suggestion to a case that a human walks, and
 * the module refuses a second decision on the same suggestion, so two
 * reviewers pressing Accept at once produce one case and one plain message.
 */
import type { APIRoute } from 'astro';
import { requireCasesCreate, writeContext } from '../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../lib/cms/admin/crudRoute.ts';
import { reviewClassification } from '../../../../../lib/cms/ai/inbox.ts';
import {
  invalid,
  methodNotAllowed,
  ok,
  serverError,
} from '../../../../../lib/cms/admin/respond.ts';

export const prerender = false;

const ACTIONS = ['ACCEPT', 'CORRECT', 'REJECT'] as const;

export const POST: APIRoute = async (context) => {
  const auth = requireCasesCreate(context);
  if (!auth.ok) return auth.response;
  const id = String(context.params.classificationId ?? '');
  const body = (await context.request.json().catch(() => null)) as Record<string, unknown> | null;
  if (body === null) return invalid([{ field: 'body', message: 'Send JSON.' }]);
  const action = String(body.action ?? '');
  if (!(ACTIONS as readonly string[]).includes(action))
    return invalid([{ field: 'action', message: 'Accept, correct or reject it.' }]);

  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    const nullable = (v: unknown): string | null =>
      v === undefined || v === null || v === '' ? null : String(v);
    const result = await reviewClassification(
      connection.db,
      id,
      {
        action: action as 'ACCEPT' | 'CORRECT' | 'REJECT',
        caseType: nullable(body.caseType),
        categoryId: nullable(body.categoryId),
        priority: nullable(body.priority),
        accountId: nullable(body.accountId),
      },
      writeContext(context.request, auth.principal),
    );
    return result.ok
      ? ok({ caseId: result.caseId, reviewStatus: result.reviewStatus })
      : invalid([{ field: 'action', message: result.reason ?? 'That could not be done.' }]);
  } catch (error) {
    return serverError('helpdesk.review', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('POST');
