export const prerender = false;

/**
 * Start the one-time connect flow for an evidence storage provider (Build
 * Prompt 51), mirroring the Outlook flow that already exists.
 *
 * The administrator is redirected to the provider's consent screen. The state
 * parameter is a sealed box carrying the acting user, their organisation, the
 * provider and a timestamp; the callback verifies all four, so a forged or
 * replayed callback is refused and a code obtained for one organisation can
 * never be redeemed into another's connection.
 *
 * Unlike the shared mailbox, this is per-organisation configuration: it names
 * the customer's own Drive, SharePoint or Dropbox and affects nobody else, so it
 * is gated on the organisation's own `CONFIG.update` grant rather than on the
 * platform owner (Build Prompt 44, AC-02, applies to `GLOBAL`-scoped writes).
 *
 * Tagged [grc.storage]; never a blank 500.
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { seal } from '@grc/auth/secretBox';
import { can } from '@grc/auth/rbac';
import { isProviderCode } from '@grc/storage/provider';
import { authorizeUrlFor, redirectUriFor } from '@grc/storage/connect';
import { providerAvailable, oauthApp } from '@grc/storage/resolve';

const TAG = '[grc.storage]';
const PAGE = '/settings/storage';
const back = (q: string): Response =>
  new Response(null, { status: 303, headers: { location: `${PAGE}?${q}` } });
const fail = (message: string): Response => back(`error=${encodeURIComponent(message)}`);

export const GET: APIRoute = async ({ params, url, locals }) => {
  const grc = locals.grc;
  if (!grc) return new Response(null, { status: 303, headers: { location: '/login' } });
  if (!grc.isPlatformOwner && !can(locals, 'update', 'CONFIG')) {
    return fail('Evidence storage is configured by an administrator.');
  }

  const provider = String(params.provider ?? '');
  if (!isProviderCode(provider)) return fail('That storage provider is not one this app offers.');

  try {
    if (!providerAvailable(provider)) {
      return fail(
        'That provider is not registered on this deployment yet. See grc/docs/storage-setup.md.',
      );
    }
    const app = oauthApp(provider);
    if (!app)
      return fail('That provider is connected by filling in its credentials, not by OAuth.');

    const state = await seal(
      getGrcEnv().sessionSecret,
      JSON.stringify({
        u: grc.userId,
        o: grc.organizationId,
        p: provider,
        t: Date.now(),
      }),
    );
    const consent = authorizeUrlFor(
      provider,
      app.clientId,
      redirectUriFor(url.origin, provider),
      state,
    );
    if (!consent) return fail('That provider has no sign-in step.');
    return new Response(null, { status: 303, headers: { location: consent } });
  } catch (err) {
    console.error(TAG, err instanceof Error ? (err.stack ?? err.message) : String(err));
    return fail('The connect flow could not start just now. Please try again.');
  }
};
