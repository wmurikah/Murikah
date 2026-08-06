/**
 * The mail sender: turns the stored Outlook connection into a working mailer.
 * prepareMailer resolves the sealed refresh token (the DB record from the
 * one-time admin connect flow, or the operator-seeded GRAPH_REFRESH_TOKEN
 * until a record exists), redeems it for a short-lived access token (cached
 * for the isolate until expiry), and writes the rotated refresh token back,
 * because Microsoft rotates consumer refresh tokens on every redemption. On
 * an auth refusal, at redemption or mid-send, the connection is marked stale
 * and logged under [grc.mail], so the Settings -> Email screen shows "Not
 * connected" until an admin reconnects; transient failures never mark it
 * stale. Callers (the queue dispatcher and the test-email endpoint) decide
 * what a held or failed send means for them.
 */
import type { Client } from '@libsql/client/web';
import type { GrcDeliveryEnv } from './env';
import { redeemRefreshToken, graphSendMail, type OutboundEmail } from './graph';
import {
  getMailConnection,
  saveMailConnection,
  rotateMailToken,
  markMailConnectionStale,
  type MailConnectionRecord,
} from '@grc/repos/mailConnection';
import { seal, open } from '@grc/auth/secretBox';

export type SendOutcome =
  | { ok: true }
  | {
      ok: false;
      /** True when the connection went stale (reconnect required); false when retryable. */
      auth: boolean;
      reason: string;
    };

export interface Mailer {
  /** The connected mailbox the message goes out as. */
  address: string;
  send(email: OutboundEmail): Promise<SendOutcome>;
}

export type PreparedMailer =
  | { ok: true; mailer: Mailer }
  | {
      ok: false;
      /** Why nothing can send right now (not connected, stale, or a transient token failure). */
      held: string;
    };

interface CachedAccess {
  token: string;
  expiresAt: number;
}
// The short-lived Graph access token, cached for the isolate until expiry.
let accessCache: CachedAccess | null = null;

/** Drop the cached access token (tests, and after a reconnect). */
export function resetMailTokenCache(): void {
  accessCache = null;
}

async function markStale(
  db: Client,
  record: MailConnectionRecord | null,
  reason: string,
  nowIso: string,
): Promise<void> {
  console.error('[grc.mail] connection marked stale:', reason);
  if (record) await markMailConnectionStale(db, record, reason, nowIso);
}

/**
 * Resolve the connection and an access token into a ready mailer, or say why
 * sending is held. Never returns a mailer for a stale connection.
 */
export async function prepareMailer(
  db: Client,
  delivery: GrcDeliveryEnv,
  sessionSecret: string,
  nowMs: number,
): Promise<PreparedMailer> {
  const graph = delivery.graph;
  if (!graph) {
    return {
      ok: false,
      held: 'The Graph app credentials (GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET, GRC_MAIL_SENDER) are not configured.',
    };
  }
  const nowIso = new Date(nowMs).toISOString();

  let record = await getMailConnection(db);
  if (record && record.status === 'stale') {
    return {
      ok: false,
      held: `The Outlook connection is stale (${record.staleReason ?? 'authorisation was refused'}). Connect it again on Settings, Email.`,
    };
  }

  let refreshToken: string | null = null;
  if (record) {
    refreshToken = await open(sessionSecret, record.sealedToken);
    if (!refreshToken) {
      await markStale(db, record, 'the stored refresh token could not be unsealed', nowIso);
      return { ok: false, held: 'The stored Outlook sign-in is unreadable. Connect it again.' };
    }
  } else if (graph.seedRefreshToken) {
    refreshToken = graph.seedRefreshToken;
  }
  if (!refreshToken) {
    return { ok: false, held: 'Outlook is not connected. Connect it on Settings, Email.' };
  }

  let accessToken: string;
  if (accessCache && accessCache.expiresAt > nowMs + 60_000) {
    accessToken = accessCache.token;
  } else {
    const redeemed = await redeemRefreshToken(graph.clientId, graph.clientSecret, refreshToken);
    if (!redeemed.ok) {
      if (redeemed.auth) {
        await markStale(db, record, redeemed.error, nowIso);
        return { ok: false, held: `Outlook refused the saved sign-in: ${redeemed.error}` };
      }
      return { ok: false, held: `The token service is unreachable: ${redeemed.error}` };
    }
    accessToken = redeemed.tokens.accessToken;
    accessCache = { token: accessToken, expiresAt: nowMs + redeemed.tokens.expiresIn * 1000 };

    // Microsoft rotates the refresh token on redemption: persist the new one
    // (creating the record when the seed token from the env was used), so the
    // connection outlives the 90-day life of any single token.
    if (redeemed.tokens.refreshToken && redeemed.tokens.refreshToken !== refreshToken) {
      const sealed = await seal(sessionSecret, redeemed.tokens.refreshToken);
      if (record) {
        await rotateMailToken(db, record, sealed, nowIso);
      } else {
        record = {
          sealedToken: sealed,
          address: graph.sender,
          connectedAt: nowIso,
          status: 'ok',
          updatedAt: nowIso,
        };
        await saveMailConnection(db, record);
      }
    }
  }

  const address = record?.address ?? graph.sender;
  const connected = record;
  return {
    ok: true,
    mailer: {
      address,
      send: async (email: OutboundEmail): Promise<SendOutcome> => {
        const res = await graphSendMail(accessToken, email);
        if (res.ok) return { ok: true };
        if (res.auth) {
          accessCache = null;
          await markStale(db, connected, res.error, new Date().toISOString());
          return { ok: false, auth: true, reason: res.error };
        }
        return { ok: false, auth: false, reason: res.error };
      },
    },
  };
}
