/**
 * Maps a notifications.channel value to its adapter. The dispatcher looks up the
 * adapter by the row's channel, or by a fallback channel when SMS metering
 * downgrades a send.
 */
import type { Channel } from './types';
import { smsChannel } from './sms-africastalking';
import { emailChannel } from './email-resend';
import { inAppChannel } from './inapp';

const REGISTRY: Record<string, Channel> = {
  SMS: smsChannel,
  EMAIL: emailChannel,
  IN_APP: inAppChannel,
};

export function channelFor(key: string): Channel | null {
  return REGISTRY[key] ?? null;
}
