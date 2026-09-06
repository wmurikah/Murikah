import type { Client } from '@libsql/client/web';
import { ingestMessage, classifyMessage } from '../ai/inbox';
import type { WriteContext } from '../admin/guard';
import { getChannelCredential, markChannelRead, rotateCredential } from './credentials';
import { initialInboxDeltaUrl, microsoftDeltaPage } from './microsoft';
import { microsoftAccessToken } from './session';

export interface InquirySyncResult {
  stored: number;
  alreadyHeld: number;
  classified: number;
  queued: number;
  pages: number;
  more: boolean;
  note: string | null;
}

function plainBody(content: string | undefined, preview: string | undefined): string | null {
  if (content && content.trim() !== '') {
    return content
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?\s*>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/\s+\n/g, '\n')
      .replace(/\n\s+/g, '\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim()
      .slice(0, 12000);
  }
  const fallback = preview?.trim() ?? '';
  return fallback === '' ? null : fallback.slice(0, 12000);
}

export async function syncInquiryEmail(
  db: Client,
  workerEnv: Cloudflare.Env,
  actorUserId: string,
  maxPages = 4,
): Promise<InquirySyncResult> {
  const credential = await getChannelCredential(db, 'INQUIRY_EMAIL');
  if (!credential) throw new Error('No connected inquiry email mailbox.');
  const token = await microsoftAccessToken(db, workerEnv, credential);
  if (!token.ok) {
    await markChannelRead(db, credential.channelConnectionId, token.error);
    throw new Error(token.error);
  }

  const ctx: WriteContext = {
    actorUserId,
    ip: null,
    userAgent: 'cms-channel-sync',
    now: new Date(),
  };
  let cursor = credential.syncCursor ?? initialInboxDeltaUrl();
  let stored = 0;
  let alreadyHeld = 0;
  let classified = 0;
  let queued = 0;
  let pages = 0;
  let note: string | null = null;
  let more = false;

  try {
    while (pages < Math.max(1, Math.min(maxPages, 6))) {
      const page = await microsoftDeltaPage(token.accessToken, cursor);
      if (!page.ok) throw new Error(page.error);
      pages += 1;

      for (const message of page.value.value ?? []) {
        if (!message.id || message['@removed'] !== undefined || message.isDraft === true) continue;
        const from = message.from?.emailAddress?.address?.trim() || null;
        const recipients = (message.toRecipients ?? [])
          .map((recipient) => recipient.emailAddress?.address?.trim() ?? '')
          .filter(Boolean)
          .join(', ');
        const result = await ingestMessage(db, {
          channelConnectionId: credential.channelConnectionId,
          externalMessageId: message.id,
          fromAddress: from,
          toAddress: recipients || credential.accountIdentifier,
          subject: message.subject?.trim() || null,
          body: plainBody(message.body?.content, message.bodyPreview),
          receivedAt: message.receivedDateTime ?? new Date().toISOString(),
          raw: {
            provider: 'MICROSOFT',
            conversationId: message.conversationId ?? null,
            internetMessageId: message.internetMessageId ?? null,
          },
        });
        if (!result.stored) {
          alreadyHeld += 1;
          continue;
        }
        stored += 1;
        if (!result.channelMessageId) continue;
        const outcome = await classifyMessage(
          db,
          result.channelMessageId,
          workerEnv as unknown as Record<string, unknown>,
          ctx,
        );
        if (outcome.classified) classified += 1;
        else {
          queued += 1;
          note = outcome.reason;
        }
      }

      const next = page.value['@odata.nextLink'];
      const delta = page.value['@odata.deltaLink'];
      if (next) {
        cursor = next;
        more = true;
        if (pages >= maxPages) break;
        continue;
      }
      if (delta) cursor = delta;
      more = false;
      break;
    }

    await rotateCredential(db, credential, null, cursor);
    await markChannelRead(db, credential.channelConnectionId, null);
    return { stored, alreadyHeld, classified, queued, pages, more, note };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markChannelRead(db, credential.channelConnectionId, message.slice(0, 500)).catch(() => undefined);
    throw error;
  }
}
