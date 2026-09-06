import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { requestDb } from '@/lib/cms/db';
import { requireChannelsManage } from '@/lib/cms/channels/access';
import { saveMicrosoftChannel, type ChannelPurpose } from '@/lib/cms/channels/credentials';
import {
  exchangeMicrosoftCode,
  microsoftConfig,
  microsoftMailbox,
  type EmailPurpose,
} from '@/lib/cms/channels/microsoft';
import { openChannelSecret, sealChannelSecret } from '@/lib/cms/channels/secretBox';

export const prerender = false;

const PAGE = '/app/administration/channels';
const MAX_AGE_MS = 15 * 60_000;
const redirect = (query: string): Response =>
  new Response(null, { status: 303, headers: { location: `${PAGE}?${query}` } });
const fail = (message: string): Response => redirect(`error=${encodeURIComponent(message)}`);

interface State {
  userId?: string;
  purpose?: ChannelPurpose;
  issuedAt?: number;
}

function isEmailPurpose(value: unknown): value is EmailPurpose {
  return value === 'NOTIFICATION_EMAIL' || value === 'INQUIRY_EMAIL';
}

export const GET: APIRoute = async (context) => {
  const auth = requireChannelsManage(context);
  if (!auth.ok) return auth.response;

  const providerError = context.url.searchParams.get('error');
  if (providerError) {
    return fail(
      context.url.searchParams.get('error_description') ??
        `Microsoft sign-in was not completed (${providerError}).`,
    );
  }
  const code = context.url.searchParams.get('code');
  const stateValue = context.url.searchParams.get('state');
  if (!code || !stateValue) return fail('The Microsoft sign-in response was incomplete.');

  try {
    const sessionSecret = env.CMS_SESSION_SECRET?.trim() ?? '';
    if (sessionSecret === '') return fail('The CMS session security secret is unavailable.');
    const opened = await openChannelSecret(sessionSecret, stateValue);
    const state = opened ? (JSON.parse(opened) as State) : null;
    if (
      !state ||
      state.userId !== auth.userId ||
      !isEmailPurpose(state.purpose) ||
      typeof state.issuedAt !== 'number'
    ) {
      return fail('The Microsoft sign-in response is not valid for this session.');
    }
    if (Date.now() - state.issuedAt > MAX_AGE_MS) return fail('The Microsoft sign-in expired. Start again.');

    const config = microsoftConfig(env);
    if (!config) return fail('Microsoft sign-in is not configured for this CMS.');
    const redirectUri = `${context.url.origin}/api/admin/channels/microsoft/callback`;
    const exchanged = await exchangeMicrosoftCode(config, state.purpose, code, redirectUri);
    if (!exchanged.ok) return fail(`Microsoft sign-in could not be completed: ${exchanged.error}`);
    if (!exchanged.value.refreshToken) {
      return fail('Microsoft did not grant offline access. Reconnect and approve the requested mailbox access.');
    }
    const mailbox = await microsoftMailbox(exchanged.value.accessToken);
    if (!mailbox.ok) return fail(`The connected mailbox could not be read: ${mailbox.error}`);

    const db = await requestDb(context.locals);
    await saveMicrosoftChannel(db, {
      purpose: state.purpose,
      mailbox: mailbox.value,
      sealedRefreshToken: await sealChannelSecret(sessionSecret, exchanged.value.refreshToken),
      scopes: exchanged.value.scope,
      actorUserId: auth.userId,
    });
    return redirect(
      `connected=${encodeURIComponent(mailbox.value)}&purpose=${encodeURIComponent(state.purpose)}`,
    );
  } catch (error) {
    console.error('[cms.channels.microsoft.callback]', error instanceof Error ? error.message : String(error));
    return fail('The mailbox connection could not be saved. Please try again.');
  }
};
