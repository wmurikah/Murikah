type P7Statement = {
  bind(...values: unknown[]): P7Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
  run(): Promise<{ meta?: { changes?: number } }>;
};
type P7Database = {
  prepare(query: string): P7Statement;
  batch(statements: P7Statement[]): Promise<Array<{ meta?: { changes?: number } }>>;
};
type P7Env = { TUTOR_DB: P7Database };

const P7_ID=/^[A-Za-z0-9_-]{1,128}$/;
const EVIDENCE_RULESET='phase7-evidence-strength-v1';
const AGGREGATION_RULESET='phase7-passport-aggregation-v1';
const LEVELS=['emerging','developing','applied_with_support','independent','advanced'] as const;
const LEVEL_ORDER:Record<string,number>={emerging:0,developing:1,applied_with_support:2,independent:3,advanced:4};
const STRENGTH_ORDER:Record<string,number>={limited:0,supporting:1,strong:2};

function p7Json(payload:unknown,status=200):Response{
  return Response.json(payload,{status,headers:{'cache-control':'private, no-store','x-content-type-options':'nosniff'}});
}
async function p7Body(request:Request):Promise<Record<string,unknown>>{
  try{const value=await request.json();return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};}catch{return {};}
}
function p7Text(value:unknown,max=128):string{const out=String(value??'').trim();return out.length<=max?out:'';}
function p7Id(value:unknown):string{const out=p7Text(value,128);return P7_ID.test(out)?out:'';}
function p7Parse(value:unknown,fallback:unknown):any{try{return JSON.parse(String(value??''));}catch{return fallback;}}
function p7Generated(prefix:string):string{return prefix+'_'+crypto.randomUUID().replace(/-/g,'');}
function p7Array(value:unknown):unknown[]{return Array.isArray(value)?value:[];}

