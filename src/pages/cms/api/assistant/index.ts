/**
 * POST /api/assistant on cms.murikah.com.
 *
 * One door: it starts a conversation where none is named, and asks. The scope
 * check lives in the module and is re-run on every turn, so this route holds
 * no access logic of its own to fall out of step with it.
 *
 * SIX ROUND TRIPS AND ONE SUBREQUEST for a question on an existing
 * conversation: the conversation, the history, two scope resolutions, two
 * context reads, two message writes and the conversation touch, several of
 * which the request-scoped scope cache collapses. It is a POST, not a page, so
 * it spends nothing from a page's budget.
 */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { writeContext } from '../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../lib/cms/admin/crudRoute.ts';
import { ask, startConversation } from '../../../../lib/cms/ai/assistant.ts';
import { invalid, methodNotAllowed, ok, serverError } from '../../../../lib/cms/admin/respond.ts';

export const prerender = false;

export const POST: APIRoute = async (context) => {
  // ANY SIGNED-IN INTERNAL USER. The assistant grants nothing: it can only
  // show a person what their own scope already lets them open, so gating it on
  // a further code would deny people access to their own records.
  const principal = context.locals.cms;
  if (principal === undefined || principal.user.userType !== 'INTERNAL') {
    return new Response(JSON.stringify({ error: 'Sign in to use the assistant.' }), {
      status: 401,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }

  const body = (await context.request.json().catch(() => null)) as Record<string, unknown> | null;
  if (body === null) return invalid([{ field: 'body', message: 'Send JSON.' }]);
  const question = String(body.question ?? '').trim();
  if (question === '') return invalid([{ field: 'question', message: 'Ask something.' }]);
  if (question.length > 2000)
    return invalid([{ field: 'question', message: 'That is too long to send.' }]);

  const connection = await connect();
  if ('response' in connection) return connection.response;
  const ctx = writeContext(context.request, principal);

  try {
    let conversationId = String(body.conversationId ?? '');
    if (conversationId === '') {
      const started = await startConversation(
        connection.db,
        principal.user.userId,
        {
          entityType: body.entityType === undefined ? null : String(body.entityType),
          entityId: body.entityId === undefined ? null : String(body.entityId),
          title: question.slice(0, 80),
        },
        ctx,
      );
      // REFUSED BEFORE ANYTHING IS WRITTEN. A conversation about a record the
      // asker cannot open never exists.
      if (!started.ok) return ok({ ok: false, answer: started.reason }, 403);
      conversationId = started.conversationId;
    }

    const result = await ask(
      connection.db,
      principal.user.userId,
      conversationId,
      question,
      env as unknown as Record<string, unknown>,
      ctx,
    );
    return ok(result, result.conversationId === null ? 403 : 200);
  } catch (error) {
    return serverError('assistant.ask', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('POST');
