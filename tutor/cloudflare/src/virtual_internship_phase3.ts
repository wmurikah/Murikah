type AIStatement = {
  bind(...values: unknown[]): AIStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<{ meta?: { changes?: number } }>;
};
type AIDatabase = { prepare(query: string): AIStatement };
type AIEnv = { TUTOR_DB: AIDatabase };

const ROLES = new Set(['actor','mentor','assessor','scenario_director']);
const STATUSES = new Set(['completed','failed']);
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const HASH = /^[a-f0-9]{64}$/;

function response(payload: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
async function bodyJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const value = await request.json();
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
function str(value: unknown, max = 256): string {
  const out = String(value ?? '').trim();
  return out.length <= max ? out : '';
}
function integer(value: unknown, fallback = -1): number {
  const n = Number(value);
  return Number.isInteger(n) ? n : fallback;
}

export async function handlePhase3AIPersistenceRoute(
  request: Request,
  env: AIEnv,
  route: string,
  now: number,
): Promise<Response | null> {
  if (route !== '/internships/ai/invocation') return null;
  if (request.method !== 'POST') return response({ error: 'method_not_allowed' }, 405);

  const body = await bodyJson(request);
  const forbidden = [
    'learner_id','owner_id','user_id','canonical_state','patch_state',
    'api_key','authorization','prompt','response','chain_of_thought','scratchpad',
  ];
  if (forbidden.some((key) => key in body)) return response({ error: 'invalid_ai_audit_payload' }, 400);

  const actorId = str(body.actor_id, 128);
  const internshipId = str(body.internship_id, 128);
  const invocationId = str(body.invocation_id, 128);
  if (!ID.test(actorId) || !ID.test(internshipId) || !ID.test(invocationId)) {
    return response({ error: 'invalid_ai_audit_payload' }, 400);
  }

  const account = await env.TUTOR_DB.prepare(
    "SELECT role, account_status FROM tutor_accounts WHERE actor_id = ? LIMIT 1",
  ).bind(actorId).first<{ role: string; account_status: string }>();
  if (!account || !['member','admin'].includes(account.role) || account.account_status !== 'active') {
    return response({ error: 'authentication_required' }, 401);
  }
  const owned = await env.TUTOR_DB.prepare(
    'SELECT id, scenario_version_id, status FROM internship_instances WHERE id = ? AND learner_id = ? LIMIT 1',
  ).bind(internshipId, actorId).first<{ id: string; scenario_version_id: string; status: string }>();
  if (!owned) return response({ error: 'internship_not_found' }, 404);
  if (owned.status !== 'active') return response({ error: 'internship_not_active' }, 409);

  const scenarioVersionId = str(body.scenario_version_id, 128);
  const role = str(body.model_role, 32);
  const status = str(body.status, 16);
  const contextHash = str(body.context_hash, 64);
  const outputHash = str(body.output_hash, 64);
  const orchestrationVersion = integer(body.orchestration_schema_version);
  const promptVersion = integer(body.prompt_version);
  const outputSchemaVersion = integer(body.output_schema_version, 0);
  const firstTokenMs = integer(body.first_token_ms, 0);
  const totalMs = integer(body.total_ms, 0);
  const retryCount = integer(body.retry_count, 0);
  const fallbackCount = integer(body.fallback_count, 0);
  const startedAt = integer(body.started_at);
  const completedAt = integer(body.completed_at);
  const assistanceRaw = body.assistance_level;
  const assistanceLevel = assistanceRaw === undefined || assistanceRaw === null ? null : integer(assistanceRaw);

  if (
    scenarioVersionId !== owned.scenario_version_id ||
    !ROLES.has(role) ||
    !STATUSES.has(status) ||
    !HASH.test(contextHash) ||
    (outputHash !== '' && !HASH.test(outputHash)) ||
    orchestrationVersion !== 1 ||
    promptVersion < 1 ||
    outputSchemaVersion < 0 ||
    firstTokenMs < 0 ||
    totalMs < 0 ||
    retryCount < 0 || retryCount > 1 ||
    fallbackCount < 0 || fallbackCount > 1 ||
    startedAt < 0 || completedAt < startedAt ||
    (assistanceLevel !== null && (assistanceLevel < 0 || assistanceLevel > 5))
  ) {
    return response({ error: 'invalid_ai_audit_payload' }, 400);
  }

  const provider = str(body.provider, 128);
  const modelId = str(body.model_id, 256);
  if (status === 'completed' && (!provider || !modelId)) {
    return response({ error: 'invalid_ai_audit_payload' }, 400);
  }

  try {
    await env.TUTOR_DB.prepare(
      'INSERT INTO internship_ai_invocations(' +
      'id, internship_id, scenario_version_id, model_role, scenario_actor_id, task_id, event_id, decision_id, ' +
      'provider, model_id, profile_id, orchestration_schema_version, prompt_version, output_schema_version, ' +
      'context_hash, output_hash, status, first_token_ms, total_ms, retry_count, fallback_count, error_code, ' +
      'assistance_level, started_at, completed_at, created_at' +
      ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT(id) DO NOTHING',
    ).bind(
      invocationId, owned.id, owned.scenario_version_id, role,
      str(body.scenario_actor_id, 128), str(body.task_id, 128), str(body.event_id, 128), str(body.decision_id, 128),
      provider, modelId, str(body.profile_id, 128),
      orchestrationVersion, promptVersion, outputSchemaVersion,
      contextHash, outputHash, status, firstTokenMs, totalMs, retryCount, fallbackCount,
      str(body.error_code, 128), assistanceLevel, startedAt, completedAt, now,
    ).run();
  } catch {
    return response({ error: 'ai_audit_persistence_failed' }, 503);
  }
  return response({ ok: true, invocation_id: invocationId });
}
