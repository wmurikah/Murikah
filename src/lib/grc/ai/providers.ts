/**
 * The three AI providers, ported from 05_AIService.gs: how each request is built
 * (OpenAI /v1/chat/completions, Anthropic /v1/messages with the version header,
 * Google generateContent) and how each response is parsed to content and token
 * usage. Pure request-shaping and response-parsing, so the service only does the
 * fetch and the logging. Import-free, so node strips types and unit-tests this.
 */

export type Provider = 'openai' | 'anthropic' | 'google';

export const PROVIDERS: Provider[] = ['openai', 'anthropic', 'google'];

export const PROVIDER_LABELS: Record<Provider, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google AI',
};

export const DEFAULT_MODELS: Record<Provider, string> = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-3-5-sonnet-20241022',
  google: 'gemini-1.5-flash',
};

export function isProvider(v: string): v is Provider {
  return v === 'openai' || v === 'anthropic' || v === 'google';
}

export interface CallOptions {
  model: string;
  maxTokens: number;
  temperature: number;
}

export interface ProviderRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface AiUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ProviderResponse {
  content: string;
  usage: AiUsage;
}

/** Build the HTTP request for a provider (the service performs the fetch). */
export function buildRequest(
  provider: Provider,
  apiKey: string,
  systemPrompt: string,
  prompt: string,
  opts: CallOptions,
): ProviderRequest {
  if (provider === 'openai') {
    return {
      url: 'https://api.openai.com/v1/chat/completions',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: opts.model,
        max_tokens: opts.maxTokens,
        temperature: opts.temperature,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt },
        ],
      }),
    };
  }
  if (provider === 'anthropic') {
    return {
      url: 'https://api.anthropic.com/v1/messages',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: opts.model,
        max_tokens: opts.maxTokens,
        temperature: opts.temperature,
        system: systemPrompt,
        messages: [{ role: 'user', content: prompt }],
      }),
    };
  }
  // google
  return {
    url: `https://generativelanguage.googleapis.com/v1beta/models/${opts.model}:generateContent?key=${encodeURIComponent(apiKey)}`,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: opts.maxTokens, temperature: opts.temperature },
    }),
  };
}

interface OpenAiJson {
  choices?: { message?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}
interface AnthropicJson {
  content?: { text?: string }[];
  usage?: { input_tokens?: number; output_tokens?: number };
}
interface GoogleJson {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

const num = (v: number | undefined): number => (typeof v === 'number' ? v : 0);

/** Parse a provider's JSON response to the content text and token usage. */
export function parseResponse(provider: Provider, json: unknown): ProviderResponse {
  if (provider === 'openai') {
    const j = json as OpenAiJson;
    const content = j.choices?.[0]?.message?.content ?? '';
    const u = j.usage ?? {};
    return {
      content,
      usage: {
        promptTokens: num(u.prompt_tokens),
        completionTokens: num(u.completion_tokens),
        totalTokens: num(u.total_tokens),
      },
    };
  }
  if (provider === 'anthropic') {
    const j = json as AnthropicJson;
    const content = (j.content ?? []).map((p) => p.text ?? '').join('');
    const u = j.usage ?? {};
    const p = num(u.input_tokens);
    const c = num(u.output_tokens);
    return { content, usage: { promptTokens: p, completionTokens: c, totalTokens: p + c } };
  }
  const j = json as GoogleJson;
  const content = (j.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
  const u = j.usageMetadata ?? {};
  return {
    content,
    usage: {
      promptTokens: num(u.promptTokenCount),
      completionTokens: num(u.candidatesTokenCount),
      totalTokens: num(u.totalTokenCount),
    },
  };
}
