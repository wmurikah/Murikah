/**
 * Calling a model over HTTP, with the key read from a Worker secret and never
 * from a row.
 *
 * NO SDK, AND NOT ONLY BECAUSE THE PHASE FORBIDS ONE. A provider SDK is a
 * dependency that ships a retry policy, a telemetry client and a transport you
 * did not choose into a Worker with a 50-subrequest budget. Two request shapes
 * and one response shape are perhaps eighty lines; the SDK is megabytes and
 * hides where the round trips go.
 *
 * WHERE THE KEY LIVES, AND WHY NOWHERE ELSE. `ai_providers.secret_name` holds
 * the NAME of a Worker secret. The value is read from `env` at call time and
 * never written anywhere: not to a row, not to a log, not into an error
 * message. A key in the database is readable by anyone holding the Turso
 * token, lands in every backup and every copy taken for a staging environment,
 * and cannot be rotated without an UPDATE against production. A key in the
 * Worker's secret store is rotated with one `wrangler secret put` and appears
 * in no dump.
 *
 * WHAT A FAILURE IS ALLOWED TO SAY. Four states, and each is a different
 * action for the administrator:
 *
 *   OK             The provider answered.
 *   UNAUTHORISED   The key is missing, wrong, or has been revoked. Rotate it.
 *   UNREACHABLE    The network or the provider is down. Wait, then retry.
 *   ERROR          Anything else, including a malformed response.
 *
 * The provider's own error body is logged and never returned, because it can
 * quote the request, and the request can contain a customer's message.
 */
import type { AiProvider } from './providers.ts';

/** What a model was asked, in the one shape both request builders take. */
export interface ModelRequest {
  /** The standing instruction. Never a customer's words. */
  readonly system: string;
  /** The turns, oldest first. */
  readonly messages: readonly { role: 'user' | 'assistant'; content: string }[];
  /** Overrides the provider's configured ceiling, for a small classification. */
  readonly maxOutputTokens?: number;
}

export type VerifyStatus = 'OK' | 'UNAUTHORISED' | 'UNREACHABLE' | 'ERROR';

export interface ModelAnswer {
  readonly status: VerifyStatus;
  /** The text, or an empty string on any status but OK. */
  readonly content: string;
  readonly model: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly latencyMs: number;
}

/** The default ceiling where a provider configures none. */
const DEFAULT_MAX_OUTPUT_TOKENS = 1024;

/** Longer than a model needs and shorter than a Worker's patience. */
const TIMEOUT_MS = 30_000;

const ENDPOINTS: Readonly<Record<string, string>> = {
  ANTHROPIC: 'https://api.anthropic.com/v1/messages',
  OPENAI: 'https://api.openai.com/v1/chat/completions',
  GOOGLE: 'https://generativelanguage.googleapis.com/v1beta/models',
};

/**
 * The secret's value, by the name the provider row carries.
 *
 * Deliberately narrow: it reads one property off the Worker environment and
 * returns whether it was set. The name comes from an administrator typing it
 * into a form, so it is checked against the shape a Worker secret can have
 * rather than used to index the environment with whatever arrived.
 */
export function secretValue(env: Record<string, unknown>, name: string): string | null {
  if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(name)) return null;
  const value = env[name];
  return typeof value === 'string' && value !== '' ? value : null;
}

/** True where the named secret is present, for the screen. Never the value. */
export function secretPresent(env: Record<string, unknown>, name: string): boolean {
  return secretValue(env, name) !== null;
}

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null;

/**
 * One model call.
 *
 * ONE SUBREQUEST, ALWAYS. There is no retry loop here: a Worker that retries a
 * 30-second call twice has spent its whole request budget on one answer, and
 * the caller is better placed to decide whether asking again is worth it.
 */
