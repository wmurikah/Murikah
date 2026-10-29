export const prerender = false;

/**
 * Finish the one-time connect flow for an evidence storage provider (Build
 * Prompt 51), mirroring the Outlook callback.
 *
 * The sealed state minted by the connect route is verified first: the same
 * user, the same organisation, the same provider, within fifteen minutes. Only
 * then is the authorization code exchanged, and the resulting refresh token is
 * sealed against that organisation before it is stored. The token never appears
 * in a page, a log line or a redirect; the administrator only ever sees
 * "Connected as ..." or a clear error.
 *
 * The organisation is taken from the state, not from the acting session, and
 * the two must agree. That is what makes a code obtained in one tenant
 * unusable against another's connection.
 *
 * Tagged [grc.storage]; never a blank 500.
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import { open } from '@grc/auth/secretBox';
import { can } from '@grc/auth/rbac';
import { isProviderCode, providerDefinition } from '@grc/storage/provider';
import { accountLabel, redirectUriFor } from '@grc/storage/connect';
import { oauthApp } from '@grc/storage/resolve';
import { exchangeCode } from '@grc/storage/providers/oauth';
import { loadConnection, saveConnection } from '@grc/repos/storageConnections';
import { writeAuditLog } from '@grc/repos/audit';

const TAG = '[grc.storage]';
const PAGE = '/settings/storage';
const STATE_MAX_AGE_MS = 15 * 60_000;
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
    const refused = url.searchParams.get('error');
    if (refused) {
      const detail = url.searchParams.get('error_description') ?? refused;
      console.error(TAG, 'connect refused by provider:', detail);
      return fail(`The provider refused the sign-in: ${detail.slice(0, 200)}`);
    }
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (!code || !state) return fail('The sign-in response was incomplete. Please try again.');

    const env = getGrcEnv();
    const opened = await open(env.sessionSecret, state);
    const parsed = opened
      ? (JSON.parse(opened) as { u?: string; o?: string; p?: string; t?: number })
      : null;
    if (
      !parsed ||
      parsed.u !== grc.userId ||
      parsed.o !== grc.organizationId ||
      parsed.p !== provider ||
      typeof parsed.t !== 'number'
    ) {
      return fail('The sign-in link is not valid for this session. Please start again.');
    }
    if (Date.now() - parsed.t > STATE_MAX_AGE_MS) {
      return fail('The sign-in link expired. Please start again.');
    }

    const app = oauthApp(provider);
    if (!app) return fail('That provider is not registered on this deployment.');

    const exchanged = await exchangeCode(app, code, redirectUriFor(url.origin, provider));
    if (!exchanged.ok) {
      console.error(TAG, 'code exchange failed:', exchanged.error);
      return fail(`The sign-in could not be completed: ${exchanged.error}`);
    }
    if (!exchanged.refreshToken) {
      return fail(
        'The provider did not grant offline access, so the connection cannot be kept. Try again and accept the offline permission.',
      );
    }

    const db = await getDb(env);
    // Keep whatever folder was already chosen, so reconnecting to rotate a
    // credential does not silently move where evidence lands.
    const existing = await loadConnection(db, env.sessionSecret, grc.organizationId, provider);
    const account = await accountLabel(provider, app, exchanged.accessToken);
    await saveConnection(db, env.sessionSecret, grc.organizationId, {
      provider,
      config: {
        refresh_token: exchanged.refreshToken,
        ...(account ? { account } : {}),
      },
      folderId: existing?.folderId ?? null,
      folderName: existing?.folderName ?? null,
      // Consent proves the account, not that the chosen folder is writable, so
      // the connection is pending until a test writes and removes a probe.
      status: 'pending',
      statusDetail: 'Connected. Test the connection to confirm the folder is writable.',
      connectedBy: grc.userId,
    });

    await writeAuditLog(db, {
      organizationId: grc.organizationId,
      userId: grc.userId,
      action: 'STORAGE.connect',
      entityType: 'storage_connection',
      entityId: provider,
    }).catch(() => undefined);

    const name = providerDefinition(provider)?.name ?? provider;
    return back(
      `connected=${encodeURIComponent(account ? `${name} connected as ${account}.` : `${name} connected.`)}`,
    );
  } catch (err) {
    console.error(TAG, err instanceof Error ? (err.stack ?? err.message) : String(err));
    return fail('The connection could not be saved just now. Please try again.');
  }
};
