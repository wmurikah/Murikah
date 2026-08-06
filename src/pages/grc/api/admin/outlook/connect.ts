export const prerender = false;

/**
 * Start the one-time Outlook connect flow: redirect the admin to the Microsoft
 * authorize endpoint for personal accounts, asking consent for Mail.Send and
 * offline_access so the callback can store a refresh token. Admin only, gated
 * on the matrix (CONFIG update; a platform owner always passes). The state
 * parameter is a sealed box carrying the acting user and a timestamp, which
 * the callback verifies, so a forged or replayed callback is refused. Tagged
 * [grc.mail]; never a blank 500.
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { can } from '@grc/auth/rbac';
import { seal } from '@grc/auth/secretBox';
import { authorizeUrl } from '@grc/notify/graph';
import { getGrcDeliveryEnv } from '@grc/notify/env';

const TAG = '[grc.mail]';
const PAGE = '/settings/email';
const back = (q: string): Response =>
  new Response(null, { status: 303, headers: { location: `${PAGE}?${q}` } });

export const GET: APIRoute = async ({ locals }) => {
  const grc = locals.grc;
  if (!grc) return new Response(null, { status: 303, headers: { location: '/login' } });
  if (!grc.isPlatformOwner && !can(locals, 'update', 'CONFIG')) {
    return back(`error=${encodeURIComponent('Only an administrator can connect the mailbox.')}`);
  }
  try {
    const delivery = getGrcDeliveryEnv();
    if (!delivery.graph) {
      return back(
        `error=${encodeURIComponent(
          'The Graph app credentials are not configured. Set GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET and GRC_MAIL_SENDER first (see grc/docs/outlook-email-setup.md).',
        )}`,
      );
    }
    const state = await seal(
      getGrcEnv().sessionSecret,
      JSON.stringify({ u: grc.userId, t: Date.now() }),
    );
    return new Response(null, {
      status: 303,
      headers: { location: authorizeUrl(delivery.graph.clientId, state) },
    });
  } catch (err) {
    console.error(TAG, err instanceof Error ? (err.stack ?? err.message) : String(err));
    return back(
      `error=${encodeURIComponent('The connect flow could not start just now. Please try again.')}`,
    );
  }
};
