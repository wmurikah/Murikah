import { Container, getContainer } from '@cloudflare/containers';

type PersistenceRunResult = { meta?: { changes?: number } };
type PersistenceStatement = {
  bind(...values: unknown[]): PersistenceStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
  run(): Promise<PersistenceRunResult>;
};
type PersistenceDatabase = {
  prepare(query: string): PersistenceStatement;
  batch(statements: PersistenceStatement[]): Promise<PersistenceRunResult[]>;
};
type PersistenceR2Object = {
  body: ReadableStream<Uint8Array>;
  size: number;
  customMetadata?: Record<string, string>;
};
type PersistenceBucket = {
  put(
    key: string,
    value: ReadableStream<Uint8Array> | ArrayBuffer,
    options?: { customMetadata?: Record<string, string> },
  ): Promise<unknown>;
  get(key: string): Promise<PersistenceR2Object | null>;
  delete(key: string): Promise<void>;
};

type TutorEnv = {
  TUTOR_CONTAINER: DurableObjectNamespace<TutorContainer>;
  TUTOR_DB: PersistenceDatabase;
  TUTOR_FILES: PersistenceBucket;
  MURIKAH_TUTOR_RUNTIME: string;
  MURIKAH_CLOUDFLARE_IMAGE_REV?: string;
  MURIKAH_PUBLIC_BASE_URL?: string;
  MURIKAH_GUEST_PROMPT_LIMIT?: string;
  TZ: string;
  MURIKAH_TUTOR_ADMIN_USERNAME?: string;
  MURIKAH_TUTOR_ADMIN_PASSWORD?: string;
  MURIKAH_TUTOR_AUTH_SECRET?: string;
  MURIKAH_TUTOR_TOKEN_EXPIRE_HOURS?: string;
  MURIKAH_GOOGLE_CLIENT_ID?: string;
  MURIKAH_GOOGLE_CLIENT_SECRET?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM_EMAIL?: string;
  MURIKAH_MICROSOFT_CLIENT_ID?: string;
  MURIKAH_MICROSOFT_CLIENT_SECRET?: string;
  MURIKAH_MICROSOFT_TENANT?: string;
  MURIKAH_APPLE_CLIENT_ID?: string;
  MURIKAH_APPLE_TEAM_ID?: string;
  MURIKAH_APPLE_KEY_ID?: string;
  MURIKAH_APPLE_PRIVATE_KEY_B64?: string;
  MURIKAH_NVIDIA_NIM_API_KEY?: string;
  MURIKAH_NVIDIA_NIM_BASE_URL?: string;
  MURIKAH_LLM_PRIMARY_MODEL?: string;
  MURIKAH_LLM_SECONDARY_MODEL?: string;
  MURIKAH_LLM_TERTIARY_MODEL?: string;
  MURIKAH_GEMINI_API_KEY?: string;
  MURIKAH_FAST_CHAT_MODEL?: string;
  MURIKAH_DASHSCOPE_API_KEY?: string;
  MURIKAH_DASHSCOPE_BASE_URL?: string;
  MURIKAH_EMBEDDING_PROVIDER?: string;
  MURIKAH_EMBEDDING_MODEL?: string;
  MURIKAH_EMBEDDING_DIMENSION?: string;
  MURIKAH_EMBEDDING_ENDPOINT?: string;
  MURIKAH_SEARCH_PROVIDER?: string;
  MURIKAH_TAVILY_API_KEY?: string;
  MURIKAH_TTS_PROVIDER?: string;
  MURIKAH_TTS_MODEL?: string;
  MURIKAH_TTS_VOICE?: string;
  MURIKAH_TTS_BASE_URL?: string;
  MURIKAH_STT_PROVIDER?: string;
  MURIKAH_STT_MODEL?: string;
  MURIKAH_STT_BASE_URL?: string;
  MURIKAH_IMAGE_PROVIDER?: string;
  MURIKAH_IMAGE_MODEL?: string;
  MURIKAH_IMAGE_BASE_URL?: string;
  MURIKAH_VIDEO_PROVIDER?: string;
  MURIKAH_VIDEO_MODEL?: string;
  MURIKAH_VIDEO_BASE_URL?: string;
  MURIKAH_VIDEO_LEARNING_PROVIDER?: string;
  MURIKAH_VIDEO_LEARNING_TRANSCRIPT_PROVIDER?: string;
  MURIKAH_INVIDIOUS_API_BASE_URL?: string;
  MURIKAH_INVIDIOUS_PUBLIC_BASE_URL?: string;
};

type ContainerState = {
  status?: string;
  lastChange?: number;
  exitCode?: number;
  [key: string]: unknown;
};

type RuntimeStatus = {
  running: boolean;
  ready: boolean;
  httpStatus?: number;
  state?: ContainerState | { error: string };
  error?: string;
  workerSecretConfigured?: boolean;
};

const APP_INSTANCE = 'murikah-tutor-staging-v7';
const DIAGNOSTIC_INSTANCE = 'murikah-tutor-staging-diagnostics-v7';
const CLOUDFLARE_ENTRYPOINT = '/app/murikah-cloudflare-entrypoint.sh';
const READY_CACHE_MS = 5_000;
const PERSISTENCE_PREFIX = '/__muri/persist';
const PERSISTENCE_CLOCK_SKEW_SECONDS = 120;
const PERSISTENCE_MAX_PATHS = 20_000;
const EMAIL_CODE_TTL_SECONDS = 10 * 60;
const EMAIL_RESEND_SECONDS = 60;
const EMAIL_MAX_ATTEMPTS = 5;
const EMAIL_MAX_SENDS = 3;

let readyCacheUntil = 0;
let statusInFlight: Promise<RuntimeStatus> | null = null;

function optional(value: string | undefined): string {
  return value?.trim() || '';
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hexBytes(value: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/i.test(value)) return null;
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }
  return bytes;
}

async function digestHex(buffer: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer));
  return Array.from(digest, (value) => value.toString(16).padStart(2, '0')).join('');
}

function persistenceJson(payload: unknown, status = 200): Response {
  return Response.json(payload, {
    status,
    headers: {
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

function safePersistencePath(url: URL): string | null {
  const raw = (url.searchParams.get('path') || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = raw.split('/');
  if (
    !raw ||
    raw.length > 1024 ||
    parts.some((part) => !part || part === '.' || part === '..' || part.includes('\0'))
  ) {
    return null;
  }
  return parts.join('/');
}

type PersistenceOwnership = {
  ownerKind: 'user' | 'partner' | 'admin' | 'system';
  ownerId: string;
  objectType: string;
};

function objectTypeForPath(path: string): string {
  const parts = path.toLowerCase().split('/');
  const joined = '/' + parts.join('/') + '/';
  if (joined.includes('/knowledge') || joined.includes('/kb/') || joined.includes('/rag/')) {
    return 'knowledge';
  }
  if (joined.includes('/book') || joined.includes('/reading') || joined.includes('/notebook')) {
    return 'learning_asset';
  }
  if (joined.includes('/memory')) return 'memory';
  if (
    joined.includes('/session') ||
    joined.includes('/chat') ||
    joined.includes('/conversation')
  ) {
    return 'conversation';
  }
  if (
    joined.includes('/upload') ||
    joined.includes('/attachment') ||
    joined.includes('/document') ||
    joined.includes('/files/')
  ) {
    return 'upload';
  }
  if (
    joined.includes('/diagram') ||
    joined.includes('/visual') ||
    joined.includes('/generated') ||
    joined.includes('/output') ||
    joined.includes('/math_animator')
  ) {
    return 'generated';
  }
  if (joined.includes('/settings/')) return 'settings';
  if (joined.includes('/auth/') || joined.includes('/grant')) return 'control';
  return 'workspace';
}

function persistenceOwnership(path: string): PersistenceOwnership {
  const parts = path.split('/');
  const first = parts[0] || '';
  const second = parts[1] || '';
  if (first === 'users' && validPersistenceId(second)) {
    return { ownerKind: 'user', ownerId: second, objectType: objectTypeForPath(path) };
  }
  if (first === 'partners' && validPersistenceId(second)) {
    return { ownerKind: 'partner', ownerId: second, objectType: objectTypeForPath(path) };
  }
  if (first === 'user') {
    return { ownerKind: 'admin', ownerId: 'admin', objectType: objectTypeForPath(path) };
  }
  return { ownerKind: 'system', ownerId: 'system', objectType: objectTypeForPath(path) };
}

function persistenceObjectKey(ownership: PersistenceOwnership, objectId: string): string {
  const root =
    ownership.ownerKind === 'user'
      ? 'users'
      : ownership.ownerKind === 'partner'
        ? 'partners'
        : ownership.ownerKind;
  return [
    root,
    encodeURIComponent(ownership.ownerId),
    encodeURIComponent(ownership.objectType),
    objectId,
  ].join('/');
}

function safeContentType(value: string | null): string {
  const text = String(value || 'application/octet-stream').trim();
  if (!text || text.length > 128 || /[\r\n]/.test(text)) return 'application/octet-stream';
  return text;
}

function validPersistenceId(value: unknown): string {
  const text = String(value || '').trim();
  return /^[A-Za-z0-9_-]{3,128}$/.test(text) ? text : '';
}

function learningText(value: unknown, limit: number): string {
  return String(value || '').replace(/\0/g, '').slice(0, Math.max(0, limit));
}

function normalizeEmail(value: unknown): string {
  const email = learningText(value, 254).trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return '';
  return email;
}

function verificationRequesterHash(value: unknown): string {
  const text = learningText(value, 64).trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(text) ? text : '';
}

async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)),
  );
  return Array.from(signature, (item) => item.toString(16).padStart(2, '0')).join('');
}

function sixDigitCode(): string {
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return String(bytes[0] % 1_000_000).padStart(6, '0');
}

async function sendVerificationEmail(
  env: TutorEnv,
  email: string,
  code: string,
): Promise<void> {
  const apiKey = optional(env.RESEND_API_KEY);
  if (!apiKey) throw new Error('verification_email_not_configured');
  const from = optional(env.RESEND_FROM_EMAIL) || 'Murikah Tutor <noreply@murikah.com>';
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: email,
      subject: 'Your Murikah Tutor verification code',
      text: [
        'Your Murikah Tutor verification code is:',
        '',
        code,
        '',
        'This code expires in 10 minutes and can only be used once.',
        'If you did not try to create a Murikah Tutor account, you can ignore this email.',
      ].join('\n'),
    }),
  });
  if (!response.ok) {
    console.error('Tutor verification email send failed', response.status);
    throw new Error('verification_email_send_failed');
  }
}

