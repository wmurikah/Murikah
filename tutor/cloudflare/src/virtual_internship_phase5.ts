type P5Statement = {
  bind(...values: unknown[]): P5Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
  run(): Promise<{ meta?: { changes?: number } }>;
};
type P5Database = {
  prepare(query: string): P5Statement;
  batch(statements: P5Statement[]): Promise<Array<{ meta?: { changes?: number } }>>;
};
type P5R2Object = {
  body: ReadableStream<Uint8Array>;
  size: number;
};
type P5Bucket = {
  put(key: string, value: ArrayBuffer | ReadableStream<Uint8Array>, options?: { customMetadata?: Record<string,string> }): Promise<unknown>;
  get(key: string): Promise<P5R2Object | null>;
  delete(key: string): Promise<void>;
  list(options: { prefix: string; cursor?: string; limit?: number }): Promise<{
    objects: Array<{ key: string }>;
    truncated: boolean;
    cursor?: string;
  }>;
};
type P5Env = { TUTOR_DB: P5Database; TUTOR_FILES: P5Bucket };

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const REQUEST_ID = /^[A-Za-z0-9._:-]{3,128}$/;
const DELIVERABLE = /^[a-z][a-z0-9_]{0,63}$/;
export const PHASE5_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const PHASE5_MAX_FILES_PER_VERSION = 1;
export const PHASE5_MAX_VERSIONS = 100;
export const PHASE5_MAX_TEXT_CHARS = 120_000;
export const PHASE5_MAX_REVIEW_TEXT_BYTES = 512 * 1024;

const MIME_BY_EXT: Record<string,string> = {
  pdf:'application/pdf',
  docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv:'text/csv',
  pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt:'text/plain',
  md:'text/markdown',
  png:'image/png',
  jpg:'image/jpeg',
  jpeg:'image/jpeg',
  webp:'image/webp',
  gif:'image/gif',
  json:'application/json',
  ipynb:'application/json',
  py:'text/plain',
  js:'text/plain',
  ts:'text/plain',
  tsx:'text/plain',
  jsx:'text/plain',
  sql:'text/plain',
  html:'text/plain',
  svg:'text/plain',
};
const TEXT_REVIEW_EXT = new Set(['txt','md','csv','json','ipynb','py','js','ts','tsx','jsx','sql','html','svg']);
const DANGEROUS_EXT = new Set(['exe','dll','msi','bat','cmd','com','scr','ps1','vbs','jar','app','dmg']);

