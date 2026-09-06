import type { APIRoute } from 'astro';
import { requestDb } from '@/lib/cms/db';
import { requireChannelsManage } from '@/lib/cms/channels/access';
import {
  CHANNEL_PURPOSES,
  channelCredentialsReady,
  disconnectChannelPurpose,
  type ChannelPurpose,
} from '@/lib/cms/channels/credentials';

export const prerender = false;

function isPurpose(value: unknown): value is ChannelPurpose {
  return typeof value === 'string' && CHANNEL_PURPOSES.includes(value as ChannelPurpose);
}

export const POST: APIRoute = async (context) => {
  const auth = requireChannelsManage(context);
  if (!auth.ok) return auth.response;

  const body = (await context.request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || !isPurpose(body.purpose)) {
    return Response.json(
      { errors: [{ field: 'purpose', message: 'Choose the connection to disconnect.' }] },
      { status: 400 },
    );
  }

  try {
    const db = await requestDb(context.locals);
    if (!(await channelCredentialsReady(db))) {
      return Response.json(
        { errors: [{ field: 'setup', message: 'Channels & Communications is not configured yet.' }] },
        { status: 409 },
      );
    }
    const disconnected = await disconnectChannelPurpose(db, body.purpose, auth.userId);
    return Response.json({ ok: true, disconnected });
  } catch (error) {
    console.error('[cms.admin.channels.disconnect]', error instanceof Error ? error.message : String(error));
    return Response.json(
      { errors: [{ field: 'connection', message: 'The connection could not be disconnected.' }] },
      { status: 500 },
    );
  }
};

export const ALL: APIRoute = () =>
  Response.json({ errors: [{ field: 'method', message: 'Use POST.' }] }, { status: 405 });
