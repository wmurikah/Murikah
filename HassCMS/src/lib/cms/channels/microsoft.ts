export type EmailPurpose = 'NOTIFICATION_EMAIL' | 'INQUIRY_EMAIL';

export interface MicrosoftConfig {
  clientId: string;
  clientSecret: string;
  tenant: string;
}

export function microsoftConfig(env: Cloudflare.Env): MicrosoftConfig | null {
  const clientId = env.MICROSOFT_CLIENT_ID?.trim() ?? '';
  const clientSecret = env.MICROSOFT_CLIENT_SECRET?.trim() ?? '';
  if (clientId === '' || clientSecret === '') return null;
  return {
    clientId,
    clientSecret,
    tenant: env.MICROSOFT_TENANT?.trim() || 'organizations',
  };
}

export function microsoftScopes(purpose: EmailPurpose): string {
  return purpose === 'NOTIFICATION_EMAIL'
    ? 'offline_access Mail.Send openid email User.Read'
    : 'offline_access Mail.Read Mail.Send openid email User.Read';
}

export function microsoftAuthorizeUrl(
  config: MicrosoftConfig,
  purpose: EmailPurpose,
  redirectUri: string,
  state: string,
): string {
  const query = new URLSearchParams({
    client_id: config.clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    response_mode: 'query',
    scope: microsoftScopes(purpose),
    prompt: 'select_account',
    state,
  });
  return `https://login.microsoftonline.com/${encodeURIComponent(config.tenant)}/oauth2/v2.0/authorize?${query.toString()}`;
}

interface TokenBody {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

export type MicrosoftTokens = {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number;
  scope: string;
};

export type MicrosoftResult<T> =
  | { ok: true; value: T }
  | { ok: false; auth: boolean; error: string };

async function tokenRequest(
  config: MicrosoftConfig,
  form: URLSearchParams,
): Promise<MicrosoftResult<MicrosoftTokens>> {
  let response: Response;
  try {
    response = await fetch(
      `https://login.microsoftonline.com/${encodeURIComponent(config.tenant)}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form,
      },
    );
  } catch (error) {
    return { ok: false, auth: false, error: `Microsoft token endpoint unavailable: ${String(error)}` };
  }
  const body = (await response.json().catch(() => ({}))) as TokenBody;
  if (!response.ok || !body.access_token) {
    return {
      ok: false,
      auth: response.status >= 400 && response.status < 500,
      error: (body.error_description ?? body.error ?? `HTTP ${response.status}`).slice(0, 300),
    };
  }
  return {
    ok: true,
    value: {
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? null,
      expiresIn: body.expires_in ?? 3600,
      scope: body.scope ?? '',
    },
  };
}

export function exchangeMicrosoftCode(
  config: MicrosoftConfig,
  purpose: EmailPurpose,
  code: string,
  redirectUri: string,
): Promise<MicrosoftResult<MicrosoftTokens>> {
  return tokenRequest(
    config,
    new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      scope: microsoftScopes(purpose),
    }),
  );
}

export function redeemMicrosoftRefreshToken(
  config: MicrosoftConfig,
  purpose: EmailPurpose,
  refreshToken: string,
): Promise<MicrosoftResult<MicrosoftTokens>> {
  return tokenRequest(
    config,
    new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: microsoftScopes(purpose),
    }),
  );
}

export async function microsoftMailbox(accessToken: string): Promise<MicrosoftResult<string>> {
  try {
    const response = await fetch('https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName', {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      return { ok: false, auth: response.status === 401 || response.status === 403, error: `Microsoft Graph ${response.status}` };
    }
    const body = (await response.json()) as { mail?: string; userPrincipalName?: string };
    const address = (body.mail ?? body.userPrincipalName ?? '').trim();
    return address === ''
      ? { ok: false, auth: false, error: 'Microsoft did not return a mailbox address.' }
      : { ok: true, value: address };
  } catch (error) {
    return { ok: false, auth: false, error: `Microsoft Graph unavailable: ${String(error)}` };
  }
}

export interface OutboundMail {
  to: string;
  subject: string;
  text: string;
  cc?: string[];
}

export async function microsoftSendMail(
  accessToken: string,
  mail: OutboundMail,
): Promise<MicrosoftResult<true>> {
  try {
    const response = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        message: {
          subject: mail.subject,
          body: { contentType: 'Text', content: mail.text },
          toRecipients: [{ emailAddress: { address: mail.to } }],
          ccRecipients: (mail.cc ?? []).map((address) => ({ emailAddress: { address } })),
        },
        saveToSentItems: true,
      }),
    });
    if (response.status === 202) return { ok: true, value: true };
    const text = await response.text().catch(() => '');
    return {
      ok: false,
      auth: response.status === 401 || response.status === 403,
      error: `Microsoft sendMail ${response.status}: ${text.slice(0, 200)}`,
    };
  } catch (error) {
    return { ok: false, auth: false, error: `Microsoft Graph unavailable: ${String(error)}` };
  }
}

export async function microsoftReplyToMessage(
  accessToken: string,
  messageId: string,
  comment: string,
): Promise<MicrosoftResult<true>> {
  try {
    const response = await fetch(
      `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(messageId)}/reply`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ comment }),
      },
    );
    if (response.status === 202) return { ok: true, value: true };
    const text = await response.text().catch(() => '');
    return {
      ok: false,
      auth: response.status === 401 || response.status === 403,
      error: `Microsoft reply ${response.status}: ${text.slice(0, 200)}`,
    };
  } catch (error) {
    return { ok: false, auth: false, error: `Microsoft Graph unavailable: ${String(error)}` };
  }
}

export interface MicrosoftMessage {
  id: string;
  conversationId?: string;
  internetMessageId?: string;
  subject?: string;
  receivedDateTime?: string;
  from?: { emailAddress?: { address?: string; name?: string } };
  toRecipients?: { emailAddress?: { address?: string; name?: string } }[];
  body?: { contentType?: string; content?: string };
  bodyPreview?: string;
  isDraft?: boolean;
  '@removed'?: unknown;
}

export interface MicrosoftDeltaPage {
  value?: MicrosoftMessage[];
  '@odata.nextLink'?: string;
  '@odata.deltaLink'?: string;
}

export function initialInboxDeltaUrl(): string {
  const select = [
    'id',
    'conversationId',
    'internetMessageId',
    'subject',
    'receivedDateTime',
    'from',
    'toRecipients',
    'body',
    'bodyPreview',
    'isDraft',
  ].join(',');
  return `https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$select=${encodeURIComponent(select)}&$top=50`;
}

export async function microsoftDeltaPage(
  accessToken: string,
  url: string,
): Promise<MicrosoftResult<MicrosoftDeltaPage>> {
  if (!url.startsWith('https://graph.microsoft.com/')) {
    return { ok: false, auth: false, error: 'The saved mailbox sync cursor is invalid.' };
  }
  try {
    const response = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
    const body = (await response.json().catch(() => ({}))) as MicrosoftDeltaPage & { error?: unknown };
    if (!response.ok) {
      return {
        ok: false,
        auth: response.status === 401 || response.status === 403,
        error: `Microsoft delta sync ${response.status}`,
      };
    }
    return { ok: true, value: body };
  } catch (error) {
    return { ok: false, auth: false, error: `Microsoft Graph unavailable: ${String(error)}` };
  }
}