function json(payload: unknown, status = 200): Response {
  return Response.json(payload, {
    status,
    headers:{'cache-control':'no-store','x-content-type-options':'nosniff'},
  });
}
async function bodyJson(request: Request): Promise<Record<string,unknown>> {
  try {
    const value = await request.json();
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string,unknown>
      : {};
  } catch {
    return {};
  }
}
function cleanText(value: unknown, max: number): string {
  const out = String(value ?? '').trim();
  return out.length <= max ? out : '';
}
function id(value: unknown): string {
  const out = cleanText(value,128);
  return ID.test(out) ? out : '';
}
function requestId(value: unknown): string {
  const out = cleanText(value,128);
  return REQUEST_ID.test(out) ? out : '';
}
function generated(prefix:string): string {
  return prefix + '_' + crypto.randomUUID().replace(/-/g,'');
}
function fileExtension(name:string):string {
  const leaf = name.replace(/\\/g,'/').split('/').pop() || '';
  const dot = leaf.lastIndexOf('.');
  return dot > 0 ? leaf.slice(dot + 1).toLowerCase() : '';
}
function safeFilename(value:string):string {
  const leaf = value.replace(/[\r\n]/g,'').replace(/\\/g,'/').split('/').pop() || 'artifact';
  const clean = leaf.replace(/[^A-Za-z0-9._ ()-]/g,'_').slice(0,180);
  return clean || 'artifact';
}
function safeTitle(value:unknown):string {
  return cleanText(value,200).replace(/[\r\n]+/g,' ');
}
function safeContentType(filename:string, declared:string):{ok:boolean;contentType:string;extension:string} {
  const extension = fileExtension(filename);
  if (!extension || DANGEROUS_EXT.has(extension)) return {ok:false,contentType:'',extension};
  const canonical = MIME_BY_EXT[extension];
  if (!canonical) return {ok:false,contentType:'',extension};
  const normalized = String(declared || '').split(';',1)[0].trim().toLowerCase();
  if (normalized && (
    normalized.includes('x-msdownload') ||
    normalized.includes('x-dosexec') ||
    normalized.includes('x-executable') ||
    normalized.includes('x-sharedlib')
  )) return {ok:false,contentType:'',extension};
  const aliases:Record<string,Set<string>> = {
    md:new Set(['text/plain','text/markdown','application/octet-stream']),
    txt:new Set(['text/plain','application/octet-stream']),
    csv:new Set(['text/csv','text/plain','application/vnd.ms-excel','application/octet-stream']),
    json:new Set(['application/json','text/plain','application/octet-stream']),
    ipynb:new Set(['application/json','text/plain','application/octet-stream']),
    py:new Set(['text/plain','text/x-python','application/octet-stream']),
    js:new Set(['text/plain','text/javascript','application/javascript','application/octet-stream']),
    ts:new Set(['text/plain','text/typescript','application/octet-stream']),
    tsx:new Set(['text/plain','text/typescript','application/octet-stream']),
    jsx:new Set(['text/plain','text/javascript','application/octet-stream']),
    sql:new Set(['text/plain','application/sql','application/octet-stream']),
    html:new Set(['text/html','text/plain','application/octet-stream']),
    svg:new Set(['image/svg+xml','text/plain','application/octet-stream']),
  };
  const accepted = aliases[extension] || new Set([canonical,'application/octet-stream']);
  if (normalized && !accepted.has(normalized)) return {ok:false,contentType:'',extension};
  return {ok:true,contentType:canonical,extension};
}
async function sha256Hex(bytes:ArrayBuffer):Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256',bytes);
  return Array.from(new Uint8Array(digest)).map(b=>b.toString(16).padStart(2,'0')).join('');
}
async function activeAccount(db:P5Database,actorId:string):Promise<boolean> {
  const row = await db.prepare(
    "SELECT role, account_status FROM tutor_accounts WHERE actor_id = ? LIMIT 1",
  ).bind(actorId).first<{role:string;account_status:string}>();
  return Boolean(row && ['member','admin'].includes(row.role) && row.account_status === 'active');
}
async function ownedInternship(db:P5Database,actorId:string,internshipId:string) {
  return db.prepare(
    'SELECT id, scenario_version_id, status FROM internship_instances WHERE id = ? AND learner_id = ? LIMIT 1',
  ).bind(internshipId,actorId).first<{id:string;scenario_version_id:string;status:string}>();
}
async function taskContract(db:P5Database,internshipId:string,scenarioVersionId:string,taskId:string) {
  const row = await db.prepare(
    'SELECT t.status, d.assigned_by_actor_id, d.definition_json ' +
    'FROM internship_tasks t JOIN scenario_task_definitions d ON d.scenario_version_id = ? AND d.task_id = t.task_id ' +
    'WHERE t.internship_id = ? AND t.task_id = ? LIMIT 1',
  ).bind(scenarioVersionId,internshipId,taskId).first<{status:string;assigned_by_actor_id:string;definition_json:string}>();
  if (!row) return null;
  let definition:Record<string,unknown> = {};
  try { definition = JSON.parse(row.definition_json || '{}') as Record<string,unknown>; } catch { definition = {}; }
  const deliverables = Array.isArray(definition.deliverable_types)
    ? definition.deliverable_types.map(x=>String(x||'')).filter(x=>DELIVERABLE.test(x))
    : [];
  return {status:row.status,assigned_by_actor_id:row.assigned_by_actor_id,definition,deliverables};
}
async function taskDeliverablesAccepted(
  db:P5Database,
  internshipId:string,
  scenarioVersionId:string,
  taskId:string,
):Promise<boolean> {
  const contract=await taskContract(db,internshipId,scenarioVersionId,taskId);
  if (!contract || contract.deliverables.length === 0) return false;
  const acceptedRows=(await db.prepare(
    "SELECT deliverable_type FROM internship_artifacts WHERE internship_id = ? AND task_id = ? AND status = 'accepted'",
  ).bind(internshipId,taskId).all<{deliverable_type:string}>()).results || [];
  const accepted=new Set(acceptedRows.map(row=>row.deliverable_type));
  return contract.deliverables.every(x=>accepted.has(x));
}
function activityStatement(
  db:P5Database,
  internshipId:string,
  taskId:string,
  eventType:string,
  now:number,
  req:string,
  refs:{artifactId?:string;versionId?:string;submissionId?:string;reviewId?:string;detail?:Record<string,unknown>} = {},
):P5Statement {
  return db.prepare(
    'INSERT OR IGNORE INTO internship_artifact_activity(' +
    'id, internship_id, task_id, artifact_id, version_id, submission_id, review_id, event_type, event_time, request_id, detail_json' +
    ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).bind(
    generated('iaa'),internshipId,taskId,refs.artifactId||'',refs.versionId||'',refs.submissionId||'',
    refs.reviewId||'',eventType,now,req,JSON.stringify(refs.detail||{}),
  );
}
async function artifactOwned(db:P5Database,actorId:string,internshipId:string,artifactId:string) {
  return db.prepare(
    'SELECT a.id, a.task_id, a.deliverable_type, a.artifact_type, a.title, a.status, a.current_version_id, ' +
    'a.current_version_number, a.accepted_submission_id, a.created_at, a.updated_at, a.accepted_at ' +
    'FROM internship_artifacts a JOIN internship_instances i ON i.id = a.internship_id ' +
    'WHERE a.id = ? AND a.internship_id = ? AND i.learner_id = ? LIMIT 1',
  ).bind(artifactId,internshipId,actorId).first<Record<string,unknown>>();
}
async function versionOwned(db:P5Database,actorId:string,internshipId:string,versionId:string) {
  return db.prepare(
    'SELECT v.*, o.object_key, o.owner_kind, o.owner_id FROM internship_artifact_versions v ' +
    'JOIN internship_artifacts a ON a.id = v.artifact_id AND a.internship_id = v.internship_id ' +
    'JOIN internship_instances i ON i.id = v.internship_id ' +
    'JOIN tutor_objects o ON o.object_id = v.object_id AND o.deleted_at IS NULL ' +
    'WHERE v.id = ? AND v.internship_id = ? AND i.learner_id = ? AND o.owner_kind = ? AND o.owner_id = ? LIMIT 1',
  ).bind(versionId,internshipId,actorId,'user',actorId).first<Record<string,unknown>>();
}
async function summary(db:P5Database,internshipId:string,artifactId='') {
  const artifactWhere = artifactId ? ' AND a.id = ?' : '';
  const artifactArgs = artifactId ? [internshipId,artifactId] : [internshipId];
  const acknowledgements = (await db.prepare(
    'SELECT task_id, acknowledged_at FROM internship_task_acknowledgements WHERE internship_id = ? ORDER BY acknowledged_at, task_id',
  ).bind(internshipId).all<Record<string,unknown>>()).results || [];
  const artifacts = (await db.prepare(
    'SELECT a.id, a.task_id, a.deliverable_type, a.artifact_type, a.title, a.status, a.current_version_id, ' +
    'a.current_version_number, a.accepted_submission_id, a.created_at, a.updated_at, a.accepted_at, ' +
    'v.original_filename AS current_filename, v.content_type AS current_content_type, v.size_bytes AS current_size_bytes, v.source_type AS current_source_type ' +
    'FROM internship_artifacts a LEFT JOIN internship_artifact_versions v ON v.id = a.current_version_id ' +
    'WHERE a.internship_id = ?' + artifactWhere + ' ORDER BY a.task_id, a.deliverable_type',
  ).bind(...artifactArgs).all<Record<string,unknown>>()).results || [];
  const versions = (await db.prepare(
    'SELECT v.id, v.artifact_id, v.task_id, v.version_number, v.original_filename, v.content_type, v.size_bytes, v.source_type, ' +
    'v.prior_review_id, v.created_at, ' +
    "CASE WHEN EXISTS(SELECT 1 FROM internship_artifact_submissions s WHERE s.artifact_version_id = v.id) THEN 1 ELSE 0 END AS submitted " +
    'FROM internship_artifact_versions v JOIN internship_artifacts a ON a.id = v.artifact_id ' +
    'WHERE v.internship_id = ?' + (artifactId ? ' AND v.artifact_id = ?' : '') +
    ' ORDER BY v.created_at DESC, v.version_number DESC',
  ).bind(...artifactArgs).all<Record<string,unknown>>()).results || [];
  const submissions = (await db.prepare(
    'SELECT s.id, s.artifact_id, s.artifact_version_id, s.task_id, s.submission_number, s.prior_submission_id, s.submitted_at, s.status ' +
    'FROM internship_artifact_submissions s WHERE s.internship_id = ?' + (artifactId ? ' AND s.artifact_id = ?' : '') +
    ' ORDER BY s.submitted_at DESC, s.submission_number DESC',
  ).bind(...artifactArgs).all<Record<string,unknown>>()).results || [];
  const reviews = (await db.prepare(
    'SELECT r.id, r.task_id, r.artifact_id, r.submission_id, r.reviewer_actor_id, r.review_type, r.decision, r.feedback, ' +
    'r.requested_changes_json, r.created_at FROM internship_artifact_reviews r WHERE r.internship_id = ?' +
    (artifactId ? ' AND r.artifact_id = ?' : '') + ' ORDER BY r.created_at DESC, r.id DESC',
  ).bind(...artifactArgs).all<Record<string,unknown>>()).results || [];
  const activity = artifactId ? [] : (await db.prepare(
    'SELECT id, task_id, artifact_id, version_id, submission_id, review_id, event_type, event_time, detail_json ' +
    'FROM internship_artifact_activity WHERE internship_id = ? ORDER BY event_time DESC, id DESC LIMIT 200',
  ).bind(internshipId).all<Record<string,unknown>>()).results || [];
  return {
    acknowledgements,
    artifacts,
    versions,
    submissions,
    reviews:reviews.map(row=>({
      ...row,
      requested_changes:(()=>{try{return JSON.parse(String(row.requested_changes_json||'[]'));}catch{return [];}})(),
      requested_changes_json:undefined,
    })),
    activity,
  };
}

