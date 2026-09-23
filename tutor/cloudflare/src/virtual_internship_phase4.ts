type UIStatement = {
  bind(...values: unknown[]): UIStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
  run(): Promise<{ meta?: { changes?: number } }>;
};
type UIDatabase = { prepare(query: string): UIStatement };
type UIEnv = { TUTOR_DB: UIDatabase };

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const REQUEST_ID = /^[A-Za-z0-9._:-]{3,128}$/;
const PERIOD_KEY = /^[A-Za-z0-9._:-]{1,80}$/;
const THREAD_KINDS = new Set(['workplace','mentor']);
const SENDERS = new Set(['learner','actor','mentor','system']);

function json(payload: unknown, status = 200): Response {
  return Response.json(payload, {
    status,
    headers: {'cache-control':'no-store','x-content-type-options':'nosniff'},
  });
}
async function bodyJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const value = await request.json();
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}
function text(value: unknown, max: number): string {
  const out = String(value ?? '').trim();
  return out.length <= max ? out : '';
}
function id(value: unknown): string {
  const out = text(value,128);
  return ID.test(out) ? out : '';
}
function requestId(value: unknown): string {
  const out = text(value,128);
  return REQUEST_ID.test(out) ? out : '';
}
async function activeAccount(db: UIDatabase, actorId: string): Promise<boolean> {
  const row = await db.prepare(
    "SELECT role, account_status FROM tutor_accounts WHERE actor_id = ? LIMIT 1",
  ).bind(actorId).first<{role:string;account_status:string}>();
  return Boolean(row && ['member','admin'].includes(row.role) && row.account_status === 'active');
}
async function ownedInternship(
  db: UIDatabase,
  actorId: string,
  internshipId: string,
): Promise<{id:string;scenario_version_id:string;status:string}|null> {
  return db.prepare(
    'SELECT id, scenario_version_id, status FROM internship_instances WHERE id = ? AND learner_id = ? LIMIT 1',
  ).bind(internshipId,actorId).first<{id:string;scenario_version_id:string;status:string}>();
}
async function messageByRequest(
  db: UIDatabase,
  internshipId: string,
  req: string,
): Promise<Record<string,unknown>|null> {
  return db.prepare(
    'SELECT id, internship_id, thread_id, sender_type, sender_actor_id, body, related_task_id, related_event_id, related_model_invocation_id, request_id, created_at ' +
    'FROM internship_messages WHERE internship_id = ? AND request_id = ? LIMIT 1',
  ).bind(internshipId,req).first<Record<string,unknown>>();
}