async function textSha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (item) => item.toString(16).padStart(2, '0')).join('');
}

async function upsertLearningActor(
  env: TutorEnv,
  actorId: string,
  actorType: string,
  username: string,
  guestSessionId: string,
  now: number,
): Promise<void> {
  await env.TUTOR_DB.batch([
    env.TUTOR_DB.prepare(
      'INSERT INTO tutor_actors(actor_id, actor_type, username, guest_session_id, created_at, updated_at, converted_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, NULL) ' +
        'ON CONFLICT(actor_id) DO UPDATE SET ' +
        'actor_type = excluded.actor_type, ' +
        "username = CASE WHEN excluded.username <> '' THEN excluded.username ELSE tutor_actors.username END, " +
        "guest_session_id = CASE WHEN excluded.guest_session_id <> '' THEN excluded.guest_session_id ELSE tutor_actors.guest_session_id END, " +
        'updated_at = excluded.updated_at, ' +
        "converted_at = CASE WHEN tutor_actors.actor_type = 'guest' AND excluded.actor_type <> 'guest' " +
        'THEN COALESCE(tutor_actors.converted_at, excluded.updated_at) ELSE tutor_actors.converted_at END',
    ).bind(actorId, actorType, username, guestSessionId, now, now),
    env.TUTOR_DB.prepare(
      'INSERT OR IGNORE INTO tutor_training_consent(actor_id, training_opt_in, research_opt_in, consent_version, consented_at, updated_at) ' +
        "VALUES (?, 0, 0, '', NULL, ?)",
    ).bind(actorId, now),
    env.TUTOR_DB.prepare(
      'INSERT OR IGNORE INTO tutor_actor_profiles(actor_id, updated_at) VALUES (?, ?)',
    ).bind(actorId, now),
  ]);
}

async function verifyPersistenceRequest(
  request: Request,
  env: TutorEnv,
  url: URL,
): Promise<Response | null> {
  const secret = optional(env.MURIKAH_TUTOR_AUTH_SECRET);
  if (secret.length < 32) return persistenceJson({ error: 'persistence_unavailable' }, 503);

  const timestamp = request.headers.get('x-murikah-persistence-timestamp') || '';
  const nonce = request.headers.get('x-murikah-persistence-nonce') || '';
  const contentSha = request.headers.get('x-murikah-content-sha256') || '';
  const signature = request.headers.get('x-murikah-persistence-signature') || '';
  const signatureBytes = hexBytes(signature);
  const parsedTimestamp = Number(timestamp);
  const now = Math.floor(Date.now() / 1000);

  if (
    !Number.isInteger(parsedTimestamp) ||
    Math.abs(now - parsedTimestamp) > PERSISTENCE_CLOCK_SKEW_SECONDS ||
    !/^[0-9a-f]{32}$/i.test(nonce) ||
    !/^[0-9a-f]{64}$/i.test(contentSha) ||
    !signatureBytes
  ) {
    return persistenceJson({ error: 'persistence_unauthorized' }, 401);
  }

  if ((request.headers.get('content-type') || '').includes('application/json')) {
    const actualSha = await digestHex(await request.clone().arrayBuffer());
    if (actualSha !== contentSha) {
      return persistenceJson({ error: 'persistence_body_mismatch' }, 401);
    }
  }

  const canonical = [
    timestamp,
    nonce,
    request.method.toUpperCase(),
    url.pathname + url.search,
    contentSha,
  ].join('\n');
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const verified = await crypto.subtle.verify(
    'HMAC',
    key,
    signatureBytes,
    new TextEncoder().encode(canonical),
  );
  if (!verified) return persistenceJson({ error: 'persistence_unauthorized' }, 401);

  await env.TUTOR_DB.prepare('DELETE FROM persistence_replay WHERE expires_at <= ?')
    .bind(now)
    .run();
  const replay = await env.TUTOR_DB.prepare(
    'INSERT OR IGNORE INTO persistence_replay(nonce, expires_at) VALUES (?, ?)',
  )
    .bind(nonce, now + 300)
    .run();
  if ((replay.meta?.changes || 0) !== 1) {
    return persistenceJson({ error: 'persistence_replay' }, 409);
  }
  return null;
}