export async function handlePhase5ArtifactPersistenceRoute(
  request:Request,
  env:P5Env,
  route:string,
  now:number,
):Promise<Response|null> {
  if (!route.startsWith('/internships/artifacts/')) return null;
  const url = new URL(request.url);
  const isRawUpload = route === '/internships/artifacts/version-upload' && request.method === 'POST';
  const body = request.method === 'POST' && !isRawUpload ? await bodyJson(request) : {};
  if (!isRawUpload && ['learner_id','owner_id','user_id','object_key','status','reviewer_actor_id'].some(k=>k in body)) {
    return json({error:'invalid_actor_override'},400);
  }
  const actorId = id(isRawUpload ? request.headers.get('x-murikah-actor-id') : (request.method === 'GET' ? url.searchParams.get('actor_id') : body.actor_id));
  if (!actorId || !(await activeAccount(env.TUTOR_DB,actorId))) return json({error:'authentication_required'},401);
  const internshipId = id(isRawUpload ? request.headers.get('x-murikah-internship-id') : (request.method === 'GET' ? url.searchParams.get('internship_id') : body.internship_id));
  if (!internshipId) return json({error:'internship_not_found'},404);
  const owned = await ownedInternship(env.TUTOR_DB,actorId,internshipId);
  if (!owned) return json({error:'internship_not_found'},404);

  if (route === '/internships/artifacts/summary' && request.method === 'GET') {
    return json({ok:true,...await summary(env.TUTOR_DB,internshipId)});
  }
  if (route === '/internships/artifacts/history' && request.method === 'GET') {
    const artifactId = id(url.searchParams.get('artifact_id'));
    if (!artifactId || !(await artifactOwned(env.TUTOR_DB,actorId,internshipId,artifactId))) return json({error:'artifact_not_found'},404);
    return json({ok:true,...await summary(env.TUTOR_DB,internshipId,artifactId)});
  }
  if (route === '/internships/artifacts/integrity' && request.method === 'GET') {
    const rows=(await env.TUTOR_DB.prepare(
      'SELECT v.id, v.size_bytes, v.sha256, o.object_key, o.sha256 AS ownership_sha256 FROM internship_artifact_versions v ' +
      'JOIN internship_instances i ON i.id = v.internship_id ' +
      'JOIN tutor_objects o ON o.object_id = v.object_id AND o.deleted_at IS NULL ' +
      'WHERE v.internship_id = ? AND i.learner_id = ? AND o.owner_kind = ? AND o.owner_id = ?',
    ).bind(internshipId,actorId,'user',actorId).all<{
      id:string;size_bytes:number;sha256:string;object_key:string;ownership_sha256:string
    }>()).results || [];
    let missingObjects=0, sizeMismatches=0, hashMismatches=0;
    const registeredKeys=new Set<string>();
    for (const row of rows) {
      registeredKeys.add(row.object_key);
      const object=await env.TUTOR_FILES.get(row.object_key);
      if (!object) {
        missingObjects += 1;
        continue;
      }
      if (object.size !== Number(row.size_bytes||0)) sizeMismatches += 1;
      const actualHash=await sha256Hex(await new Response(object.body).arrayBuffer());
      if (actualHash !== row.sha256 || actualHash !== row.ownership_sha256) hashMismatches += 1;
    }
    const prefix=['users',actorId,'virtual-internships',internshipId,'artifact-version'].join('/') + '/';
    let cursor:string|undefined, orphanObjects=0;
    do {
      const listed=await env.TUTOR_FILES.list({prefix,cursor,limit:1000});
      for (const object of listed.objects) if (!registeredKeys.has(object.key)) orphanObjects += 1;
      cursor=listed.truncated ? listed.cursor : undefined;
    } while (cursor);
    return json({
      ok:missingObjects===0 && sizeMismatches===0 && hashMismatches===0 && orphanObjects===0,
      registered_version_count:rows.length,
      missing_object_count:missingObjects,
      size_mismatch_count:sizeMismatches,
      hash_mismatch_count:hashMismatches,
      orphan_object_count:orphanObjects,
    });
  }

  if (route === '/internships/artifacts/acknowledge' && request.method === 'POST') {
    if (owned.status !== 'active') return json({error:'internship_not_active'},409);
    const taskId = id(body.task_id), req = requestId(body.request_id);
    if (!taskId || !req) return json({error:'invalid_acknowledgement'},400);
    const contract = await taskContract(env.TUTOR_DB,internshipId,owned.scenario_version_id,taskId);
    if (!contract) return json({error:'task_not_found'},404);
    if (contract.status !== 'in_progress') return json({error:'task_not_available'},409);
    const existing = await env.TUTOR_DB.prepare(
      'SELECT task_id, acknowledged_at FROM internship_task_acknowledgements WHERE internship_id = ? AND task_id = ? LIMIT 1',
    ).bind(internshipId,taskId).first<Record<string,unknown>>();
    if (existing) return json({ok:true,idempotent_replay:true,acknowledgement:existing});
    try {
      await env.TUTOR_DB.batch([
        env.TUTOR_DB.prepare(
          'INSERT INTO internship_task_acknowledgements(internship_id, task_id, acknowledged_at, request_id) VALUES (?, ?, ?, ?)',
        ).bind(internshipId,taskId,now,req),
        activityStatement(env.TUTOR_DB,internshipId,taskId,'assignment_acknowledged',now,req),
      ]);
      return json({ok:true,acknowledgement:{task_id:taskId,acknowledged_at:now}},201);
    } catch {
      const raced=await env.TUTOR_DB.prepare(
        'SELECT task_id, acknowledged_at FROM internship_task_acknowledgements WHERE internship_id = ? AND task_id = ? LIMIT 1',
      ).bind(internshipId,taskId).first<Record<string,unknown>>();
      if (raced) return json({ok:true,idempotent_replay:true,acknowledgement:raced});
      return json({error:'acknowledgement_conflict'},409);
    }
  }

  if (route === '/internships/artifacts/create' && request.method === 'POST') {
    if (owned.status !== 'active') return json({error:'internship_not_active'},409);
    const taskId=id(body.task_id), deliverable=cleanText(body.deliverable_type,64), req=requestId(body.request_id);
    const title=safeTitle(body.title);
    if (!taskId || !DELIVERABLE.test(deliverable) || !req || !title) return json({error:'invalid_artifact'},400);
    const contract=await taskContract(env.TUTOR_DB,internshipId,owned.scenario_version_id,taskId);
    if (!contract) return json({error:'task_not_found'},404);
    if (contract.status !== 'in_progress') return json({error:'task_not_available'},409);
    if (!contract.deliverables.includes(deliverable)) return json({error:'deliverable_not_allowed'},400);
    const replay=await env.TUTOR_DB.prepare(
      'SELECT * FROM internship_artifacts WHERE internship_id = ? AND create_request_id = ? LIMIT 1',
    ).bind(internshipId,req).first<Record<string,unknown>>();
    if (replay) return json({ok:true,idempotent_replay:true,artifact:replay});
    const occupied=await env.TUTOR_DB.prepare(
      'SELECT id FROM internship_artifacts WHERE internship_id = ? AND task_id = ? AND deliverable_type = ? LIMIT 1',
    ).bind(internshipId,taskId,deliverable).first<{id:string}>();
    if (occupied) return json({error:'artifact_already_exists',artifact_id:occupied.id},409);
    const artifactId=generated('art');
    try {
      await env.TUTOR_DB.batch([
        env.TUTOR_DB.prepare(
          "INSERT INTO internship_artifacts(id, internship_id, task_id, deliverable_type, artifact_type, title, status, current_version_number, created_at, updated_at, create_request_id) " +
          "VALUES (?, ?, ?, ?, ?, ?, 'draft', 0, ?, ?, ?)",
        ).bind(artifactId,internshipId,taskId,deliverable,deliverable,title,now,now,req),
        activityStatement(env.TUTOR_DB,internshipId,taskId,'draft_created',now,req,{artifactId,detail:{deliverable_type:deliverable}}),
      ]);
      const artifact=await artifactOwned(env.TUTOR_DB,actorId,internshipId,artifactId);
      return json({ok:true,artifact},201);
    } catch {
      const racedReplay=await env.TUTOR_DB.prepare(
        'SELECT * FROM internship_artifacts WHERE internship_id = ? AND create_request_id = ? LIMIT 1',
      ).bind(internshipId,req).first<Record<string,unknown>>();
      if (racedReplay) return json({ok:true,idempotent_replay:true,artifact:racedReplay});
      const racedOccupied=await env.TUTOR_DB.prepare(
        'SELECT id FROM internship_artifacts WHERE internship_id = ? AND task_id = ? AND deliverable_type = ? LIMIT 1',
      ).bind(internshipId,taskId,deliverable).first<{id:string}>();
      if (racedOccupied) return json({error:'artifact_already_exists',artifact_id:racedOccupied.id},409);
      return json({error:'artifact_create_conflict'},409);
    }
  }

  if (route === '/internships/artifacts/version-text' && request.method === 'POST') {
    if (owned.status !== 'active') return json({error:'internship_not_active'},409);
    const artifactId=id(body.artifact_id), req=requestId(body.request_id);
    const content=String(body.content ?? ''), priorReviewId=id(body.prior_review_id);
    if (!artifactId || !req || !content.trim() || content.length > PHASE5_MAX_TEXT_CHARS) return json({error:'invalid_artifact_content'},400);
    const artifact=await artifactOwned(env.TUTOR_DB,actorId,internshipId,artifactId);
    if (!artifact) return json({error:'artifact_not_found'},404);
    if (!['draft','changes_requested'].includes(String(artifact.status||''))) return json({error:'invalid_artifact_state'},409);
    const contract=await taskContract(env.TUTOR_DB,internshipId,owned.scenario_version_id,String(artifact.task_id||''));
    if (!contract || contract.status !== 'in_progress') return json({error:'task_not_available'},409);
    const bytes=new TextEncoder().encode(content).buffer;
    return saveVersion(env,actorId,internshipId,artifact,bytes,{
      req,filename:safeFilename(String(artifact.title||'work') + '.md'),contentType:'text/markdown',sourceType:'text',priorReviewId,now,
    });
  }

  if (route === '/internships/artifacts/version-upload' && request.method === 'POST') {
    if (owned.status !== 'active') return json({error:'internship_not_active'},409);
    const artifactId=id(request.headers.get('x-murikah-artifact-id'));
    const req=requestId(request.headers.get('x-murikah-request-id'));
    const priorReviewId=id(request.headers.get('x-murikah-prior-review-id'));
    const filename=safeFilename(String(request.headers.get('x-murikah-artifact-filename')||''));
    const declared=String(request.headers.get('x-murikah-artifact-content-type')||'');
    if (!artifactId || !req || !filename) return json({error:'invalid_artifact_upload'},400);
    const type=safeContentType(filename,declared);
    if (!type.ok) return json({error:'unsupported_artifact_type'},415);
    const artifact=await artifactOwned(env.TUTOR_DB,actorId,internshipId,artifactId);
    if (!artifact) return json({error:'artifact_not_found'},404);
    if (!['draft','changes_requested'].includes(String(artifact.status||''))) return json({error:'invalid_artifact_state'},409);
    const contract=await taskContract(env.TUTOR_DB,internshipId,owned.scenario_version_id,String(artifact.task_id||''));
    if (!contract || contract.status !== 'in_progress') return json({error:'task_not_available'},409);
    const bytes=await request.arrayBuffer();
    if (bytes.byteLength <= 0) return json({error:'invalid_artifact_upload'},400);
    if (bytes.byteLength > PHASE5_MAX_FILE_BYTES) return json({error:'upload_too_large',max_bytes:PHASE5_MAX_FILE_BYTES},413);
    return saveVersion(env,actorId,internshipId,artifact,bytes,{
      req,filename,contentType:type.contentType,sourceType:'upload',priorReviewId,now,
    });
  }

  if (route === '/internships/artifacts/submit' && request.method === 'POST') {
    if (owned.status !== 'active') return json({error:'internship_not_active'},409);
    const artifactId=id(body.artifact_id), versionId=id(body.artifact_version_id), req=requestId(body.request_id);
    if (!artifactId || !versionId || !req) return json({error:'invalid_submission'},400);
    const artifact=await artifactOwned(env.TUTOR_DB,actorId,internshipId,artifactId);
    if (!artifact) return json({error:'artifact_not_found'},404);
    if (artifact.status === 'accepted') return json({error:'invalid_artifact_state'},409);
    const contract=await taskContract(env.TUTOR_DB,internshipId,owned.scenario_version_id,String(artifact.task_id||''));
    if (!contract || contract.status !== 'in_progress') return json({error:'task_not_available'},409);
    const replay=await env.TUTOR_DB.prepare(
      'SELECT * FROM internship_artifact_submissions WHERE internship_id = ? AND request_id = ? LIMIT 1',
    ).bind(internshipId,req).first<Record<string,unknown>>();
    if (replay) return json({ok:true,idempotent_replay:true,submission:replay});
    const active=await env.TUTOR_DB.prepare(
      "SELECT id FROM internship_artifact_submissions WHERE artifact_id = ? AND status IN ('submitted','under_review') ORDER BY submission_number DESC LIMIT 1",
    ).bind(artifactId).first<{id:string}>();
    if (active) return json({error:'submission_already_active'},409);
    const version=await versionOwned(env.TUTOR_DB,actorId,internshipId,versionId);
    if (!version || String(version.artifact_id||'') !== artifactId) return json({error:'artifact_version_not_found'},404);
    if (String(artifact.current_version_id||'') !== versionId) return json({error:'artifact_version_not_current'},409);
    if (!version.sha256 || Number(version.size_bytes||0) < 0) return json({error:'artifact_integrity_failed'},409);
    const priorVersionSubmission=await env.TUTOR_DB.prepare(
      'SELECT id FROM internship_artifact_submissions WHERE artifact_id = ? AND artifact_version_id = ? LIMIT 1',
    ).bind(artifactId,versionId).first<{id:string}>();
    if (priorVersionSubmission) return json({error:'artifact_version_already_submitted'},409);
    const previous=await env.TUTOR_DB.prepare(
      'SELECT id, submission_number FROM internship_artifact_submissions WHERE artifact_id = ? ORDER BY submission_number DESC LIMIT 1',
    ).bind(artifactId).first<{id:string;submission_number:number}>();
    for (let attempt=0;attempt<3;attempt++) {
      const latest=await env.TUTOR_DB.prepare(
        'SELECT COALESCE(MAX(submission_number),0) AS n FROM internship_artifact_submissions WHERE artifact_id = ?',
      ).bind(artifactId).first<{n:number}>();
      const number=Number(latest?.n||0)+1, submissionId=generated('sub');
      const eventType=number > 1 ? 'artifact_resubmitted' : 'artifact_submitted';
      try {
        await env.TUTOR_DB.batch([
          env.TUTOR_DB.prepare(
            "INSERT INTO internship_artifact_submissions(id, artifact_id, artifact_version_id, internship_id, task_id, submission_number, prior_submission_id, request_id, submitted_at, status) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitted')",
          ).bind(submissionId,artifactId,versionId,internshipId,String(artifact.task_id||''),number,previous?.id||null,req,now),
          env.TUTOR_DB.prepare(
            "UPDATE internship_artifacts SET status = 'submitted', updated_at = ? WHERE id = ? AND internship_id = ? AND status IN ('draft','changes_requested','submitted')",
          ).bind(now,artifactId,internshipId),
          activityStatement(env.TUTOR_DB,internshipId,String(artifact.task_id||''),eventType,now,req,{artifactId,versionId,submissionId,detail:{submission_number:number}}),
        ]);
        const saved=await env.TUTOR_DB.prepare('SELECT * FROM internship_artifact_submissions WHERE id = ? LIMIT 1').bind(submissionId).first<Record<string,unknown>>();
        return json({ok:true,submission:saved},201);
      } catch {
        const found=await env.TUTOR_DB.prepare(
          'SELECT * FROM internship_artifact_submissions WHERE internship_id = ? AND request_id = ? LIMIT 1',
        ).bind(internshipId,req).first<Record<string,unknown>>();
        if (found) return json({ok:true,idempotent_replay:true,submission:found});
        const racedActive=await env.TUTOR_DB.prepare(
          "SELECT id FROM internship_artifact_submissions WHERE artifact_id = ? AND status IN ('submitted','under_review') ORDER BY submission_number DESC LIMIT 1",
        ).bind(artifactId).first<{id:string}>();
        if (racedActive) return json({error:'submission_already_active'},409);
      }
    }
    return json({error:'submission_conflict'},409);
  }

  if (route === '/internships/artifacts/review-start' && request.method === 'POST') {
    if (owned.status !== 'active') return json({error:'internship_not_active'},409);
    const submissionId=id(body.submission_id), req=requestId(body.request_id);
    if (!submissionId || !req) return json({error:'invalid_review_request'},400);
    const submission=await env.TUTOR_DB.prepare(
      'SELECT s.id, s.artifact_id, s.artifact_version_id, s.task_id, s.status FROM internship_artifact_submissions s ' +
      'JOIN internship_instances i ON i.id = s.internship_id WHERE s.id = ? AND s.internship_id = ? AND i.learner_id = ? LIMIT 1',
    ).bind(submissionId,internshipId,actorId).first<Record<string,unknown>>();
    if (!submission) return json({error:'submission_not_found'},404);
    const existingReview=await env.TUTOR_DB.prepare(
      'SELECT id, task_id, artifact_id, submission_id, reviewer_actor_id, review_type, decision, feedback, requested_changes_json, model_invocation_id, created_at ' +
      'FROM internship_artifact_reviews WHERE internship_id = ? AND submission_id = ? LIMIT 1',
    ).bind(internshipId,submissionId).first<Record<string,unknown>>();
    if (existingReview) {
      const taskReady=existingReview.decision === 'accepted' && await taskDeliverablesAccepted(
        env.TUTOR_DB,internshipId,owned.scenario_version_id,String(submission.task_id||''),
      );
      return json({ok:true,already_reviewed:true,review:existingReview,submission,task_ready_for_completion:taskReady});
    }
    const reviewContract=await taskContract(env.TUTOR_DB,internshipId,owned.scenario_version_id,String(submission.task_id||''));
    if (!reviewContract || reviewContract.status !== 'in_progress') return json({error:'task_not_available'},409);
    if (submission.status === 'submitted') {
      await env.TUTOR_DB.prepare(
        "UPDATE internship_artifact_submissions SET status = 'under_review' WHERE id = ? AND internship_id = ? AND status = 'submitted'",
      ).bind(submissionId,internshipId).run();
    }
    return json({ok:true,submission:{...submission,status:submission.status === 'submitted' ? 'under_review' : submission.status}});
  }

  if (route === '/internships/artifacts/review-material' && request.method === 'GET') {
    const submissionId=id(url.searchParams.get('submission_id'));
    if (!submissionId) return json({error:'submission_not_found'},404);
    const row=await env.TUTOR_DB.prepare(
      'SELECT s.id AS submission_id, s.artifact_id, s.artifact_version_id, s.task_id, s.submission_number, s.status AS submission_status, ' +
      'a.deliverable_type, a.title, v.original_filename, v.content_type, v.size_bytes, v.sha256, v.source_type, v.object_id, ' +
      'o.object_key, d.assigned_by_actor_id, d.definition_json ' +
      'FROM internship_artifact_submissions s JOIN internship_artifacts a ON a.id = s.artifact_id ' +
      'JOIN internship_artifact_versions v ON v.id = s.artifact_version_id ' +
      'JOIN tutor_objects o ON o.object_id = v.object_id AND o.deleted_at IS NULL ' +
      'JOIN internship_instances i ON i.id = s.internship_id ' +
      'JOIN scenario_task_definitions d ON d.scenario_version_id = i.scenario_version_id AND d.task_id = s.task_id ' +
      'WHERE s.id = ? AND s.internship_id = ? AND i.learner_id = ? AND o.owner_kind = ? AND o.owner_id = ? LIMIT 1',
    ).bind(submissionId,internshipId,actorId,'user',actorId).first<Record<string,unknown>>();
    if (!row) return json({error:'submission_not_found'},404);
    const prior=(await env.TUTOR_DB.prepare(
      'SELECT r.decision, r.feedback, r.requested_changes_json, r.created_at FROM internship_artifact_reviews r ' +
      'JOIN internship_artifact_submissions s ON s.id = r.submission_id ' +
      'WHERE r.artifact_id = ? AND r.submission_id <> ? ORDER BY r.created_at DESC LIMIT 3',
    ).bind(String(row.artifact_id||''),submissionId).all<Record<string,unknown>>()).results || [];
    const object=await env.TUTOR_FILES.get(String(row.object_key||''));
    if (!object) return json({error:'artifact_storage_failed'},503);
    const extension=fileExtension(String(row.original_filename||''));
    const extractable=row.source_type === 'text' || TEXT_REVIEW_EXT.has(extension);
    let content='';
    if (extractable && object.size <= PHASE5_MAX_REVIEW_TEXT_BYTES) {
      const bytes=await new Response(object.body).arrayBuffer();
      content=new TextDecoder('utf-8',{fatal:false}).decode(bytes).slice(0,PHASE5_MAX_TEXT_CHARS);
    }
    let definition:Record<string,unknown>={};
    try { definition=JSON.parse(String(row.definition_json||'{}')) as Record<string,unknown>; } catch { definition={}; }
    return json({
      ok:true,
      material:{
        submission_id:row.submission_id,artifact_id:row.artifact_id,artifact_version_id:row.artifact_version_id,
        task_id:row.task_id,submission_number:row.submission_number,deliverable_type:row.deliverable_type,title:row.title,
        original_filename:row.original_filename,content_type:row.content_type,size_bytes:row.size_bytes,
        reviewer_actor_id:row.assigned_by_actor_id,
        task:{title:definition.title||'',brief:definition.brief||'',business_context:definition.business_context||'',learner_objective:definition.learner_objective||''},
        extractable:Boolean(content),content,prior_reviews:prior.map(p=>({
          decision:p.decision,feedback:p.feedback,
          requested_changes:(()=>{try{return JSON.parse(String(p.requested_changes_json||'[]'));}catch{return [];}})(),
          created_at:p.created_at,
        })),
      },
    });
  }

  if (route === '/internships/artifacts/review' && request.method === 'POST') {
    if (owned.status !== 'active') return json({error:'internship_not_active'},409);
    const submissionId=id(body.submission_id), req=requestId(body.request_id);
    const decision=cleanText(body.decision,32), feedback=String(body.feedback??'').trim();
    const modelInvocationId=id(body.model_invocation_id);
    const requested=Array.isArray(body.requested_changes)
      ? body.requested_changes.map(x=>String(x||'').trim()).filter(Boolean).slice(0,12)
      : [];
    if (!submissionId || !req || !['changes_requested','accepted'].includes(decision) || !feedback || feedback.length>6000 || !modelInvocationId) {
      return json({error:'invalid_review'},400);
    }
    if (requested.some(x=>x.length>1000)) return json({error:'invalid_review'},400);
    const existing=await env.TUTOR_DB.prepare(
      'SELECT * FROM internship_artifact_reviews WHERE internship_id = ? AND submission_id = ? LIMIT 1',
    ).bind(internshipId,submissionId).first<Record<string,unknown>>();
    if (existing) {
      const taskReady=existing.decision === 'accepted' && await taskDeliverablesAccepted(
        env.TUTOR_DB,internshipId,owned.scenario_version_id,String(existing.task_id||''),
      );
      return json({ok:true,idempotent_replay:true,review:existing,task_ready_for_completion:taskReady});
    }
    const submission=await env.TUTOR_DB.prepare(
      'SELECT s.*, a.deliverable_type FROM internship_artifact_submissions s JOIN internship_artifacts a ON a.id = s.artifact_id ' +
      'JOIN internship_instances i ON i.id = s.internship_id WHERE s.id = ? AND s.internship_id = ? AND i.learner_id = ? LIMIT 1',
    ).bind(submissionId,internshipId,actorId).first<Record<string,unknown>>();
    if (!submission) return json({error:'submission_not_found'},404);
    if (!['submitted','under_review'].includes(String(submission.status||''))) return json({error:'invalid_submission_state'},409);
    const contract=await taskContract(env.TUTOR_DB,internshipId,owned.scenario_version_id,String(submission.task_id||''));
    if (!contract || contract.status !== 'in_progress' || !contract.assigned_by_actor_id) return json({error:'review_unavailable'},409);
    const reviewId=generated('rev');
    const eventType=decision === 'accepted' ? 'artifact_accepted' : 'changes_requested';
    try {
      await env.TUTOR_DB.batch([
      env.TUTOR_DB.prepare(
        'INSERT INTO internship_artifact_reviews(id, internship_id, task_id, artifact_id, submission_id, reviewer_actor_id, review_type, decision, feedback, requested_changes_json, model_invocation_id, request_id, created_at) ' +
        "VALUES (?, ?, ?, ?, ?, ?, 'workflow', ?, ?, ?, ?, ?, ?)",
      ).bind(reviewId,internshipId,String(submission.task_id||''),String(submission.artifact_id||''),submissionId,contract.assigned_by_actor_id,decision,feedback,JSON.stringify(requested),modelInvocationId,req,now),
      env.TUTOR_DB.prepare(
        'UPDATE internship_artifact_submissions SET status = ? WHERE id = ? AND internship_id = ?',
      ).bind(decision,submissionId,internshipId),
      decision === 'accepted'
        ? env.TUTOR_DB.prepare(
            "UPDATE internship_artifacts SET status = 'accepted', accepted_submission_id = ?, accepted_at = ?, updated_at = ? WHERE id = ? AND internship_id = ?",
          ).bind(submissionId,now,now,String(submission.artifact_id||''),internshipId)
        : env.TUTOR_DB.prepare(
            "UPDATE internship_artifacts SET status = 'changes_requested', updated_at = ? WHERE id = ? AND internship_id = ?",
          ).bind(now,String(submission.artifact_id||''),internshipId),
      activityStatement(env.TUTOR_DB,internshipId,String(submission.task_id||''),eventType,now,req,{
        artifactId:String(submission.artifact_id||''),versionId:String(submission.artifact_version_id||''),submissionId,reviewId,
        detail:{decision},
      }),
      ]);
    } catch {
      const racedReview=await env.TUTOR_DB.prepare(
        'SELECT * FROM internship_artifact_reviews WHERE internship_id = ? AND submission_id = ? LIMIT 1',
      ).bind(internshipId,submissionId).first<Record<string,unknown>>();
      if (racedReview) {
        const taskReady=racedReview.decision === 'accepted' && await taskDeliverablesAccepted(
          env.TUTOR_DB,internshipId,owned.scenario_version_id,String(racedReview.task_id||''),
        );
        return json({ok:true,idempotent_replay:true,review:racedReview,task_ready_for_completion:taskReady});
      }
      return json({error:'review_conflict'},409);
    }
    const taskReady=decision === 'accepted' && await taskDeliverablesAccepted(
      env.TUTOR_DB,internshipId,owned.scenario_version_id,String(submission.task_id||''),
    );
    const review=await env.TUTOR_DB.prepare(
      'SELECT id, task_id, artifact_id, submission_id, reviewer_actor_id, review_type, decision, feedback, requested_changes_json, model_invocation_id, created_at FROM internship_artifact_reviews WHERE id = ?',
    ).bind(reviewId).first<Record<string,unknown>>();
    return json({ok:true,review,task_ready_for_completion:taskReady},201);
  }

  if (route === '/internships/artifacts/task-completed' && request.method === 'POST') {
    const taskId=id(body.task_id), req=requestId(body.request_id);
    if (!taskId || !req) return json({error:'invalid_task_completion'},400);
    const contract=await taskContract(env.TUTOR_DB,internshipId,owned.scenario_version_id,taskId);
    if (!contract || contract.status !== 'completed') return json({error:'task_not_completed'},409);
    await env.TUTOR_DB.batch([
      activityStatement(env.TUTOR_DB,internshipId,taskId,'task_completed',now,req),
    ]);
    return json({ok:true},201);
  }

  if (route === '/internships/artifacts/download' && request.method === 'GET') {
    const versionId=id(url.searchParams.get('version_id'));
    if (!versionId) return json({error:'artifact_version_not_found'},404);
    const version=await versionOwned(env.TUTOR_DB,actorId,internshipId,versionId);
    if (!version) return json({error:'artifact_version_not_found'},404);
    const object=await env.TUTOR_FILES.get(String(version.object_key||''));
    if (!object) return json({error:'artifact_storage_failed'},503);
    if (Number(version.size_bytes||0) !== object.size) return json({error:'artifact_integrity_failed'},503);
    return new Response(object.body,{
      status:200,
      headers:{
        'content-type':String(version.content_type||'application/octet-stream'),
        'content-length':String(object.size),
        'content-disposition':'attachment; filename="' + safeFilename(String(version.original_filename||'artifact')) + '"',
        'cache-control':'private, no-store',
        'x-content-type-options':'nosniff',
      },
    });
  }

  if (route === '/internships/artifacts/version-text' && request.method === 'GET') {
    const versionId=id(url.searchParams.get('version_id'));
    if (!versionId) return json({error:'artifact_version_not_found'},404);
    const version=await versionOwned(env.TUTOR_DB,actorId,internshipId,versionId);
    if (!version || version.source_type !== 'text') return json({error:'artifact_version_not_found'},404);
    const object=await env.TUTOR_FILES.get(String(version.object_key||''));
    if (!object || object.size > PHASE5_MAX_REVIEW_TEXT_BYTES) return json({error:'artifact_storage_failed'},503);
    const bytes=await new Response(object.body).arrayBuffer();
    return json({ok:true,version_id:versionId,content:new TextDecoder().decode(bytes)});
  }

  return json({error:'artifact_route_not_found'},404);
}

