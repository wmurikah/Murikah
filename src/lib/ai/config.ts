/** AI defaults. Override the model with the AI_MODEL env var. */
export const AI_DEFAULTS = {
  /** A current small, fast, low-cost chat model. */
  anthropicModel: 'claude-haiku-4-5-20251001',
  workersAiModel: '@cf/meta/llama-3.1-8b-instruct',
  /** Bounded output for chat and for document extraction. */
  chatMaxTokens: 700,
  extractMaxTokens: 1200,
  /** Limits on the incoming message list (untrusted input). */
  maxMessages: 16,
  maxCharsPerMessage: 4000,
};
