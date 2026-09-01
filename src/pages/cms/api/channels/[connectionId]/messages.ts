/**
 * POST /api/channels/:connectionId/messages.
 *
 * Where a poll or a webhook delivers inbound messages. Writing the same
 * external id twice is safe by construction: the table carries
 * UNIQUE(channel_connection_id, external_message_id) and the insert is a
 * single statement that defers to it, so a retried delivery is a no-op decided
 * by the database rather than by a check with a race inside it.
 *
 * Classification is attempted per message and is allowed to fail: a message
 * that lands and is not classified sits in the queue, which is exactly the
 * state a connection with no active provider produces.
 */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { requireCasesManage, writeContext } from '../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../lib/cms/admin/crudRoute.ts';
import { ingestMessage, classifyMessage } from '../../../../../lib/cms/ai/inbox.ts';
import { getConnection } from '../../../../../lib/cms/ai/channels.ts';
import {
  invalid,
  methodNotAllowed,
  ok,
  serverError,
} from '../../../../../lib/cms/admin/respond.ts';

export const prerender = false;

export const POST: APIRoute = async (context) => {
  const auth = requireCasesManage(context);
  if (!auth.ok) return auth.response;
  const connectionId = String(context.params.connectionId ?? '');
  const body = (await context.request.json().catch(() => null)) as Record<string, unknown> | null;
  if (body === null) return invalid([{ field: 'body', message: 'Send JSON.' }]);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (messages.length === 0)
    return invalid([{ field: 'messages', message: 'Send at least one message.' }]);

  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  const ctx = writeContext(context.request, auth.principal);

  try {
    const target = await getConnection(connection.db, connectionId);
    if (target === null)
      return invalid([{ field: 'connectionId', message: 'No such connection.' }]);
    if (target.status === 'DISABLED')
      return invalid([{ field: 'connectionId', message: 'That connection is disabled.' }]);

    let stored = 0;
    let alreadyHeld = 0;
    let classified = 0;
    let queued = 0;
    let note: string | null = null;

    for (const raw of messages) {
      const message = raw as Record<string, unknown>;
      const externalId = String(message.externalMessageId ?? '').trim();
      if (externalId === '') continue;
      const result = await ingestMessage(connection.db, {
        channelConnectionId: connectionId,
        externalMessageId: externalId,
        fromAddress: message.from === undefined ? null : String(message.from),
        toAddress: message.to === undefined ? null : String(message.to),
        subject: message.subject === undefined ? null : String(message.subject),
        body: message.body === undefined ? null : String(message.body),
        receivedAt: String(message.receivedAt ?? ctx.now.toISOString()),
        raw: message.raw,
      });
      if (result.stored) stored += 1;
      else {
        alreadyHeld += 1;
        // ALREADY HELD MEANS ALREADY HANDLED. Re-classifying a message this
        // system has seen would spend a model call to reach the same answer,
        // and would race the review somebody may already have made on it.
        continue;
      }
      if (result.channelMessageId === null) continue;
      const outcome = await classifyMessage(
        connection.db,
        result.channelMessageId,
        env as unknown as Record<string, unknown>,
        ctx,
      );
      if (outcome.classified) classified += 1;
      else {
        queued += 1;
        note = outcome.reason;
      }
    }

    await connection.db.execute({
      sql: `UPDATE channel_connections SET last_polled_at = ? WHERE channel_connection_id = ?`,
      args: [ctx.now.toISOString().slice(0, 19).replace('T', ' '), connectionId],
    });

    return ok({ stored, alreadyHeld, classified, queued, note });
  } catch (error) {
    return serverError('channels.ingest', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('POST');