async function saveVersion(
  env:P5Env,
  actorId:string,
  internshipId:string,
  artifact:Record<string,unknown>,
  bytes:ArrayBuffer,
  options:{req:string;filename:string;contentType:string;sourceType:'text'|'upload';priorReviewId:string;now:number},
):Promise<Response> {
  if (bytes.byteLength > PHASE5_MAX_FILE_BYTES) return json({error:'upload_too_large',max_bytes:PHASE5_MAX_FILE_BYTES},413);
  const replay=await env.TUTOR_DB.prepare(
    'SELECT * FROM internship_artifact_versions WHERE artifact_id = ? AND request_id = ? LIMIT 1',
  ).bind(String(artifact.id||''),options.req).first<Record<string,unknown>>();
  if (replay) return json({ok:true,idempotent_replay:true,version:replay});
  if (options.priorReviewId) {
    const prior=await env.TUTOR_DB.prepare(
      'SELECT id FROM internship_artifact_reviews WHERE id = ? AND artifact_id = ? AND internship_id = ? LIMIT 1',
    ).bind(options.priorReviewId,String(artifact.id||''),internshipId).first<{id:string}>();
    if (!prior) return json({error:'invalid_review_reference'},400);
  }
  const sha=await sha256Hex(bytes);
  for (let attempt=0;attempt<3;attempt++) {
    const current=await env.TUTOR_DB.prepare(
      'SELECT current_version_number, status FROM internship_artifacts WHERE id = ? AND internship_id = ? LIMIT 1',
    ).bind(String(artifact.id||''),internshipId).first<{current_version_number:number;status:string}>();
    if (!current || current.status === 'accepted') return json({error:'invalid_artifact_state'},409);
    if (Number(current.current_version_number||0) >= PHASE5_MAX_VERSIONS) {
      return json({error:'artifact_version_limit',max_versions:PHASE5_MAX_VERSIONS},409);
    }
    const number=Number(current.current_version_number||0)+1;
    const versionId=generated('ver'), objectId=generated('obj');
    const key=['users',actorId,'virtual-internships',internshipId,'artifact-version',versionId].join('/');
    const runtimePath=['virtual-internships',internshipId,'artifact-version',versionId].join('/');
    await env.TUTOR_FILES.put(key,bytes,{
      customMetadata:{
        object_id:objectId,owner_kind:'user',owner_id:actorId,object_type:'artifact-version',
        artifact_id:String(artifact.id||''),artifact_version_id:versionId,sha256:sha,
      },
    });
    try {
      await env.TUTOR_DB.batch([
        env.TUTOR_DB.prepare(
          'INSERT INTO tutor_objects(object_id, owner_kind, owner_id, object_type, runtime_path, object_key, sha256, size_bytes, content_type, created_at, updated_at, deleted_at) ' +
          "VALUES (?, 'user', ?, 'artifact-version', ?, ?, ?, ?, ?, ?, ?, NULL)",
        ).bind(objectId,actorId,runtimePath,key,sha,bytes.byteLength,options.contentType,options.now,options.now),
        env.TUTOR_DB.prepare(
          'INSERT INTO internship_artifact_versions(id, artifact_id, internship_id, task_id, version_number, object_id, original_filename, content_type, size_bytes, sha256, source_type, prior_review_id, request_id, created_at, created_by) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ).bind(versionId,String(artifact.id||''),internshipId,String(artifact.task_id||''),number,objectId,options.filename,options.contentType,bytes.byteLength,sha,options.sourceType,options.priorReviewId||null,options.req,options.now,actorId),
        env.TUTOR_DB.prepare(
          'UPDATE internship_artifacts SET current_version_id = ?, current_version_number = ?, updated_at = ? ' +
          'WHERE id = ? AND internship_id = ? AND current_version_number = ?',
        ).bind(versionId,number,options.now,String(artifact.id||''),internshipId,Number(current.current_version_number||0)),
        activityStatement(env.TUTOR_DB,internshipId,String(artifact.task_id||''),'artifact_version_saved',options.now,options.req,{
          artifactId:String(artifact.id||''),versionId,detail:{version_number:number,source_type:options.sourceType},
        }),
      ]);
      const saved=await env.TUTOR_DB.prepare(
        'SELECT id, artifact_id, task_id, version_number, original_filename, content_type, size_bytes, sha256, source_type, prior_review_id, created_at FROM internship_artifact_versions WHERE id = ? LIMIT 1',
      ).bind(versionId).first<Record<string,unknown>>();
      if (saved) return json({ok:true,version:saved},201);
    } catch {
      await env.TUTOR_FILES.delete(key);
      const found=await env.TUTOR_DB.prepare(
        'SELECT * FROM internship_artifact_versions WHERE artifact_id = ? AND request_id = ? LIMIT 1',
      ).bind(String(artifact.id||''),options.req).first<Record<string,unknown>>();
      if (found) return json({ok:true,idempotent_replay:true,version:found});
      continue;
    }
    await env.TUTOR_FILES.delete(key);
  }
  return json({error:'artifact_storage_failed'},503);
}
