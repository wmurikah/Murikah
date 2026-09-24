type P6Statement = {
  bind(...values: unknown[]): P6Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
  run(): Promise<{ meta?: { changes?: number } }>;
};
type P6Database = {
  prepare(query: string): P6Statement;
  batch(statements: P6Statement[]): Promise<Array<{ meta?: { changes?: number } }>>;
};
type P6Env = { TUTOR_DB: P6Database };

const ID=/^[A-Za-z0-9_-]{1,128}$/;
const REQUEST_ID=/^[A-Za-z0-9._:-]{3,128}$/;
const HEX64=/^[0-9a-f]{64}$/;
const ASSISTANCE_SOURCES=new Set(['murikah_mentor','external_declared','approved_tool']);
const ASSISTANCE_PROVENANCE=new Set(['system_observed','learner_declared']);

function json(payload:unknown,status=200):Response{
  return Response.json(payload,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
}
async function bodyJson(request:Request):Promise<Record<string,unknown>>{
  try{const value=await request.json();return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};}
  catch{return {};}
}
function text(value:unknown,max:number):string{const out=String(value??'').trim();return out.length<=max?out:'';}
function id(value:unknown):string{const out=text(value,128);return ID.test(out)?out:'';}
function requestId(value:unknown):string{const out=text(value,128);return REQUEST_ID.test(out)?out:'';}
function int(value:unknown):number{const out=Number(value);return Number.isSafeInteger(out)?out:0;}
function generated(prefix:string):string{return prefix+'_'+crypto.randomUUID().replace(/-/g,'');}
function parseJson(value:unknown,fallback:unknown):unknown{try{return JSON.parse(String(value??''));}catch{return fallback;}}
function stable(value:unknown):unknown{
  if(Array.isArray(value))return value.map(stable);
  if(value&&typeof value==='object'){
    const out:Record<string,unknown>={};
    for(const key of Object.keys(value as Record<string,unknown>).sort())out[key]=stable((value as Record<string,unknown>)[key]);
    return out;
  }
  return value;
}
async function sha256Hex(value:string):Promise<string>{
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map(b=>b.toString(16).padStart(2,'0')).join('');
}
async function activeAccount(db:P6Database,actorId:string):Promise<boolean>{
  const row=await db.prepare("SELECT role, account_status FROM tutor_accounts WHERE actor_id = ? LIMIT 1")
    .bind(actorId).first<{role:string;account_status:string}>();
  return Boolean(row&&['member','admin'].includes(row.role)&&row.account_status==='active');
}
async function ownedInternship(db:P6Database,actorId:string,internshipId:string){
  return db.prepare(
    'SELECT i.id, i.learner_id, i.scenario_version_id, i.started_at, i.status, i.qualifying, c.canonical_json '+
    'FROM internship_instances i JOIN scenario_version_content c ON c.scenario_version_id = i.scenario_version_id '+
    'WHERE i.id = ? AND i.learner_id = ? LIMIT 1'
  ).bind(internshipId,actorId).first<Record<string,unknown>>();
}
function safeArray(value:unknown):unknown[]{return Array.isArray(value)?value:[];}