async function requestJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const value = await request.json();
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function handlePersistence(request: Request, env: TutorEnv, url: URL): Promise<Response> {
  const denied = await verifyPersistenceRequest(request, env, url);
  if (denied) return denied;

  const route = url.pathname.slice(PERSISTENCE_PREFIX.length);
  const now = Math.floor(Date.now() / 1000);

  if (route === '/learning/actor' && request.method === 'POST') {
    const body = await requestJson(request);
    const actorId = validPersistenceId(body.actor_id);
    const actorType = learningText(body.actor_type, 16);
    const username = learningText(body.username, 254);
    const guestSessionId = learningText(body.guest_session_id, 128);
    if (!actorId || !['guest', 'member', 'admin'].includes(actorType)) {
      return persistenceJson({ error: 'invalid_learning_actor' }, 400);
    }
    try {
      await upsertLearningActor(
        env,
        actorId,
        actorType,
        actorType === 'guest' ? '' : username,
        actorType === 'guest' ? (guestSessionId || actorId) : '',
        now,
      );
      return persistenceJson({ ok: true });
    } catch (error) {
      console.error('Tutor D1 actor upsert failed', error);
      return persistenceJson({ error: 'learning_actor_failed' }, 503);
    }
  }

  if (route === '/learning/turn/start' && request.method === 'POST') {
    const body = await requestJson(request);
    const turnId = validPersistenceId(body.turn_id);
    const conversationId = validPersistenceId(body.conversation_id);
    const actorId = validPersistenceId(body.actor_id);
    const actorType = learningText(body.actor_type, 16);
    const username = learningText(body.username, 254);
    const guestSessionId = learningText(body.guest_session_id, 128);
    const prompt = learningText(body.prompt, 120000);
    const promptSummary = learningText(body.prompt_summary, 800);
    const capability = learningText(body.capability || 'chat', 64) || 'chat';
    const language = learningText(body.language, 24);
    const modelProfileId = learningText(body.model_profile_id, 128);
    const modelId = learningText(body.model_id, 256);
    const regenerate = body.regenerate === true ? 1 : 0;
    if (
      !turnId ||
      !conversationId ||
      !actorId ||
      !['guest', 'member', 'admin'].includes(actorType) ||
      (!prompt.trim() && regenerate !== 1)
    ) {
      return persistenceJson({ error: 'invalid_learning_turn' }, 400);
    }
    try {
      await upsertLearningActor(
        env,
        actorId,
        actorType,
        actorType === 'guest' ? '' : username,
        actorType === 'guest' ? (guestSessionId || actorId) : '',
        now,
      );
      await env.TUTOR_DB.prepare(
        'INSERT INTO tutor_conversations(conversation_id, actor_id, title, summary, surface, created_at, updated_at, message_count, last_turn_id) ' +
          "VALUES (?, ?, ?, '', 'chat', ?, ?, 0, ?) " +
          'ON CONFLICT(conversation_id) DO UPDATE SET actor_id = excluded.actor_id, updated_at = excluded.updated_at, last_turn_id = excluded.last_turn_id',
      )
        .bind(conversationId, actorId, promptSummary.slice(0, 100), now, now, turnId)
        .run();
      await env.TUTOR_DB.prepare(
        'INSERT INTO tutor_turns(turn_id, conversation_id, actor_id, status, capability, language, prompt_summary, response_summary, ' +
          'model_profile_id, model_id, provider, first_token_ms, total_ms, error_code, error_text, retryable, regenerate, training_eligible, ' +
          'created_at, updated_at, finished_at) ' +
          "VALUES (?, ?, ?, 'running', ?, ?, ?, '', ?, ?, '', 0, 0, '', '', 0, ?, 0, ?, ?, NULL) " +
          'ON CONFLICT(turn_id) DO UPDATE SET updated_at = excluded.updated_at',
      )
        .bind(
          turnId,
          conversationId,
          actorId,
          capability,
          language,
          promptSummary,
          modelProfileId,
          modelId,
          regenerate,
          now,
          now,
        )
        .run();
      if (prompt.trim()) {
        const messageId = turnId + '_user';
        const promptHash = await textSha256(prompt);
        await env.TUTOR_DB.prepare(
          'INSERT INTO tutor_messages(message_id, conversation_id, turn_id, actor_id, role, content, content_summary, content_sha256, created_at) ' +
            "VALUES (?, ?, ?, ?, 'user', ?, ?, ?, ?) " +
            'ON CONFLICT(message_id) DO UPDATE SET content = excluded.content, content_summary = excluded.content_summary, content_sha256 = excluded.content_sha256',
        )
          .bind(messageId, conversationId, turnId, actorId, prompt, promptSummary, promptHash, now)
          .run();
      }
      await env.TUTOR_DB.prepare(
        'UPDATE tutor_conversations SET message_count = (SELECT COUNT(*) FROM tutor_messages WHERE conversation_id = ?), updated_at = ? WHERE conversation_id = ?',
      )
        .bind(conversationId, now, conversationId)
        .run();
      return persistenceJson({ ok: true });
    } catch (error) {
      console.error('Tutor D1 learning turn start failed', error);
      return persistenceJson({ error: 'learning_turn_start_failed' }, 503);
    }
  }

  if (route === '/learning/turn/finish' && request.method === 'POST') {
    const body = await requestJson(request);
    const turnId = validPersistenceId(body.turn_id);
    const status = learningText(body.status || 'completed', 16);
    const response = learningText(body.response, 120000);
    const responseSummary = learningText(body.response_summary, 800);
    const provider = learningText(body.provider, 128);
    const modelId = learningText(body.model_id, 256);
    const firstTokenMs = Number(body.first_token_ms || 0);
    const totalMs = Number(body.total_ms || 0);
    const errorCode = learningText(body.error_code, 128);
    const errorTextValue = learningText(body.error_text, 2000);
    const retryable = body.retryable === true ? 1 : 0;
    if (
      !turnId ||
      !['completed', 'failed', 'timed_out', 'cancelled'].includes(status) ||
      !Number.isSafeInteger(firstTokenMs) ||
      firstTokenMs < 0 ||
      !Number.isSafeInteger(totalMs) ||
      totalMs < 0
    ) {
      return persistenceJson({ error: 'invalid_learning_finish' }, 400);
    }
    try {
      const turn = await env.TUTOR_DB.prepare(
        'SELECT conversation_id, actor_id FROM tutor_turns WHERE turn_id = ?',
      )
        .bind(turnId)
        .first<{ conversation_id: string; actor_id: string }>();
      if (!turn) return persistenceJson({ error: 'learning_turn_not_found' }, 404);

      if (response) {
        const responseHash = await textSha256(response);
        await env.TUTOR_DB.prepare(
          'INSERT INTO tutor_messages(message_id, conversation_id, turn_id, actor_id, role, content, content_summary, content_sha256, created_at) ' +
            "VALUES (?, ?, ?, ?, 'assistant', ?, ?, ?, ?) " +
            'ON CONFLICT(message_id) DO UPDATE SET content = excluded.content, content_summary = excluded.content_summary, content_sha256 = excluded.content_sha256',
        )
          .bind(
            turnId + '_assistant',
            turn.conversation_id,
            turnId,
            turn.actor_id,
            response,
            responseSummary,
            responseHash,
            now,
          )
          .run();
      }
      await env.TUTOR_DB.prepare(
        'UPDATE tutor_turns SET status = ?, response_summary = ?, provider = ?, ' +
          "model_id = CASE WHEN ? <> '' THEN ? ELSE model_id END, first_token_ms = ?, total_ms = ?, " +
          'error_code = ?, error_text = ?, retryable = ?, updated_at = ?, finished_at = ?, ' +
          "training_eligible = CASE WHEN ? = 'completed' AND EXISTS (" +
          'SELECT 1 FROM tutor_training_consent c WHERE c.actor_id = tutor_turns.actor_id AND c.training_opt_in = 1' +
          ') THEN 1 ELSE 0 END WHERE turn_id = ?',
      )
        .bind(
          status,
          responseSummary,
          provider,
          modelId,
          modelId,
          firstTokenMs,
          totalMs,
          errorCode,
          errorTextValue,
          retryable,
          now,
          now,
          status,
          turnId,
        )
        .run();
      await env.TUTOR_DB.prepare(
        'UPDATE tutor_conversations SET summary = ?, message_count = (SELECT COUNT(*) FROM tutor_messages WHERE conversation_id = ?), ' +
          'updated_at = ?, last_turn_id = ? WHERE conversation_id = ?',
      )
        .bind(responseSummary, turn.conversation_id, now, turnId, turn.conversation_id)
        .run();
      return persistenceJson({ ok: true });
    } catch (error) {
      console.error('Tutor D1 learning turn finish failed', error);
      return persistenceJson({ error: 'learning_turn_finish_failed' }, 503);
    }
  }

  if (route === '/learning/status' && request.method === 'GET') {
    try {
      const counts = await env.TUTOR_DB.prepare(
        'SELECT ' +
          '(SELECT COUNT(*) FROM tutor_actors) AS actors, ' +
          '(SELECT COUNT(*) FROM tutor_conversations) AS conversations, ' +
          '(SELECT COUNT(*) FROM tutor_turns) AS turns, ' +
          '(SELECT COUNT(*) FROM tutor_messages) AS messages',
      ).first<{ actors: number; conversations: number; turns: number; messages: number }>();
      return persistenceJson({ ok: true, ...(counts || {}) });
    } catch (error) {
      return persistenceJson({ ok: false, error: 'learning_status_unavailable' }, 503);
    }
  }

  if (route === '/email/start' && request.method === 'POST') {
    const body = await requestJson(request);
    const email = normalizeEmail(body.email);
    const purpose = learningText(body.purpose, 32);
    const provider = learningText(body.provider, 32);
    const requesterHash = verificationRequesterHash(body.requester_hash);
    if (!email || !['local_signup', 'social_signup'].includes(purpose)) {
      return persistenceJson({ error: 'invalid_email_verification_request' }, 400);
    }
    const domain = email.split('@')[1] || '';
    const hourAgo = now - 3600;
    const emailRate = await env.TUTOR_DB.prepare(
      'SELECT COUNT(*) AS count FROM tutor_email_verifications WHERE email = ? AND created_at >= ?',
    ).bind(email, hourAgo).first<{ count: number }>();
    if (Number(emailRate?.count || 0) >= 5) {
      return persistenceJson({ error: 'verification_rate_limited', retry_after: 3600 }, 429);
    }
    if (requesterHash) {
      const requesterRate = await env.TUTOR_DB.prepare(
        'SELECT COUNT(*) AS count FROM tutor_email_verifications WHERE requester_hash = ? AND created_at >= ?',
      ).bind(requesterHash, hourAgo).first<{ count: number }>();
      if (Number(requesterRate?.count || 0) >= 10) {
        return persistenceJson({ error: 'verification_rate_limited', retry_after: 3600 }, 429);
      }
    }

    const challengeId = crypto.randomUUID().replace(/-/g, '');
    const code = sixDigitCode();
    const secret = optional(env.MURIKAH_TUTOR_AUTH_SECRET);
    const digest = await hmacHex(secret, `${challengeId}\n${email}\n${code}`);
    const expiresAt = now + EMAIL_CODE_TTL_SECONDS;
    const resendAfter = now + EMAIL_RESEND_SECONDS;
    await env.TUTOR_DB.prepare(
      'INSERT INTO tutor_email_verifications(challenge_id, email, email_domain, purpose, provider, requester_hash, code_digest, attempts, max_attempts, send_count, expires_at, resend_after, verified_at, consumed_at, created_at, updated_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 1, ?, ?, NULL, NULL, ?, ?)',
    )
      .bind(
        challengeId,
        email,
        domain,
        purpose,
        provider,
        requesterHash,
        digest,
        EMAIL_MAX_ATTEMPTS,
        expiresAt,
        resendAfter,
        now,
        now,
      )
      .run();
    try {
      await sendVerificationEmail(env, email, code);
    } catch (error) {
      console.error('Tutor verification start could not send email', error);
      return persistenceJson({ error: 'verification_email_unavailable' }, 503);
    }
    return persistenceJson({
      ok: true,
      challenge_id: challengeId,
      expires_in: EMAIL_CODE_TTL_SECONDS,
      resend_after: EMAIL_RESEND_SECONDS,
      masked_email: email.replace(/^(.{1,2}).*(@.*)$/, '$1••••$2'),
    });
  }

  if (route === '/email/resend' && request.method === 'POST') {
    const body = await requestJson(request);
    const challengeId = validPersistenceId(body.challenge_id);
    const requesterHash = verificationRequesterHash(body.requester_hash);
    if (!challengeId) return persistenceJson({ error: 'invalid_verification_challenge' }, 400);
    const row = await env.TUTOR_DB.prepare(
      'SELECT email, requester_hash, expires_at, resend_after, send_count, consumed_at FROM tutor_email_verifications WHERE challenge_id = ?',
    ).bind(challengeId).first<{
      email: string;
      requester_hash: string;
      expires_at: number;
      resend_after: number;
      send_count: number;
      consumed_at: number | null;
    }>();
    if (!row || row.consumed_at || Number(row.expires_at || 0) <= now) {
      return persistenceJson({ error: 'verification_expired' }, 410);
    }
    if (row.requester_hash && requesterHash && row.requester_hash !== requesterHash) {
      return persistenceJson({ error: 'verification_requester_mismatch' }, 403);
    }
    if (Number(row.send_count || 0) >= EMAIL_MAX_SENDS) {
      return persistenceJson({ error: 'verification_send_limit' }, 429);
    }
    if (Number(row.resend_after || 0) > now) {
      return persistenceJson({
        error: 'verification_resend_cooldown',
        retry_after: Number(row.resend_after) - now,
      }, 429);
    }
    const code = sixDigitCode();
    const secret = optional(env.MURIKAH_TUTOR_AUTH_SECRET);
    const digest = await hmacHex(secret, `${challengeId}\n${row.email}\n${code}`);
    const resendAfter = now + EMAIL_RESEND_SECONDS;
    await env.TUTOR_DB.prepare(
      'UPDATE tutor_email_verifications SET code_digest = ?, attempts = 0, send_count = send_count + 1, resend_after = ?, updated_at = ? WHERE challenge_id = ?',
    ).bind(digest, resendAfter, now, challengeId).run();
    try {
      await sendVerificationEmail(env, row.email, code);
    } catch (error) {
      console.error('Tutor verification resend could not send email', error);
      return persistenceJson({ error: 'verification_email_unavailable' }, 503);
    }
    return persistenceJson({ ok: true, resend_after: EMAIL_RESEND_SECONDS });
  }

  if (route === '/email/verify' && request.method === 'POST') {
    const body = await requestJson(request);
    const challengeId = validPersistenceId(body.challenge_id);
    const code = learningText(body.code, 12).trim();
    if (!challengeId || !/^\d{6}$/.test(code)) {
      return persistenceJson({ error: 'invalid_verification_code' }, 422);
    }
    const row = await env.TUTOR_DB.prepare(
      'SELECT email, purpose, provider, code_digest, attempts, max_attempts, expires_at, consumed_at FROM tutor_email_verifications WHERE challenge_id = ?',
    ).bind(challengeId).first<{
      email: string;
      purpose: string;
      provider: string;
      code_digest: string;
      attempts: number;
      max_attempts: number;
      expires_at: number;
      consumed_at: number | null;
    }>();
    if (!row || row.consumed_at || Number(row.expires_at || 0) <= now) {
      return persistenceJson({ error: 'verification_expired' }, 410);
    }
    if (Number(row.attempts || 0) >= Number(row.max_attempts || EMAIL_MAX_ATTEMPTS)) {
      return persistenceJson({ error: 'verification_attempt_limit' }, 429);
    }
    const secret = optional(env.MURIKAH_TUTOR_AUTH_SECRET);
    const supplied = await hmacHex(secret, `${challengeId}\n${row.email}\n${code}`);
    if (supplied !== row.code_digest) {
      await env.TUTOR_DB.prepare(
        'UPDATE tutor_email_verifications SET attempts = attempts + 1, updated_at = ? WHERE challenge_id = ?',
      ).bind(now, challengeId).run();
      return persistenceJson({ error: 'invalid_verification_code' }, 422);
    }
    await env.TUTOR_DB.prepare(
      'UPDATE tutor_email_verifications SET verified_at = ?, consumed_at = ?, updated_at = ? WHERE challenge_id = ?',
    ).bind(now, now, now, challengeId).run();
    return persistenceJson({
      ok: true,
      email: row.email,
      purpose: row.purpose,
      provider: row.provider,
      verified_at: now,
    });
  }

  if (route === '/account/upsert' && request.method === 'POST') {
    const body = await requestJson(request);
    const actorId = validPersistenceId(body.actor_id);
    const username = learningText(body.username, 254);
    const role = learningText(body.role || 'member', 16);
    const authProvider = learningText(body.auth_provider || 'local', 32);
    const email = normalizeEmail(body.email);
    const emailVerifiedAtRaw = Number(body.email_verified_at || 0);
    const emailVerifiedAt =
      Number.isSafeInteger(emailVerifiedAtRaw) && emailVerifiedAtRaw > 0
        ? emailVerifiedAtRaw
        : null;
    if (!actorId || !['guest', 'member', 'admin'].includes(role) || !authProvider) {
      return persistenceJson({ error: 'invalid_account_metadata' }, 400);
    }
    try {
      await upsertLearningActor(
        env,
        actorId,
        role === 'member' ? 'member' : role,
        role === 'guest' ? '' : username,
        role === 'guest' ? actorId : '',
        now,
      );
      await env.TUTOR_DB.prepare(
        'INSERT INTO tutor_accounts(actor_id, username, role, account_status, auth_provider, created_at, updated_at, email, email_verified_at) ' +
          "VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?) " +
          'ON CONFLICT(actor_id) DO UPDATE SET username = excluded.username, role = excluded.role, ' +
          "account_status = 'active', auth_provider = excluded.auth_provider, updated_at = excluded.updated_at, " +
          "email = CASE WHEN excluded.email <> '' THEN excluded.email ELSE tutor_accounts.email END, " +
          'email_verified_at = COALESCE(excluded.email_verified_at, tutor_accounts.email_verified_at)',
      )
        .bind(actorId, username, role, authProvider, now, now, email, emailVerifiedAt)
        .run();
      return persistenceJson({ ok: true });
    } catch (error) {
      console.error('Tutor D1 account upsert failed', error);
      return persistenceJson({ error: 'account_upsert_failed' }, 503);
    }
  }

  if (route === '/audit' && request.method === 'POST') {
    const body = await requestJson(request);
    const actorId = learningText(body.actor_id, 128);
    const actorRole = learningText(body.actor_role, 16);
    const action = learningText(body.action, 96);
    const resource = learningText(body.resource, 192);
    const outcome = learningText(body.outcome, 16);
    const detail = learningText(body.detail, 500);
    if (!action || !resource || !['allowed', 'denied', 'error'].includes(outcome)) {
      return persistenceJson({ error: 'invalid_audit_event' }, 400);
    }
    const auditId = crypto.randomUUID().replace(/-/g, '');
    await env.TUTOR_DB.prepare(
      'INSERT INTO tutor_access_audit(audit_id, actor_id, actor_role, action, resource, outcome, detail, created_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(auditId, actorId, actorRole, action, resource, outcome, detail, now)
      .run();
    return persistenceJson({ ok: true, audit_id: auditId });
  }

  if (route === '/ownership/reconcile' && request.method === 'POST') {
    try {
      const result = await env.TUTOR_DB.prepare(
        'SELECT path, object_key, sha256, size_bytes, updated_at FROM persistence_objects ORDER BY path',
      ).all<{
        path: string;
        object_key: string;
        sha256: string;
        size_bytes: number;
        updated_at: number;
      }>();
      const rows = result.results || [];
      let registered = 0;
      for (let offset = 0; offset < rows.length; offset += 40) {
        const statements: PersistenceStatement[] = [];
        for (const row of rows.slice(offset, offset + 40)) {
          const probe = new URL('https://persist.invalid/');
          probe.searchParams.set('path', row.path);
          const path = safePersistencePath(probe);
          if (!path) continue;
          const ownership = persistenceOwnership(path);
          const objectId = await textSha256(path);
          statements.push(
            env.TUTOR_DB.prepare(
              'INSERT INTO tutor_objects(object_id, owner_kind, owner_id, object_type, runtime_path, object_key, sha256, size_bytes, content_type, created_at, updated_at, deleted_at) ' +
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'application/octet-stream', ?, ?, NULL) " +
                'ON CONFLICT(runtime_path) DO UPDATE SET owner_kind = excluded.owner_kind, owner_id = excluded.owner_id, ' +
                'object_type = excluded.object_type, object_key = excluded.object_key, sha256 = excluded.sha256, ' +
                'size_bytes = excluded.size_bytes, updated_at = excluded.updated_at, deleted_at = NULL',
            ).bind(
              objectId,
              ownership.ownerKind,
              ownership.ownerId,
              ownership.objectType,
              path,
              row.object_key,
              row.sha256,
              Number(row.size_bytes || 0),
              Number(row.updated_at || now),
              now,
            ),
          );
        }
        if (statements.length) {
          await env.TUTOR_DB.batch(statements);
          registered += statements.length;
        }
      }
      return persistenceJson({ ok: true, registered });
    } catch (error) {
      console.error('Tutor object ownership reconciliation failed', error);
      return persistenceJson({ error: 'ownership_reconcile_failed' }, 503);
    }
  }

  if (route === '/ownership/status' && request.method === 'GET') {
    try {
      const counts = await env.TUTOR_DB.prepare(
        'SELECT ' +
          '(SELECT COUNT(*) FROM tutor_objects WHERE deleted_at IS NULL) AS objects, ' +
          "(SELECT COUNT(*) FROM tutor_objects WHERE deleted_at IS NULL AND owner_kind = 'user') AS user_objects, " +
          "(SELECT COUNT(*) FROM tutor_objects WHERE deleted_at IS NULL AND owner_kind = 'partner') AS partner_objects, " +
          "(SELECT COUNT(*) FROM tutor_accounts WHERE account_status = 'active') AS accounts, " +
          '(SELECT COUNT(*) FROM persistence_objects p LEFT JOIN tutor_objects o ON o.runtime_path = p.path WHERE o.object_id IS NULL) AS unregistered',
      ).first<{
        objects: number;
        user_objects: number;
        partner_objects: number;
        accounts: number;
        unregistered: number;
      }>();
      return persistenceJson({ ok: true, ...(counts || {}) });
    } catch (error) {
      return persistenceJson({ ok: false, error: 'ownership_status_unavailable' }, 503);
    }
  }

  if (route === '/manifest' && request.method === 'GET') {
    const result = await env.TUTOR_DB.prepare(
      'SELECT path, sha256, size_bytes, mtime_ms, updated_at FROM persistence_objects ORDER BY path',
    ).all();
    return persistenceJson({ items: result.results || [] });
  }

  if (route === '/object') {
    const path = safePersistencePath(url);
    if (!path) return persistenceJson({ error: 'invalid_path' }, 400);

    if (request.method === 'GET') {
      const row = await env.TUTOR_DB.prepare(
        'SELECT object_key, sha256, size_bytes, mtime_ms FROM persistence_objects WHERE path = ?',
      )
        .bind(path)
        .first<{
          object_key: string;
          sha256: string;
          size_bytes: number;
          mtime_ms: number;
        }>();
      if (!row) return persistenceJson({ error: 'not_found' }, 404);
      const object = await env.TUTOR_FILES.get(row.object_key);
      if (!object) return persistenceJson({ error: 'object_missing' }, 503);
      return new Response(object.body, {
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(object.size),
          'x-murikah-object-sha256': row.sha256,
          'x-murikah-object-mtime-ms': String(row.mtime_ms),
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        },
      });
    }

    if (request.method === 'PUT') {
      const sha = request.headers.get('x-murikah-object-sha256') || '';
      const signedContentSha = request.headers.get('x-murikah-content-sha256') || '';
      const generation = request.headers.get('x-murikah-object-generation') || '';
      const mtime = Number(request.headers.get('x-murikah-object-mtime-ms') || '0');
      const size = Number(request.headers.get('x-murikah-object-size') || '0');
      const ownership = persistenceOwnership(path);
      const suppliedOwnerKind = request.headers.get('x-murikah-object-owner-kind') || '';
      const suppliedOwnerId = request.headers.get('x-murikah-object-owner-id') || '';
      const suppliedObjectType = request.headers.get('x-murikah-object-type') || '';
      const suppliedObjectId = request.headers.get('x-murikah-object-id') || '';
      const contentType = safeContentType(request.headers.get('x-murikah-object-content-type'));
      const objectId = await textSha256(path);
      if (
        !/^[0-9a-f]{64}$/i.test(sha) ||
        sha !== signedContentSha ||
        !/^[0-9a-f]{32}$/i.test(generation) ||
        !Number.isSafeInteger(mtime) ||
        mtime < 0 ||
        !Number.isSafeInteger(size) ||
        size < 0 ||
        (suppliedOwnerKind && suppliedOwnerKind !== ownership.ownerKind) ||
        (suppliedOwnerId && suppliedOwnerId !== ownership.ownerId) ||
        (suppliedObjectType && suppliedObjectType !== ownership.objectType) ||
        (suppliedObjectId && suppliedObjectId !== objectId)
      ) {
        return persistenceJson({ error: 'invalid_object_metadata' }, 400);
      }
      const key = persistenceObjectKey(ownership, objectId);
      await env.TUTOR_FILES.put(key, request.body || new ArrayBuffer(0), {
        customMetadata: {
          path,
          sha256: sha,
          object_id: objectId,
          owner_kind: ownership.ownerKind,
          owner_id: ownership.ownerId,
          object_type: ownership.objectType,
        },
      });
      await env.TUTOR_DB.batch([
        env.TUTOR_DB.prepare(
          'INSERT INTO persistence_objects(path, object_key, sha256, size_bytes, mtime_ns, mtime_ms, generation, updated_at) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?) ' +
            'ON CONFLICT(path) DO UPDATE SET object_key = excluded.object_key, sha256 = excluded.sha256, ' +
            'size_bytes = excluded.size_bytes, mtime_ns = excluded.mtime_ns, mtime_ms = excluded.mtime_ms, ' +
            'generation = excluded.generation, updated_at = excluded.updated_at',
        ).bind(path, key, sha, size, mtime, mtime, generation, now),
        env.TUTOR_DB.prepare(
          'INSERT INTO tutor_objects(object_id, owner_kind, owner_id, object_type, runtime_path, object_key, sha256, size_bytes, content_type, created_at, updated_at, deleted_at) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL) ' +
            'ON CONFLICT(runtime_path) DO UPDATE SET ' +
            'object_id = excluded.object_id, owner_kind = excluded.owner_kind, owner_id = excluded.owner_id, ' +
            'object_type = excluded.object_type, object_key = excluded.object_key, sha256 = excluded.sha256, ' +
            'size_bytes = excluded.size_bytes, content_type = excluded.content_type, updated_at = excluded.updated_at, deleted_at = NULL',
        ).bind(
          objectId,
          ownership.ownerKind,
          ownership.ownerId,
          ownership.objectType,
          path,
          key,
          sha,
          size,
          contentType,
          now,
          now,
        ),
      ]);
      return persistenceJson({
        ok: true,
        object_id: objectId,
        owner_kind: ownership.ownerKind,
        owner_id: ownership.ownerId,
        object_type: ownership.objectType,
      });
    }
  }

  if (route === '/commit' && request.method === 'POST') {
    const body = await requestJson(request);
    const generation = String(body.generation || '');
    const rawPaths = Array.isArray(body.paths) ? body.paths : [];
    const paths = Array.from(new Set(rawPaths.map((value) => String(value || '')).filter(Boolean)));
    if (!/^[0-9a-f]{32}$/i.test(generation) || paths.length > PERSISTENCE_MAX_PATHS) {
      return persistenceJson({ error: 'invalid_commit' }, 400);
    }
    for (const path of paths) {
      const probe = new URL('https://persist.invalid/');
      probe.searchParams.set('path', path);
      if (safePersistencePath(probe) !== path) {
        return persistenceJson({ error: 'invalid_commit_path' }, 400);
      }
    }

    const statements: PersistenceStatement[] = [];
    for (let offset = 0; offset < paths.length; offset += 50) {
      const chunk = paths.slice(offset, offset + 50);
      const placeholders = chunk.map(() => '?').join(',');
      statements.push(
        env.TUTOR_DB.prepare(
          'UPDATE persistence_objects SET generation = ?, updated_at = ? WHERE path IN (' +
            placeholders +
            ')',
        ).bind(generation, now, ...chunk),
      );
    }
    if (statements.length) await env.TUTOR_DB.batch(statements);

    // Do not infer deletes from one container's missing local paths. During a
    // Cloudflare rollout, old and new image generations can overlap briefly;
    // treating either snapshot as globally authoritative could delete a newer
    // object's durable copy. Explicit tombstones can be introduced after the
    // single-container replacement test. Until then, orphaned objects are safer
    // than data loss.
    await env.TUTOR_DB.prepare(
      "INSERT INTO persistence_meta(key, value, updated_at) VALUES ('last_generation', ?, ?) " +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    )
      .bind(generation, now)
      .run();
    return persistenceJson({ ok: true, pruned: 0 });
  }

  if (route === '/guest/session' && request.method === 'POST') {
    const body = await requestJson(request);
    const uid = validPersistenceId(body.uid);
    const expiresAt = Number(body.expires_at || 0);
    const usedCount = Number(body.used_count || 0);
    const promptLimit = Number(body.prompt_limit || 7);
    if (
      !uid ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= now ||
      !Number.isSafeInteger(usedCount) ||
      usedCount < 0 ||
      !Number.isSafeInteger(promptLimit) ||
      promptLimit < 1 ||
      usedCount > promptLimit
    ) {
      return persistenceJson({ error: 'invalid_guest_session' }, 400);
    }
    await env.TUTOR_DB.prepare('DELETE FROM guest_sessions WHERE expires_at <= ?').bind(now).run();
    await env.TUTOR_DB.prepare(
      'INSERT INTO guest_sessions(uid, expires_at, used_count, prompt_limit, created_at, updated_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(uid) DO UPDATE SET ' +
        'expires_at = excluded.expires_at, used_count = MAX(guest_sessions.used_count, excluded.used_count), ' +
        'prompt_limit = excluded.prompt_limit, updated_at = excluded.updated_at',
    )
      .bind(uid, expiresAt, usedCount, promptLimit, now, now)
      .run();
    return persistenceJson({ ok: true });
  }

  if (route === '/guest/session' && request.method === 'DELETE') {
    const uid = validPersistenceId(url.searchParams.get('uid'));
    if (!uid) return persistenceJson({ error: 'invalid_guest' }, 400);
    await env.TUTOR_DB.prepare('DELETE FROM guest_sessions WHERE uid = ?').bind(uid).run();
    return persistenceJson({ ok: true });
  }

  if (route === '/guest/status' && request.method === 'GET') {
    const uid = validPersistenceId(url.searchParams.get('uid'));
    if (!uid) return persistenceJson({ error: 'invalid_guest' }, 400);
    const row = await env.TUTOR_DB.prepare(
      'SELECT s.expires_at, s.used_count + COUNT(p.request_id) AS used_count, s.prompt_limit ' +
        'FROM guest_sessions s LEFT JOIN guest_prompts p ON p.uid = s.uid ' +
        'WHERE s.uid = ? GROUP BY s.uid, s.expires_at, s.used_count, s.prompt_limit',
    )
      .bind(uid)
      .first<{ expires_at: number; used_count: number; prompt_limit: number }>();
    const expired = !row || row.expires_at <= now;
    const used = Number(row?.used_count || 0);
    const limit = Number(row?.prompt_limit || 7);
    return persistenceJson({
      guest: true,
      used,
      limit,
      remaining: expired ? 0 : Math.max(0, limit - used),
      requires_auth: expired || used >= limit,
    });
  }

  if (route === '/guest/reserve' && request.method === 'POST') {
    const body = await requestJson(request);
    const uid = validPersistenceId(body.uid);
    const requestId = validPersistenceId(body.request_id);
    if (!uid || !requestId) return persistenceJson({ error: 'invalid_guest_prompt' }, 400);

    // One conditional write enforces expiry, idempotency and the seven-prompt
    // ceiling without CREATE TRIGGER statements. D1 serializes the write, so
    // concurrent tabs cannot both claim the final remaining prompt.
    const inserted = await env.TUTOR_DB.prepare(
      'INSERT OR IGNORE INTO guest_prompts(uid, request_id, created_at) ' +
        'SELECT ?, ?, ? WHERE EXISTS (' +
        'SELECT 1 FROM guest_sessions s WHERE s.uid = ? AND s.expires_at > ? ' +
        'AND s.used_count + (SELECT COUNT(*) FROM guest_prompts gp WHERE gp.uid = s.uid) < s.prompt_limit' +
        ')',
    )
      .bind(uid, requestId, now, uid, now)
      .run();
    if ((inserted.meta?.changes || 0) === 1) {
      return persistenceJson({ ok: true, charged: true });
    }

    const duplicate = await env.TUTOR_DB.prepare(
      'SELECT 1 AS present FROM guest_prompts WHERE uid = ? AND request_id = ?',
    )
      .bind(uid, requestId)
      .first<{ present: number }>();
    if (duplicate) return persistenceJson({ ok: true, charged: false });

    const state = await env.TUTOR_DB.prepare(
      'SELECT s.expires_at, s.used_count + COUNT(p.request_id) AS used_count, s.prompt_limit ' +
        'FROM guest_sessions s LEFT JOIN guest_prompts p ON p.uid = s.uid ' +
        'WHERE s.uid = ? GROUP BY s.uid, s.expires_at, s.used_count, s.prompt_limit',
    )
      .bind(uid)
      .first<{ expires_at: number; used_count: number; prompt_limit: number }>();
    if (!state || state.expires_at <= now) {
      return persistenceJson({ error: 'guest_session_expired' }, 403);
    }
    if (Number(state.used_count || 0) >= Number(state.prompt_limit || 7)) {
      return persistenceJson({ error: 'guest_prompt_limit' }, 403);
    }

    console.error('Tutor D1 guest reserve failed without a classified state');
    return persistenceJson({ error: 'persistence_failed' }, 503);
  }

  if (route === '/guest/release' && request.method === 'POST') {
    const body = await requestJson(request);
    const uid = validPersistenceId(body.uid);
    const requestId = validPersistenceId(body.request_id);
    if (!uid || !requestId) return persistenceJson({ error: 'invalid_guest_prompt' }, 400);
    await env.TUTOR_DB.prepare('DELETE FROM guest_prompts WHERE uid = ? AND request_id = ?')
      .bind(uid, requestId)
      .run();
    return persistenceJson({ ok: true });
  }

  return persistenceJson({ error: 'persistence_route_not_found' }, 404);
}

