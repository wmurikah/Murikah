/**
 * Cloudflare Workers AI provider. A no-external-key fallback used when
 * AI_PROVIDER is 'workers-ai' and the AI binding is present. Kept simple: it
 * returns the full reply as a single chunk rather than token streaming.
 */
import { AI_DEFAULTS } from './config';
import type { ChatProvider, ChatRequest } from './types';

interface AiBinding {
  run: (model: string, input: unknown) => Promise<unknown>;
}

export class WorkersAiProvider implements ChatProvider {
  constructor(
    private ai: AiBinding,
    private model: string = AI_DEFAULTS.workersAiModel,
  ) {}

  async complete(req: ChatRequest): Promise<string> {
    const result = (await this.ai.run(this.model, {
      max_tokens: req.maxTokens ?? AI_DEFAULTS.chatMaxTokens,
      messages: [{ role: 'system', content: req.system }, ...req.messages],
    })) as { response?: string };
    return result.response ?? '';
  }

  async streamChat(req: ChatRequest): Promise<ReadableStream<string>> {
    const text = await this.complete(req);
    return new ReadableStream<string>({
      start(controller) {
        if (text) controller.enqueue(text);
        controller.close();
      },
    });
  }
}
