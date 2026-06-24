export const prerender = false;

import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { guard } from '@/lib/demo/guard';
import { json } from '@/lib/http';
import { getProvider, type ChatMessage } from '@/lib/ai';
import { buildSystemPrompt } from '@/lib/ai/prompt';
import { AI_DEFAULTS } from '@/lib/ai/config';

// Shown when no provider is configured. Calm, on-brand, points the right way.
const FALLBACK_REPLY =
  'Thanks for your interest. The live assistant is not switched on in this environment, but here is the short version. Murikah helps African organisations run, prove and improve their internal audit and AI governance. You can explore Audit OS at /audit-os, assurance at /assurance, and the guides at /insights. To talk to the team or book a demo, go to /contact.';

function sanitizeMessages(input: unknown): ChatMessage[] | null {
  if (!Array.isArray(input)) return null;
  const msgs = input
    .slice(-AI_DEFAULTS.maxMessages)
    .map((m) => {
      const r = (m ?? {}) as Record<string, unknown>;
      return {
        role: r.role === 'assistant' ? ('assistant' as const) : ('user' as const),
        content: String(r.content ?? '').slice(0, AI_DEFAULTS.maxCharsPerMessage),
      };
    })
    .filter((m) => m.content.trim().length > 0);
  if (msgs.length === 0 || msgs[msgs.length - 1].role !== 'user') return null;
  return msgs;
}

function sse(
  textStream: ReadableStream<string>,
  onDone: (full: string) => Promise<void>,
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = textStream.getReader();
      let full = '';
      const send = (obj: unknown) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            full += value;
            send({ delta: value });
          }
        }
      } catch {
        send({ error: true });
      } finally {
        send({ done: true });
        try {
          await onDone(full);
        } catch {
          // logging is best-effort
        }
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    },
  });
}

export const POST: APIRoute = async (context) => {
  const g = await guard(context, 'assistant');
  if (g instanceof Response) return g;

  let body: Record<string, unknown> = {};
  try {
    body = (await context.request.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  const messages = sanitizeMessages(body.messages);
  if (!messages) return json({ ok: false, error: 'No message to answer.' }, 422);

  const provider = getProvider(env);
  const lastUser = messages[messages.length - 1].content;

  // Best-effort audit logging of the turn.
  const logTurn = async (reply: string) => {
    if (!g.db) return;
    const conversationId = crypto.randomUUID();
    try {
      await g.db.batch(
        [
          {
            sql: 'INSERT INTO assistant_conversations (id, session_id) VALUES (?, ?)',
            args: [conversationId, g.sessionId],
          },
          {
            sql: 'INSERT INTO assistant_messages (id, conversation_id, role, content, tokens) VALUES (?, ?, ?, ?, ?)',
            args: [
              crypto.randomUUID(),
              conversationId,
              'user',
              lastUser,
              Math.ceil(lastUser.length / 4),
            ],
          },
          {
            sql: 'INSERT INTO assistant_messages (id, conversation_id, role, content, tokens) VALUES (?, ?, ?, ?, ?)',
            args: [
              crypto.randomUUID(),
              conversationId,
              'assistant',
              reply,
              Math.ceil(reply.length / 4),
            ],
          },
        ],
        'write',
      );
    } catch {
      // best-effort
    }
  };

  // No provider configured: stream the calm fallback.
  if (!provider) {
    const fallback = new ReadableStream<string>({
      start(c) {
        c.enqueue(FALLBACK_REPLY);
        c.close();
      },
    });
    return sse(fallback, logTurn);
  }

  try {
    const textStream = await provider.streamChat({
      system: buildSystemPrompt(),
      messages,
      maxTokens: AI_DEFAULTS.chatMaxTokens,
    });
    return sse(textStream, logTurn);
  } catch {
    const errStream = new ReadableStream<string>({
      start(c) {
        c.enqueue(
          'Sorry, I could not answer just now. Please try again, or contact the team at /contact.',
        );
        c.close();
      },
    });
    return sse(errStream, logTurn);
  }
};