function buildContainerEnv(source: TutorEnv): Record<string, string> {
  return {
    TZ: source.TZ || 'Africa/Nairobi',
    FRONTEND_HOST: '0.0.0.0',
    MURIKAH_TUTOR_RUNTIME: optional(source.MURIKAH_TUTOR_RUNTIME),
    MURIKAH_CLOUDFLARE_IMAGE_REV: optional(source.MURIKAH_CLOUDFLARE_IMAGE_REV),
    MURIKAH_PUBLIC_BASE_URL: optional(source.MURIKAH_PUBLIC_BASE_URL),
    MURIKAH_GUEST_PROMPT_LIMIT: optional(source.MURIKAH_GUEST_PROMPT_LIMIT) || '7',
    MURIKAH_TUTOR_ADMIN_USERNAME: optional(source.MURIKAH_TUTOR_ADMIN_USERNAME) || 'admin',
    MURIKAH_TUTOR_ADMIN_PASSWORD: optional(source.MURIKAH_TUTOR_ADMIN_PASSWORD),
    MURIKAH_TUTOR_AUTH_SECRET: optional(source.MURIKAH_TUTOR_AUTH_SECRET),
    MURIKAH_TUTOR_TOKEN_EXPIRE_HOURS: optional(source.MURIKAH_TUTOR_TOKEN_EXPIRE_HOURS) || '24',
    MURIKAH_GOOGLE_CLIENT_ID: optional(source.MURIKAH_GOOGLE_CLIENT_ID),
    MURIKAH_GOOGLE_CLIENT_SECRET: optional(source.MURIKAH_GOOGLE_CLIENT_SECRET),
    MURIKAH_MICROSOFT_CLIENT_ID: optional(source.MURIKAH_MICROSOFT_CLIENT_ID),
    MURIKAH_MICROSOFT_CLIENT_SECRET: optional(source.MURIKAH_MICROSOFT_CLIENT_SECRET),
    MURIKAH_MICROSOFT_TENANT: optional(source.MURIKAH_MICROSOFT_TENANT) || 'common',
    MURIKAH_APPLE_CLIENT_ID: optional(source.MURIKAH_APPLE_CLIENT_ID),
    MURIKAH_APPLE_TEAM_ID: optional(source.MURIKAH_APPLE_TEAM_ID),
    MURIKAH_APPLE_KEY_ID: optional(source.MURIKAH_APPLE_KEY_ID),
    MURIKAH_APPLE_PRIVATE_KEY_B64: optional(source.MURIKAH_APPLE_PRIVATE_KEY_B64),
    MURIKAH_NVIDIA_NIM_API_KEY: optional(source.MURIKAH_NVIDIA_NIM_API_KEY),
    MURIKAH_NVIDIA_NIM_BASE_URL: optional(source.MURIKAH_NVIDIA_NIM_BASE_URL),
    MURIKAH_LLM_PRIMARY_MODEL: optional(source.MURIKAH_LLM_PRIMARY_MODEL),
    MURIKAH_LLM_SECONDARY_MODEL: optional(source.MURIKAH_LLM_SECONDARY_MODEL),
    MURIKAH_LLM_TERTIARY_MODEL: optional(source.MURIKAH_LLM_TERTIARY_MODEL),
    MURIKAH_GEMINI_API_KEY: optional(source.MURIKAH_GEMINI_API_KEY),
    MURIKAH_FAST_CHAT_MODEL: optional(source.MURIKAH_FAST_CHAT_MODEL) || 'gemini-3.8-flash',
    MURIKAH_DASHSCOPE_API_KEY: optional(source.MURIKAH_DASHSCOPE_API_KEY),
    MURIKAH_DASHSCOPE_BASE_URL: optional(source.MURIKAH_DASHSCOPE_BASE_URL),
    MURIKAH_EMBEDDING_PROVIDER: optional(source.MURIKAH_EMBEDDING_PROVIDER),
    MURIKAH_EMBEDDING_MODEL: optional(source.MURIKAH_EMBEDDING_MODEL),
    MURIKAH_EMBEDDING_DIMENSION: optional(source.MURIKAH_EMBEDDING_DIMENSION),
    MURIKAH_EMBEDDING_ENDPOINT: optional(source.MURIKAH_EMBEDDING_ENDPOINT),
    MURIKAH_SEARCH_PROVIDER: optional(source.MURIKAH_SEARCH_PROVIDER),
    MURIKAH_TAVILY_API_KEY: optional(source.MURIKAH_TAVILY_API_KEY),
    MURIKAH_TTS_PROVIDER: optional(source.MURIKAH_TTS_PROVIDER),
    MURIKAH_TTS_MODEL: optional(source.MURIKAH_TTS_MODEL),
    MURIKAH_TTS_VOICE: optional(source.MURIKAH_TTS_VOICE),
    MURIKAH_TTS_BASE_URL: optional(source.MURIKAH_TTS_BASE_URL),
    MURIKAH_STT_PROVIDER: optional(source.MURIKAH_STT_PROVIDER),
    MURIKAH_STT_MODEL: optional(source.MURIKAH_STT_MODEL),
    MURIKAH_STT_BASE_URL: optional(source.MURIKAH_STT_BASE_URL),
    MURIKAH_IMAGE_PROVIDER: optional(source.MURIKAH_IMAGE_PROVIDER),
    MURIKAH_IMAGE_MODEL: optional(source.MURIKAH_IMAGE_MODEL),
    MURIKAH_IMAGE_BASE_URL: optional(source.MURIKAH_IMAGE_BASE_URL),
    MURIKAH_VIDEO_PROVIDER: optional(source.MURIKAH_VIDEO_PROVIDER),
    MURIKAH_VIDEO_MODEL: optional(source.MURIKAH_VIDEO_MODEL),
    MURIKAH_VIDEO_BASE_URL: optional(source.MURIKAH_VIDEO_BASE_URL),
    MURIKAH_VIDEO_LEARNING_PROVIDER: optional(source.MURIKAH_VIDEO_LEARNING_PROVIDER),
    MURIKAH_VIDEO_LEARNING_TRANSCRIPT_PROVIDER: optional(
      source.MURIKAH_VIDEO_LEARNING_TRANSCRIPT_PROVIDER,
    ),
    MURIKAH_INVIDIOUS_API_BASE_URL: optional(source.MURIKAH_INVIDIOUS_API_BASE_URL),
    MURIKAH_INVIDIOUS_PUBLIC_BASE_URL: optional(source.MURIKAH_INVIDIOUS_PUBLIC_BASE_URL),
  };
}