async function assessmentSummary(db:P6Database,internshipId:string){
  const assessments=(await db.prepare(
    'SELECT id, internship_id, task_id, artifact_id, artifact_version_id, submission_id, rubric_id, rubric_schema_version, rubric_hash, '+
    'assessment_type, status, assessor_model_invocation_id, assessor_prompt_version, assessor_schema_version, calculation_version, '+
    'aggregate_numeric, overall_summary, limitations_json, created_at, completed_at, failed_at FROM internship_assessments '+
    'WHERE internship_id = ? ORDER BY created_at DESC, id DESC'
  ).bind(internshipId).all<Record<string,unknown>>()).results||[];
  const criteria=(await db.prepare(
    'SELECT c.assessment_id, c.criterion_id, c.result_state, c.rating_id, c.numeric_value, c.feedback, c.evidence_refs_json, c.limitation '+
    'FROM internship_assessment_criteria c JOIN internship_assessments a ON a.id = c.assessment_id '+
    'WHERE a.internship_id = ? ORDER BY a.created_at DESC, c.criterion_id'
  ).bind(internshipId).all<Record<string,unknown>>()).results||[];
  const assistance=(await db.prepare(
    'SELECT id, task_id, artifact_id, artifact_version_id, source, provenance, assistance_level, category, summary, model_invocation_id, event_time '+
    'FROM internship_assistance_events WHERE internship_id = ? ORDER BY event_time ASC, id ASC'
  ).bind(internshipId).all<Record<string,unknown>>()).results||[];
  const reviews=(await db.prepare(
    'SELECT id, review_type, cutoff_at, evidence_snapshot_json, evidence_snapshot_hash, status, strengths_json, development_areas_json, '+
    'priorities_json, assistance_summary_json, narrative, model_invocation_id, narrative_version, supersedes_review_id, created_at, finalized_at '+
    'FROM internship_performance_reviews WHERE internship_id = ? ORDER BY finalized_at DESC, id DESC'
  ).bind(internshipId).all<Record<string,unknown>>()).results||[];
  return {
    assessments:assessments.map(a=>({
      ...a,
      limitations:parseJson(a.limitations_json,[]),
      criteria:criteria.filter(c=>c.assessment_id===a.id).map(c=>({
        ...c,evidence_refs:parseJson(c.evidence_refs_json,[]),
      })),
    })),
    assistance_events:assistance,
    performance_reviews:reviews.map(r=>({
      ...r,
      evidence_snapshot:parseJson(r.evidence_snapshot_json,{}),
      strengths:parseJson(r.strengths_json,[]),
      development_areas:parseJson(r.development_areas_json,[]),
      priorities:parseJson(r.priorities_json,[]),
      assistance_summary:parseJson(r.assistance_summary_json,{}),
    })),
  };
}

