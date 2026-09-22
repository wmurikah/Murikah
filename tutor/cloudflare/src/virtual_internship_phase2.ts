type RunResult = { meta?: { changes?: number } };
export type ScenarioStatement = {
  bind(...values: unknown[]): ScenarioStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
  run(): Promise<RunResult>;
};
export type ScenarioDatabase = {
  prepare(query: string): ScenarioStatement;
  batch(statements: ScenarioStatement[]): Promise<RunResult[]>;
};
type ScenarioEnv = { TUTOR_DB: ScenarioDatabase };

export const SCENARIO_SCHEMA_VERSION = 1;
export const SCENARIO_MAX_CASCADE_DEPTH = 16;
export const SCENARIO_MAX_CANONICAL_BYTES = 1_048_576;
const DAY_SECONDS = 86_400;
const ID_RE = /^[a-z][a-z0-9_]{2,63}$/;
const TASK_STATES = new Set(['locked','available','in_progress','completed','cancelled']);
const EVENT_TRIGGERS = new Set(['time_elapsed_days','task_state','all_dependencies_completed','fact_equals','prior_event','decision']);
const EVENT_MUTATIONS = new Set(['reveal_fact','set_mutable_fact','unlock_task','assign_task','adjust_deadline','record_decision']);
const TASK_TRANSITIONS: Record<string, Set<string>> = {
  locked: new Set(),
  available: new Set(['in_progress','cancelled']),
  in_progress: new Set(['completed','cancelled']),
  completed: new Set(),
  cancelled: new Set(),
};

function json(payload: unknown, status = 200): Response {
  return Response.json(payload,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
}
async function bodyJson(request:Request):Promise<Record<string,unknown>>{
  try{const value=await request.json();return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};}catch{return {};}
}
function id(value:unknown):string{const v=String(value||'').trim();return ID_RE.test(v)?v:'';}
function requestId(value:unknown):string{const v=String(value||'').trim();return /^[A-Za-z0-9._:-]{3,128}$/.test(v)?v:'';}
function int(value:unknown, fallback=0):number{const n=Number(value);return Number.isSafeInteger(n)?n:fallback;}
function stable(value:unknown):unknown{
  if(Array.isArray(value))return value.map(stable);
  if(value&&typeof value==='object'){
    const out:Record<string,unknown>={};
    for(const key of Object.keys(value as Record<string,unknown>).sort())out[key]=stable((value as Record<string,unknown>)[key]);
    return out;
  }
  return value;
}
function canonicalDefinition(value:Record<string,unknown>):Record<string,unknown>{
  const cloned=structuredClone(value);
  const manifest=cloned.manifest;
  if(manifest&&typeof manifest==='object'&&!Array.isArray(manifest))(manifest as Record<string,unknown>).content_hash='';
  return cloned;
}
async function sha256(value:string):Promise<string>{
  const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)));
  return Array.from(digest,b=>b.toString(16).padStart(2,'0')).join('');
}
function canonicalString(value:Record<string,unknown>):string{return JSON.stringify(stable(canonicalDefinition(value)));}
function arrayOfObjects(value:unknown):Record<string,unknown>[]{
  return Array.isArray(value)?value.filter((v):v is Record<string,unknown>=>Boolean(v&&typeof v==='object'&&!Array.isArray(v))):[];
}
function asObject(value:unknown):Record<string,unknown>{return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};}
function asArray(value:unknown):unknown[]{return Array.isArray(value)?value:[];}
function definitionShape(definition:Record<string,unknown>):{ok:true;manifest:Record<string,unknown>}|{ok:false;error:string}{
  const manifest=asObject(definition.manifest);
  if(int(manifest.schema_version)!==SCENARIO_SCHEMA_VERSION)return {ok:false,error:'scenario_schema_version_unsupported'};
  const versionId=id(manifest.scenario_version_id);
  if(!versionId)return {ok:false,error:'scenario_manifest_invalid'};
  const limits:[string,number][]=[['actors',64],['facts',128],['tasks',128],['events',128],['decisions',64]];
  for(const [name,max] of limits)if(!Array.isArray(definition[name])||asArray(definition[name]).length>max)return {ok:false,error:'scenario_definition_invalid'};
  if(!definition.company||typeof definition.company!=='object'||Array.isArray(definition.company))return {ok:false,error:'scenario_definition_invalid'};
  const sets:Record<string,Set<string>>={};
  for(const [name,key] of [['actors','actor_id'],['facts','id'],['tasks','task_id'],['events','event_id'],['decisions','decision_id']] as const){
    const values=arrayOfObjects(definition[name]).map(row=>id(row[key]));
    if(values.some(v=>!v)||new Set(values).size!==values.length)return {ok:false,error:'scenario_definition_invalid'};
    sets[name]=new Set(values);
  }
  const taskDeps=new Map<string,string[]>();
  for(const task of arrayOfObjects(definition.tasks)){
    const taskId=id(task.task_id), deps=asArray(task.dependencies).map(id);
    if(!sets.actors.has(id(task.assigned_by_actor_id))||deps.some(dep=>!sets.tasks.has(dep)||dep===taskId))return {ok:false,error:'scenario_definition_reference_invalid'};
    if(deps.length && task.initial_state!=='locked')return {ok:false,error:'scenario_task_initial_state_invalid'};
    taskDeps.set(taskId,deps);
  }
  const taskVisiting=new Set<string>(),taskVisited=new Set<string>();
  const visitTask=(taskId:string):boolean=>{
    if(taskVisiting.has(taskId))return false;if(taskVisited.has(taskId))return true;
    taskVisiting.add(taskId);for(const dep of taskDeps.get(taskId)||[])if(!visitTask(dep))return false;
    taskVisiting.delete(taskId);taskVisited.add(taskId);return true;
  };
  for(const taskId of Array.from(sets.tasks).sort())if(!visitTask(taskId))return {ok:false,error:'scenario_task_cycle'};
  for(const actor of arrayOfObjects(definition.actors)){
    if(asArray(actor.knowledge_fact_ids).map(id).some(factId=>!sets.facts.has(factId)))return {ok:false,error:'scenario_definition_reference_invalid'};
    if(asArray(actor.allowed_event_ids).map(id).some(eventId=>!sets.events.has(eventId)))return {ok:false,error:'scenario_definition_reference_invalid'};
  }
  const decisionOptions=new Map<string,Set<string>>();
  for(const decision of arrayOfObjects(definition.decisions)){
    const options=new Set(arrayOfObjects(decision.options).map(option=>id(option.option_id)));
    if(options.has('')||options.size!==arrayOfObjects(decision.options).length)return {ok:false,error:'scenario_decision_invalid'};
    decisionOptions.set(id(decision.decision_id),options);
  }
  const eventDeps=new Map<string,string[]>();
  for(const event of arrayOfObjects(definition.events)){
    if(event.once!==true)return {ok:false,error:'scenario_repeat_events_deferred'};
    for(const trigger of arrayOfObjects(event.triggers)){
      const kind=String(trigger.trigger_type||'');
      if(!EVENT_TRIGGERS.has(kind))return {ok:false,error:'scenario_trigger_invalid'};
      if(['task_state','all_dependencies_completed'].includes(kind)&&!sets.tasks.has(id(trigger.task_id)))return {ok:false,error:'scenario_definition_reference_invalid'};
      if(kind==='fact_equals'&&!sets.facts.has(id(trigger.fact_id)))return {ok:false,error:'scenario_definition_reference_invalid'};
      if(kind==='prior_event'&&!sets.events.has(id(trigger.event_id)))return {ok:false,error:'scenario_definition_reference_invalid'};
      if(kind==='decision'){
        const decisionId=id(trigger.decision_id),optionId=id(trigger.option_id);
        if(!decisionOptions.get(decisionId)?.has(optionId))return {ok:false,error:'scenario_decision_invalid'};
      }
    }
    if(asArray(event.actor_ids).map(id).some(actorId=>!sets.actors.has(actorId)))return {ok:false,error:'scenario_definition_reference_invalid'};
    eventDeps.set(id(event.event_id),arrayOfObjects(event.triggers).filter(t=>t.trigger_type==='prior_event').map(t=>id(t.event_id)));
    for(const mutation of arrayOfObjects(event.mutations)){
      const kind=String(mutation.mutation_type||'');
      if(!EVENT_MUTATIONS.has(kind))return {ok:false,error:'scenario_mutation_invalid'};
      if(['reveal_fact','set_mutable_fact'].includes(kind)&&!sets.facts.has(id(mutation.fact_id)))return {ok:false,error:'scenario_definition_reference_invalid'};
      if(['unlock_task','assign_task','adjust_deadline'].includes(kind)&&!sets.tasks.has(id(mutation.task_id)))return {ok:false,error:'scenario_definition_reference_invalid'};
      if(kind==='set_mutable_fact'){
        const fact=arrayOfObjects(definition.facts).find(f=>id(f.id)===id(mutation.fact_id));
        if(fact?.mutability!=='mutable')return {ok:false,error:'scenario_immutable_fact'};
      }
      if(kind==='record_decision'){
        const decisionId=id(mutation.decision_id),optionId=id(mutation.option_id);
        if(!decisionOptions.get(decisionId)?.has(optionId))return {ok:false,error:'scenario_decision_invalid'};
      }
    }
  }
  const eventVisiting=new Set<string>(),eventVisited=new Set<string>();
  const visitEvent=(eventId:string):boolean=>{
    if(eventVisiting.has(eventId))return false;if(eventVisited.has(eventId))return true;
    eventVisiting.add(eventId);for(const dep of eventDeps.get(eventId)||[])if(!visitEvent(dep))return false;
    eventVisiting.delete(eventId);eventVisited.add(eventId);return true;
  };
  for(const eventId of Array.from(sets.events).sort())if(!visitEvent(eventId))return {ok:false,error:'scenario_event_cycle'};
  return {ok:true,manifest};
}
function manifestRef(versionId:string):string{return `d1:scenario-version-content/${versionId}`;}

