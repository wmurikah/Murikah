/**
 * In-app channel. There is nothing to send: the notification row itself is the
 * message, and the in-app centre reads it. Delivery is marking the row as sent,
 * done by the dispatcher; here we only report success.
 */
import type { Channel, SendResult } from './types';

export const inAppChannel: Channel = {
  key: 'IN_APP',
  async send(): Promise<SendResult> {
    return { ok: true };
  },
};
