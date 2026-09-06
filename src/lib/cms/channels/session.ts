import type { Client } from '@libsql/client/web';
import type { ChannelCredential } from './credentials';
import { rotateCredential } from './credentials';
import {
  microsoftConfig,
  redeemMicrosoftRefreshToken,
  type EmailPurpose,
} from './microsoft';
import { openChannelSecret, sealChannelSecret } from './secretBox';

export type AccessTokenResult =
  | { ok: true; accessToken: string }
  | { ok: false; auth: boolean; error: string };

export async function microsoftAccessToken(
  db: Client,
  env: Cloudflare.Env,
  credential: ChannelCredential,
): Promise<AccessTokenResult> {
  const purpose = credential.purpose as EmailPurpose;
  if (purpose !== 'NOTIFICATION_EMAIL' && purpose !== 'INQUIRY_EMAIL') {
    return { ok: false, auth: false, error: 'That connection is not a Microsoft email connection.' };
  }
  const config = microsoftConfig(env);
  if (!config) return { ok: false, auth: true, error: 'Microsoft application credentials are unavailable.' };
  const secret = env.CMS_SESSION_SECRET?.trim() ?? '';
  if (secret === '' || !credential.sealedRefreshToken) {
    return { ok: false, auth: true, error: 'The mailbox connection needs to be reconnected.' };
  }
  const refreshToken = await openChannelSecret(secret, credential.sealedRefreshToken);
  if (!refreshToken) return { ok: false, auth: true, error: 'The mailbox credential could not be opened. Reconnect it.' };

  const redeemed = await redeemMicrosoftRefreshToken(config, purpose, refreshToken);
  if (!redeemed.ok) return redeemed;
  if (redeemed.value.refreshToken && redeemed.value.refreshToken !== refreshToken) {
    await rotateCredential(
      db,
      credential,
      await sealChannelSecret(secret, redeemed.value.refreshToken),
      undefined,
    );
  }
  return { ok: true, accessToken: redeemed.value.accessToken };
}
