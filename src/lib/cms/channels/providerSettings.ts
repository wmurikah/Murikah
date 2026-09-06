import type { Client } from '@libsql/client/web';
import { microsoftConfig, type MicrosoftConfig } from './microsoft';
import { openChannelSecret } from './secretBox';

export interface MicrosoftProviderStatus {
  ready: boolean;
  configured: boolean;
  clientId: string | null;
  tenant: string | null;
  source: 'DATABASE' | 'ENVIRONMENT' | null;
}

export async function providerSettingsReady(db: Client): Promise<boolean> {
  try {
    await db.execute('SELECT provider FROM channel_provider_settings LIMIT 1');
    return true;
  } catch (error) {
    if (String(error).toLowerCase().includes('no such table')) return false;
    throw error;
  }
}

async function databaseMicrosoftConfig(
  db: Client,
  env: Cloudflare.Env,
): Promise<MicrosoftConfig | null> {
  if (!(await providerSettingsReady(db))) return null;
  const found = await db.execute(
    `SELECT client_id, tenant_id, sealed_client_secret
       FROM channel_provider_settings
      WHERE provider = 'MICROSOFT'
      LIMIT 1`,
  );
  const row = found.rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;

  const sessionSecret = env.CMS_SESSION_SECRET?.trim() ?? '';
  if (sessionSecret === '') return null;
  const sealed = String(row.sealed_client_secret ?? '');
  const clientSecret = sealed ? await openChannelSecret(sessionSecret, sealed) : null;
  const clientId = String(row.client_id ?? '').trim();
  const tenant = String(row.tenant_id ?? '').trim();
  if (!clientSecret || clientId === '' || tenant === '') return null;
  return { clientId, clientSecret, tenant };
}

export async function loadMicrosoftConfig(
  db: Client,
  env: Cloudflare.Env,
): Promise<MicrosoftConfig | null> {
  const stored = await databaseMicrosoftConfig(db, env);
  return stored ?? microsoftConfig(env);
}

export async function microsoftProviderStatus(
  db: Client,
  env: Cloudflare.Env,
): Promise<MicrosoftProviderStatus> {
  const ready = await providerSettingsReady(db);
  if (ready) {
    const found = await db.execute(
      `SELECT client_id, tenant_id, sealed_client_secret
         FROM channel_provider_settings
        WHERE provider = 'MICROSOFT'
        LIMIT 1`,
    );
    const row = found.rows[0] as Record<string, unknown> | undefined;
    if (row) {
      const sessionSecret = env.CMS_SESSION_SECRET?.trim() ?? '';
      const sealed = String(row.sealed_client_secret ?? '');
      const opened = sessionSecret && sealed ? await openChannelSecret(sessionSecret, sealed) : null;
      return {
        ready,
        configured:
          String(row.client_id ?? '').trim() !== '' &&
          String(row.tenant_id ?? '').trim() !== '' &&
          opened !== null,
        clientId: String(row.client_id ?? '').trim() || null,
        tenant: String(row.tenant_id ?? '').trim() || null,
        source: 'DATABASE',
      };
    }
  }

  const fromEnvironment = microsoftConfig(env);
  if (fromEnvironment) {
    return {
      ready,
      configured: true,
      clientId: fromEnvironment.clientId,
      tenant: fromEnvironment.tenant,
      source: 'ENVIRONMENT',
    };
  }

  return { ready, configured: false, clientId: null, tenant: null, source: null };
}