export async function handlePhase6AssessmentPersistenceRoute(
  request:Request,env:P6Env,route:string,now:number,
):Promise<Response|null>{
  if(!route.startsWith('/internships/assessments')&&!route.startsWith('/internships/assistance')&&!route.startsWith('/internships/performance-reviews'))return null;
  const url=new URL(request.url);
  const isGet=request.method==='GET';
  const body=isGet?{}:await bodyJson(request);
  const actorId=id(isGet?url.searchParams.get('actor_id'):body.actor_id);
  const internshipId=id(isGet?url.searchParams.get('internship_id'):body.internship_id);
  if(!actorId||!internshipId||!await activeAccount(env.TUTOR_DB,actorId))return json({error:'authentication_required'},401);
  const owned=await ownedInternship(env.TUTOR_DB,actorId,internshipId);
  if(!owned)return json({error:'internship_not_found'},404);

  if(route==='/internships/assessments/summary'&&request.method==='GET'){
    return json({ok:true,...await assessmentSummary(env.TUTOR_DB,internshipId)});
  }

  if(route==='/internships/assessments/start'&&request.method==='POST'){
    if(owned.status!=='active')return json({error:'internship_not_active'},409);
    const submissionId=id(body.submission_id),req=requestId(body.request_id);
    const rubricId=id(body.rubric_id),rubricSchema=int(body.rubric_schema_version);
    const rubricHash=text(body.rubric_hash,64),calculationVersion=text(body.calculation_version,80);
    const promptVersion=int(body.assessor_prompt_version),schemaVersion=int(body.assessor_schema_version);
    if(!submissionId||!req||!rubricId||rubricSchema<1||!HEX64.test(rubricHash)||!calculationVersion||promptVersion<1||schemaVersion<1){
      return json({error:'invalid_assessment_request'},400);
    }
    const existing=await env.TUTOR_DB.prepare(
      'SELECT * FROM internship_assessments WHERE internship_id = ? AND request_id = ? LIMIT 1'
    ).bind(internshipId,req).first<Record<string,unknown>>();
    if(existing)return json({ok:true,idempotent_replay:true,assessment:existing});
    const cached=await env.TUTOR_DB.prepare(
      "SELECT * FROM internship_assessments WHERE internship_id = ? AND submission_id = ? AND rubric_id = ? AND rubric_hash = ? AND status = 'completed' ORDER BY completed_at DESC LIMIT 1"
    ).bind(internshipId,submissionId,rubricId,rubricHash).first<Record<string,unknown>>();
    if(cached)return json({ok:true,cached:true,assessment:cached});
    const row=await env.TUTOR_DB.prepare(
      'SELECT s.id AS submission_id, s.artifact_id, s.artifact_version_id, s.task_id, s.status AS submission_status, '+
      'a.status AS artifact_status, d.definition_json FROM internship_artifact_submissions s '+
      'JOIN internship_artifacts a ON a.id = s.artifact_id AND a.internship_id = s.internship_id '+
      'JOIN internship_artifact_versions v ON v.id = s.artifact_version_id AND v.artifact_id = s.artifact_id '+
      'JOIN scenario_task_definitions d ON d.scenario_version_id = ? AND d.task_id = s.task_id '+
      'WHERE s.id = ? AND s.internship_id = ? LIMIT 1'
    ).bind(String(owned.scenario_version_id||''),submissionId,internshipId).first<Record<string,unknown>>();
    if(!row)return json({error:'submission_not_found'},404);
    if(String(row.submission_status)!=='accepted'||String(row.artifact_status)!=='accepted')return json({error:'assessment_not_eligible'},409);
    const definition=parseJson(row.definition_json,{}) as Record<string,unknown>;
    const rubric=(definition&&typeof definition.rubric==='object'&&definition.rubric&&!Array.isArray(definition.rubric))
      ? definition.rubric as Record<string,unknown>:null;
    if(!rubric||String(rubric.rubric_id||'')!==rubricId||int(rubric.schema_version)!==rubricSchema)return json({error:'rubric_mismatch'},409);
    const assessmentId=generated('asm');
    try{
      await env.TUTOR_DB.batch([
        env.TUTOR_DB.prepare(
          "INSERT INTO internship_assessments(id, internship_id, task_id, artifact_id, artifact_version_id, submission_id, rubric_id, rubric_schema_version, rubric_hash, assessment_type, status, assessor_prompt_version, assessor_schema_version, calculation_version, request_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'artifact', 'pending', ?, ?, ?, ?, ?)"
        ).bind(assessmentId,internshipId,String(row.task_id||''),String(row.artifact_id||''),String(row.artifact_version_id||''),submissionId,rubricId,rubricSchema,rubricHash,promptVersion,schemaVersion,calculationVersion,req,now),
        env.TUTOR_DB.prepare("UPDATE internship_assessments SET status = 'assessing' WHERE id = ? AND status = 'pending'").bind(assessmentId),
      ]);
      const created=await env.TUTOR_DB.prepare('SELECT * FROM internship_assessments WHERE id = ?').bind(assessmentId).first<Record<string,unknown>>();
      return json({ok:true,assessment:created},201);
    }catch(error){console.error('Phase 6 assessment start failed',error);return json({error:'assessment_persistence_failed'},503);}
  }

  if(route==='/internships/assessments/complete'&&request.method==='POST'){
    const assessmentId=id(body.assessment_id),modelInvocationId=id(body.model_invocation_id);
    const summary=text(body.overall_summary,4000),aggregate=body.aggregate_numeric==null?'':text(body.aggregate_numeric,80);
    const limitations=safeArray(body.limitations).map(x=>text(x,1000)).filter(Boolean).slice(0,32);
    const criteria=safeArray(body.criterion_results);
    if(!assessmentId||!modelInvocationId||!summary||!criteria.length)return json({error:'invalid_assessment_result'},400);
    const assessment=await env.TUTOR_DB.prepare(
      'SELECT a.* FROM internship_assessments a JOIN internship_instances i ON i.id = a.internship_id WHERE a.id = ? AND a.internship_id = ? AND i.learner_id = ? LIMIT 1'
    ).bind(assessmentId,internshipId,actorId).first<Record<string,unknown>>();
    if(!assessment)return json({error:'assessment_not_found'},404);
    if(assessment.status==='completed')return json({ok:true,idempotent_replay:true,assessment});
    if(!['pending','assessing'].includes(String(assessment.status||'')))return json({error:'assessment_not_active'},409);
    const inserts:P6Statement[]=[];
    const seen=new Set<string>();
    let evidenceCount=0;
    for(const raw of criteria){
      if(!raw||typeof raw!=='object'||Array.isArray(raw))return json({error:'invalid_assessment_result'},400);
      const row=raw as Record<string,unknown>,criterionId=id(row.criterion_id);
      const state=text(row.result_state,32),ratingId=text(row.rating_id,80),numeric=row.numeric_value==null?'':text(row.numeric_value,80);
      const feedback=text(row.feedback,3000),limitation=text(row.limitation,2000);
      const refs=safeArray(row.evidence_refs);
      if(!criterionId||seen.has(criterionId)||!['assessed','not_assessed'].includes(state))return json({error:'invalid_assessment_result'},400);
      if(state==='assessed'&&(!ratingId||!feedback||!refs.length))return json({error:'invalid_assessment_result'},400);
      if(state==='not_assessed'&&!limitation)return json({error:'invalid_assessment_result'},400);
      for(const refRaw of refs){
        if(!refRaw||typeof refRaw!=='object'||Array.isArray(refRaw))return json({error:'invalid_evidence_reference'},400);
        const ref=refRaw as Record<string,unknown>;
        if(String(ref.artifact_id||'')!==String(assessment.artifact_id||'')||
           String(ref.artifact_version_id||'')!==String(assessment.artifact_version_id||'')||
           String(ref.submission_id||'')!==String(assessment.submission_id||''))return json({error:'invalid_evidence_reference'},400);
        evidenceCount+=1;
      }
      seen.add(criterionId);
      inserts.push(env.TUTOR_DB.prepare(
        'INSERT INTO internship_assessment_criteria(assessment_id, criterion_id, result_state, rating_id, numeric_value, feedback, evidence_refs_json, limitation) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(assessmentId,criterionId,state,ratingId,numeric||null,feedback,JSON.stringify(refs),limitation));
    }
    if(seen.size!==criteria.length)return json({error:'invalid_assessment_result'},400);
    try{
      await env.TUTOR_DB.batch([
        ...inserts,
        env.TUTOR_DB.prepare(
          "UPDATE internship_assessments SET status = 'completed', assessor_model_invocation_id = ?, aggregate_numeric = ?, overall_summary = ?, limitations_json = ?, completed_at = ? WHERE id = ? AND status IN ('pending','assessing')"
        ).bind(modelInvocationId,aggregate||null,summary,JSON.stringify(limitations),now,assessmentId),
      ]);
      const completed=await env.TUTOR_DB.prepare('SELECT * FROM internship_assessments WHERE id = ?').bind(assessmentId).first<Record<string,unknown>>();
      return json({ok:true,assessment:completed,criteria_count:criteria.length,evidence_reference_count:evidenceCount});
    }catch(error){console.error('Phase 6 assessment completion failed',error);return json({error:'assessment_persistence_failed'},503);}
  }

  if(route==='/internships/assessments/fail'&&request.method==='POST'){
    const assessmentId=id(body.assessment_id),reason=text(body.reason,1000);
    const assessment=await env.TUTOR_DB.prepare(
      'SELECT a.id, a.status FROM internship_assessments a JOIN internship_instances i ON i.id = a.internship_id WHERE a.id = ? AND a.internship_id = ? AND i.learner_id = ? LIMIT 1'
    ).bind(assessmentId,internshipId,actorId).first<Record<string,unknown>>();
    if(!assessment)return json({error:'assessment_not_found'},404);
    if(assessment.status==='completed')return json({error:'assessment_already_completed'},409);
    await env.TUTOR_DB.prepare(
      "UPDATE internship_assessments SET status = 'failed', limitations_json = ?, failed_at = ? WHERE id = ? AND status IN ('pending','assessing','failed')"
    ).bind(JSON.stringify(reason?[reason]:['Formal assessment could not be completed.']),now,assessmentId).run();
    return json({ok:true,status:'failed'});
  }

  if(route==='/internships/assistance/record'&&request.method==='POST'){
    if(owned.status!=='active')return json({error:'internship_not_active'},409);
    const req=requestId(body.request_id),taskId=id(body.task_id)||'',artifactId=id(body.artifact_id)||'',versionId=id(body.artifact_version_id)||'';
    const source=text(body.source,40),provenance=text(body.provenance,40),level=int(body.assistance_level);
    const category=text(body.category,80),summary=text(body.summary,1000),modelInvocation=id(body.model_invocation_id)||'';
    if(!req||!ASSISTANCE_SOURCES.has(source)||!ASSISTANCE_PROVENANCE.has(provenance)||level<0||level>5||!category)return json({error:'invalid_assistance_event'},400);
    const existing=await env.TUTOR_DB.prepare('SELECT * FROM internship_assistance_events WHERE internship_id = ? AND request_id = ? LIMIT 1')
      .bind(internshipId,req).first<Record<string,unknown>>();
    if(existing)return json({ok:true,idempotent_replay:true,assistance_event:existing});
    if(taskId){
      const task=await env.TUTOR_DB.prepare('SELECT task_id FROM internship_tasks WHERE internship_id = ? AND task_id = ? LIMIT 1').bind(internshipId,taskId).first();
      if(!task)return json({error:'task_not_found'},404);
    }
    if(artifactId){
      const artifact=await env.TUTOR_DB.prepare('SELECT id FROM internship_artifacts WHERE internship_id = ? AND id = ? LIMIT 1').bind(internshipId,artifactId).first();
      if(!artifact)return json({error:'artifact_not_found'},404);
    }
    if(versionId){
      const version=await env.TUTOR_DB.prepare('SELECT id FROM internship_artifact_versions WHERE internship_id = ? AND id = ? LIMIT 1').bind(internshipId,versionId).first();
      if(!version)return json({error:'artifact_version_not_found'},404);
    }
    const eventId=generated('assist');
    await env.TUTOR_DB.prepare(
      'INSERT INTO internship_assistance_events(id, internship_id, task_id, artifact_id, artifact_version_id, source, provenance, assistance_level, category, summary, model_invocation_id, event_time, request_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(eventId,internshipId,taskId,artifactId,versionId,source,provenance,level,category,summary,modelInvocation,now,req).run();
    const created=await env.TUTOR_DB.prepare('SELECT * FROM internship_assistance_events WHERE id = ?').bind(eventId).first<Record<string,unknown>>();
    return json({ok:true,assistance_event:created},201);
  }

  if(route==='/internships/performance-reviews/record'&&request.method==='POST'){
    if(owned.status!=='active'&&owned.status!=='stopped')return json({error:'review_unavailable'},409);
    const req=requestId(body.request_id),reviewType=text(body.review_type,16),cutoff=int(body.cutoff_at);
    const snapshot=body.evidence_snapshot,providedHash=text(body.evidence_snapshot_hash,64);
    if(!req||!['midpoint','final'].includes(reviewType)||!cutoff||!snapshot||typeof snapshot!=='object'||Array.isArray(snapshot))return json({error:'invalid_performance_review'},400);
    const canonical=JSON.stringify(stable(snapshot));
    const actualHash=await sha256Hex(canonical);
    if(providedHash&&providedHash!==actualHash)return json({error:'review_snapshot_hash_mismatch'},409);
    const canonicalScenario=parseJson(owned.canonical_json,{}) as Record<string,unknown>;
    const manifest=(canonicalScenario&&typeof canonicalScenario.manifest==='object'&&canonicalScenario.manifest&&!Array.isArray(canonicalScenario.manifest))
      ? canonicalScenario.manifest as Record<string,unknown>:{};
    const policy=(manifest&&typeof manifest.review_policy==='object'&&manifest.review_policy&&!Array.isArray(manifest.review_policy))
      ? manifest.review_policy as Record<string,unknown>:{};
    const minimum=Math.max(1,int(manifest.minimum_duration_days)||90);
    const demo=['demo','test'].includes(String(manifest.classification||''));
    const midpoint=demo?(int(policy.demo_accelerated_midpoint_day)||Math.max(1,Math.floor(minimum/2))):(int(policy.midpoint_day)||Math.max(1,Math.floor(minimum/2)));
    const finalDay=demo?(int(policy.demo_accelerated_final_day)||Math.max(midpoint,minimum-5)):(int(policy.final_review_day)||Math.max(midpoint,minimum-5));
    const requiredDay=reviewType==='midpoint'?midpoint:finalDay;
    const elapsed=Math.max(0,Math.floor((now-int(owned.started_at))/86400));
    if(elapsed<requiredDay||cutoff>now||cutoff<int(owned.started_at))return json({error:'review_not_eligible',required_day:requiredDay,elapsed_days:elapsed},409);
    const existing=await env.TUTOR_DB.prepare('SELECT * FROM internship_performance_reviews WHERE internship_id = ? AND review_type = ? AND request_id = ? LIMIT 1')
      .bind(internshipId,reviewType,req).first<Record<string,unknown>>();
    if(existing)return json({ok:true,idempotent_replay:true,performance_review:existing});
    const strengths=safeArray(body.strengths).slice(0,12),development=safeArray(body.development_areas).slice(0,12),priorities=safeArray(body.priorities).slice(0,12);
    const assistanceSummary=(body.assistance_summary&&typeof body.assistance_summary==='object'&&!Array.isArray(body.assistance_summary))?body.assistance_summary:{};
    const narrative=text(body.narrative,8000),modelInvocation=id(body.model_invocation_id)||'',narrativeVersion=Math.max(1,int(body.narrative_version)||1);
    const supersedes=id(body.supersedes_review_id)||null,reviewId=generated('perf');
    if(supersedes){
      const prior=await env.TUTOR_DB.prepare('SELECT id FROM internship_performance_reviews WHERE id = ? AND internship_id = ? AND review_type = ? LIMIT 1')
        .bind(supersedes,internshipId,reviewType).first();
      if(!prior)return json({error:'superseded_review_not_found'},404);
    }
    await env.TUTOR_DB.prepare(
      "INSERT INTO internship_performance_reviews(id, internship_id, review_type, cutoff_at, evidence_snapshot_json, evidence_snapshot_hash, status, strengths_json, development_areas_json, priorities_json, assistance_summary_json, narrative, model_invocation_id, narrative_version, supersedes_review_id, request_id, created_at, finalized_at) VALUES (?, ?, ?, ?, ?, ?, 'finalized', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(reviewId,internshipId,reviewType,cutoff,canonical,actualHash,JSON.stringify(strengths),JSON.stringify(development),JSON.stringify(priorities),JSON.stringify(assistanceSummary),narrative,modelInvocation,narrativeVersion,supersedes,req,now,now).run();
    const created=await env.TUTOR_DB.prepare('SELECT * FROM internship_performance_reviews WHERE id = ?').bind(reviewId).first<Record<string,unknown>>();
    return json({ok:true,performance_review:created},201);
  }

  return null;
}
