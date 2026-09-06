import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { requestDb } from '@/lib/cms/db';
import { requireChannelsManage } from '@/lib/cms/channels/access';
import { providerSettingsReady } from '@/lib/cms/channels/providerSettings';
import { sealChannelSecret } from '@/lib/cms/channels/secretBox';

export const prerender = false;

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

export const POST: APIRoute = async (context) => {
  const auth = requireChannelsManage(context);
  if (!auth.ok) return auth.response;
  const body = (await context.request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) {
    return Response.json(
      { errors: [{ field: 'body', message: 'Enter the WhatsApp setup details.' }] },
      { status: 400 },
    );
  }

  const appId = text(body.appId);
  const configurationId = text(body.configurationId);
  const appSecret = text(body.appSecret);
  if (!appId || !configurationId) {
    return Response.json(
      { errors: [{ field: 'settings', message: 'App ID and configuration ID are required.' }] },
      { status: 400 },
    );
  }
  if (appId.length > 200 || configurationId.length > 300 || appSecret.length > 1000) {
    return Response.json(
      { errors: [{ field: 'settings', message: 'One of the WhatsApp setup values is too long.' }] },
      { status: 400 },
    );
  }

  try {
    const db = await requestDb(context.locals);
    if (!(await providerSettingsReady(db))) {
      return Response.json(
        { errors: [{ field: 'setup', message: 'Run the channel provider settings database setup first.' }] },
        { status: 409 },
      );
    }

    const existing = await db.execute(
      `SELECT sealed_client_secret
         FROM channel_provider_settings
        WHERE provider = 'META'
        LIMIT 1`,
    );
    const current = existing.rows[0] as Record<string, unknown> | undefined;
    if (!current && !appSecret) {
      return Response.json(
        { errors: [{ field: 'appSecret', message: 'App secret is required for the first setup.' }] },
        { status: 400 },
      );
    }

    const sessionSecret = env.CMS_SESSION_SECRET?.trim() ?? '';
    if (!sessionSecret) {
      return Response.json(
        { errors: [{ field: 'security', message: 'The CMS security key is unavailable.' }] },
        { status: 409 },
      );
    }
    const sealedSecret = appSecret
      ? await sealChannelSecret(sessionSecret, appSecret)
      : String(current?.sealed_client_secret ?? '');

    await db.execute({
      sql: `INSERT INTO channel_provider_settings
              (provider, client_id, tenant_id, sealed_client_secret,
               configured_by_user_id, configured_at, updated_at)
            VALUES ('META', ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            ON CONFLICT(provider) DO UPDATE SET
              client_id = excluded.client_id,
              tenant_id = excluded.tenant_id,
              sealed_client_secret = excluded.sealed_client_secret,
              configured_by_user_id = excluded.configured_by_user_id,
              updated_at = CURRENT_TIMESTAMP`,
      args: [appId, configurationId, sealedSecret, auth.userId],
    });
    return Response.json({ ok: true });
  } catch (error) {
    console.error('[cms.channels.meta.settings]', error instanceof Error ? error.message : String(error));
    return Response.json(
      { errors: [{ field: 'settings', message: 'WhatsApp setup could not be saved.' }] },
      { status: 500 },
    );
  }
};

export const ALL: APIRoute = () =>
  Response.json({ errors: [{ field: 'method', message: 'Use POST.' }] }, { status: 405 });
