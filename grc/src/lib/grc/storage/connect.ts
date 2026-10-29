/**
 * The one-time OAuth connect flow for the storage providers (Build Prompt 51).
 *
 * Google Drive, SharePoint/OneDrive and Dropbox are connected the way the
 * Outlook mailbox already is: the administrator is sent to the provider's
 * consent screen, comes back with an authorization code, and the code is
 * exchanged for a refresh token that rests sealed against their organisation.
 *
 * The differences between the three, the authorize URL, the scope, and where
 * the connected account's name is read from, are the whole of this module. The
 * two routes that use it are then identical for every provider, which is what
 * keeps a fourth from needing a fourth pair of routes.
 */
import type { ProviderCode } from './provider';
import { googleAuthorizeUrl } from './providers/googleDrive';
import { microsoftAuthorizeUrl } from './providers/sharepoint';
import { dropboxAuthorizeUrl } from './providers/dropbox';
import { authed, type OAuthApp } from './providers/oauth';

/** The redirect URI registered with each provider, derived from the request. */
export function redirectUriFor(origin: string, provider: ProviderCode): string {
  return `${origin}/api/admin/storage/${provider}/callback`;
}

/** The provider's consent URL, or null for a provider with no OAuth leg (R2). */
export function authorizeUrlFor(
  provider: ProviderCode,
  clientId: string,
  redirectUri: string,
  state: string,
): string | null {
  switch (provider) {
    case 'google_drive':
      return googleAuthorizeUrl(clientId, redirectUri, state);
    case 'sharepoint':
      return microsoftAuthorizeUrl(clientId, redirectUri, state);
    case 'dropbox':
      return dropboxAuthorizeUrl(clientId, redirectUri, state);
    case 'r2':
      return null;
  }
}

/**
 * A readable name for the account that was just connected, so the settings
 * screen can say whose Drive or Dropbox the evidence is going to rather than
 * only that "a connection exists". Best-effort: a provider that will not answer
 * costs a label, never the connection.
 */
export async function accountLabel(
  provider: ProviderCode,
  app: OAuthApp,
  accessToken: string,
): Promise<string | null> {
  const token = async (): Promise<string> => accessToken;
  void app;
  try {
    if (provider === 'google_drive') {
      const res = await authed(
        token,
        'https://www.googleapis.com/drive/v3/about?fields=user(emailAddress,displayName)',
      );
      if (!res.ok) return null;
      const body = (await res.json()) as { user?: { emailAddress?: string; displayName?: string } };
      return body.user?.emailAddress ?? body.user?.displayName ?? null;
    }
    if (provider === 'sharepoint') {
      const res = await authed(token, 'https://graph.microsoft.com/v1.0/me');
      if (!res.ok) return null;
      const body = (await res.json()) as { userPrincipalName?: string; displayName?: string };
      return body.userPrincipalName ?? body.displayName ?? null;
    }
    if (provider === 'dropbox') {
      const res = await authed(token, 'https://api.dropboxapi.com/2/users/get_current_account', {
        method: 'POST',
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { email?: string; name?: { display_name?: string } };
      return body.email ?? body.name?.display_name ?? null;
    }
  } catch {
    // A label is a courtesy; its absence is not a failed connection.
  }
  return null;
}