export async function callModel(
  provider: AiProvider,
  env: Record<string, unknown>,
  request: ModelRequest,
): Promise<ModelAnswer> {
  const started = Date.now();
  const fail = (status: VerifyStatus): ModelAnswer => ({
    status,
    content: '',
    model: provider.model,
    inputTokens: null,
    outputTokens: null,
    latencyMs: Date.now() - started,
  });

  const key = secretValue(env, provider.secretName);
  // A MISSING SECRET IS UNAUTHORISED, NOT AN ERROR. It is the same fix as a
  // revoked key: put the secret in place. Calling out with no credential to
  // learn that would spend a subrequest to be told what is already known.
  if (key === null) return fail('UNAUTHORISED');

  const maxTokens =
    request.maxOutputTokens ?? provider.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;

  let url: string;
  let headers: Record<string, string>;
  let body: unknown;

  if (provider.providerType === 'ANTHROPIC') {
    url = provider.baseUrl ?? ENDPOINTS.ANTHROPIC!;
    headers = {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    };
    body = {
      model: provider.model,
      max_tokens: maxTokens,
      system: request.system,
      messages: request.messages,
      ...(provider.temperature === null ? {} : { temperature: provider.temperature }),
    };
  } else {
    // OPENAI, AZURE_OPENAI and OTHER all speak the chat-completions shape; a
    // provider that does not is configured with its own base URL and is
    // expected to. GOOGLE is listed in the CHECK and has no endpoint here yet,
    // so it is refused rather than sent somewhere that will not understand it.
    if (provider.providerType === 'GOOGLE') return fail('ERROR');
    url = provider.baseUrl ?? ENDPOINTS.OPENAI!;
    headers = { 'content-type': 'application/json', authorization: `Bearer ${key}` };
    body = {
      model: provider.model,
      max_completion_tokens: maxTokens,
      messages: [{ role: 'system', content: request.system }, ...request.messages],
      ...(provider.temperature === null ? {} : { temperature: provider.temperature }),
    };
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    // A timeout and a DNS failure are the same action: wait and try again.
    console.error('[cms.ai.model] provider unreachable', error);
    return fail('UNREACHABLE');
  }

  if (!response.ok) {
    // THE PROVIDER'S BODY GOES TO THE LOG AND NEVER TO THE CALLER. It quotes
    // the request back, and the request can contain a customer's message.
    const detail = await response.text().catch(() => '');
    console.error(`[cms.ai.model] provider refused ${response.status}: ${detail.slice(0, 300)}`);
    if (response.status === 401 || response.status === 403) return fail('UNAUTHORISED');
    if (response.status === 429 || response.status >= 500) return fail('UNREACHABLE');
    return fail('ERROR');
  }

  const parsed = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (parsed === null) return fail('ERROR');

  const latencyMs = Date.now() - started;

  if (provider.providerType === 'ANTHROPIC') {
    const blocks = Array.isArray(parsed.content) ? parsed.content : [];
    const content = blocks
      .map((block) => {
        const b = block as Record<string, unknown>;
        return b.type === 'text' && typeof b.text === 'string' ? b.text : '';
      })
      .join('');
    const usage = (parsed.usage ?? {}) as Record<string, unknown>;
    return {
      status: 'OK',
      content,
      model: typeof parsed.model === 'string' ? parsed.model : provider.model,
      inputTokens: num(usage.input_tokens),
      outputTokens: num(usage.output_tokens),
      latencyMs,
    };
  }

  const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
  const first = (choices[0] ?? {}) as Record<string, unknown>;
  const message = (first.message ?? {}) as Record<string, unknown>;
  const usage = (parsed.usage ?? {}) as Record<string, unknown>;
  return {
    status: 'OK',
    content: typeof message.content === 'string' ? message.content : '',
    model: typeof parsed.model === 'string' ? parsed.model : provider.model,
    inputTokens: num(usage.prompt_tokens),
    outputTokens: num(usage.completion_tokens),
    latencyMs,
  };
}

/**
 * The smallest call that proves the credential works.
 *
 * One token of output. The question is "does this key open this model", not
 * "what does this model say", and an administrator pressing Test should not be
 * billed for a paragraph.
 */
export async function verifyProvider(
  provider: AiProvider,
  env: Record<string, unknown>,
): Promise<VerifyStatus> {
  const answer = await callModel(provider, env, {
    system: 'Reply with the single word OK.',
    messages: [{ role: 'user', content: 'OK' }],
    maxOutputTokens: 8,
  });
  return answer.status;
}
