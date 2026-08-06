/**
 * The Microsoft Graph wire layer for Outlook mail: the OAuth2 endpoints for
 * personal Microsoft accounts (the /consumers authority), the authorization
 * code and refresh-token exchanges, the /me mailbox lookup and the
 * /me/sendMail call. Sending is delegated: the message goes out as the
 * signed-in mailbox (hassaudit@outlook.com), connected once by an admin
 * through the Setup -> Settings -> Email screen. The URL and message builders
 * are pure so they unit test directly; the callers (sendMail.ts and the
 * connect endpoints) own token storage and error policy.
 */

export const GRAPH_AUTHORIZE_URL =
  'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize';
export const GRAPH_TOKEN_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token';
export const GRAPH_SCOPE = 'offline_access Mail.Send openid email User.Read';

/** The registered redirect URI; must match the Entra app registration exactly. */
export const OUTLOOK_REDIRECT_URI = 'https://grc.murikah.com/api/admin/outlook/callback';

/** The authorize URL the Connect Outlook action redirects the admin to. */
export function authorizeUrl(clientId: string, state: string): string {
  const q = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: OUTLOOK_REDIRECT_URI,
    response_mode: 'query',
    scope: GRAPH_SCOPE,
    prompt: 'consent',
    state,
  });
  return `${GRAPH_AUTHORIZE_URL}?${q.toString()}`;
}

export interface GraphTokens {
  accessToken: string;
  /** Seconds until the access token expires. */
  expiresIn: number;
  /** Present when Microsoft issued (or rotated) a refresh token. */
  refreshToken: string | null;
}

export type TokenResult =
  | { ok: true; tokens: GraphTokens }
  | {
      ok: false;
      /** True when the grant itself was refused (reconnect required), false on a transient failure. */
      auth: boolean;
      error: string;
    };

interface TokenResponseBody {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  error?: string;
  error_description?: string;
}

/**
 * A 4xx from the token endpoint means the grant was refused (expired, revoked
 * or consent withdrawn): the connection is dead until an admin reconnects. A
 * 5xx or a network failure is transient and retryable.
 */
async function tokenRequest(form: URLSearchParams): Promise<TokenResult> {
  let res: Response;
  try {
    res = await fetch(GRAPH_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form,
    });
  } catch (err) {
    return { ok: false, auth: false, error: `token endpoint unreachable: ${String(err)}` };
  }
  let body: TokenResponseBody = {};
  try {
    body = (await res.json()) as TokenResponseBody;
  } catch {
    body = {};
  }
  if (!res.ok || !body.access_token) {
    const detail = body.error_description ?? body.error ?? `HTTP ${res.status}`;
    return { ok: false, auth: res.status >= 400 && res.status < 500, error: detail.slice(0, 300) };
  }
  return {
    ok: true,
    tokens: {
      accessToken: body.access_token,
      expiresIn: body.expires_in ?? 3600,
      refreshToken: body.refresh_token ?? null,
    },
  };
}

/** Exchange the authorization code from the connect callback for tokens. */
export async function exchangeAuthCode(
  clientId: string,
  clientSecret: string,
  code: string,
): Promise<TokenResult> {
  return tokenRequest(
    new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: OUTLOOK_REDIRECT_URI,
      scope: GRAPH_SCOPE,
    }),
  );
}

/** Redeem the stored refresh token for a short-lived access token. */
export async function redeemRefreshToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<TokenResult> {
  return tokenRequest(
    new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: GRAPH_SCOPE,
    }),
  );
}

/** The signed-in mailbox address from Graph /me, or null when unreadable. */
export async function fetchMailboxAddress(accessToken: string): Promise<string | null> {
  try {
    const res = await fetch('https://graph.microsoft.com/v1.0/me', {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    const me = (await res.json()) as { mail?: string; userPrincipalName?: string };
    const address = me.mail ?? me.userPrincipalName ?? '';
    return address.trim() !== '' ? address : null;
  } catch {
    return null;
  }
}

const REPLY_TO = 'audit@hasspetroleum.com';

export interface OutboundEmail {
  to: string;
  subject: string;
  /** The HTML body; when absent the plain text is sent as the body. */
  html?: string;
  /** The plain-text fallback, sent when no HTML body is given. */
  text?: string;
  cc?: string[];
}

interface GraphRecipient {
  emailAddress: { address: string };
}

interface GraphMessage {
  subject: string;
  body: { contentType: 'HTML' | 'Text'; content: string };
  toRecipients: GraphRecipient[];
  ccRecipients: GraphRecipient[];
  replyTo: GraphRecipient[];
}

/** Build the Graph message payload (pure; exported for the unit tests). */
export function buildGraphMessage(email: OutboundEmail): GraphMessage {
  const asRecipient = (address: string): GraphRecipient => ({ emailAddress: { address } });
  const body: GraphMessage['body'] =
    email.html && email.html.trim() !== ''
      ? { contentType: 'HTML', content: email.html }
      : { contentType: 'Text', content: email.text ?? '' };
  return {
    subject: email.subject,
    body,
    toRecipients: [asRecipient(email.to)],
    ccRecipients: (email.cc ?? []).map(asRecipient),
    replyTo: [asRecipient(REPLY_TO)],
  };
}

export type GraphSendResult =
  | { ok: true }
  | {
      ok: false;
      /** True when Graph refused the token (the connection is stale). */
      auth: boolean;
      error: string;
    };

/** Send one email through Graph as the signed-in mailbox. */
export async function graphSendMail(
  accessToken: string,
  email: OutboundEmail,
): Promise<GraphSendResult> {
  let res: Response;
  try {
    res = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ message: buildGraphMessage(email), saveToSentItems: true }),
    });
  } catch (err) {
    return { ok: false, auth: false, error: `Graph unreachable: ${String(err)}` };
  }
  if (res.status === 202) return { ok: true };
  const text = await res.text().catch(() => '');
  return {
    ok: false,
    auth: res.status === 401 || res.status === 403,
    error: `Graph sendMail ${res.status}: ${text.slice(0, 200)}`,
  };
}