function hasAdminSecret(runtimeEnv: Record<string, string>): boolean {
  return (runtimeEnv.MURIKAH_TUTOR_ADMIN_PASSWORD || '').length >= 14;
}

function hasAuthSecret(runtimeEnv: Record<string, string>): boolean {
  return (runtimeEnv.MURIKAH_TUTOR_AUTH_SECRET || '').length >= 32;
}

function hasRequiredRuntimeSecrets(runtimeEnv: Record<string, string>): boolean {
  return hasAdminSecret(runtimeEnv) && hasAuthSecret(runtimeEnv);
}

export class TutorContainer extends Container<TutorEnv> {
  defaultPort = 3782;
  sleepAfter = '30m';
  enableInternet = true;
  entrypoint = [CLOUDFLARE_ENTRYPOINT];

  onStop(stopParams: unknown): void {
    console.log('Murikah Tutor container stopped', JSON.stringify(stopParams));
  }

  onError(error: unknown): void {
    console.error('Murikah Tutor container lifecycle error', error);
  }

  private async readContainerState(): Promise<ContainerState | { error: string }> {
    try {
      return (await this.getState()) as ContainerState;
    } catch (error) {
      return { error: errorText(error) };
    }
  }

  async ensureStarted(runtimeEnv: Record<string, string>): Promise<RuntimeStatus> {
    if (!hasRequiredRuntimeSecrets(runtimeEnv)) {
      return {
        running: false,
        ready: false,
        error: 'Required Tutor runtime secrets are not available to the Worker runtime.',
        workerSecretConfigured: false,
      };
    }

    if (this.ctx.container.running) {
      const current = await this.runtimeStatus();
      return { ...current, workerSecretConfigured: true };
    }

    let startError = '';
    try {
      this.ctx.container.start({
        env: runtimeEnv,
        enableInternet: true,
        entrypoint: [CLOUDFLARE_ENTRYPOINT],
      });
    } catch (error) {
      startError = errorText(error);
      if (!this.ctx.container.running) {
        return {
          running: false,
          ready: false,
          state: await this.readContainerState(),
          error: startError,
          workerSecretConfigured: true,
        };
      }
    }

    await delay(150);
    const status = await this.runtimeStatus();
    return {
      ...status,
      error: status.error || (status.running ? undefined : startError || undefined),
      workerSecretConfigured: true,
    };
  }