async function p7ActiveAccount(db:P7Database,actorId:string):Promise<boolean>{
  const row=await db.prepare("SELECT role, account_status FROM tutor_accounts WHERE actor_id = ? LIMIT 1")
    .bind(actorId).first<{role:string;account_status:string}>();
  return Boolean(row&&['member','admin'].includes(row.role)&&row.account_status==='active');
}
async function p7OwnedInternship(db:P7Database,actorId:string,internshipId:string){
  return db.prepare(
    'SELECT i.id, i.learner_id, i.scenario_version_id, v.scenario_pack_id '+
    'FROM internship_instances i JOIN scenario_versions v ON v.id=i.scenario_version_id '+
    'WHERE i.id=? AND i.learner_id=? LIMIT 1'
  ).bind(internshipId,actorId).first<Record<string,unknown>>();
}
function p7Candidate(ratingId:string,assistance:number):string{
  if(ratingId==='not_yet')return 'not_demonstrated';
  if(ratingId==='developing')return 'developing';
  if(ratingId==='meets'||ratingId==='exceeds')return assistance<=1?'independent':'applied_with_support';
  return '';
}
function p7ContextIdentity(value:any):string{
  const fields=['career_family','role_family','scenario_pack_id','task_category','domain','work_context'];
  return fields.map(key=>String(value?.[key]??'').trim()).join('|');
}
function p7LevelAtLeast(actual:string,required:string):boolean{
  if(actual==='not_demonstrated')return false;
  return actual in LEVEL_ORDER&&required in LEVEL_ORDER&&LEVEL_ORDER[actual]>=LEVEL_ORDER[required];
}
function p7Trend(rows:Record<string,unknown>[]):string{
  if(rows.length<3)return 'insufficient_evidence';
  const ordered=[...rows].sort((a,b)=>(Number(a.created_at||0)-Number(b.created_at||0))||String(a.id||'').localeCompare(String(b.id||'')));
  const values=ordered.map(row=>String(row.demonstrated_level||'')==='not_demonstrated'?-1:(LEVEL_ORDER[String(row.demonstrated_level||'')]??-1));
  const deltas=values.slice(1).map((value,index)=>value-values[index]);
  if(deltas.every(x=>x===0))return 'stable';
  if(deltas.every(x=>x>=0)&&deltas.some(x=>x>0))return 'improving';
  return 'mixed';
}
function p7QualifyingRows(rules:Record<string,unknown>,rows:Record<string,unknown>[]):Record<string,unknown>[]{
  const required=String(rules.min_candidate||'developing');
  return rows.filter(row=>p7LevelAtLeast(String(row.demonstrated_level||''),required));
}
function p7RecencyEligible(definition:Record<string,unknown>,historical:Record<string,unknown>[],now:number){
  const policy=p7Parse(definition.recency_policy_json,{}) as Record<string,unknown>;
  const expiry=Number(policy.expires_after_days||0);
  if(!Number.isFinite(expiry)||expiry<=0)return {rows:historical,expired:0};
  const cutoff=now-(expiry*86400);
  const rows=historical.filter(row=>Number(row.created_at||0)>=cutoff);
  return {rows,expired:historical.length-rows.length};
}
function p7RequirementMet(level:string,rules:Record<string,unknown>,rows:Record<string,unknown>[]):boolean{
  const qualifying=p7QualifyingRows(rules,rows);
  if(qualifying.length<Number(rules.min_records||1))return false;
  const independent=qualifying.filter(row=>row.demonstrated_level==='independent').length;
  if(independent<Number(rules.min_independent||0))return false;
  const taskContexts=new Set(qualifying.map(row=>String(row.internship_id||'')+':'+String(row.task_id||'')));
  if(taskContexts.size<Number(rules.min_task_contexts||0))return false;
  const contexts=new Set(qualifying.map(row=>p7ContextIdentity(p7Parse(row.transfer_context_json,{}))).filter(value=>value.replace(/\|/g,'').length>0));
  if(contexts.size<Number(rules.min_transfer_contexts||0))return false;
  return true;
}
function p7Aggregate(definition:Record<string,unknown>,historicalRows:Record<string,unknown>[],now:number):Record<string,unknown>|null{
  if(!historicalRows.length)return null;
  const recency=p7RecencyEligible(definition,historicalRows,now);
  const rows=recency.rows;
  if(!rows.length)return null;
  const positive=rows.filter(row=>String(row.demonstrated_level||'')!=='not_demonstrated');
  if(!positive.length)return null;
  const requirements=p7Parse(definition.evidence_requirements_json,{}) as Record<string,Record<string,unknown>>;
  let current='emerging';
  for(const level of LEVELS){
    const rules=requirements[level];
    if(rules&&p7RequirementMet(level,rules,rows))current=level;
  }
  const conflict=p7Parse(definition.recency_policy_json,{}) as Record<string,unknown>;
  const window=Math.max(1,Number(conflict.conflict_window||2));
  const recent=[...rows].sort((a,b)=>(Number(a.created_at||0)-Number(b.created_at||0))||String(a.id||'').localeCompare(String(b.id||''))).slice(-window);
  const strongNegative=recent.filter(row=>row.evidence_strength==='strong'&&row.demonstrated_level==='not_demonstrated');
  if(strongNegative.length>=2&&LEVEL_ORDER[current]>LEVEL_ORDER.emerging)current=String(conflict.two_strong_not_demonstrated_cap||'emerging');
  else if(strongNegative.length&&LEVEL_ORDER[current]>LEVEL_ORDER.developing)current=String(conflict.latest_strong_not_demonstrated_cap||'developing');
  if(!(current in LEVEL_ORDER))current='emerging';

  const independent=rows.filter(row=>row.demonstrated_level==='independent').length;
  const assisted=rows.filter(row=>['developing','applied_with_support'].includes(String(row.demonstrated_level||''))).length;
  const tasks=new Set(rows.map(row=>String(row.internship_id||'')+':'+String(row.task_id||'')));
  const contexts=new Set(rows.map(row=>p7ContextIdentity(p7Parse(row.transfer_context_json,{}))).filter(value=>value.replace(/\|/g,'').length>0));
  const internships=new Set(rows.map(row=>String(row.internship_id||'')).filter(Boolean));
  let strength='limited';
  for(const row of positive)if((STRENGTH_ORDER[String(row.evidence_strength||'')]??0)>STRENGTH_ORDER[strength])strength=String(row.evidence_strength);
  const last=Math.max(...positive.map(row=>Number(row.created_at||0)));
  const strengthDistribution:Record<string,number>={limited:0,supporting:0,strong:0};
  for(const row of rows){
    const value=String(row.evidence_strength||'');
    if(value in strengthDistribution)strengthDistribution[value]+=1;
  }

  const nextIndex=LEVEL_ORDER[current]+1;
  const nextLevel=LEVELS[nextIndex]||null;
  const missing:Array<Record<string,unknown>>=[];
  if(nextLevel&&requirements[nextLevel]){
    const r=requirements[nextLevel];
    const qualifying=p7QualifyingRows(r,rows);
    const qualifyingIndependent=qualifying.filter(row=>row.demonstrated_level==='independent').length;
    const qualifyingTasks=new Set(qualifying.map(row=>String(row.internship_id||'')+':'+String(row.task_id||'')));
    const qualifyingContexts=new Set(qualifying.map(row=>p7ContextIdentity(p7Parse(row.transfer_context_json,{}))).filter(value=>value.replace(/\|/g,'').length>0));
    const minRecords=Math.max(0,Number(r.min_records||0)-qualifying.length);
    const minIndependent=Math.max(0,Number(r.min_independent||0)-qualifyingIndependent);
    const minTasks=Math.max(0,Number(r.min_task_contexts||0)-qualifyingTasks.size);
    const minContexts=Math.max(0,Number(r.min_transfer_contexts||0)-qualifyingContexts.size);
    if(minRecords)missing.push({kind:'evidence_records',count:minRecords});
    if(minIndependent)missing.push({kind:'independent_demonstrations',count:minIndependent});
    if(minTasks)missing.push({kind:'distinct_task_contexts',count:minTasks});
    if(minContexts)missing.push({kind:'distinct_transfer_contexts',count:minContexts});
  }
  return {
    current_level:current,evidence_strength_summary:strength,evidence_count:rows.length,
    independent_count:independent,assisted_count:assisted,distinct_task_count:tasks.size,
    distinct_context_count:contexts.size,distinct_internship_count:internships.size,
    trend:p7Trend(rows),last_demonstrated_at:last,
    explanation:{
      qualifying_evidence_records:rows.length,historical_evidence_records:historicalRows.length,
      expired_evidence_records:recency.expired,independent_demonstrations:independent,
      assisted_demonstrations:assisted,distinct_task_contexts:tasks.size,
      distinct_transfer_contexts:contexts.size,strongest_evidence_strength:strength,
      evidence_strength_distribution:strengthDistribution,
      contradictory_records:rows.filter(row=>row.demonstrated_level==='not_demonstrated').length,
    },
    next_requirements:missing,aggregation_ruleset_version:AGGREGATION_RULESET,
  };
}
async function p7EvidenceRows(db:P7Database,actorId:string):Promise<Record<string,unknown>[]>{
  const result=await db.prepare(
    "SELECT e.* FROM competency_evidence e WHERE e.learner_id=? AND NOT EXISTS ("+
    "SELECT 1 FROM competency_evidence_adjustments a WHERE a.evidence_id=e.id AND a.action IN ('revoked','superseded')) "+
    "ORDER BY e.created_at ASC,e.id ASC"
  ).bind(actorId).all<Record<string,unknown>>();
  return result.results||[];
}
function p7Key(competencyId:string,definitionVersion:number):string{
  return competencyId+':'+String(definitionVersion);
}
async function p7RefreshPassport(
  db:P7Database,actorId:string,targetKeys:Set<string>,now:number,
):Promise<number>{
  if(!targetKeys.size)return 0;
  const definitions=(await db.prepare(
    "SELECT * FROM competency_definitions WHERE status='active' ORDER BY competency_id,definition_version"
  ).all<Record<string,unknown>>()).results||[];
  const compatibility=(await db.prepare(
    "SELECT competency_id,from_version,to_version,compatibility FROM competency_definition_compatibility WHERE compatibility='compatible'"
  ).all<Record<string,unknown>>()).results||[];
  const allEvidence=await p7EvidenceRows(db,actorId);
  let written=0;
  for(const definition of definitions){
    const cid=String(definition.competency_id||''),version=Number(definition.definition_version||0);
    const key=p7Key(cid,version);
    const compatibleFrom=compatibility.filter(row=>
      String(row.competency_id||'')===cid&&Number(row.to_version||0)===version
    );
    const shouldRefresh=targetKeys.has(key)||compatibleFrom.some(row=>
      targetKeys.has(p7Key(cid,Number(row.from_version||0)))
    );
    if(!shouldRefresh)continue;
    const compatibleVersions=new Set<number>([version]);
    for(const row of compatibleFrom)compatibleVersions.add(Number(row.from_version||0));
    const rows=allEvidence.filter(row=>
      String(row.competency_id||'')===cid&&compatibleVersions.has(Number(row.definition_version||0))
    );
    const aggregate=p7Aggregate(definition,rows,now);
    const previous=await db.prepare(
      'SELECT current_level FROM competency_passports WHERE learner_id=? AND competency_id=? AND definition_version=? LIMIT 1'
    ).bind(actorId,cid,version).first<Record<string,unknown>>();
    if(!aggregate){
      if(previous){
        await db.prepare(
          'DELETE FROM competency_passports WHERE learner_id=? AND competency_id=? AND definition_version=?'
        ).bind(actorId,cid,version).run();
      }
      continue;
    }
    await db.prepare(
      'INSERT INTO competency_passports(learner_id,competency_id,definition_version,current_level,evidence_strength_summary,evidence_count,independent_count,assisted_count,distinct_task_count,distinct_context_count,distinct_internship_count,trend,last_demonstrated_at,explanation_json,next_requirements_json,aggregation_ruleset_version,calculated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) '+
      'ON CONFLICT(learner_id,competency_id,definition_version) DO UPDATE SET current_level=excluded.current_level,evidence_strength_summary=excluded.evidence_strength_summary,evidence_count=excluded.evidence_count,independent_count=excluded.independent_count,assisted_count=excluded.assisted_count,distinct_task_count=excluded.distinct_task_count,distinct_context_count=excluded.distinct_context_count,distinct_internship_count=excluded.distinct_internship_count,trend=excluded.trend,last_demonstrated_at=excluded.last_demonstrated_at,explanation_json=excluded.explanation_json,next_requirements_json=excluded.next_requirements_json,aggregation_ruleset_version=excluded.aggregation_ruleset_version,calculated_at=excluded.calculated_at'
    ).bind(
      actorId,cid,version,aggregate.current_level,aggregate.evidence_strength_summary,aggregate.evidence_count,
      aggregate.independent_count,aggregate.assisted_count,aggregate.distinct_task_count,aggregate.distinct_context_count,
      aggregate.distinct_internship_count,aggregate.trend,aggregate.last_demonstrated_at,
      JSON.stringify(aggregate.explanation),JSON.stringify(aggregate.next_requirements),AGGREGATION_RULESET,now
    ).run();
    const prior=String(previous?.current_level||'');
    if(prior!==String(aggregate.current_level)){
      await db.prepare(
        'INSERT INTO competency_passport_history(id,learner_id,competency_id,definition_version,previous_level,new_level,aggregation_ruleset_version,explanation_json,changed_at) VALUES (?,?,?,?,?,?,?,?,?)'
      ).bind(p7Generated('cph'),actorId,cid,version,prior||null,aggregate.current_level,AGGREGATION_RULESET,JSON.stringify(aggregate.explanation),now).run();
    }
    written+=1;
  }
  return written;
}
async function p7Rebuild(db:P7Database,actorId:string,now:number):Promise<number>{
  const definitions=(await db.prepare(
    "SELECT competency_id,definition_version FROM competency_definitions WHERE status='active' ORDER BY competency_id,definition_version"
  ).all<Record<string,unknown>>()).results||[];
  const keys=new Set(definitions.map(row=>p7Key(String(row.competency_id||''),Number(row.definition_version||0))));
  const written=await p7RefreshPassport(db,actorId,keys,now);
  await db.prepare(
    "DELETE FROM competency_passports WHERE learner_id=? AND NOT EXISTS ("+
    "SELECT 1 FROM competency_definitions d WHERE d.competency_id=competency_passports.competency_id "+
    "AND d.definition_version=competency_passports.definition_version AND d.status='active')"
  ).bind(actorId).run();
  return written;
}
async function p7DeriveAssessment(db:P7Database,actorId:string,assessment:Record<string,unknown>,now:number):Promise<number>{
  const assessmentId=String(assessment.id||''),internshipId=String(assessment.internship_id||'');
  const existing=await db.prepare(
    "SELECT status,derived_count,evidence_ruleset_version FROM competency_derivation_status WHERE assessment_id=? AND learner_id=? LIMIT 1"
  ).bind(assessmentId,actorId).first<Record<string,unknown>>();
  if(
    String(existing?.evidence_ruleset_version||'')===EVIDENCE_RULESET&&
    (existing?.status==='completed'||existing?.status==='excluded')
  )return Number(existing.derived_count||0);
  await db.prepare(
    "INSERT INTO competency_derivation_status(assessment_id,learner_id,status,evidence_ruleset_version,derived_count,last_error,updated_at) VALUES (?,?,'pending',?,0,'',?) "+
    "ON CONFLICT(assessment_id) DO UPDATE SET status='pending',evidence_ruleset_version=excluded.evidence_ruleset_version,last_error='',updated_at=excluded.updated_at"
  ).bind(assessmentId,actorId,EVIDENCE_RULESET,now).run();

  const submission=await db.prepare(
    'SELECT s.submitted_at,s.submission_number,v.version_number FROM internship_artifact_submissions s '+
    'JOIN internship_artifact_versions v ON v.id=s.artifact_version_id AND v.artifact_id=s.artifact_id '+
    'WHERE s.id=? AND s.internship_id=? AND s.artifact_id=? AND s.artifact_version_id=? LIMIT 1'
  ).bind(assessment.submission_id,internshipId,assessment.artifact_id,assessment.artifact_version_id).first<Record<string,unknown>>();
  if(!submission){
    await db.prepare("UPDATE competency_derivation_status SET status='failed',last_error='broken_submission_lineage',updated_at=? WHERE assessment_id=?")
      .bind(now,assessmentId).run();
    return 0;
  }
  const criterionRows=(await db.prepare(
    'SELECT * FROM internship_assessment_criteria WHERE assessment_id=? ORDER BY criterion_id'
  ).bind(assessmentId).all<Record<string,unknown>>()).results||[];
  let derived=0;
  for(const criterion of criterionRows){
    if(String(criterion.result_state||'')!=='assessed')continue;
    const refs=p7Parse(criterion.evidence_refs_json,[]);
    if(!Array.isArray(refs)||!refs.length)continue;
    const lineageValid=refs.every((raw:any)=>raw&&typeof raw==='object'&&
      String(raw.artifact_id||'')===String(assessment.artifact_id||'')&&
      String(raw.artifact_version_id||'')===String(assessment.artifact_version_id||'')&&
      String(raw.submission_id||'')===String(assessment.submission_id||''));
    if(!lineageValid)continue;
    const mappings=(await db.prepare(
      'SELECT m.*,d.context_metadata_json FROM competency_assessment_mappings m '+
      'JOIN competency_definitions d ON d.competency_id=m.competency_id AND d.definition_version=m.definition_version '+
      'WHERE m.scenario_version_id=? AND m.task_id=? AND m.rubric_id=? AND m.criterion_id=? ORDER BY m.mapping_version DESC'
    ).bind(assessment.scenario_version_id,assessment.task_id,assessment.rubric_id,criterion.criterion_id).all<Record<string,unknown>>()).results||[];
    if(!mappings.length)continue;

    const assistance=(await db.prepare(
      "SELECT source,provenance,assistance_level,category,event_time FROM internship_assistance_events "+
      "WHERE internship_id=? AND event_time<=? AND (task_id='' OR task_id=?) "+
      "AND (artifact_id='' OR artifact_id=?) AND (artifact_version_id='' OR artifact_version_id=?) "+
      "ORDER BY event_time ASC,id ASC"
    ).bind(internshipId,submission.submitted_at,assessment.task_id,assessment.artifact_id,assessment.artifact_version_id).all<Record<string,unknown>>()).results||[];
    const maxAssistance=assistance.length?Math.max(...assistance.map(row=>Number(row.assistance_level||0))):0;
    const observed=assistance.filter(row=>row.provenance==='system_observed').length;
    const declared=assistance.filter(row=>row.provenance==='learner_declared').length;
    const candidate=p7Candidate(String(criterion.rating_id||''),maxAssistance);
    if(!candidate)continue;
    const specific=refs.every((raw:any)=>raw&&typeof raw.locator==='object');
    for(const mapping of mappings){
      const contextMetadata=p7Parse(mapping.context_metadata_json,{}) as Record<string,unknown>;
      const physical=Boolean(contextMetadata.physical);
      const strength=!specific?'limited':(maxAssistance<=1&&!physical?'strong':'supporting');
      const limitations=[
        String(criterion.limitation||''),
        ...p7Array(p7Parse(assessment.limitations_json,[])).map(String),
      ].filter(Boolean);
      if(physical)limitations.push('Virtual Internship simulation evidence does not fully verify physical or manual competence.');
      const definitionVersion=Number(mapping.definition_version||0);
      if(!p7Id(mapping.competency_id)||definitionVersion<1)continue;
      const evidenceId=p7Generated('ce');
      try{
        await db.prepare(
          'INSERT INTO competency_evidence(id,learner_id,competency_id,definition_version,sub_competency_id,internship_id,scenario_pack_id,scenario_version_id,task_id,artifact_id,artifact_version_id,submission_id,assessment_id,criterion_id,mapping_version,criterion_rating_id,criterion_numeric,demonstrated_level,assistance_level,assistance_context_json,revision_context_json,evidence_strength,strength_factors_json,transfer_context_json,limitations_json,source_type,evidence_ruleset_version,created_at) '+
          "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'virtual_internship',?,?)"
        ).bind(
          evidenceId,actorId,mapping.competency_id,definitionVersion,String(mapping.sub_competency_id||''),
          internshipId,assessment.scenario_pack_id,assessment.scenario_version_id,assessment.task_id,
          assessment.artifact_id,assessment.artifact_version_id,assessment.submission_id,assessmentId,criterion.criterion_id,
          Number(mapping.mapping_version||0),criterion.rating_id,criterion.numeric_value,candidate,maxAssistance,
          JSON.stringify({maximum_level:maxAssistance,recorded_event_count:assistance.length,system_observed_count:observed,learner_declared_count:declared,
            label:maxAssistance===0?'Independent demonstration':maxAssistance===1?'Clarification only':maxAssistance===2?'Light coaching used':maxAssistance===3?'Moderate coaching used':maxAssistance===4?'Substantial coaching used':'Solution-level assistance used'}),
          JSON.stringify({artifact_version_number:Number(submission.version_number||0),submission_number:Number(submission.submission_number||0),
            revision_count:Math.max(0,Number(submission.version_number||1)-1)}),
          strength,JSON.stringify({formal_assessment_completed:true,exact_lineage_valid:true,specific_evidence_references:specific,low_assistance_context:maxAssistance<=1,physical_simulation_limitation:physical,source_type:'virtual_internship'}),
          String(mapping.context_tags_json||'{}'),
          JSON.stringify(limitations),
          EVIDENCE_RULESET,Number(assessment.completed_at||now)
        ).run();
        derived+=1;
      }catch(error){
        const message=String(error);
        if(!message.toLowerCase().includes('unique'))throw error;
      }
    }
  }
  const count=await db.prepare('SELECT COUNT(*) AS n FROM competency_evidence WHERE assessment_id=? AND learner_id=?')
    .bind(assessmentId,actorId).first<{n:number}>();
  const durableCount=Number(count?.n||0);
  await db.prepare(
    "UPDATE competency_derivation_status SET status=?,derived_count=?,last_error='',updated_at=? WHERE assessment_id=?"
  ).bind(durableCount>0?'completed':'excluded',durableCount,now,assessmentId).run();
  return durableCount;
}
async function p7Reconcile(db:P7Database,actorId:string,now:number):Promise<{assessments:number;evidence:number;passports:number}>{
  const rows=(await db.prepare(
    "SELECT a.*,i.scenario_version_id,v.scenario_pack_id FROM internship_assessments a "+
    "JOIN internship_instances i ON i.id=a.internship_id JOIN scenario_versions v ON v.id=i.scenario_version_id "+
    "LEFT JOIN competency_derivation_status ds ON ds.assessment_id=a.id AND ds.learner_id=i.learner_id "+
    "WHERE i.learner_id=? AND a.status='completed' AND ("+
    "ds.assessment_id IS NULL OR ds.status IN ('pending','failed') OR ds.evidence_ruleset_version<>?) "+
    "ORDER BY a.completed_at ASC,a.id ASC"
  ).bind(actorId,EVIDENCE_RULESET).all<Record<string,unknown>>()).results||[];
  let evidence=0;
  const affected=new Set<string>();
  for(const row of rows){
    evidence+=await p7DeriveAssessment(db,actorId,row,now);
    const keys=(await db.prepare(
      'SELECT DISTINCT competency_id,definition_version FROM competency_evidence WHERE assessment_id=? AND learner_id=?'
    ).bind(row.id,actorId).all<Record<string,unknown>>()).results||[];
    for(const key of keys)affected.add(p7Key(String(key.competency_id||''),Number(key.definition_version||0)));
  }
  const recencyDefinitions=(await db.prepare(
    "SELECT competency_id,definition_version,recency_policy_json FROM competency_definitions WHERE status='active'"
  ).all<Record<string,unknown>>()).results||[];
  for(const definition of recencyDefinitions){
    const policy=p7Parse(definition.recency_policy_json,{}) as Record<string,unknown>;
    if(Number(policy.expires_after_days||0)>0){
      affected.add(p7Key(String(definition.competency_id||''),Number(definition.definition_version||0)));
    }
  }
  const passports=await p7RefreshPassport(db,actorId,affected,now);
  return {assessments:rows.length,evidence,passports};
}
async function p7Summary(db:P7Database,actorId:string){
  const passports=(await db.prepare(
    'SELECT p.*,d.name,d.description,d.domain,d.level_framework_version,d.evidence_requirements_json,d.transfer_policy_json,d.recency_policy_json '+
    'FROM competency_passports p JOIN competency_definitions d ON d.competency_id=p.competency_id AND d.definition_version=p.definition_version '+
    'WHERE p.learner_id=? ORDER BY d.domain,d.name'
  ).bind(actorId).all<Record<string,unknown>>()).results||[];
  const definitions=(await db.prepare(
    "SELECT competency_id,definition_version,name,description,domain,parent_competency_id,level_framework_version,evidence_requirements_json,transfer_policy_json,recency_policy_json,context_metadata_json,status "+
    "FROM competency_definitions WHERE status='active' ORDER BY domain,name"
  ).all<Record<string,unknown>>()).results||[];
  const framework=await db.prepare(
    "SELECT levels_json FROM competency_level_frameworks WHERE version='phase7-levels-v1' LIMIT 1"
  ).first<Record<string,unknown>>();
  return {
    aggregation_ruleset_version:AGGREGATION_RULESET,
    evidence_ruleset_version:EVIDENCE_RULESET,
    level_framework:p7Parse(framework?.levels_json,[]),
    competencies:passports.map(row=>({
      competency_id:row.competency_id,definition_version:row.definition_version,name:row.name,
      description:row.description,domain:row.domain,level_framework_version:row.level_framework_version,
      current_level:row.current_level,evidence_strength_summary:row.evidence_strength_summary,
      evidence_count:row.evidence_count,independent_count:row.independent_count,assisted_count:row.assisted_count,
      distinct_task_count:row.distinct_task_count,distinct_context_count:row.distinct_context_count,
      distinct_internship_count:row.distinct_internship_count,trend:row.trend,last_demonstrated_at:row.last_demonstrated_at,
      explanation:p7Parse(row.explanation_json,{}),next_requirements:p7Parse(row.next_requirements_json,[]),
      aggregation_ruleset_version:row.aggregation_ruleset_version,
    })),
    definitions:definitions.map(row=>({
      competency_id:row.competency_id,definition_version:row.definition_version,name:row.name,
      description:row.description,domain:row.domain,parent_competency_id:row.parent_competency_id,
      level_framework_version:row.level_framework_version,
      evidence_requirements:p7Parse(row.evidence_requirements_json,{}),
      context_metadata:p7Parse(row.context_metadata_json,{}),
    })),
  };
}
async function p7Evidence(db:P7Database,actorId:string,competencyId:string){
  const query=
    'SELECT e.*,a.completed_at,ar.title AS artifact_title,ar.deliverable_type,sp.title AS scenario_title '+
    'FROM competency_evidence e JOIN internship_assessments a ON a.id=e.assessment_id '+
    'JOIN internship_artifacts ar ON ar.id=e.artifact_id JOIN scenario_packs sp ON sp.id=e.scenario_pack_id '+
    'WHERE e.learner_id=? '+(competencyId?'AND e.competency_id=? ':'')+
    'ORDER BY e.created_at DESC,e.id DESC';
  const statement=db.prepare(query);
  const rows=(competencyId?await statement.bind(actorId,competencyId).all<Record<string,unknown>>():await statement.bind(actorId).all<Record<string,unknown>>()).results||[];
  const adjustments=(await db.prepare(
    'SELECT a.* FROM competency_evidence_adjustments a JOIN competency_evidence e ON e.id=a.evidence_id WHERE e.learner_id=? ORDER BY a.created_at'
  ).bind(actorId).all<Record<string,unknown>>()).results||[];
  return rows.map(row=>({
    id:row.id,competency_id:row.competency_id,definition_version:row.definition_version,
    sub_competency_id:row.sub_competency_id,internship_id:row.internship_id,
    scenario_pack_id:row.scenario_pack_id,scenario_version_id:row.scenario_version_id,
    scenario_title:row.scenario_title,task_id:row.task_id,artifact_id:row.artifact_id,
    artifact_title:row.artifact_title,artifact_type:row.deliverable_type,artifact_version_id:row.artifact_version_id,
    submission_id:row.submission_id,assessment_id:row.assessment_id,criterion_id:row.criterion_id,
    mapping_version:row.mapping_version,criterion_rating_id:row.criterion_rating_id,criterion_numeric:row.criterion_numeric,
    demonstrated_level:row.demonstrated_level,evidence_strength:row.evidence_strength,
    assistance_level:row.assistance_level,assistance_context:p7Parse(row.assistance_context_json,{}),
    revision_context:p7Parse(row.revision_context_json,{}),strength_factors:p7Parse(row.strength_factors_json,{}),
    transfer_context:p7Parse(row.transfer_context_json,{}),limitations:p7Parse(row.limitations_json,[]),
    source_type:row.source_type,evidence_ruleset_version:row.evidence_ruleset_version,
    created_at:row.created_at,assessment_date:row.completed_at,
    adjustments:adjustments.filter(a=>a.evidence_id===row.id).map(a=>({action:a.action,reason:a.reason,created_at:a.created_at})),
  }));
}

