/**
 * AI provider API keys, read from Worker secrets only. The keys are never stored
 * in the database and never returned to the client; the settings page shows only
 * a masked tail. An absent key leaves that provider unconfigured, and the AI
 * features degrade gracefully.
 */
import { env } from 'cloudflare:workers';
import type { Provider } from './providers';
import { maskKey } from './validation';

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** The configured API key for a provider, or null when the secret is unset. */
export function aiKeyFor(provider: Provider): string | null {
  if (provider === 'openai') return nonEmpty(env.AI_API_KEY_OPENAI);
  if (provider === 'anthropic') return nonEmpty(env.AI_API_KEY_ANTHROPIC);
  return nonEmpty(env.AI_API_KEY_GOOGLE_AI);
}

/** Which providers have a key set (for the settings page and the active-provider guard). */
export function keyPresence(): Record<Provider, boolean> {
  return {
    openai: aiKeyFor('openai') != null,
    anthropic: aiKeyFor('anthropic') != null,
    google: aiKeyFor('google') != null,
  };
}

/** The masked tail of a provider's key, for display only. */
export function maskedKey(provider: Provider): string {
  return maskKey(aiKeyFor(provider));
}
