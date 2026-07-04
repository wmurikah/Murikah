/**
 * Delivery-side environment for the GRC notification dispatcher. Read from the
 * Cloudflare Worker env. Nothing throws when missing: the production gate keeps
 * real sends off unless GRC_ENV is exactly 'production' and the Outlook
 * credentials are present, so a preview or local run drains the queue as a
 * dry-run and a queued row is simply left PENDING. Secrets are Worker secrets or
 * .dev.vars, never committed.
 */
import { env } from 'cloudflare:workers';

export interface OutlookConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  sender: string;
  tenant: string;
}

export interface GrcDeliveryEnv {
  /** Real sends happen only in 'production'. Anything else is a dry-run. */
  mode: 'production' | 'other';
  outlook: OutlookConfig | null;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

export function getGrcDeliveryEnv(): GrcDeliveryEnv {
  const mode = env.GRC_ENV === 'production' ? 'production' : 'other';
  const clientId = nonEmpty(env.OUTLOOK_CLIENT_ID);
  const clientSecret = nonEmpty(env.OUTLOOK_CLIENT_SECRET);
  const refreshToken = nonEmpty(env.OUTLOOK_REFRESH_TOKEN);
  const sender = nonEmpty(env.OUTLOOK_SENDER_EMAIL);
  const outlook =
    clientId && clientSecret && refreshToken && sender
      ? {
          clientId,
          clientSecret,
          refreshToken,
          sender,
          tenant: nonEmpty(env.OUTLOOK_TENANT) ?? 'common',
        }
      : null;
  return { mode, outlook };
}

/** Real sends require production mode and configured Outlook credentials. */
export function canSend(delivery: GrcDeliveryEnv): boolean {
  return delivery.mode === 'production' && delivery.outlook != null;
}
