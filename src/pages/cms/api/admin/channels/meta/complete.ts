import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { requestDb } from '@/lib/cms/db';
import { requireChannelsManage } from '@/lib/cms/channels/access';
import { channelCredentialsReady, saveMetaChannel } from '@/lib/cms/channels/credentials';
import { exchangeMetaCode, metaPhoneNumber, subscribeMetaApp } from '@/lib/cms/channels/meta';
import { loadMetaConfig } from '@/lib/cms/channels/providerSettings';
import { sealChannelSecret } from '@/lib/cms/channels/secretBox';

export const prerender = false;

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

export const POST: APIRoute = async (context) => {
  const auth = requireChannelsManage(context);
  if (!auth.ok) return auth.response;
  const body = (await context.request.json().catch(() => null)) as Record<string, unknown> | null;
  const code = text(body?.code);
  const wabaId = text(body?.wabaId);
  const phoneNumberId = text(body?.phoneNumberId);
  if (!code || !wabaId) {
    return Response.json(
      {
        errors: [
          {
            field: 'signup',
            message: 'WhatsApp pairing did not return the required account details.',
          },
        ],
      },
      { status: 400 },
    );
  }

  try {
    const db = await requestDb(context.locals);
    if (!(await channelCredentialsReady(db))) {
      return Response.json(
        {
          errors: [
            {
              field: 'setup',
              message: 'Run the Channels & Communications database setup first.',
            },
          ],
        },
        { status: 409 },
      );
    }
    const config = await loadMetaConfig(db, env);
    if (!config) {
      return Response.json(
        { errors: [{ field: 'setup', message: 'Complete the WhatsApp setup first.' }] },
        { status: 409 },
      );
    }

    const exchanged = await exchangeMetaCode(config, code);
    if (!exchanged.ok) {
      return Response.json(
        { errors: [{ field: 'signup', message: exchanged.error }] },
        { status: exchanged.auth ? 409 : 502 },
      );
    }
    const phone = await metaPhoneNumber(exchanged.value, wabaId, phoneNumberId || null);
    if (!phone.ok) {
      return Response.json(
        { errors: [{ field: 'phone', message: phone.error }] },
        { status: phone.auth ? 409 : 502 },
      );
    }
    const subscribed = await subscribeMetaApp(exchanged.value, wabaId);
    if (!subscribed.ok) {
      return Response.json(
        { errors: [{ field: 'webhook', message: subscribed.error }] },
        { status: subscribed.auth ? 409 : 502 },
      );
    }

    const sessionSecret = env.CMS_SESSION_SECRET?.trim() ?? '';
    if (!sessionSecret) {
      return Response.json(
        { errors: [{ field: 'security', message: 'The CMS security key is unavailable.' }] },
        { status: 409 },
      );
    }
    await saveMetaChannel(db, {
      phoneNumber: phone.value.displayPhoneNumber,
      wabaId,
      phoneNumberId: phone.value.id,
      sealedAccessToken: await sealChannelSecret(sessionSecret, exchanged.value),
      actorUserId: auth.userId,
    });
    return Response.json({ ok: true, phoneNumber: phone.value.displayPhoneNumber });
  } catch (error) {
    console.error(
      '[cms.channels.meta.complete]',
      error instanceof Error ? error.message : String(error),
    );
    return Response.json(
      { errors: [{ field: 'signup', message: 'WhatsApp pairing could not be completed.' }] },
      { status: 500 },
    );
  }
};

export const ALL: APIRoute = () =>
  Response.json({ errors: [{ field: 'method', message: 'Use POST.' }] }, { status: 405 });
