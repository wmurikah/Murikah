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
      { errors: [{ field: 'body', message: 'Enter the Microsoft setup details.' }] },
      { status: 400 },
    );
  }

  const tenant = text(body.tenant);
  const clientId = text(body.clientId);
  const clientSecret = text(body.clientSecret);
  if (!tenant || !clientId) {
    return Response.json(
      { errors: [{ field: 'settings', message: 'Tenant and application ID are required.' }] },
      { status: 400 },
    );
  }
  if (tenant.length > 200 || clientId.length > 200 || clientSecret.length > 1000) {
    return Response.json(
      { errors: [{ field: 'settings', message: 'One of the Microsoft setup values is too long.' }] },
      { status: 400 },
    );
  }

  try {
    const db = await requestDb(context.locals);
    if (!(await providerSettingsReady(db))) {
      return Response.json(
        { errors: [{ field: 'setup', message: 'Run the Microsoft channel setup database script first.' }] },
        { status: 409 },
      );
    }

    const existing = await db.execute(
      `SELECT sealed_client_secret
         FROM channel_provider_settings
        WHERE provider = 'MICROSOFT'
        LIMIT 1`,
    );
    const current = existing.rows[0] as Record<string, unknown> | undefined;
    if (!current && !clientSecret) {
      return Response.json(
        { errors: [{ field: 'clientSecret', message: 'Client secret is required for the first setup.' }] },
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

    const sealedClientSecret = clientSecret
      ? await sealChannelSecret(sessionSecret, clientSecret)
      : String(current?.sealed_client_secret ?? '');

    await db.execute({
      sql: `INSERT INTO channel_provider_settings
              (provider, client_id, tenant_id, sealed_client_secret,
               configured_by_user_id, configured_at, updated_at)
            VALUES ('MICROSOFT', ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            ON CONFLICT(provider) DO UPDATE SET
              client_id = excluded.client_id,
              tenant_id = excluded.tenant_id,
              sealed_client_secret = excluded.sealed_client_secret,
              configured_by_user_id = excluded.configured_by_user_id,
              updated_at = CURRENT_TIMESTAMP`,
      args: [clientId, tenant, sealedClientSecret, auth.userId],
    });

    return Response.json({ ok: true });
  } catch (error) {
    console.error('[cms.channels.microsoft.settings]', error instanceof Error ? error.message : String(error));
    return Response.json(
      { errors: [{ field: 'settings', message: 'Microsoft setup could not be saved.' }] },
      { status: 500 },
    );
  }
};

export const ALL: APIRoute = () =>
  Response.json({ errors: [{ field: 'method', message: 'Use POST.' }] }, { status: 405 });