  async runtimeStatus(): Promise<RuntimeStatus> {
    const state = await this.readContainerState();
    if (!this.ctx.container.running) {
      return { running: false, ready: false, state };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1200);
    try {
      const response = await this.ctx.container.getTcpPort(3782).fetch('http://container/health', {
        signal: controller.signal,
        headers: { 'cache-control': 'no-store' },
      });
      return {
        running: true,
        ready: response.status === 200,
        httpStatus: response.status,
        state,
      };
    } catch (error) {
      return {
        running: true,
        ready: false,
        state,
        error: errorText(error),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async runtimeRevision(): Promise<{ running: boolean; imageRevision: string; error?: string }> {
    if (!this.ctx.container.running) {
      return { running: false, imageRevision: '' };
    }
    try {
      const process = await this.ctx.container.exec(
        ['/bin/sh', '-lc', 'cat /app/murikah-cloudflare-image-rev 2>/dev/null || true'],
        { stdout: 'pipe', stderr: 'combined' },
      );
      const output = await process.output();
      const imageRevision = new TextDecoder().decode(output.stdout).trim().split(/\s+/)[0] || '';
      return { running: true, imageRevision };
    } catch (error) {
      return { running: true, imageRevision: '', error: errorText(error) };
    }
  }

  async isolatedStartupDiagnostics(
    runtimeEnv: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const report: Record<string, unknown> = {
      workerSecretConfigured: hasRequiredRuntimeSecrets(runtimeEnv),
    };

    if (this.ctx.container.running) {
      try {
        this.ctx.container.destroy('Restarting Murikah staging diagnostic');
      } catch (error) {
        report.preflightDestroyError = errorText(error);
      }
      for (let attempt = 0; attempt < 50 && this.ctx.container.running; attempt += 1) {
        await delay(100);
      }
    }

    let startError = '';
    try {
      this.ctx.container.start({
        env: runtimeEnv,
        enableInternet: true,
        entrypoint: ['/bin/sh', '-c', "trap 'exit 0' TERM INT; while :; do sleep 60; done"],
      });
      for (let attempt = 0; attempt < 50 && !this.ctx.container.running; attempt += 1) {
        await delay(100);
      }
    } catch (error) {
      startError = errorText(error);
    }

    report.running = this.ctx.container.running;
    report.startError = startError || undefined;
    if (!this.ctx.container.running) return report;

    const run = async (
      command: string[],
      env?: Record<string, string>,
    ): Promise<Record<string, unknown>> => {
      try {
        const process = await this.ctx.container.exec(command, {
          stdout: 'pipe',
          stderr: 'combined',
          ...(env ? { env } : {}),
        });
        const output = await process.output();
        return {
          exitCode: output.exitCode,
          output: new TextDecoder().decode(output.stdout).slice(0, 16000),
        };
      } catch (error) {
        return { error: errorText(error) };
      }
    };

    try {
      report.image = await run([
        '/bin/sh',
        '-lc',
        [
          'id',
          "printf 'node='; node --version 2>&1 || true",
          "printf 'python='; python --version 2>&1 || true",
          "printf 'image-revision='; cat /app/murikah-cloudflare-image-rev 2>/dev/null || echo missing",
          'for p in /app/web/server.js /app/start-frontend.sh /app/start-backend.sh /app/murikah-tutor-bootstrap.py /app/murikah-cloudflare-entrypoint.sh /app/data; do if [ -e "$p" ]; then stat -c \'%A %u:%g %n\' "$p" 2>/dev/null || ls -ld "$p"; else echo "missing $p"; fi; done',
        ].join('; '),
      ]);

      let appProcess: Awaited<ReturnType<typeof this.ctx.container.exec>> | null = null;
      let appProcessError = '';
      try {
        appProcess = await this.ctx.container.exec(
          [
            '/bin/sh',
            '-lc',
            'rm -f /tmp/muri-start.log; timeout 25s /app/murikah-cloudflare-entrypoint.sh >/tmp/muri-start.log 2>&1 || true',
          ],
          {
            stdout: 'ignore',
            stderr: 'ignore',
            env: runtimeEnv,
          },
        );
      } catch (error) {
        appProcessError = errorText(error);
      }

      await delay(10000);

      let portProbe = 'not-tested';
      if (appProcess) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 1500);
        try {
          const response = await this.ctx.container
            .getTcpPort(3782)
            .fetch('http://container/health', { signal: controller.signal });
          portProbe = `http-${response.status}`;
        } catch (error) {
          portProbe = errorText(error);
        } finally {
          clearTimeout(timer);
        }
      }

      report.runtime = {
        appProcessError: appProcessError || undefined,
        port3782: portProbe,
        snapshot: await run([
          'python',
          '-c',
          [
            'from pathlib import Path',
            'def text(p):',
            "    try: return Path(p).read_bytes().replace(b'\\x00', b' ').decode('utf-8', 'replace').strip()",
            "    except Exception as exc: return f'<unavailable:{type(exc).__name__}>'",
            "print('tcp4:')",
            "print(text('/proc/net/tcp'))",
            "print('tcp6:')",
            "print(text('/proc/net/tcp6'))",
            "print('processes:')",
            "for d in sorted(Path('/proc').iterdir(), key=lambda x: int(x.name) if x.name.isdigit() else 10**9):",
            '    if d.name.isdigit():',
            "        cmd = text(str(d / 'cmdline'))",
            "        if cmd: print(d.name + ' ' + cmd[:700])",
          ].join('\n'),
        ]),
      };

      if (appProcess) await appProcess.exitCode;

      report.startupLog = await run([
        'python',
        '-c',
        [
          'from pathlib import Path',
          "p=Path('/tmp/muri-start.log')",
          "data=p.read_text(encoding='utf-8', errors='replace')[-14000:] if p.exists() else '<no startup log>'",
          "blocked=('password=', 'secret=', 'token=', 'client_secret=', 'private_key=')",
          'for line in data.splitlines():',
          '    low=line.lower()',
          "    print('<redacted diagnostic line>' if any(x in low for x in blocked) else line)",
        ].join('\n'),
      ]);
    } finally {
      try {
        if (this.ctx.container.running) {
          this.ctx.container.destroy('Murikah staging diagnostic complete');
        }
      } catch (error) {
        report.cleanupError = errorText(error);
      }
    }

    return report;
  }
}

async function persistenceStatus(env: TutorEnv): Promise<Response> {
  try {
    const objects = await env.TUTOR_DB.prepare(
      'SELECT COUNT(*) AS count FROM persistence_objects',
    ).first<{ count: number }>();
    const guests = await env.TUTOR_DB.prepare(
      'SELECT COUNT(*) AS count FROM guest_sessions WHERE expires_at > ?',
    )
      .bind(Math.floor(Date.now() / 1000))
      .first<{ count: number }>();
    const schema = await env.TUTOR_DB.prepare(
      "SELECT value FROM persistence_meta WHERE key = 'schema_version'",
    ).first<{ value: string }>();
    const checkpoint = await env.TUTOR_DB.prepare(
      "SELECT updated_at FROM persistence_meta WHERE key = 'last_generation'",
    ).first<{ updated_at: number }>();
    const learningSchema = await env.TUTOR_DB.prepare(
      "SELECT value FROM persistence_meta WHERE key = 'learning_journal_schema_version'",
    ).first<{ value: string }>();
    const learningTurns = await env.TUTOR_DB.prepare(
      'SELECT COUNT(*) AS count FROM tutor_turns',
    ).first<{ count: number }>();
    const ownershipSchema = await env.TUTOR_DB.prepare(
      "SELECT value FROM persistence_meta WHERE key = 'ownership_schema_version'",
    ).first<{ value: string }>();
    const emailVerificationSchema = await env.TUTOR_DB.prepare(
      "SELECT value FROM persistence_meta WHERE key = 'email_verification_schema_version'",
    ).first<{ value: string }>();
    const ownershipCounts = await env.TUTOR_DB.prepare(
      'SELECT ' +
        '(SELECT COUNT(*) FROM tutor_objects WHERE deleted_at IS NULL) AS owned_objects, ' +
        "(SELECT COUNT(*) FROM tutor_objects WHERE deleted_at IS NULL AND owner_kind = 'user') AS user_objects, " +
        "(SELECT COUNT(*) FROM tutor_accounts WHERE account_status = 'active') AS active_accounts, " +
        '(SELECT COUNT(*) FROM persistence_objects p LEFT JOIN tutor_objects o ON o.runtime_path = p.path WHERE o.object_id IS NULL) AS unregistered_objects',
    ).first<{
      owned_objects: number;
      user_objects: number;
      active_accounts: number;
      unregistered_objects: number;
    }>();
    return persistenceJson({
      ok: true,
      schemaVersion: schema?.value || '',
      learningJournalSchemaVersion: learningSchema?.value || '',
      ownershipSchemaVersion: ownershipSchema?.value || '',
      emailVerificationSchemaVersion: emailVerificationSchema?.value || '',
      learningTurnCount: learningTurns?.count || 0,
      durableObjectCount: objects?.count || 0,
      ownedObjectCount: ownershipCounts?.owned_objects || 0,
      userOwnedObjectCount: ownershipCounts?.user_objects || 0,
      activeAccountCount: ownershipCounts?.active_accounts || 0,
      unregisteredObjectCount: ownershipCounts?.unregistered_objects || 0,
      activeGuestSessions: guests?.count || 0,
      lastCheckpointAt: checkpoint?.updated_at || null,
      r2PrivateBindingConfigured: Boolean(env.TUTOR_FILES),
    });
  } catch (error) {
    console.error('Tutor persistence status failed', error);
    return persistenceJson({ ok: false, error: 'persistence_unavailable' }, 503);
  }
}

function edgeHealth(env: TutorEnv): Response {
  return Response.json(
    {
      ok: true,
      runtime: env.MURIKAH_TUTOR_RUNTIME,
      note: 'Edge Worker is available. This endpoint does not require Tutor to be warm.',
    },
    { headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } },
  );
}

