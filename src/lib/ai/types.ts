/** Provider-agnostic chat types. */

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  system: string;
  messages: ChatMessage[];
  maxTokens?: number;
}

export interface DocExtractRequest {
  system: string;
  instruction: string;
  /** MIME type, e.g. application/pdf, image/png, image/jpeg. */
  mediaType: string;
  /** Base64-encoded document bytes (transient, never stored). */
  dataBase64: string;
  maxTokens?: number;
}

export interface ChatProvider {
  /** Stream the assistant reply as a sequence of text chunks. */
  streamChat(req: ChatRequest): Promise<ReadableStream<string>>;
  /** Non-streaming completion, used internally where streaming is not needed. */
  complete(req: ChatRequest): Promise<string>;
  /** Optional: read a document and return raw text (expected to be JSON). */
  extractFromDocument?(req: DocExtractRequest): Promise<string>;
}
