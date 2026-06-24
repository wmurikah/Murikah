/**
 * Anthropic provider. Calls the Messages API server-side with a bounded
 * max_tokens. The key is passed in from a Cloudflare secret and never leaves
 * the Worker. Errors are thrown generically so the endpoint can return a calm
 * message; raw provider errors are never surfaced to the client.
 */
import { AI_DEFAULTS } from './config';
import type { ChatProvider, ChatRequest, DocExtractRequest } from './types';

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

export class AnthropicProvider implements ChatProvider {
  constructor(
    private apiKey: string,
    private model: string = AI_DEFAULTS.anthropicModel,
  ) {}

  private headers() {
    return {
      'content-type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': API_VERSION,
    };
  }

  async streamChat(req: ChatRequest): Promise<ReadableStream<string>> {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        model: this.model,
        max_tokens: req.maxTokens ?? AI_DEFAULTS.chatMaxTokens,
        system: req.system,
        messages: req.messages,
        stream: true,
      }),
    });
    if (!res.ok || !res.body) throw new Error('provider_error');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    return new ReadableStream<string>({
      async start(controller) {
        let buffer = '';
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed.startsWith('data:')) continue;
              const payload = trimmed.slice(5).trim();
              if (!payload || payload === '[DONE]') continue;
              try {
                const evt = JSON.parse(payload);
                if (
                  evt.type === 'content_block_delta' &&
                  evt.delta?.type === 'text_delta' &&
                  typeof evt.delta.text === 'string'
                ) {
                  controller.enqueue(evt.delta.text);
                }
              } catch {
                // ignore keep-alives and non-JSON lines
              }
            }
          }
        } finally {
          controller.close();
        }
      },
    });
  }

  async complete(req: ChatRequest): Promise<string> {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        model: this.model,
        max_tokens: req.maxTokens ?? AI_DEFAULTS.chatMaxTokens,
        system: req.system,
        messages: req.messages,
      }),
    });
    if (!res.ok) throw new Error('provider_error');
    const data = (await res.json()) as { content?: { type: string; text?: string }[] };
    return data.content?.find((b) => b.type === 'text')?.text ?? '';
  }

  async extractFromDocument(req: DocExtractRequest): Promise<string> {
    const block =
      req.mediaType === 'application/pdf'
        ? {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: req.dataBase64 },
          }
        : {
            type: 'image',
            source: { type: 'base64', media_type: req.mediaType, data: req.dataBase64 },
          };

    const res = await fetch(API_URL, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        model: this.model,
        max_tokens: req.maxTokens ?? AI_DEFAULTS.extractMaxTokens,
        system: req.system,
        messages: [{ role: 'user', content: [block, { type: 'text', text: req.instruction }] }],
      }),
    });
    if (!res.ok) throw new Error('provider_error');
    const data = (await res.json()) as { content?: { type: string; text?: string }[] };
    return data.content?.find((b) => b.type === 'text')?.text ?? '';
  }
}
