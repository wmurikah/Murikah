/**
 * SMS via Africa's Talking. Sends the notification body to the recipient's
 * phone. Outside production, or without credentials, it does not call the
 * provider and defers the row so it remains retryable.
 */
import type { Channel, SendResult } from './types';

interface AtRecipient {
  status?: string;
  messageId?: string;
  number?: string;
}
interface AtResponse {
  SMSMessageData?: { Recipients?: AtRecipient[] };
}

export const smsChannel: Channel = {
  key: 'SMS',
  async send(notification, recipient, env): Promise<SendResult> {
    if (!recipient.phone) return { outcome: 'failed', message: 'no phone number on file' };
    const message = notification.body ?? notification.subject ?? '';
    if (env.mode !== 'production' || !env.at) {
      return { outcome: 'deferred', message: 'SMS delivery is not configured' };
    }
    try {
      const res = await fetch('https://api.africastalking.com/version1/messaging', {
        method: 'POST',
        headers: {
          apiKey: env.at.apiKey,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({
          username: env.at.username,
          to: recipient.phone,
          message,
          from: env.at.senderId,
        }),
      });
      if (!res.ok) return { outcome: 'failed', message: `africastalking http ${res.status}` };
      const data = (await res.json()) as AtResponse;
      const first = data.SMSMessageData?.Recipients?.[0];
      const status = first?.status ?? '';
      if (first && status !== 'Success') {
        return { outcome: 'failed', message: `africastalking status ${status}` };
      }
      return { outcome: 'sent', providerId: first?.messageId };
    } catch (err) {
      return {
        outcome: 'failed',
        message: `africastalking error ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};
