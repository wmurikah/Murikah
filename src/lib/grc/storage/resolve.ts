/**
 * Resolve an organisation's active evidence storage provider (Build Prompt 51).
 *
 * This is the one place that turns a stored, sealed connection into a working
 * `StorageProvider`, and the only place a readable credential exists. Everything
 * above it, the whole evidence layer, takes the interface and never learns which
 * provider answered.
 *
 * A provider instance is built per request and discarded with it: no module-level
 * map, so one organisation's credential can never be served to another, and an
 * administrator who disconnects a provider is disconnected on the very next
 * request rather than when a cache happens to expire.
 *
 * `null` is a first-class answer. An organisation that has not configured a
 * provider, or whose connection has not passed a test, has no provider, and the
 * evidence section keeps its honest "not configured" message rather than failing
 * at the moment of upload.
 */
import type { Client } from '@libsql/client/web';
import type { ProviderCode, StorageProvider } from './provider';
import { isProviderCode } from './provider';
import { loadActiveConnection, loadConnection } from '@grc/repos/storageConnections';
import { createR2Provider } from './providers/r2';
import { createGoogleDriveProvider, GOOGLE_TOKEN_URL } from './providers/googleDrive';
import { createSharePointProvider, MS_TOKEN_URL } from './providers/sharepoint';
import { createDropboxProvider, DROPBOX_TOKEN_URL } from './providers/dropbox';
import { getDropboxApp, getGoogleStorageApp, getMicrosoftStorageApp } from './env';
import type { OAuthApp } from './providers/oauth';

/** Whether the platform can offer a provider at all, for the settings screen. */
export function providerAvailable(code: ProviderCode): boolean {
  switch (code) {
    case 'r2':
      // Configured entirely per organisation, so it needs nothing of the platform.
      return true;
    case 'google_drive':
      return getGoogleStorageApp() !== null;
    case 'sharepoint':
      return getMicrosoftStorageApp() !== null;
    case 'dropbox':
      return getDropboxApp() !== null;
  }
}

/**
 * The platform's OAuth registration for a provider, with its token endpoint.
 * Exported so the connect and callback routes redeem against the same
 * application the provider factory refreshes with.
 */
export function oauthApp(code: ProviderCode): OAuthApp | null {
  switch (code) {
    case 'google_drive': {
      const app = getGoogleStorageApp();
      return app ? { ...app, tokenUrl: GOOGLE_TOKEN_URL } : null;
    }
    case 'sharepoint': {
      const app = getMicrosoftStorageApp();
      return app ? { ...app, tokenUrl: MS_TOKEN_URL } : null;
    }
    case 'dropbox': {
      const app = getDropboxApp();
      return app ? { ...app, tokenUrl: DROPBOX_TOKEN_URL } : null;
    }
    case 'r2':
      return null;
  }
}

/**
 * Build a provider from an already-unsealed connection. Exported so the settings
 * screen can test and list folders for a provider that is configured but not yet
 * active: an administrator has to be able to prove a connection works before
 * making it the one their evidence depends on.
 */
export function buildProvider(
  provider: ProviderCode,
  config: Record<string, string>,
  folderId: string | null,
): StorageProvider | null {
  if (provider === 'r2') return createR2Provider(config, folderId);
  const app = oauthApp(provider);
  if (!app) return null;
  if (provider === 'google_drive') return createGoogleDriveProvider(app, config, folderId);
  if (provider === 'sharepoint') return createSharePointProvider(app, config, folderId);
  return createDropboxProvider(app, config, folderId);
}

/**
 * The acting organisation's active provider, or null when it has none.
 *
 * The screen tells an administrator whose connection is configured but untested
 * to test it; a successful test is what activates it (Build Prompt 54).
 */
export async function resolveProvider(
  db: Client,
  secret: string,
  organizationId: string,
): Promise<StorageProvider | null> {
  // "Active and tested" is one predicate inside loadActiveConnection (Build
  // Prompt 54), so the resolver and the evidence gate cannot answer differently.
  // A connection that never passed a test is not returned: it is half
  // configured, and writing evidence into it would be writing into something
  // nobody has proved reachable.
  const connection = await loadActiveConnection(db, secret, organizationId);
  if (!connection) return null;
  return buildProvider(connection.provider, connection.config, connection.folderId);
}

/**
 * The organisation's connection for one particular backend code, whether or not
 * it is the active one.
 *
 * This is how a stored object stays readable after an administrator switches
 * providers: a reference records the backend that holds it, and the download
 * path asks for that backend rather than for whatever is active now. An unknown
 * code (a legacy `drive` row) is not a provider and returns null, which the
 * seam handles by falling back to the platform's own credential.
 */
export async function resolveProviderForBackend(
  db: Client,
  secret: string,
  organizationId: string,
  backend: string,
): Promise<StorageProvider | null> {
  if (!isProviderCode(backend)) return null;
  return resolveConfiguredProvider(db, secret, organizationId, backend);
}

/** One configured provider, active or not, for the test and folder-picker paths. */
export async function resolveConfiguredProvider(
  db: Client,
  secret: string,
  organizationId: string,
  provider: ProviderCode,
): Promise<StorageProvider | null> {
  const connection = await loadConnection(db, secret, organizationId, provider);
  if (!connection) return null;
  return buildProvider(provider, connection.config, connection.folderId);
}

/**
 * Whether the acting organisation can store evidence right now. The screens ask
 * this to decide between the upload control and the "not configured" message.
 */
export async function storageReady(
  db: Client,
  secret: string,
  organizationId: string,
): Promise<boolean> {
  return (await resolveProvider(db, secret, organizationId)) !== null;
}