function workerConfig(runtimeEnv: Record<string, string>, env: TutorEnv): Response {
  const ready = hasRequiredRuntimeSecrets(runtimeEnv);
  return Response.json(
    {
      ok: ready,
      runtime: env.MURIKAH_TUTOR_RUNTIME,
      adminPasswordConfigured: hasAdminSecret(runtimeEnv),
      authSecretConfigured: hasAuthSecret(runtimeEnv),
      verificationEmailConfigured: Boolean(optional(env.RESEND_API_KEY)),
      geminiFastLaneConfigured: Boolean(runtimeEnv.MURIKAH_GEMINI_API_KEY),
      fastChatModel: runtimeEnv.MURIKAH_FAST_CHAT_MODEL,
      expectedImageRevision: optional(env.MURIKAH_CLOUDFLARE_IMAGE_REV),
      persistenceConfigured: Boolean(env.TUTOR_DB && env.TUTOR_FILES),
      appInstance: APP_INSTANCE,
    },
    {
      status: ready ? 200 : 503,
      headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
    },
  );
}

function startingShell(
  message = 'Preparing your learning space. You can stay on this page.',
): Response {
  const safeMessage = message.replace(
    /[<>&]/g,
    (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[char] || char,
  );
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Murikah Tutor</title><style>*{box-sizing:border-box}body{margin:0;min-height:100dvh;background:#f6f7f7;color:#1E2A30;font-family:Inter,system-ui,sans-serif}header{height:80px;display:flex;align-items:center;padding:0 clamp(20px,4vw,40px);border-bottom:1px solid #dfe4e6;background:#fff}.brand{border-radius:12px;background:#1E2A30;color:#fff;padding:12px 20px;font-size:18px;font-weight:760}.brand span{color:#C59A39;margin:0 8px}main{width:min(900px,100%);min-height:calc(100dvh - 80px);margin:auto;padding:clamp(28px,5vw,52px) clamp(20px,4vw,40px);display:flex;flex-direction:column}h1{font-size:clamp(26px,4vw,38px);letter-spacing:-.035em;margin:0 0 12px}p{color:#66747b;line-height:1.6;margin:0}.bar{width:min(420px,100%);height:3px;margin-top:22px;border-radius:999px;overflow:hidden;background:#e1e5e7}.bar:after{content:"";display:block;width:32%;height:100%;border-radius:999px;background:#A9822E;animation:move 1.15s ease-in-out infinite alternate}@keyframes move{to{transform:translateX(210%)}}.small{margin-top:12px;font-size:13px;color:#879298}.composer{margin-top:auto;border:1px solid #d8dee1;border-radius:30px;background:#fff;padding:20px;box-shadow:0 12px 40px rgba(30,42,48,.06)}.prompt{min-height:58px;color:#879298;font-size:18px}.tools{display:flex;align-items:center;justify-content:space-between;color:#66747b}.send{display:grid;place-items:center;width:44px;height:44px;border-radius:50%;background:#e7ebed;color:#1E2A30;font-size:23px}</style></head><body><header><div class="brand">Murikah <span>|</span> Tutor</div></header><main><section><h1>How can I help you learn today?</h1><p id="status">${safeMessage}</p><div class="bar"></div><div class="small" id="small">Preparing your guest workspace…</div></section><div class="composer"><div class="prompt">Ask anything…</div><div class="tools"><span>Chat</span><span class="send">↑</span></div></div></main><script>(function(){let attempts=0;async function check(){attempts++;try{const r=await fetch('/__muri/runtime-status',{cache:'no-store'});const s=await r.json();if(s.ready){location.reload();return;}if(s.workerSecretConfigured===false){document.getElementById('status').textContent='Tutor staging configuration is incomplete.';document.getElementById('small').textContent='The runtime secret binding needs attention.';return;}if(attempts>40){document.getElementById('status').textContent='Tutor is still starting.';document.getElementById('small').textContent='You can stay on this page; it will open automatically.';}}catch(e){}setTimeout(check,attempts<15?750:1500);}check();})();</script></body></html>`,
    {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    },
  );
}

async function safeStatus(
  tutor: ReturnType<typeof getContainer<TutorContainer>>,
  runtimeEnv: Record<string, string>,
): Promise<RuntimeStatus> {
  if (!hasRequiredRuntimeSecrets(runtimeEnv)) {
    return {
      running: false,
      ready: false,
      error: 'Required Tutor runtime secrets are not available to the Worker runtime.',
      workerSecretConfigured: false,
    };
  }

  try {
    let status = await tutor.runtimeStatus();
    if (!status.running) status = await tutor.ensureStarted(runtimeEnv);
    return { ...status, workerSecretConfigured: true };
  } catch (error) {
    console.error('Murikah Tutor runtime RPC failed', error);
    return {
      running: false,
      ready: false,
      error: errorText(error),
      workerSecretConfigured: true,
    };
  }
}

async function cachedStatus(
  tutor: ReturnType<typeof getContainer<TutorContainer>>,
  runtimeEnv: Record<string, string>,
): Promise<RuntimeStatus> {
  if (Date.now() < readyCacheUntil) {
    return { running: true, ready: true, workerSecretConfigured: true };
  }
  if (statusInFlight) return statusInFlight;

  statusInFlight = safeStatus(tutor, runtimeEnv)
    .then((status) => {
      if (status.ready) readyCacheUntil = Date.now() + READY_CACHE_MS;
      return status;
    })
    .finally(() => {
      statusInFlight = null;
    });
  return statusInFlight;
}

export default {
  async fetch(request: Request, env: TutorEnv): Promise<Response> {
    const url = new URL(request.url);
    const runtimeEnv = buildContainerEnv(env);

    if (url.pathname === '/favicon.ico') return new Response(null, { status: 204 });
    if (url.pathname === '/__muri/edge-health') return edgeHealth(env);
    if (url.pathname === '/__muri/worker-config') return workerConfig(runtimeEnv, env);
    if (url.pathname === '/__muri/persistence-status') return persistenceStatus(env);
    if (url.pathname.startsWith(PERSISTENCE_PREFIX)) {
      return handlePersistence(request, env, url);
    }

    if (url.pathname === '/__muri/container-diagnostics') {
      try {
        const diagnostic = getContainer(env.TUTOR_CONTAINER, DIAGNOSTIC_INSTANCE);
        const report = await diagnostic.isolatedStartupDiagnostics(runtimeEnv);
        return Response.json(report, {
          headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
        });
      } catch (error) {
        console.error('Murikah Tutor diagnostics RPC failed', error);
        return Response.json(
          {
            running: false,
            workerSecretConfigured: hasRequiredRuntimeSecrets(runtimeEnv),
            error: errorText(error),
          },
          {
            status: 503,
            headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
          },
        );
      }
    }

    const tutor = getContainer(env.TUTOR_CONTAINER, APP_INSTANCE);
    const status = await cachedStatus(tutor, runtimeEnv);

    if (url.pathname === '/__muri/runtime-status') {
      return Response.json(status, {
        headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
      });
    }

    if (url.pathname === '/__muri/runtime-revision') {
      const revision = await tutor.runtimeRevision();
      return Response.json(
        {
          ...status,
          ...revision,
          expectedImageRevision: optional(env.MURIKAH_CLOUDFLARE_IMAGE_REV),
        },
        {
          headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
        },
      );
    }

    if (status.ready) {
      try {
        const response = await tutor.fetch(request);
        if (
          response.status === 101 ||
          request.headers.get('upgrade')?.toLowerCase() === 'websocket'
        ) {
          return response;
        }
        const headers = new Headers(response.headers);
        headers.set('x-murikah-tutor-runtime', 'cloudflare-container');
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      } catch (error) {
        readyCacheUntil = 0;
        console.error('Murikah Tutor proxy failed', error);
        return startingShell('Reconnecting to your Tutor…');
      }
    }

    if (url.pathname === '/health') {
      return Response.json(
        {
          status: hasRequiredRuntimeSecrets(runtimeEnv) ? 'starting' : 'configuration-error',
          runtime: env.MURIKAH_TUTOR_RUNTIME,
          workerSecretConfigured: hasRequiredRuntimeSecrets(runtimeEnv),
          containerState: status.state,
          error: status.error,
        },
        {
          status: 503,
          headers: { 'retry-after': '2', 'cache-control': 'no-store' },
        },
      );
    }

    return startingShell(
      hasRequiredRuntimeSecrets(runtimeEnv)
        ? 'Preparing your learning space. You can stay on this page.'
        : 'Tutor staging configuration is incomplete.',
    );
  },
};