type OwnedInternship={id:string;learner_id:string;scenario_version_id:string;started_at:number;status:string};
async function ownedInternship(db:ScenarioDatabase,internshipId:string,actorId:string):Promise<OwnedInternship|null>{
  return db.prepare('SELECT id, learner_id, scenario_version_id, started_at, status FROM internship_instances WHERE id = ? AND learner_id = ? LIMIT 1')
    .bind(internshipId,actorId).first<OwnedInternship>();
}
async function readyState(db:ScenarioDatabase,internshipId:string):Promise<{scenario_version_id:string;status:string;revision:number}|null>{
  return db.prepare('SELECT scenario_version_id, status, revision FROM internship_scenario_state WHERE internship_id = ? LIMIT 1')
    .bind(internshipId).first<{scenario_version_id:string;status:string;revision:number}>();
}
async function replayChange(db:ScenarioDatabase,internshipId:string,req:string):Promise<{revision:number;change_type:string}|null>{
  return db.prepare('SELECT revision, change_type FROM internship_state_changes WHERE internship_id = ? AND request_id = ? LIMIT 1').bind(internshipId,req).first<{revision:number;change_type:string}>();
}

export async function buildScenarioInitializationStatements(
  db:ScenarioDatabase,scenarioVersionId:string,internshipId:string,startedAt:number,now:number,
):Promise<ScenarioStatement[]>{
  const content=await db.prepare('SELECT c.scenario_version_id FROM scenario_version_content c JOIN scenario_versions sv ON sv.id = c.scenario_version_id WHERE c.scenario_version_id = ? AND c.content_hash = sv.content_hash AND c.manifest_ref = sv.manifest_ref LIMIT 1').bind(scenarioVersionId).first<{scenario_version_id:string}>();
  if(!content)return [];
  const facts=(await db.prepare('SELECT fact_id, initial_value_json, visibility, initially_revealed FROM scenario_facts WHERE scenario_version_id = ? ORDER BY fact_id').bind(scenarioVersionId).all<{fact_id:string;initial_value_json:string;visibility:string;initially_revealed:number}>()).results||[];
  const tasks=(await db.prepare('SELECT task_id, due_offset_days FROM scenario_task_definitions WHERE scenario_version_id = ? ORDER BY authored_sequence, task_id').bind(scenarioVersionId).all<{task_id:string;due_offset_days:number}>()).results||[];
  const events=(await db.prepare('SELECT event_id FROM scenario_event_definitions WHERE scenario_version_id = ? ORDER BY event_id').bind(scenarioVersionId).all<{event_id:string}>()).results||[];
  const deps=(await db.prepare('SELECT task_id, depends_on_task_id FROM scenario_task_dependencies WHERE scenario_version_id = ? ORDER BY task_id, depends_on_task_id').bind(scenarioVersionId).all<{task_id:string;depends_on_task_id:string}>()).results||[];
  const depCount=new Map<string,number>();for(const row of deps)depCount.set(row.task_id,(depCount.get(row.task_id)||0)+1);
  const statements:ScenarioStatement[]=[
    db.prepare("INSERT INTO internship_scenario_state(internship_id, scenario_version_id, status, revision, initialized_at, updated_at) VALUES (?, ?, 'ready', 0, ?, ?)").bind(internshipId,scenarioVersionId,now,now),
    db.prepare("INSERT INTO internship_state_changes(internship_id, revision, change_type, source_id, changed_at, request_id, detail_json) VALUES (?, 0, 'scenario_initialized', ?, ?, 'scenario:init', '{}')").bind(internshipId,scenarioVersionId,now),
  ];
  for(const fact of facts){
    const learner=fact.initially_revealed===1&&['public','learner_visible'].includes(fact.visibility)?1:0;
    statements.push(db.prepare('INSERT INTO internship_scenario_facts(internship_id, fact_id, current_value_json, is_revealed, learner_revealed, updated_revision) VALUES (?, ?, ?, ?, ?, 0)')
      .bind(internshipId,fact.fact_id,fact.initial_value_json,fact.initially_revealed,learner));
  }
  for(const task of tasks){
    const status=(depCount.get(task.task_id)||0)>0?'locked':'available';
    statements.push(db.prepare('INSERT INTO internship_tasks(internship_id, task_id, status, due_at, updated_revision) VALUES (?, ?, ?, ?, 0)')
      .bind(internshipId,task.task_id,status,startedAt+task.due_offset_days*DAY_SECONDS));
  }
  for(const event of events)statements.push(db.prepare('INSERT INTO internship_event_state(internship_id, event_id, fired_count, last_fired_at, updated_revision) VALUES (?, ?, 0, NULL, 0)').bind(internshipId,event.event_id));
  return statements;
}

