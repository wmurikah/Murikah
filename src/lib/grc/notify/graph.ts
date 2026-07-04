/**
 * Email delivery through Microsoft Graph (Outlook), ported from the source
 * Outlook path. An access token is obtained via the OAuth2 refresh-token flow
 * against login.microsoftonline.com (scope Mail.Send) and cached for the isolate;
 * mail is sent through graph.microsoft.com/v1.0/me/sendMail as the configured
 * sender, with reply-to audit@hasspetroleum.com and any CC list. Runs from the
 * Worker. If Graph is not configured the caller leaves the row PENDING rather
 * than failing.
 */
import type { OutlookConfig } from './env';

const REPLY_TO = 'audit@hasspetroleum.com';

interface CachedToken {
  token: string;
  expiresAt: number;
}
// Cached for the lifetime of the isolate; refreshed shortly before expiry.
let tokenCache: CachedToken | null = null;

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
}

async function getAccessToken(cfg: OutlookConfig, now: number): Promise<string | null> {
  if (tokenCache && tokenCache.expiresAt > now + 60_000) return tokenCache.token;
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    refresh_token: cfg.refreshToken,
    grant_type: 'refresh_token',
    scope: 'https://graph.microsoft.com/Mail.Send offline_access',
  });
  const res = await fetch(`https://login.microsoftonline.com/${cfg.tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) return null;
  const json = (await res.json()) as TokenResponse;
  if (!json.access_token) return null;
  tokenCache = { token: json.access_token, expiresAt: now + (json.expires_in ?? 3600) * 1000 };
  return json.access_token;
}

export interface OutboundEmail {
  to: string;
  subject: string;
  html: string;
  cc?: string[];
}

export interface SendResult {
  ok: boolean;
  error?: string;
}

/** Send one email through Graph. Returns ok:false with a reason on any failure. */
export async function sendViaGraph(
  cfg: OutlookConfig,
  email: OutboundEmail,
  now: number,
): Promise<SendResult> {
  const token = await getAccessToken(cfg, now);
  if (!token) return { ok: false, error: 'could not obtain Graph token' };

  const message = {
    subject: email.subject,
    body: { contentType: 'HTML', content: email.html },
    toRecipients: [{ emailAddress: { address: email.to } }],
    ccRecipients: (email.cc ?? []).map((address) => ({ emailAddress: { address } })),
    replyTo: [{ emailAddress: { address: REPLY_TO } }],
  };
  const res = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ message, saveToSentItems: true }),
  });
  if (res.status === 202) return { ok: true };
  const text = await res.text().catch(() => '');
  return { ok: false, error: `Graph sendMail ${res.status}: ${text.slice(0, 200)}` };
}

/** Reset the cached token (used by tests and after a credential change). */
export function resetTokenCache(): void {
  tokenCache = null;
}
