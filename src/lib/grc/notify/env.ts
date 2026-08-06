/**
 * Delivery-side environment for the GRC notification dispatcher. Read from the
 * Cloudflare Worker env. Nothing throws when missing: the production gate keeps
 * automated queue sends off unless GRC_ENV is exactly 'production' and the
 * Graph app credentials are present, so a preview or local run drains the
 * queue as a dry-run and a queued row is simply left PENDING. The refresh
 * token is not part of this env: it is minted by the one-time admin connect
 * flow and stored sealed in the database (repos/mailConnection.ts), with
 * GRAPH_REFRESH_TOKEN accepted as an optional operator-provided seed. Secrets
 * are Worker secrets or .dev.vars, never committed.
 */
import { env } from 'cloudflare:workers';

export interface GraphAppConfig {
  clientId: string;
  clientSecret: string;
  /** The mailbox notifications send as (hassaudit@outlook.com). */
  sender: string;
  /** An optional operator-set refresh token, used only until the DB record exists. */
  seedRefreshToken: string | null;
}

export interface GrcDeliveryEnv {
  /** Real queue sends happen only in 'production'. Anything else is a dry-run. */
  mode: 'production' | 'other';
  graph: GraphAppConfig | null;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

export function getGrcDeliveryEnv(): GrcDeliveryEnv {
  const mode = env.GRC_ENV === 'production' ? 'production' : 'other';
  const clientId = nonEmpty(env.GRAPH_CLIENT_ID);
  const clientSecret = nonEmpty(env.GRAPH_CLIENT_SECRET);
  const sender = nonEmpty(env.GRC_MAIL_SENDER);
  const graph =
    clientId && clientSecret && sender
      ? {
          clientId,
          clientSecret,
          sender,
          seedRefreshToken: nonEmpty(env.GRAPH_REFRESH_TOKEN),
        }
      : null;
  return { mode, graph };
}

/** Automated queue sends require production mode and the Graph app credentials. */
export function canSend(delivery: GrcDeliveryEnv): boolean {
  return delivery.mode === 'production' && delivery.graph != null;
}