async function installDefinition(request:Request,env:ScenarioEnv,now:number):Promise<Response>{
  const body=await bodyJson(request),versionId=id(body.scenario_version_id),definition=asObject(body.canonical_definition);
  if(!versionId||Object.keys(definition).length===0)return json({error:'scenario_definition_invalid'},400);
  const shape=definitionShape(definition);if(!shape.ok)return json({error:shape.error},400);
  if(id(shape.manifest.scenario_version_id)!==versionId)return json({error:'scenario_version_mismatch'},409);
  const canonical=canonicalString(definition);
  if(new TextEncoder().encode(canonical).byteLength>SCENARIO_MAX_CANONICAL_BYTES)return json({error:'scenario_definition_too_large'},413);
  const digest=await sha256(canonical), declared=String(shape.manifest.content_hash||'');
  if(declared!==digest||String(body.content_hash||digest)!==digest)return json({error:'scenario_content_hash_mismatch'},409);
  const sv=await env.TUTOR_DB.prepare('SELECT id, scenario_pack_id, version, schema_version, status, manifest_ref, minimum_duration_days, content_hash FROM scenario_versions WHERE id = ? LIMIT 1').bind(versionId).first<{id:string;scenario_pack_id:string;version:number;schema_version:number;status:string;manifest_ref:string;minimum_duration_days:number;content_hash:string}>();
  if(!sv)return json({error:'scenario_version_not_available'},404);
  if(sv.schema_version!==SCENARIO_SCHEMA_VERSION)return json({error:'scenario_schema_version_mismatch'},409);
  if(id(shape.manifest.id)!==sv.scenario_pack_id||int(shape.manifest.scenario_version)!==sv.version||int(shape.manifest.minimum_duration_days)!==sv.minimum_duration_days)return json({error:'scenario_version_metadata_mismatch'},409);
  const existing=await env.TUTOR_DB.prepare('SELECT content_hash FROM scenario_version_content WHERE scenario_version_id = ? LIMIT 1').bind(versionId).first<{content_hash:string}>();
  if(existing)return existing.content_hash===digest?json({ok:true,idempotent_replay:true,scenario_version_id:versionId,content_hash:digest,manifest_ref:manifestRef(versionId)}):json({error:'scenario_definition_immutable'},409);
  const expectedRef=manifestRef(versionId);
  if(sv.status==='published'&&(sv.content_hash!==digest||sv.manifest_ref!==expectedRef))return json({error:'published_scenario_snapshot_missing'},409);
  if(!['draft','published'].includes(sv.status))return json({error:'scenario_version_not_available'},409);

  const actors=arrayOfObjects(definition.actors),facts=arrayOfObjects(definition.facts),tasks=arrayOfObjects(definition.tasks),events=arrayOfObjects(definition.events),decisions=arrayOfObjects(definition.decisions);
  const statements:ScenarioStatement[]=[];
  if(sv.status==='draft')statements.push(env.TUTOR_DB.prepare('UPDATE scenario_versions SET content_hash = ?, manifest_ref = ? WHERE id = ? AND status = \'draft\'').bind(digest,expectedRef,versionId));
  statements.push(env.TUTOR_DB.prepare('INSERT INTO scenario_version_content(scenario_version_id, schema_version, manifest_ref, canonical_json, content_hash, installed_at) VALUES (?, ?, ?, ?, ?, ?)').bind(versionId,SCENARIO_SCHEMA_VERSION,expectedRef,JSON.stringify(stable(definition)),digest,now));
  for(const actor of actors){
    statements.push(env.TUTOR_DB.prepare('INSERT INTO scenario_actors(scenario_version_id, actor_id, name, actor_class, job_title, department_id, definition_json, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(versionId,id(actor.actor_id),String(actor.name||''),String(actor.actor_class||''),String(actor.job_title||''),id(actor.department_id),JSON.stringify(stable(actor)),actor.active===true?1:0));
    for(const factId of asArray(actor.knowledge_fact_ids).map(id))statements.push(env.TUTOR_DB.prepare('INSERT INTO scenario_actor_knowledge(scenario_version_id, actor_id, fact_id) VALUES (?, ?, ?)').bind(versionId,id(actor.actor_id),factId));
  }
  for(const fact of facts)statements.push(env.TUTOR_DB.prepare('INSERT INTO scenario_facts(scenario_version_id, fact_id, fact_key, initial_value_json, mutability, visibility, visibility_scopes_json, source, initially_revealed, future_only) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(versionId,id(fact.id),id(fact.key),JSON.stringify(fact.value),String(fact.mutability),String(fact.visibility),JSON.stringify(asArray(fact.visibility_scopes)),String(fact.source||''),fact.initially_revealed===true?1:0,fact.future_only===true?1:0));
  for(const task of tasks){
    const due=asObject(task.due_policy);
    statements.push(env.TUTOR_DB.prepare('INSERT INTO scenario_task_definitions(scenario_version_id, task_id, authored_sequence, title, category, assigned_by_actor_id, initial_state, due_offset_days, definition_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(versionId,id(task.task_id),int(task.authored_sequence),String(task.title||''),String(task.category||''),id(task.assigned_by_actor_id),String(task.initial_state||''),int(due.days),JSON.stringify(stable(task))));
    for(const dep of asArray(task.dependencies).map(id))statements.push(env.TUTOR_DB.prepare('INSERT INTO scenario_task_dependencies(scenario_version_id, task_id, depends_on_task_id) VALUES (?, ?, ?)').bind(versionId,id(task.task_id),dep));
  }
  for(const event of events){
    statements.push(env.TUTOR_DB.prepare('INSERT INTO scenario_event_definitions(scenario_version_id, event_id, authored_sequence, event_type, priority, once_only, audit_label, definition_json) VALUES (?, ?, ?, ?, ?, 1, ?, ?)')
      .bind(versionId,id(event.event_id),int(event.authored_sequence),String(event.event_type||''),int(event.priority),String(event.audit_label||''),JSON.stringify(stable(event))));
    arrayOfObjects(event.triggers).forEach((trigger,index)=>statements.push(env.TUTOR_DB.prepare('INSERT INTO scenario_event_triggers(scenario_version_id, event_id, trigger_index, trigger_type, trigger_json) VALUES (?, ?, ?, ?, ?)')
      .bind(versionId,id(event.event_id),index,String(trigger.trigger_type||''),JSON.stringify(stable(trigger)))));
  }
  for(const decision of decisions)for(const option of arrayOfObjects(decision.options))statements.push(env.TUTOR_DB.prepare('INSERT INTO scenario_decision_options(scenario_version_id, decision_id, option_id, label) VALUES (?, ?, ?, ?)')
    .bind(versionId,id(decision.decision_id),id(option.option_id),String(option.label||'')));
  try{await env.TUTOR_DB.batch(statements);return json({ok:true,scenario_version_id:versionId,content_hash:digest,manifest_ref:expectedRef},201);}
  catch(error){console.error('Virtual Internship Phase 2 definition install failed',error);return json({error:'scenario_definition_install_failed'},503);}
}

async function statePayload(db:ScenarioDatabase,owned:OwnedInternship){
  const state=await readyState(db,owned.id);if(!state||state.status!=='ready')return null;
  const facts=(await db.prepare('SELECT f.fact_id, f.mutability, f.visibility, f.future_only, r.current_value_json, r.is_revealed, r.learner_revealed, r.updated_revision FROM scenario_facts f JOIN internship_scenario_facts r ON r.fact_id = f.fact_id AND r.internship_id = ? WHERE f.scenario_version_id = ? ORDER BY f.fact_id').bind(owned.id,owned.scenario_version_id).all<Record<string,unknown>>()).results||[];
  const tasks=(await db.prepare('SELECT task_id, status, due_at, updated_revision FROM internship_tasks WHERE internship_id = ? ORDER BY task_id').bind(owned.id).all<Record<string,unknown>>()).results||[];
  const firings=(await db.prepare('SELECT event_id, fired_at, revision_after FROM internship_event_firings WHERE internship_id = ? ORDER BY revision_after, event_id').bind(owned.id).all<Record<string,unknown>>()).results||[];
  const decisions=(await db.prepare('SELECT decision_id, option_id, decided_at, revision FROM internship_decisions WHERE internship_id = ? ORDER BY decision_id').bind(owned.id).all<Record<string,unknown>>()).results||[];
  return {internship_id:owned.id,scenario_version_id:owned.scenario_version_id,status:state.status,revision:state.revision,facts:facts.map(row=>({...row,current_value:JSON.parse(String(row.current_value_json||'null')),current_value_json:undefined})),tasks,fired_events:firings,decisions};
}
async function taskSnapshot(db:ScenarioDatabase,internshipId:string,scenarioVersionId:string){
  const tasks=(await db.prepare('SELECT task_id, status, due_at FROM internship_tasks WHERE internship_id = ? ORDER BY task_id').bind(internshipId).all<{task_id:string;status:string;due_at:number}>()).results||[];
  const deps=(await db.prepare('SELECT task_id, depends_on_task_id FROM scenario_task_dependencies WHERE scenario_version_id = ? ORDER BY task_id, depends_on_task_id').bind(scenarioVersionId).all<{task_id:string;depends_on_task_id:string}>()).results||[];
  return {tasks,deps};
}
function unlockedAfter(tasks:{task_id:string;status:string}[],deps:{task_id:string;depends_on_task_id:string}[],overrides:Map<string,string>):string[]{
  const status=new Map(tasks.map(t=>[t.task_id,overrides.get(t.task_id)||t.status]));
  const byTask=new Map<string,string[]>();for(const dep of deps){const list=byTask.get(dep.task_id)||[];list.push(dep.depends_on_task_id);byTask.set(dep.task_id,list);}
  const out:string[]=[];for(const task of tasks){if(status.get(task.task_id)!=='locked')continue;const needed=byTask.get(task.task_id)||[];if(needed.length&&needed.every(dep=>status.get(dep)==='completed'))out.push(task.task_id);}
  return out.sort();
}
async function taskTransition(request:Request,env:ScenarioEnv,owned:OwnedInternship,now:number):Promise<Response>{
  const body=await bodyJson(request),taskId=id(body.task_id),target=String(body.target_status||''),req=requestId(body.request_id);
  if(!taskId||!TASK_STATES.has(target)||!req)return json({error:'scenario_task_transition_invalid'},400);
  const state=await readyState(env.TUTOR_DB,owned.id);if(!state||state.status!=='ready')return json({error:'scenario_not_ready'},409);
  const replay=await replayChange(env.TUTOR_DB,owned.id,req);if(replay)return json({ok:true,idempotent_replay:true,revision:replay.revision});
  const expected=body.expected_revision===undefined?state.revision:int(body.expected_revision,-1);if(expected!==state.revision)return json({error:'scenario_revision_conflict',revision:state.revision},409);
  const task=await env.TUTOR_DB.prepare('SELECT status FROM internship_tasks WHERE internship_id = ? AND task_id = ? LIMIT 1').bind(owned.id,taskId).first<{status:string}>();
  if(!task)return json({error:'scenario_task_not_found'},404);
  if(task.status===target)return json({ok:true,idempotent_replay:true,revision:state.revision});
  if(!TASK_TRANSITIONS[task.status]?.has(target))return json({error:'scenario_task_transition_invalid'},409);
  const snap=await taskSnapshot(env.TUTOR_DB,owned.id,owned.scenario_version_id),next=state.revision+1,overrides=new Map([[taskId,target]]);
  const unlocked=target==='completed'?unlockedAfter(snap.tasks,snap.deps,overrides):[];
  const detail=JSON.stringify({task_id:taskId,from:task.status,to:target,unlocked});
  const statements=[
    env.TUTOR_DB.prepare("INSERT INTO internship_state_changes(internship_id, revision, change_type, source_id, changed_at, request_id, detail_json) VALUES (?, ?, 'task_transition', ?, ?, ?, ?)").bind(owned.id,next,taskId,now,req,detail),
    env.TUTOR_DB.prepare('UPDATE internship_tasks SET status = ?, updated_revision = ? WHERE internship_id = ? AND task_id = ? AND status = ?').bind(target,next,owned.id,taskId,task.status),
    ...unlocked.map(child=>env.TUTOR_DB.prepare("UPDATE internship_tasks SET status = 'available', updated_revision = ? WHERE internship_id = ? AND task_id = ? AND status = 'locked'").bind(next,owned.id,child)),
    env.TUTOR_DB.prepare('UPDATE internship_scenario_state SET revision = ?, updated_at = ? WHERE internship_id = ? AND revision = ?').bind(next,now,owned.id,state.revision),
  ];
  try{await env.TUTOR_DB.batch(statements);console.log(JSON.stringify({event:'vi_scenario_task_transition',internship_id:owned.id,scenario_version_id:owned.scenario_version_id,state_revision:next,unlocked_task_count:unlocked.length}));return json({ok:true,revision:next,unlocked_tasks:unlocked});}
  catch{return json({error:'scenario_revision_conflict'},409);}
}
async function recordDecision(request:Request,env:ScenarioEnv,owned:OwnedInternship,now:number):Promise<Response>{
  const body=await bodyJson(request),decisionId=id(body.decision_id),optionId=id(body.option_id),req=requestId(body.request_id);
  if(!decisionId||!optionId||!req)return json({error:'scenario_decision_invalid'},400);
  const state=await readyState(env.TUTOR_DB,owned.id);if(!state||state.status!=='ready')return json({error:'scenario_not_ready'},409);
  const replay=await replayChange(env.TUTOR_DB,owned.id,req);if(replay)return json({ok:true,idempotent_replay:true,revision:replay.revision});
  const option=await env.TUTOR_DB.prepare('SELECT option_id FROM scenario_decision_options WHERE scenario_version_id = ? AND decision_id = ? AND option_id = ? LIMIT 1').bind(owned.scenario_version_id,decisionId,optionId).first<{option_id:string}>();
  if(!option)return json({error:'scenario_decision_invalid'},400);
  const existing=await env.TUTOR_DB.prepare('SELECT option_id, revision FROM internship_decisions WHERE internship_id = ? AND decision_id = ? LIMIT 1').bind(owned.id,decisionId).first<{option_id:string;revision:number}>();
  if(existing)return existing.option_id===optionId?json({ok:true,idempotent_replay:true,revision:existing.revision}):json({error:'scenario_decision_already_recorded'},409);
  const expected=body.expected_revision===undefined?state.revision:int(body.expected_revision,-1);if(expected!==state.revision)return json({error:'scenario_revision_conflict',revision:state.revision},409);
  const next=state.revision+1,detail=JSON.stringify({decision_id:decisionId,option_id:optionId});
  try{await env.TUTOR_DB.batch([
    env.TUTOR_DB.prepare("INSERT INTO internship_state_changes(internship_id, revision, change_type, source_id, changed_at, request_id, detail_json) VALUES (?, ?, 'decision_recorded', ?, ?, ?, ?)").bind(owned.id,next,decisionId,now,req,detail),
    env.TUTOR_DB.prepare('INSERT INTO internship_decisions(internship_id, decision_id, option_id, request_id, decided_at, revision) VALUES (?, ?, ?, ?, ?, ?)').bind(owned.id,decisionId,optionId,req,now,next),
    env.TUTOR_DB.prepare('UPDATE internship_scenario_state SET revision = ?, updated_at = ? WHERE internship_id = ? AND revision = ?').bind(next,now,owned.id,state.revision),
  ]);return json({ok:true,revision:next});}catch{return json({error:'scenario_revision_conflict'},409);}
}
async function triggerOk(db:ScenarioDatabase,owned:OwnedInternship,trigger:Record<string,unknown>,now:number):Promise<boolean>{
  const kind=String(trigger.trigger_type||'');
  if(kind==='time_elapsed_days')return now>=owned.started_at+int(trigger.days)*DAY_SECONDS;
  if(kind==='task_state'){
    const row=await db.prepare('SELECT status FROM internship_tasks WHERE internship_id = ? AND task_id = ? LIMIT 1').bind(owned.id,id(trigger.task_id)).first<{status:string}>();
    return row?.status===String(trigger.status||'');
  }
  if(kind==='all_dependencies_completed'){
    const taskId=id(trigger.task_id);
    const rows=(await db.prepare('SELECT d.depends_on_task_id, t.status FROM scenario_task_dependencies d JOIN internship_tasks t ON t.internship_id = ? AND t.task_id = d.depends_on_task_id WHERE d.scenario_version_id = ? AND d.task_id = ? ORDER BY d.depends_on_task_id').bind(owned.id,owned.scenario_version_id,taskId).all<{depends_on_task_id:string;status:string}>()).results||[];
    return rows.length>0&&rows.every(row=>row.status==='completed');
  }
  if(kind==='fact_equals'){
    const row=await db.prepare('SELECT current_value_json FROM internship_scenario_facts WHERE internship_id = ? AND fact_id = ? LIMIT 1').bind(owned.id,id(trigger.fact_id)).first<{current_value_json:string}>();
    return Boolean(row)&&JSON.stringify(JSON.parse(row!.current_value_json))===JSON.stringify(trigger.expected);
  }
  if(kind==='prior_event'){
    const row=await db.prepare('SELECT event_id FROM internship_event_firings WHERE internship_id = ? AND event_id = ? LIMIT 1').bind(owned.id,id(trigger.event_id)).first<{event_id:string}>();
    return Boolean(row);
  }
  if(kind==='decision'){
    const row=await db.prepare('SELECT option_id FROM internship_decisions WHERE internship_id = ? AND decision_id = ? LIMIT 1').bind(owned.id,id(trigger.decision_id)).first<{option_id:string}>();
    return row?.option_id===id(trigger.option_id);
  }
  return false;
}
async function eligibleEvents(db:ScenarioDatabase,owned:OwnedInternship,now:number){
  const events=(await db.prepare('SELECT event_id, priority, authored_sequence, definition_json FROM scenario_event_definitions WHERE scenario_version_id = ? ORDER BY priority DESC, authored_sequence ASC, event_id ASC').bind(owned.scenario_version_id).all<{event_id:string;priority:number;authored_sequence:number;definition_json:string}>()).results||[];
  const fired=new Set(((await db.prepare('SELECT event_id FROM internship_event_firings WHERE internship_id = ?').bind(owned.id).all<{event_id:string}>()).results||[]).map(r=>r.event_id));
  const eligible=[];
  for(const event of events){
    if(fired.has(event.event_id))continue;
    const definition=JSON.parse(event.definition_json) as Record<string,unknown>, triggers=arrayOfObjects(definition.triggers);
    let okay=true;for(const trigger of triggers)if(!(await triggerOk(db,owned,trigger,now))){okay=false;break;}
    if(okay)eligible.push({event_id:event.event_id,definition});
  }
  return eligible;
}
async function applyEvent(env:ScenarioEnv,owned:OwnedInternship,event:{event_id:string;definition:Record<string,unknown>},now:number,req:string):Promise<{ok:boolean;revision:number;unlocked:string[]}>{
  const state=await readyState(env.TUTOR_DB,owned.id);if(!state||state.status!=='ready')throw new Error('scenario_not_ready');
  const next=state.revision+1, mutations=arrayOfObjects(event.definition.mutations), statements:ScenarioStatement[]=[];
  const mutationSummary:Record<string,unknown>[]=[];
  for(const mutation of mutations){
    const kind=String(mutation.mutation_type||'');if(!EVENT_MUTATIONS.has(kind))throw new Error('scenario_mutation_invalid');
    if(kind==='reveal_fact'){
      const factId=id(mutation.fact_id);statements.push(env.TUTOR_DB.prepare('UPDATE internship_scenario_facts SET is_revealed = 1, learner_revealed = 1, updated_revision = ? WHERE internship_id = ? AND fact_id = ?').bind(next,owned.id,factId));mutationSummary.push({mutation_type:kind,fact_id:factId});
    }else if(kind==='set_mutable_fact'){
      const factId=id(mutation.fact_id), fact=await env.TUTOR_DB.prepare('SELECT mutability FROM scenario_facts WHERE scenario_version_id = ? AND fact_id = ? LIMIT 1').bind(owned.scenario_version_id,factId).first<{mutability:string}>();
      if(!fact||fact.mutability!=='mutable')throw new Error('scenario_immutable_fact');
      statements.push(env.TUTOR_DB.prepare('UPDATE internship_scenario_facts SET current_value_json = ?, updated_revision = ? WHERE internship_id = ? AND fact_id = ?').bind(JSON.stringify(mutation.value),next,owned.id,factId));mutationSummary.push({mutation_type:kind,fact_id:factId,value:mutation.value});
    }else if(kind==='unlock_task'||kind==='assign_task'){
      const taskId=id(mutation.task_id);statements.push(env.TUTOR_DB.prepare("UPDATE internship_tasks SET status = 'available', updated_revision = ? WHERE internship_id = ? AND task_id = ? AND status = 'locked'").bind(next,owned.id,taskId));mutationSummary.push({mutation_type:kind,task_id:taskId});
    }else if(kind==='adjust_deadline'){
      const taskId=id(mutation.task_id),seconds=int(mutation.offset_days)*DAY_SECONDS;statements.push(env.TUTOR_DB.prepare('UPDATE internship_tasks SET due_at = due_at + ?, updated_revision = ? WHERE internship_id = ? AND task_id = ?').bind(seconds,next,owned.id,taskId));mutationSummary.push({mutation_type:kind,task_id:taskId,offset_days:int(mutation.offset_days)});
    }else if(kind==='record_decision'){
      const decisionId=id(mutation.decision_id),optionId=id(mutation.option_id);
      const option=await env.TUTOR_DB.prepare('SELECT option_id FROM scenario_decision_options WHERE scenario_version_id = ? AND decision_id = ? AND option_id = ? LIMIT 1').bind(owned.scenario_version_id,decisionId,optionId).first<{option_id:string}>();
      if(!option)throw new Error('scenario_decision_invalid');
      statements.push(env.TUTOR_DB.prepare('INSERT OR IGNORE INTO internship_decisions(internship_id, decision_id, option_id, request_id, decided_at, revision) VALUES (?, ?, ?, ?, ?, ?)').bind(owned.id,decisionId,optionId,`${req}:decision:${decisionId}`,now,next));mutationSummary.push({mutation_type:kind,decision_id:decisionId,option_id:optionId});
    }
  }
  const snap=await taskSnapshot(env.TUTOR_DB,owned.id,owned.scenario_version_id),unlocked=unlockedAfter(snap.tasks,snap.deps,new Map());
  for(const child of unlocked)statements.push(env.TUTOR_DB.prepare("UPDATE internship_tasks SET status = 'available', updated_revision = ? WHERE internship_id = ? AND task_id = ? AND status = 'locked'").bind(next,owned.id,child));
  const firingId=`ief_${event.event_id}_${next}`, eventReq=`${req}:${event.event_id}`, triggerType=String(arrayOfObjects(event.definition.triggers)[0]?.trigger_type||'');
  const summary=JSON.stringify(mutationSummary);
  statements.unshift(
    env.TUTOR_DB.prepare("INSERT INTO internship_state_changes(internship_id, revision, change_type, source_id, changed_at, request_id, detail_json) VALUES (?, ?, 'event_fired', ?, ?, ?, ?)").bind(owned.id,next,event.event_id,now,eventReq,summary),
    env.TUTOR_DB.prepare('INSERT INTO internship_event_firings(internship_id, event_id, firing_id, trigger_type, trigger_source, fired_at, revision_before, revision_after, applied_mutations_json, request_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(owned.id,event.event_id,firingId,triggerType,'deterministic_evaluator',now,state.revision,next,summary,eventReq),
    env.TUTOR_DB.prepare('UPDATE internship_event_state SET fired_count = fired_count + 1, last_fired_at = ?, updated_revision = ? WHERE internship_id = ? AND event_id = ?').bind(now,next,owned.id,event.event_id)
  );
  statements.push(env.TUTOR_DB.prepare('UPDATE internship_scenario_state SET revision = ?, updated_at = ? WHERE internship_id = ? AND revision = ?').bind(next,now,owned.id,state.revision));
  try{await env.TUTOR_DB.batch(statements);return {ok:true,revision:next,unlocked};}catch{return {ok:false,revision:state.revision,unlocked:[]};}
}
async function evaluate(request:Request,env:ScenarioEnv,owned:OwnedInternship,now:number):Promise<Response>{
  const evaluationStartedMs=Date.now();
  const body=await bodyJson(request),req=requestId(body.request_id);if(!req)return json({error:'scenario_evaluation_invalid'},400);
  const initial=await readyState(env.TUTOR_DB,owned.id);if(!initial||initial.status!=='ready')return json({error:'scenario_not_ready'},409);
  const expected=body.expected_revision===undefined?initial.revision:int(body.expected_revision,-1);if(expected!==initial.revision)return json({error:'scenario_revision_conflict',revision:initial.revision},409);
  const fired:string[]=[];let evaluated=0,unlocked=0;
  for(let depth=0;depth<SCENARIO_MAX_CASCADE_DEPTH;depth++){
    const eligible=await eligibleEvents(env.TUTOR_DB,owned,now);evaluated+=eligible.length;if(!eligible.length)break;
    const event=eligible[0],applied=await applyEvent(env,owned,event,now,req);if(!applied.ok)continue;
    fired.push(event.event_id);unlocked+=applied.unlocked.length;
  }
  const remaining=await eligibleEvents(env.TUTOR_DB,owned,now);
  if(remaining.length)return json({error:'scenario_cascade_limit'},409);
  const final=await readyState(env.TUTOR_DB,owned.id);
  console.log(JSON.stringify({event:'vi_scenario_evaluate',internship_id:owned.id,scenario_version_id:owned.scenario_version_id,state_revision:final?.revision||initial.revision,evaluated_event_count:evaluated,fired_event_count:fired.length,unlocked_task_count:unlocked,elapsed_ms:Math.max(0,Date.now()-evaluationStartedMs)}));
  return json({ok:true,revision:final?.revision||initial.revision,fired_events:fired,evaluated_event_count:evaluated});
}
async function actorView(db:ScenarioDatabase,owned:OwnedInternship,actorId:string):Promise<Record<string,unknown>|null>{
  const actor=await db.prepare('SELECT actor_id, name, actor_class, job_title, department_id FROM scenario_actors WHERE scenario_version_id = ? AND actor_id = ? AND active = 1 LIMIT 1').bind(owned.scenario_version_id,actorId).first<Record<string,unknown>>();
  if(!actor)return null;
  const rows=(await db.prepare("SELECT f.fact_id, f.future_only, r.current_value_json, r.is_revealed FROM scenario_facts f JOIN internship_scenario_facts r ON r.internship_id = ? AND r.fact_id = f.fact_id LEFT JOIN scenario_actor_knowledge k ON k.scenario_version_id = f.scenario_version_id AND k.actor_id = ? AND k.fact_id = f.fact_id WHERE f.scenario_version_id = ? AND (f.visibility = 'public' OR k.actor_id IS NOT NULL) ORDER BY f.fact_id").bind(owned.id,actorId,owned.scenario_version_id).all<{fact_id:string;future_only:number;current_value_json:string;is_revealed:number}>()).results||[];
  const facts=rows.filter(r=>r.future_only!==1||r.is_revealed===1).map(r=>({fact_id:r.fact_id,value:JSON.parse(r.current_value_json)}));
  return {actor,facts};
}
async function learnerView(db:ScenarioDatabase,owned:OwnedInternship):Promise<Record<string,unknown>>{
  const facts=(await db.prepare('SELECT fact_id, current_value_json FROM internship_scenario_facts WHERE internship_id = ? AND learner_revealed = 1 ORDER BY fact_id').bind(owned.id).all<{fact_id:string;current_value_json:string}>()).results||[];
  const tasks=(await db.prepare('SELECT d.task_id, d.title, d.category, t.status, t.due_at FROM internship_tasks t JOIN scenario_task_definitions d ON d.scenario_version_id = ? AND d.task_id = t.task_id WHERE t.internship_id = ? ORDER BY d.authored_sequence, d.task_id').bind(owned.scenario_version_id,owned.id).all<Record<string,unknown>>()).results||[];
  const events=(await db.prepare('SELECT f.event_id, f.fired_at, d.audit_label FROM internship_event_firings f JOIN scenario_event_definitions d ON d.scenario_version_id = ? AND d.event_id = f.event_id WHERE f.internship_id = ? ORDER BY f.revision_after, f.event_id').bind(owned.scenario_version_id,owned.id).all<Record<string,unknown>>()).results||[];
  return {internship_id:owned.id,scenario_version_id:owned.scenario_version_id,facts:facts.map(f=>({fact_id:f.fact_id,value:JSON.parse(f.current_value_json)})),tasks,fired_events:events};
}

export async function handleScenarioPersistenceRoute(request:Request,env:ScenarioEnv,route:string,now:number):Promise<Response|null>{
  if(route==='/scenario-definition/install'&&request.method==='POST')return installDefinition(request,env,now);
  if(!route.startsWith('/internships/scenario/'))return null;
  const body=request.method==='POST'?await bodyJson(request):{};
  const url=new URL(request.url);
  if(['learner_id','owner_id','user_id','canonical_state','patch_state'].some(key=>key in body))return json({error:'invalid_actor_override'},400);
  const actorId=id(request.method==='GET'?url.searchParams.get('actor_id'):body.actor_id);
  const internshipId=id(request.method==='GET'?url.searchParams.get('internship_id'):body.internship_id);
  if(!actorId)return json({error:'authentication_required'},401);
  if(!internshipId)return json({error:'internship_not_found'},404);
  const account=await env.TUTOR_DB.prepare("SELECT role, account_status FROM tutor_accounts WHERE actor_id = ? LIMIT 1").bind(actorId).first<{role:string;account_status:string}>();
  if(!account||!['member','admin'].includes(account.role)||account.account_status!=='active')return json({error:'authentication_required'},401);
  const owned=await ownedInternship(env.TUTOR_DB,internshipId,actorId);if(!owned)return json({error:'internship_not_found'},404);

  if(route==='/internships/scenario/initialize'&&request.method==='POST'){
    const req=requestId(body.request_id)||'scenario:init';
    const current=await readyState(env.TUTOR_DB,owned.id);if(current?.status==='ready')return json({ok:true,idempotent_replay:true,revision:current.revision});
    const statements=await buildScenarioInitializationStatements(env.TUTOR_DB,owned.scenario_version_id,owned.id,owned.started_at,now);
    if(!statements.length)return json({error:'scenario_definition_not_engine_ready'},409);
    try{await env.TUTOR_DB.batch(statements);return json({ok:true,revision:0});}catch{
      const replay=await readyState(env.TUTOR_DB,owned.id);return replay?.status==='ready'?json({ok:true,idempotent_replay:true,revision:replay.revision}):json({error:'scenario_initialization_failed'},503);
    }
  }
  if(route==='/internships/scenario/definition'&&request.method==='GET'){
    const row=await env.TUTOR_DB.prepare('SELECT c.canonical_json, c.content_hash, c.manifest_ref FROM scenario_version_content c JOIN scenario_versions sv ON sv.id = c.scenario_version_id JOIN internship_instances i ON i.scenario_version_id = c.scenario_version_id WHERE i.id = ? AND i.learner_id = ? AND c.content_hash = sv.content_hash AND c.manifest_ref = sv.manifest_ref LIMIT 1').bind(owned.id,actorId).first<{canonical_json:string;content_hash:string;manifest_ref:string}>();
    if(!row)return json({error:'scenario_definition_not_engine_ready'},404);
    return json({ok:true,scenario_version_id:owned.scenario_version_id,content_hash:row.content_hash,manifest_ref:row.manifest_ref,definition:JSON.parse(row.canonical_json)});
  }
  if(route==='/internships/scenario/state'&&request.method==='GET'){
    const state=await statePayload(env.TUTOR_DB,owned);return state?json({ok:true,state}):json({error:'scenario_not_ready'},409);
  }
  if(route==='/internships/scenario/actor-view'&&request.method==='GET'){
    const scenarioActorId=id(url.searchParams.get('scenario_actor_id'));if(!scenarioActorId)return json({error:'scenario_actor_not_found'},404);
    const view=await actorView(env.TUTOR_DB,owned,scenarioActorId);return view?json({ok:true,view}):json({error:'scenario_actor_not_found'},404);
  }
  if(route==='/internships/scenario/learner-view'&&request.method==='GET')return json({ok:true,view:await learnerView(env.TUTOR_DB,owned)});
  if(route==='/internships/scenario/task-transition'&&request.method==='POST')return taskTransition(new Request(request.url,{method:'POST',headers:request.headers,body:JSON.stringify(body)}),env,owned,now);
  if(route==='/internships/scenario/decision'&&request.method==='POST')return recordDecision(new Request(request.url,{method:'POST',headers:request.headers,body:JSON.stringify(body)}),env,owned,now);
  if(route==='/internships/scenario/evaluate'&&request.method==='POST')return evaluate(new Request(request.url,{method:'POST',headers:request.headers,body:JSON.stringify(body)}),env,owned,now);
  return json({error:'scenario_route_not_found'},404);
}
