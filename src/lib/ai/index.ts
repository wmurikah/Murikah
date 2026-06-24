/**
 * Provider selection. Defaults to Anthropic when a key is set; uses Workers AI
 * when AI_PROVIDER is 'workers-ai' and the binding is present. Returns null when
 * nothing is configured, so the endpoint can degrade to a calm message.
 */
import type { ChatProvider } from './types';
import { AnthropicProvider } from './anthropic';
import { WorkersAiProvider } from './workers-ai';

interface ProviderEnv {
  AI_PROVIDER?: string;
  ANTHROPIC_API_KEY?: string;
  AI_MODEL?: string;
  AI?: { run: (model: string, input: unknown) => Promise<unknown> };
}

export function getProvider(env: ProviderEnv): ChatProvider | null {
  const choice = (env.AI_PROVIDER ?? 'anthropic').toLowerCase();

  if (choice === 'workers-ai' && env.AI) {
    return new WorkersAiProvider(env.AI, env.AI_MODEL);
  }
  if (env.ANTHROPIC_API_KEY) {
    return new AnthropicProvider(env.ANTHROPIC_API_KEY, env.AI_MODEL);
  }
  return null;
}

export type { ChatProvider, ChatMessage } from './types';
