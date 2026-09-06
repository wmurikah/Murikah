import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { requestDb } from '@/lib/cms/db';
import { requireChannelsManage } from '@/lib/cms/channels/access';
import { channelCredentialsReady } from '@/lib/cms/channels/credentials';
import {
  microsoftAuthorizeUrl,
  microsoftConfig,
  type EmailPurpose,
} from '@/lib/cms/channels/microsoft';
import { sealChannelSecret } from '@/lib/cms/channels/secretBox';

export const prerender = false;

const PAGE = '/app/administration/channels';
const back = (url: URL, message: string): Response =>
  new Response(null, {
    status: 303,
    headers: { location: `${PAGE}?error=${encodeURIComponent(message)}` },
  });

function purposeFrom(url: URL): EmailPurpose | null {
  const purpose = url.searchParams.get('purpose');
  return purpose === 'NOTIFICATION_EMAIL' || purpose === 'INQUIRY_EMAIL' ? purpose : null;
}

export const GET: APIRoute = async (context) => {
  const auth = requireChannelsManage(context);
  if (!auth.ok) return auth.response;
  const purpose = purposeFrom(context.url);
  if (!purpose) return back(context.url, 'Choose the email connection to configure.');

  const db = await requestDb(context.locals);
  if (!(await channelCredentialsReady(db))) {
    return back(context.url, 'Run the Channels & Communications database setup script first.');
  }

  const config = microsoftConfig(env);
  if (!config) {
    return back(
      context.url,
      'Microsoft sign-in is not configured for this CMS. The existing Microsoft application credentials are required.',
    );
  }
  const sessionSecret = env.CMS_SESSION_SECRET?.trim() ?? '';
  if (sessionSecret === '') return back(context.url, 'The CMS session security secret is unavailable.');

  const redirectUri = `${context.url.origin}/api/admin/channels/microsoft/callback`;
  const state = await sealChannelSecret(
    sessionSecret,
    JSON.stringify({ userId: auth.userId, purpose, issuedAt: Date.now() }),
  );
  return new Response(null, {
    status: 303,
    headers: { location: microsoftAuthorizeUrl(config, purpose, redirectUri, state) },
  });
};
