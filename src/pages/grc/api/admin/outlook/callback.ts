export const prerender = false;

/**
 * Finish the one-time Outlook connect flow: verify the sealed state minted by
 * the connect endpoint (same admin, within fifteen minutes), exchange the
 * authorization code at the consumers token endpoint, read the connected
 * mailbox address from Graph /me, and store the refresh token sealed in the
 * platform config row (repos/mailConnection.ts). The token never appears in a
 * page, a log line or a redirect; the admin only ever sees "Outlook
 * connected" with the address, or a clear error. Tagged [grc.mail]; never a
 * blank 500.
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import { seal, open } from '@grc/auth/secretBox';
import { exchangeAuthCode, fetchMailboxAddress } from '@grc/notify/graph';
import { getGrcDeliveryEnv } from '@grc/notify/env';
import { saveMailConnection } from '@grc/repos/mailConnection';
import { resetMailTokenCache } from '@grc/notify/sendMail';
import { writeAuditLog } from '@grc/repos/audit';

const TAG = '[grc.mail]';
const PAGE = '/settings/email';
const STATE_MAX_AGE_MS = 15 * 60_000;
const back = (q: string): Response =>
  new Response(null, { status: 303, headers: { location: `${PAGE}?${q}` } });
const fail = (message: string): Response => back(`error=${encodeURIComponent(message)}`);

export const GET: APIRoute = async ({ url, locals }) => {
  const grc = locals.grc;
  if (!grc) return new Response(null, { status: 303, headers: { location: '/login' } });
  // Platform owner only (Build Prompt 44): this is the step that stores the
  // shared mailbox record on the platform-wide GLOBAL sentinel, so it carries
  // the same authority as the connect flow that started it (AC-02).
  if (!grc.isPlatformOwner) {
    return fail('The shared mailbox is connected by the platform owner.');
  }
  try {
    const refused = url.searchParams.get('error');
    if (refused) {
      const detail = url.searchParams.get('error_description') ?? refused;
      console.error(TAG, 'connect refused by Microsoft:', detail);
      return fail(`Microsoft refused the sign-in: ${detail.slice(0, 200)}`);
    }
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (!code || !state) return fail('The sign-in response was incomplete. Please try again.');

    const env = getGrcEnv();
    const opened = await open(env.sessionSecret, state);
    const parsed = opened ? (JSON.parse(opened) as { u?: string; t?: number }) : null;
    if (!parsed || parsed.u !== grc.userId || typeof parsed.t !== 'number') {
      return fail('The sign-in link is not valid for this session. Please start again.');
    }
    if (Date.now() - parsed.t > STATE_MAX_AGE_MS) {
      return fail('The sign-in link expired. Please start again.');
    }

    const delivery = getGrcDeliveryEnv();
    if (!delivery.graph) {
      return fail('The Graph app credentials are not configured.');
    }
    const exchanged = await exchangeAuthCode(
      delivery.graph.clientId,
      delivery.graph.clientSecret,
      code,
    );
    if (!exchanged.ok) {
      console.error(TAG, 'code exchange failed:', exchanged.error);
      return fail(`The sign-in could not be completed: ${exchanged.error}`);
    }
    if (!exchanged.tokens.refreshToken) {
      return fail(
        'Microsoft did not grant offline access, so the connection cannot be kept. Check the offline_access scope and try again.',
      );
    }

    const address =
      (await fetchMailboxAddress(exchanged.tokens.accessToken)) ?? delivery.graph.sender;
    const nowIso = new Date().toISOString();
    const db = await getDb(env);
    await saveMailConnection(db, {
      sealedToken: await seal(env.sessionSecret, exchanged.tokens.refreshToken),
      address,
      connectedAt: nowIso,
      status: 'ok',
      updatedAt: nowIso,
    });
    resetMailTokenCache();
    await writeAuditLog(db, {
      organizationId: grc.organizationId,
      userId: grc.userId,
      action: 'MAIL.connect',
      entityType: 'config',
      entityId: 'outlook',
    }).catch(() => undefined);
    return back(`connected=${encodeURIComponent(address)}`);
  } catch (err) {
    console.error(TAG, err instanceof Error ? (err.stack ?? err.message) : String(err));
    return fail('The connection could not be saved just now. Please try again.');
  }
};
