/**
 * Channel adapter contract. Each adapter delivers one notification to one
 * recipient and reports the outcome. External adapters fail closed: when their
 * production configuration is absent they return `deferred`, which tells the
 * dispatcher to put the claimed row back in the queue.
 */
import type { DeliveryEnv } from '../env';

export interface OutboundNotification {
  id: string;
  orgId: string;
  channel: string;
  subject: string | null;
  body: string | null;
  templateKey: string | null;
  entityType: string | null;
  entityId: string | null;
}

export interface DeliveryRecipient {
  name: string | null;
  phone: string | null;
  email: string | null;
}

export interface SendResult {
  outcome: 'sent' | 'failed' | 'deferred';
  providerId?: string;
  message?: string;
}

export interface Channel {
  readonly key: string;
  send(
    notification: OutboundNotification,
    recipient: DeliveryRecipient,
    env: DeliveryEnv,
  ): Promise<SendResult>;
}