export async function handlePhase7PassportPersistenceRoute(
  request:Request,env:P7Env,route:string,now:number,
):Promise<Response|null>{
  if(!route.startsWith('/internships/passport'))return null;
  const url=new URL(request.url);
  const body=request.method==='GET'?{}:await p7Body(request);
  const actorId=p7Id(request.method==='GET'?url.searchParams.get('actor_id'):body.actor_id);
  if(!actorId||!await p7ActiveAccount(env.TUTOR_DB,actorId))return p7Json({error:'authentication_required'},401);

  if(route==='/internships/passport/reconcile'&&request.method==='POST'){
    const internshipId=p7Id(body.internship_id)||'';
    if(internshipId&&!await p7OwnedInternship(env.TUTOR_DB,actorId,internshipId))return p7Json({error:'internship_not_found'},404);
    try{return p7Json({ok:true,...await p7Reconcile(env.TUTOR_DB,actorId,now)});}
    catch(error){
      console.error('Phase 7 passport reconciliation failed',error);
      return p7Json({error:'passport_reconciliation_failed'},503);
    }
  }
  if(route==='/internships/passport/rebuild'&&request.method==='POST'){
    try{
      const reconciled=await p7Reconcile(env.TUTOR_DB,actorId,now);
      const rebuilt=await p7Rebuild(env.TUTOR_DB,actorId,now);
      return p7Json({ok:true,rebuild:true,...reconciled,passports:rebuilt});
    }catch(error){
      console.error('Phase 7 passport rebuild failed',error);
      return p7Json({error:'passport_rebuild_failed'},503);
    }
  }
  if(route==='/internships/passport/summary'&&request.method==='GET'){
    try{return p7Json({ok:true,...await p7Summary(env.TUTOR_DB,actorId)});}
    catch(error){console.error('Phase 7 passport summary failed',error);return p7Json({error:'passport_unavailable'},503);}
  }
  if(route==='/internships/passport/evidence'&&request.method==='GET'){
    const competencyId=p7Id(url.searchParams.get('competency_id'))||'';
    try{return p7Json({ok:true,evidence:await p7Evidence(env.TUTOR_DB,actorId,competencyId)});}
    catch(error){console.error('Phase 7 evidence read failed',error);return p7Json({error:'passport_evidence_unavailable'},503);}
  }
  if(route==='/internships/passport/export-source'&&request.method==='GET'){
    try{
      const summary=await p7Summary(env.TUTOR_DB,actorId);
      const evidence=await p7Evidence(env.TUTOR_DB,actorId,'');
      return p7Json({ok:true,...summary,evidence});
    }catch(error){console.error('Phase 7 export source failed',error);return p7Json({error:'passport_export_unavailable'},503);}
  }
  return null;
}
