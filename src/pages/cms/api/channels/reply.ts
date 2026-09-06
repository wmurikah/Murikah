import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { requestDb } from '@/lib/cms/db';
import { requireInquiriesReply } from '@/lib/cms/channels/access';
import { getChannelCredential } from '@/lib/cms/channels/credentials';
import { microsoftReplyToMessage } from '@/lib/cms/channels/microsoft';
import { microsoftAccessToken } from '@/lib/cms/channels/session';
import { newId } from '@/lib/cms/repos/authRecords';
import { addCommunication, getCase } from '@/lib/cms/repos/serviceAdmin';
import type { WriteContext } from '@/lib/cms/admin/guard';

export const prerender = false;

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export const POST: APIRoute = async (context) => {
  const auth = requireInquiriesReply(context);
  if (!auth.ok) return auth.response;
  const body = (await context.request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) {
    return Response.json({ errors: [{ field: 'body', message: 'Send JSON.' }] }, { status: 400 });
  }
  const channelMessageId = text(body.channelMessageId);
  const message = text(body.message);
  if (!channelMessageId || message.length < 2) {
    return Response.json(
      { errors: [{ field: 'message', message: 'Write the reply.' }] },
      { status: 400 },
    );
  }
  if (message.length > 4000) {
    return Response.json(
      { errors: [{ field: 'message', message: 'Keep the reply below 4,000 characters.' }] },
      { status: 400 },
    );
  }

  try {
    const db = await requestDb(context.locals);
    const pointer = await db.execute({
      sql: `SELECT case_id FROM channel_messages
             WHERE channel_message_id = ? AND direction = 'INBOUND' LIMIT 1`,
      args: [channelMessageId],
    });
    const caseId = String(
      (pointer.rows[0] as Record<string, unknown> | undefined)?.case_id ?? '',
    );
    if (!caseId) {
      return Response.json(
        {
          errors: [
            {
              field: 'case',
              message: 'Review and link this inquiry to a Helpdesk case before replying.',
            },
          ],
        },
        { status: 409 },
      );
    }
    if (!(await getCase(db, auth.userId, caseId))) {
      return Response.json(
        { errors: [{ field: 'case', message: 'That case is outside your access.' }] },
        { status: 403 },
      );
    }

    const found = await db.execute({
      sql: `SELECT cm.channel_connection_id, cm.external_message_id, cm.from_address,
                   cm.subject, cm.account_id, cm.contact_id, cc.channel
              FROM channel_messages cm
              JOIN channel_connections cc ON cc.channel_connection_id = cm.channel_connection_id
             WHERE cm.channel_message_id = ? AND cm.case_id = ? LIMIT 1`,
      args: [channelMessageId, caseId],
    });
    const row = found.rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      return Response.json(
        { errors: [{ field: 'message', message: 'Inquiry not found.' }] },
        { status: 404 },
      );
    }
    if (String(row.channel) !== 'EMAIL') {
      return Response.json(
        {
          errors: [
            {
              field: 'channel',
              message: 'WhatsApp replies become available after the Meta connection is completed.',
            },
          ],
        },
        { status: 409 },
      );
    }

    const credential = await getChannelCredential(db, 'INQUIRY_EMAIL');
    if (!credential || credential.channelConnectionId !== String(row.channel_connection_id)) {
      return Response.json(
        { errors: [{ field: 'connection', message: 'The inquiry mailbox needs to be connected.' }] },
        { status: 409 },
      );
    }
    const recipient = String(row.from_address ?? '').trim();
    if (!recipient) {
      return Response.json(
        { errors: [{ field: 'recipient', message: 'This inquiry has no reply address.' }] },
        { status: 409 },
      );
    }

    const token = await microsoftAccessToken(db, env, credential);
    if (!token.ok) {
      return Response.json(
        { errors: [{ field: 'connection', message: token.error }] },
        { status: 409 },
      );
    }
    const sent = await microsoftReplyToMessage(
      token.accessToken,
      String(row.external_message_id),
      message,
    );
    if (!sent.ok) {
      return Response.json(
        { errors: [{ field: 'send', message: sent.error }] },
        { status: sent.auth ? 409 : 502 },
      );
    }

    const now = new Date();
    const stamp = now.toISOString().slice(0, 19).replace('T', ' ');
    const subject = String(row.subject ?? '').trim();
    const accountId = row.account_id == null ? null : String(row.account_id);
    const contactId = row.contact_id == null ? null : String(row.contact_id);
    const outboundId = newId('CHM');
    await db.execute({
      sql: `INSERT INTO channel_messages
              (channel_message_id, channel_connection_id, external_message_id, direction,
               from_address, to_address, subject, body, received_at, account_id,
               contact_id, case_id, status, raw_json, created_at)
            VALUES (?, ?, ?, 'OUTBOUND', ?, ?, ?, ?, ?, ?, ?, ?, 'LINKED', ?, ?)`,
      args: [
        outboundId,
        credential.channelConnectionId,
        `outbound:${crypto.randomUUID()}`,
        credential.accountIdentifier,
        recipient,
        subject ? `Re: ${subject.replace(/^Re:\s*/i, '')}` : 'Re: inquiry',
        message,
        stamp,
        accountId,
        contactId,
        caseId,
        JSON.stringify({ provider: 'MICROSOFT', inReplyTo: String(row.external_message_id) }),
        stamp,
      ],
    });

    const writeContext: WriteContext = {
      actorUserId: auth.userId,
      ip: null,
      userAgent: context.request.headers.get('user-agent'),
      now,
    };
    const recorded = await addCommunication(
      db,
      auth.userId,
      caseId,
      {
        direction: 'OUTBOUND',
        channel: 'EMAIL',
        contactId,
        subject: subject ? `Re: ${subject.replace(/^Re:\s*/i, '')}` : null,
        messageSummary: message,
        communicatedAt: stamp,
      },
      writeContext,
    );
    if (!recorded.ok) {
      console.error('[cms.channels.reply] provider sent but case communication log failed', recorded);
    }
    return Response.json({ ok: true, channelMessageId: outboundId });
  } catch (error) {
    console.error('[cms.channels.reply]', error instanceof Error ? error.message : String(error));
    return Response.json(
      { errors: [{ field: 'send', message: 'The reply could not be sent just now.' }] },
      { status: 500 },
    );
  }
};