export async function handlePhase4WorkspacePersistenceRoute(
  request: Request,
  env: UIEnv,
  route: string,
  now: number,
): Promise<Response | null> {
  if (!route.startsWith('/internships/ui/')) return null;
  const url = new URL(request.url);
  const body = request.method === 'POST' ? await bodyJson(request) : {};
  if (['learner_id','owner_id','user_id','canonical_state','patch_state','api_key','authorization'].some((key)=>key in body)) {
    return json({error:'invalid_workspace_payload'},400);
  }
  const actorId = id(request.method === 'GET' ? url.searchParams.get('actor_id') : body.actor_id);
  if (!actorId) return json({error:'authentication_required'},401);
  if (!(await activeAccount(env.TUTOR_DB,actorId))) return json({error:'authentication_required'},401);

  if (route === '/internships/ui/current' && request.method === 'GET') {
    const row = await env.TUTOR_DB.prepare(
      "SELECT id, status FROM internship_instances WHERE learner_id = ? " +
      "ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END, updated_at DESC, id DESC LIMIT 1",
    ).bind(actorId).first<{id:string;status:string}>();
    return json({ok:true, internship_id:row?.id || '', status:row?.status || ''});
  }

  if (route === '/internships/ui/start-options' && request.method === 'GET') {
    const rows = (await env.TUTOR_DB.prepare(
      "SELECT sp.slug, sp.title, sp.role_title, sv.id AS scenario_version_id, sv.version, c.canonical_json " +
      "FROM scenario_packs sp JOIN scenario_versions sv ON sv.scenario_pack_id = sp.id " +
      "JOIN scenario_version_content c ON c.scenario_version_id = sv.id " +
      "WHERE sp.status = 'published' AND sv.status = 'published' " +
      "AND c.content_hash = sv.content_hash AND c.manifest_ref = sv.manifest_ref " +
      "ORDER BY sp.title, sv.version DESC",
    ).all<Record<string,unknown>>()).results || [];
    const options:Record<string,unknown>[] = [];
    for (const row of rows) {
      try {
        const definition = JSON.parse(String(row.canonical_json || '{}')) as Record<string,unknown>;
        const manifest = definition.manifest && typeof definition.manifest === 'object'
          ? definition.manifest as Record<string,unknown>
          : {};
        if (manifest.qualifying !== true || manifest.classification !== 'qualifying') continue;
        options.push({
          scenario_slug:String(row.slug || ''),
          title:String(row.title || ''),
          role_title:String(row.role_title || ''),
          scenario_version:Number(row.version || 0),
          scenario_version_id:String(row.scenario_version_id || ''),
          minimum_duration_days:Number(manifest.minimum_duration_days || 90),
          expected_workload_band:String(manifest.expected_workload_band || ''),
        });
      } catch {
        continue;
      }
    }
    return json({ok:true, options});
  }

  const internshipId = id(request.method === 'GET' ? url.searchParams.get('internship_id') : body.internship_id);
  if (!internshipId) return json({error:'internship_not_found'},404);
  const owned = await ownedInternship(env.TUTOR_DB,actorId,internshipId);
  if (!owned) return json({error:'internship_not_found'},404);

  if (route === '/internships/ui/threads' && request.method === 'GET') {
    const rows = (await env.TUTOR_DB.prepare(
      "SELECT t.id, t.thread_key, t.thread_kind, t.scenario_actor_id, t.related_task_id, t.title, t.created_at, t.updated_at, " +
      "COALESCE((SELECT m.body FROM internship_messages m WHERE m.thread_id = t.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1),'') AS last_body, " +
      "COALESCE((SELECT m.sender_type FROM internship_messages m WHERE m.thread_id = t.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1),'') AS last_sender_type, " +
      "COALESCE((SELECT m.created_at FROM internship_messages m WHERE m.thread_id = t.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1),0) AS last_message_at, " +
      "(SELECT COUNT(*) FROM internship_messages m WHERE m.thread_id = t.id) AS message_count " +
      "FROM internship_message_threads t WHERE t.internship_id = ? ORDER BY t.updated_at DESC, t.id",
    ).bind(owned.id).all<Record<string,unknown>>()).results || [];
    return json({ok:true, threads:rows});
  }

  if (route === '/internships/ui/thread' && request.method === 'GET') {
    const threadId = id(url.searchParams.get('thread_id'));
    if (!threadId) return json({error:'thread_not_found'},404);
    const thread = await env.TUTOR_DB.prepare(
      'SELECT id, thread_key, thread_kind, scenario_actor_id, related_task_id, title, created_at, updated_at ' +
      'FROM internship_message_threads WHERE id = ? AND internship_id = ? LIMIT 1',
    ).bind(threadId,owned.id).first<Record<string,unknown>>();
    if (!thread) return json({error:'thread_not_found'},404);
    const messages = (await env.TUTOR_DB.prepare(
      'SELECT id, sender_type, sender_actor_id, body, related_task_id, related_event_id, related_model_invocation_id, request_id, created_at ' +
      'FROM internship_messages WHERE thread_id = ? AND internship_id = ? ORDER BY created_at ASC, id ASC LIMIT 250',
    ).bind(threadId,owned.id).all<Record<string,unknown>>()).results || [];
    return json({ok:true, thread, messages});
  }

  if (route === '/internships/ui/message-by-request' && request.method === 'GET') {
    const req = requestId(url.searchParams.get('request_id'));
    if (!req) return json({error:'message_not_found'},404);
    const message = await messageByRequest(env.TUTOR_DB,owned.id,req);
    return message ? json({ok:true,message}) : json({error:'message_not_found'},404);
  }

  if (route === '/internships/ui/message' && request.method === 'POST') {
    if (owned.status !== 'active') return json({error:'internship_stopped'},409);
    const req = requestId(body.request_id);
    const messageId = id(body.message_id);
    const proposedThreadId = id(body.thread_id);
    const threadKind = text(body.thread_kind,32);
    const scenarioActorId = id(body.scenario_actor_id);
    const senderType = text(body.sender_type,16);
    const messageBody = String(body.body ?? '');
    const relatedTaskId = id(body.related_task_id);
    const relatedEventId = id(body.related_event_id);
    const modelInvocationId = id(body.related_model_invocation_id);
    const threadTitle = text(body.thread_title,160);
    if (!req || !messageId || !proposedThreadId || !THREAD_KINDS.has(threadKind) || !SENDERS.has(senderType)) {
      return json({error:'invalid_workspace_message'},400);
    }
    if (!messageBody.trim() || messageBody.length > 20000 || !threadTitle) {
      return json({error:'invalid_workspace_message'},400);
    }
    if (threadKind === 'workplace') {
      if (!scenarioActorId || !['learner','actor'].includes(senderType)) return json({error:'invalid_workspace_message'},400);
      if (senderType === 'actor' && !modelInvocationId) return json({error:'invalid_workspace_message'},400);
    } else {
      if (scenarioActorId || !['learner','mentor'].includes(senderType)) return json({error:'invalid_workspace_message'},400);
      if (senderType === 'mentor' && !modelInvocationId) return json({error:'invalid_workspace_message'},400);
    }
    const replay = await messageByRequest(env.TUTOR_DB,owned.id,req);
    if (replay) return json({ok:true,idempotent_replay:true,message:replay});

    const threadKey = threadKind === 'mentor' ? 'mentor' : 'workplace:' + scenarioActorId;
    await env.TUTOR_DB.prepare(
      'INSERT OR IGNORE INTO internship_message_threads(id, internship_id, thread_key, thread_kind, scenario_actor_id, related_task_id, title, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(proposedThreadId,owned.id,threadKey,threadKind,scenarioActorId,relatedTaskId,threadTitle,now,now).run();
    const thread = await env.TUTOR_DB.prepare(
      'SELECT id FROM internship_message_threads WHERE internship_id = ? AND thread_key = ? LIMIT 1',
    ).bind(owned.id,threadKey).first<{id:string}>();
    if (!thread?.id) return json({error:'workspace_message_persistence_failed'},503);
    await env.TUTOR_DB.prepare(
      'INSERT OR IGNORE INTO internship_messages(id, internship_id, thread_id, sender_type, sender_actor_id, body, related_task_id, related_event_id, related_model_invocation_id, request_id, created_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(
      messageId,owned.id,thread.id,senderType,
      senderType === 'actor' ? scenarioActorId : '',
      messageBody,relatedTaskId,relatedEventId,modelInvocationId,req,now,
    ).run();
    await env.TUTOR_DB.prepare(
      'UPDATE internship_message_threads SET updated_at = ?, related_task_id = CASE WHEN ? <> ? THEN ? ELSE related_task_id END WHERE id = ? AND internship_id = ?',
    ).bind(now,relatedTaskId,'',relatedTaskId,thread.id,owned.id).run();
    const saved = await messageByRequest(env.TUTOR_DB,owned.id,req);
    return saved ? json({ok:true,message:saved},201) : json({error:'workspace_message_persistence_failed'},503);
  }

  if (route === '/internships/ui/reflections' && request.method === 'GET') {
    const rows = (await env.TUTOR_DB.prepare(
      'SELECT id, period_key, prompt_version, content, created_at, updated_at FROM internship_reflections ' +
      'WHERE internship_id = ? ORDER BY updated_at DESC, id DESC',
    ).bind(owned.id).all<Record<string,unknown>>()).results || [];
    return json({ok:true,reflections:rows});
  }

  if (route === '/internships/ui/reflection' && request.method === 'POST') {
    if (owned.status !== 'active') return json({error:'internship_stopped'},409);
    const reflectionId = id(body.reflection_id);
    const period = text(body.period_key,80);
    const content = String(body.content ?? '');
    const promptVersion = Number(body.prompt_version || 1);
    if (!reflectionId || !PERIOD_KEY.test(period) || !Number.isInteger(promptVersion) || promptVersion < 1) {
      return json({error:'invalid_reflection'},400);
    }
    if (!content.trim() || content.length > 20000) return json({error:'invalid_reflection'},400);
    await env.TUTOR_DB.prepare(
      'INSERT INTO internship_reflections(id, internship_id, period_key, prompt_version, content, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT(internship_id, period_key) DO UPDATE SET content = excluded.content, prompt_version = excluded.prompt_version, updated_at = excluded.updated_at',
    ).bind(reflectionId,owned.id,period,promptVersion,content,now,now).run();
    const saved = await env.TUTOR_DB.prepare(
      'SELECT id, period_key, prompt_version, content, created_at, updated_at FROM internship_reflections WHERE internship_id = ? AND period_key = ? LIMIT 1',
    ).bind(owned.id,period).first<Record<string,unknown>>();
    return json({ok:true,reflection:saved},201);
  }

  return json({error:'workspace_route_not_found'},404);
}
