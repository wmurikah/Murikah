/**
 * What the three OAuth storage providers share (Build Prompt 51).
 *
 * Google Drive, Microsoft Graph and Dropbox all follow the same shape the
 * Outlook connect flow already established: a one-time consent captures a
 * refresh token, the token rests sealed per organisation, and every call
 * redeems it for a short-lived access token. Only the endpoints and the scopes
 * differ, so the redemption, the caching within one request, and the "the
 * connection has gone stale" reporting live here once.
 *
 * The access token is held for the life of the provider instance and no longer.
 * A provider instance is built per request from the sealed config, so a token
 * cannot outlive the request that redeemed it, and there is no module-level map
 * for one organisation's token to be served to another.
 *
 * The client id and secret are the platform's application registration, held as
 * Worker secrets: they identify Murikah to the provider and are the same for
 * every customer. What is per-organisation, and sealed, is the refresh token
 * that names the customer's own account.
 */

export interface OAuthApp {
  clientId: string;
  clientSecret: string;
  tokenUrl: string;
}

export type TokenOutcome =
  | { ok: true; accessToken: string; refreshToken?: string }
  | { ok: false; error: string };

/**
 * Redeem a refresh token for an access token. Some providers rotate the refresh
 * token on redemption (Microsoft consumer accounts do); the rotated value is
 * returned so the caller can write it back rather than letting the connection
 * die on the next call.
 */
export async function redeemRefresh(
  app: OAuthApp,
  refreshToken: string,
  scope?: string,
): Promise<TokenOutcome> {
  const body = new URLSearchParams({
    client_id: app.clientId,
    client_secret: app.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  if (scope) body.set('scope', scope);
  try {
    const res = await fetch(app.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    const payload = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      error_description?: string;
      error?: string;
    };
    if (!res.ok || !payload.access_token) {
      return {
        ok: false,
        error:
          payload.error_description ?? payload.error ?? `Token refresh failed (${res.status}).`,
      };
    }
    return {
      ok: true,
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'The provider is unreachable.',
    };
  }
}

/** Exchange an authorization code for tokens, on the callback leg of the consent. */
export async function exchangeCode(
  app: OAuthApp,
  code: string,
  redirectUri: string,
): Promise<TokenOutcome> {
  const body = new URLSearchParams({
    client_id: app.clientId,
    client_secret: app.clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
  });
  try {
    const res = await fetch(app.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    const payload = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      error_description?: string;
      error?: string;
    };
    if (!res.ok || !payload.access_token) {
      return {
        ok: false,
        error:
          payload.error_description ?? payload.error ?? `Code exchange failed (${res.status}).`,
      };
    }
    return { ok: true, accessToken: payload.access_token, refreshToken: payload.refresh_token };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'The provider is unreachable.',
    };
  }
}

/**
 * A per-instance access-token holder. The first call redeems, the rest reuse,
 * and the whole thing is discarded with the provider instance at the end of the
 * request.
 */
export function tokenHolder(
  app: OAuthApp,
  refreshToken: string,
  scope?: string,
): () => Promise<string> {
  let cached: string | null = null;
  return async () => {
    if (cached) return cached;
    const outcome = await redeemRefresh(app, refreshToken, scope);
    if (!outcome.ok) throw new Error(outcome.error);
    cached = outcome.accessToken;
    return cached;
  };
}

/** A fetch that carries the bearer token, for the provider modules. */
export async function authed(
  token: () => Promise<string>,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const accessToken = await token();
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${accessToken}`);
  return fetch(url, { ...init, headers });
}
