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

export interface MetaProviderConfig {
  appId: string;
  appSecret: string;
  configurationId: string;
}

export interface MetaProviderStatus {
  ready: boolean;
  configured: boolean;
  appId: string | null;
  configurationId: string | null;
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

async function providerRow(db: Client, provider: 'MICROSOFT' | 'META') {
  if (!(await providerSettingsReady(db))) return null;
  const found = await db.execute({
    sql: `SELECT client_id, tenant_id, sealed_client_secret
            FROM channel_provider_settings
           WHERE provider = ?
           LIMIT 1`,
    args: [provider],
  });
  return (found.rows[0] as Record<string, unknown> | undefined) ?? null;
}

async function databaseMicrosoftConfig(
  db: Client,
  env: Cloudflare.Env,
): Promise<MicrosoftConfig | null> {
  const row = await providerRow(db, 'MICROSOFT');
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
  const row = ready ? await providerRow(db, 'MICROSOFT') : null;
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

export async function loadMetaConfig(
  db: Client,
  env: Cloudflare.Env,
): Promise<MetaProviderConfig | null> {
  const row = await providerRow(db, 'META');
  if (!row) return null;
  const sessionSecret = env.CMS_SESSION_SECRET?.trim() ?? '';
  if (!sessionSecret) return null;
  const appId = String(row.client_id ?? '').trim();
  const configurationId = String(row.tenant_id ?? '').trim();
  const sealed = String(row.sealed_client_secret ?? '');
  const appSecret = sealed ? await openChannelSecret(sessionSecret, sealed) : null;
  if (!appSecret || !appId || !configurationId) return null;
  return { appId, appSecret, configurationId };
}

export async function metaProviderStatus(
  db: Client,
  env: Cloudflare.Env,
): Promise<MetaProviderStatus> {
  const ready = await providerSettingsReady(db);
  const row = ready ? await providerRow(db, 'META') : null;
  if (!row) return { ready, configured: false, appId: null, configurationId: null };

  const sessionSecret = env.CMS_SESSION_SECRET?.trim() ?? '';
  const sealed = String(row.sealed_client_secret ?? '');
  const opened = sessionSecret && sealed ? await openChannelSecret(sessionSecret, sealed) : null;
  const appId = String(row.client_id ?? '').trim();
  const configurationId = String(row.tenant_id ?? '').trim();
  return {
    ready,
    configured: appId !== '' && configurationId !== '' && opened !== null,
    appId: appId || null,
    configurationId: configurationId || null,
  };
}
