import { useEffect, useMemo, useState } from 'react';
import { useSandbox } from '@/sandbox/store';
import { can, missingPermission } from '@/sandbox/permissions';
import { daysBetween, formatDate } from '@/sandbox/date';
import type { Finding, FindingStatus, RiskRating } from '@/sandbox/types';
import { Badge, Button, Drawer, EmptyState, Panel, RatingBadge, TooltipLock } from '../Ui';
import AiAssistant from '../AiAssistant';
import { Icon } from '../Icon';

type SortKey='id'|'rating'|'due'|'status';
const allColumns=['id','title','engagement','process','rating','owner','due','status'] as const;
type Column=(typeof allColumns)[number];

export default function FindingsScreen(){
  const {state,dispatch}=useSandbox();
  const [query,setQuery]=useState('');
  const [rating,setRating]=useState('');
  const [status,setStatus]=useState('');
  const [owner,setOwner]=useState('');
  const [engagement,setEngagement]=useState('');
  const [overdue,setOverdue]=useState(false);
  const [sort,setSort]=useState<SortKey>('id');
  const [sortDesc,setSortDesc]=useState(true);
  const [columns,setColumns]=useState<Column[]>([...allColumns]);
  const [columnsOpen,setColumnsOpen]=useState(false);
  const [selected,setSelected]=useState<string[]>([]);
  const [createOpen,setCreateOpen]=useState(false);
  const [viewName,setViewName]=useState('');
  const [aiOpen,setAiOpen]=useState(false);
  const [focusIndex,setFocusIndex]=useState(0);
  const canEdit=can(state,'finding.edit');
  const canCreate=can(state,'finding.create');

  const rows=useMemo(()=>{
    const q=query.trim().toLowerCase();
    let list=state.findings.filter(f=>{
      if(q && !(f.id+' '+f.observationTitle+' '+f.process).toLowerCase().includes(q)) return false;
      if(rating && f.riskRating!==rating) return false;
      if(status && f.status!==status) return false;
      if(owner && f.ownerId!==owner) return false;
      if(engagement && f.engagementId!==engagement) return false;
      if(overdue && daysBetween(f.dueDate)>=0) return false;
      if(state.activeRoleCode==='UNIT_MANAGER' && f.ownerId!==state.activeUserId) return false;
      return true;
    });
    const rank:Record<string,number>={Critical:4,High:3,Medium:2,Low:1};
    list=[...list].sort((a,b)=>{
      let result=0;
      if(sort==='id') result=a.id.localeCompare(b.id);
      if(sort==='rating') result=(rank[a.riskRating]??0)-(rank[b.riskRating]??0);
      if(sort==='due') result=a.dueDate.localeCompare(b.dueDate);
      if(sort==='status') result=a.status.localeCompare(b.status);
      return sortDesc?-result:result;
    });
    return list;
  },[state,query,rating,status,owner,engagement,overdue,sort,sortDesc]);

  useEffect(()=>{
    const handler=(event:KeyboardEvent)=>{
      const tag=(event.target as HTMLElement)?.tagName;
      if(['INPUT','SELECT','TEXTAREA'].includes(tag)) return;
      if(event.key==='j'||event.key==='J'){event.preventDefault();setFocusIndex(i=>Math.min(rows.length-1,i+1));}
      if(event.key==='k'||event.key==='K'){event.preventDefault();setFocusIndex(i=>Math.max(0,i-1));}
      if(event.key==='Enter'&&rows[focusIndex]){event.preventDefault();dispatch({type:'SELECT_FINDING',findingId:rows[focusIndex].id});}
    };
    window.addEventListener('keydown',handler);
    return()=>window.removeEventListener('keydown',handler);
  },[rows,focusIndex,dispatch]);

  const active=state.findings.find(f=>f.id===state.selectedFindingId) ?? null;
  const activeWp=active?state.workPapers.find(w=>w.workPaperId===active.workPaperId):null;
  const activeActions=active?state.actionPlans.filter(a=>a.findingId===active.id):[];
  const ownerUsers=state.users.filter(u=>u.roleCode==='UNIT_MANAGER');

  const toggleColumn=(col:Column)=>setColumns(current=>current.includes(col)?current.filter(x=>x!==col):[...current,col]);
  const sortBy=(key:SortKey)=>{if(sort===key)setSortDesc(v=>!v);else{setSort(key);setSortDesc(false);}};
  const visible=(col:Column)=>columns.includes(col);

  const bulkStatus=(next:FindingStatus)=>{
    selected.forEach(id=>dispatch({type:'UPDATE_FINDING',findingId:id,patch:{status:next},reason:'Bulk finding status update'}));
    setSelected([]);
  };

  const filters={rating,status,owner,engagement,overdue:overdue?'1':''};

  return <div className="sb-screen" data-tour="findings">
    <div className="sb-page-head">
      <div><h1>Findings</h1><p>Evidence-based observations, management responses and remediation linkage.</p></div>
      <TooltipLock label={canCreate?'Create a finding':missingPermission('finding.create')}>
        <Button icon="plus" variant="primary" disabled={!canCreate} onClick={()=>setCreateOpen(true)}>Create finding</Button>
      </TooltipLock>
    </div>

    <Panel>
      <div className="sb-toolbar">
        <label className="sb-search"><Icon name="search"/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search findings…"/><span>{rows.length}</span></label>
        <select value={rating} onChange={e=>setRating(e.target.value)} aria-label="Filter by rating"><option value="">All ratings</option>{['Critical','High','Medium','Low'].map(v=><option key={v}>{v}</option>)}</select>
        <select value={status} onChange={e=>setStatus(e.target.value)} aria-label="Filter by status"><option value="">All statuses</option>{['Draft','In review','Issued','Action in progress','Overdue','Closed'].map(v=><option key={v}>{v}</option>)}</select>
        <select value={owner} onChange={e=>setOwner(e.target.value)} aria-label="Filter by owner"><option value="">All owners</option>{ownerUsers.map(u=><option value={u.userId} key={u.userId}>{u.fullName}</option>)}</select>
        <select value={engagement} onChange={e=>setEngagement(e.target.value)} aria-label="Filter by engagement"><option value="">All engagements</option>{state.engagements.map(e=><option value={e.engagementId} key={e.engagementId}>{e.title}</option>)}</select>
        <label className="sb-check"><input type="checkbox" checked={overdue} onChange={e=>setOverdue(e.target.checked)}/> Overdue</label>
        <div className="sb-toolbar__spacer"/>
        <div className="sb-popover-wrap">
          <Button icon="columns" variant="quiet" onClick={()=>setColumnsOpen(v=>!v)}>Columns</Button>
          {columnsOpen&&<div className="sb-popover sb-columns">{allColumns.map(c=><label key={c}><input type="checkbox" checked={columns.includes(c)} onChange={()=>toggleColumn(c)}/><span>{c[0].toUpperCase()+c.slice(1)}</span></label>)}</div>}
        </div>
      </div>

      <div className="sb-saved-views">
        <span>Saved views</span>
        {state.savedFindingViews.map(view=><button key={view.id} onClick={()=>{
          const f=view.filters;
          setRating(f.rating?.includes(',')?'':f.rating??'');setStatus(f.status==='open'?'':f.status??'');setOwner(f.owner??'');setEngagement(f.engagement??'');setOverdue(f.overdue==='1');
        }}>{view.name}</button>)}
        <input value={viewName} onChange={e=>setViewName(e.target.value)} placeholder="New view name"/>
        <button disabled={!viewName.trim()} onClick={()=>{dispatch({type:'SAVE_FINDING_VIEW',name:viewName.trim(),filters});setViewName('');}}>Save view</button>
      </div>

      {selected.length>0&&<div className="sb-bulk"><strong>{selected.length} selected</strong><button onClick={()=>bulkStatus('In review')}>Send to review</button><button onClick={()=>bulkStatus('Closed')}>Mark closed</button><button onClick={()=>setSelected([])}>Clear</button></div>}

      {rows.length===0?<EmptyState title="No findings match" body="Clear one or more filters to see the seeded audit portfolio."/>:<div className="sb-table-wrap"><table className="sb-table sb-table--sticky">
        <thead><tr>
          <th className="sb-col-check"><span className="sb-visually-hidden">Select</span></th>
          {visible('id')&&<th><button onClick={()=>sortBy('id')}>ID</button></th>}
          {visible('title')&&<th>Finding</th>}
          {visible('engagement')&&<th>Engagement</th>}
          {visible('process')&&<th>Process</th>}
          {visible('rating')&&<th><button onClick={()=>sortBy('rating')}>Rating</button></th>}
          {visible('owner')&&<th>Owner</th>}
          {visible('due')&&<th><button onClick={()=>sortBy('due')}>Due</button></th>}
          {visible('status')&&<th><button onClick={()=>sortBy('status')}>Status</button></th>}
        </tr></thead>
        <tbody>{rows.map((f,index)=><tr key={f.id} className={index===focusIndex?'is-keyboard-active':''} onClick={()=>dispatch({type:'SELECT_FINDING',findingId:f.id})}>
          <td className="sb-col-check" onClick={e=>e.stopPropagation()}><input type="checkbox" checked={selected.includes(f.id)} onChange={e=>setSelected(current=>e.target.checked?[...current,f.id]:current.filter(id=>id!==f.id))} aria-label={'Select '+f.id}/></td>
          {visible('id')&&<td className="sb-mono">{f.id}</td>}
          {visible('title')&&<td><strong>{f.observationTitle}</strong><small>{f.observationDescription.slice(0,90)}…</small></td>}
          {visible('engagement')&&<td>{state.engagements.find(e=>e.engagementId===f.engagementId)?.title}</td>}
          {visible('process')&&<td>{f.process}</td>}
          {visible('rating')&&<td><RatingBadge rating={f.riskRating}/></td>}
          {visible('owner')&&<td>{state.users.find(u=>u.userId===f.ownerId)?.fullName}</td>}
          {visible('due')&&<td className={daysBetween(f.dueDate)<0&&f.status!=='Closed'?'sb-overdue':''}>{formatDate(f.dueDate)}</td>}
          {visible('status')&&<td><Badge tone={f.status==='Closed'?'success':f.status==='Overdue'?'warn':'neutral'}>{f.status}</Badge></td>}
        </tr>)}</tbody>
      </table></div>}
    </Panel>

    <Drawer open={!!active} title={active?active.id+' · '+active.observationTitle:'Finding'} onClose={()=>dispatch({type:'SELECT_FINDING',findingId:null})} wide>
      {active&&<div className="sb-finding-detail">
        <div className="sb-detail-meta"><RatingBadge rating={active.riskRating}/><Badge>{active.status}</Badge><span>{active.process}</span><span>Due {formatDate(active.dueDate)}</span></div>
        <section><h3>Condition</h3><p>{active.observationDescription}</p></section>
        <section><h3>Criteria</h3><p>{active.criteria}</p></section>
        <section><h3>Root cause</h3><p>{active.rootCause}</p></section>
        <section><h3>Risk / effect</h3><p>{active.riskSummary}</p></section>
        <section><h3>Recommendation</h3><p>{active.recommendation}</p></section>
        <section><h3>Management response</h3><p>{active.managementResponse||'No response recorded yet.'}</p></section>

        <div className="sb-grid sb-grid--2">
          <section><h3>Linked evidence</h3>{activeWp?.evidence.length?<ul className="sb-compact-list">{activeWp.evidence.map(e=><li key={e.attachmentId}><Icon name="file"/><span>{e.fileName}</span><small>{e.sizeKb} KB</small></li>)}</ul>:<p className="sb-muted">No evidence attached to this draft.</p>}</section>
          <section><h3>Linked actions</h3>{activeActions.length?<ul className="sb-compact-list">{activeActions.map(a=><li key={a.actionPlanId}><span><strong>{a.actionPlanRef}</strong>{a.actionDescription}</span><Badge>{a.status}</Badge></li>)}</ul>:<p className="sb-muted">No action plans linked yet.</p>}</section>
        </div>

        <section><h3>Activity timeline</h3><ol className="sb-timeline">{(active.activity??[]).map(item=><li key={item.id}><i/><div><strong>{item.label}</strong><small>{formatDate(item.createdAt)}</small></div></li>)}{activeActions.flatMap(a=>a.activity).slice(-5).map(item=><li key={item.id}><i/><div><strong>{item.label}</strong><small>{formatDate(item.createdAt)}</small></div></li>)}</ol></section>
        <div className="sb-detail-actions">
          <Button icon="sparkles" onClick={()=>setAiOpen(true)}>AI assistant</Button>
          <TooltipLock label={canEdit?'Edit finding status':missingPermission('finding.edit')}>
            <Button disabled={!canEdit} onClick={()=>dispatch({type:'UPDATE_FINDING',findingId:active.id,patch:{status:active.status==='Closed'?'Action in progress':'Closed'},reason:'Finding status changed from detail drawer'})}>{active.status==='Closed'?'Reopen':'Mark closed'}</Button>
          </TooltipLock>
        </div>
      </div>}
    </Drawer>

    <CreateFindingDrawer open={createOpen} onClose={()=>setCreateOpen(false)}/>
    {active&&<AiAssistant open={aiOpen} onClose={()=>setAiOpen(false)} entityType="finding" entityId={active.id}/>}
  </div>;
}

function CreateFindingDrawer({open,onClose}:{open:boolean;onClose:()=>void}){
  const {state,dispatch}=useSandbox();
  const d=state.findingDraft;
  const [error,setError]=useState('');
  const next=()=>{
    if(d.step===1&&(!d.condition.trim()||!d.criteria.trim())){setError('Condition and criteria are required.');return;}
    if(d.step===2&&(!d.cause.trim()||!d.effect.trim()||!d.riskRating)){setError('Cause, effect and rating are required.');return;}
    setError('');dispatch({type:'SET_FINDING_DRAFT',patch:{step:Math.min(3,d.step+1)}});
  };
  const create=()=>{
    if(!d.recommendation.trim()){setError('Recommendation is required.');return;}
    dispatch({type:'CREATE_FINDING_FROM_DRAFT'});setError('');onClose();
  };
  return <Drawer open={open} onClose={onClose} title="Create finding" wide>
    <div className="sb-stepper">{[1,2,3].map(n=><span key={n} className={d.step>=n?'is-active':''}><i>{n}</i>{n===1?'Condition':n===2?'Cause & risk':'Recommendation'}</span>)}</div>
    <p className="sb-muted">Draft autosaves to this browser as you type.</p>
    {error&&<p className="sb-error" role="alert">{error}</p>}
    <div className="sb-form">
      {d.step===1&&<>
        <label>Engagement<select value={d.engagementId} onChange={e=>dispatch({type:'SET_FINDING_DRAFT',patch:{engagementId:e.target.value}})}>{state.engagements.map(e=><option value={e.engagementId} key={e.engagementId}>{e.title}</option>)}</select></label>
        <label>Process<select value={d.process} onChange={e=>dispatch({type:'SET_FINDING_DRAFT',patch:{process:e.target.value}})}>{['ICT','Finance','Credit','Operations','Procurement','HR'].map(v=><option key={v}>{v}</option>)}</select></label>
        <label>Condition<textarea rows={6} value={d.condition} onChange={e=>dispatch({type:'SET_FINDING_DRAFT',patch:{condition:e.target.value}})} placeholder="State what was observed, the sample and the exception."/></label>
        <label>Criteria<textarea rows={4} value={d.criteria} onChange={e=>dispatch({type:'SET_FINDING_DRAFT',patch:{criteria:e.target.value}})} placeholder="Policy, IIA Standards, ISO/IEC 27001 Annex A…"/></label>
      </>}
      {d.step===2&&<>
        <label>Root cause<textarea rows={5} value={d.cause} onChange={e=>dispatch({type:'SET_FINDING_DRAFT',patch:{cause:e.target.value}})}/></label>
        <label>Risk / effect<textarea rows={5} value={d.effect} onChange={e=>dispatch({type:'SET_FINDING_DRAFT',patch:{effect:e.target.value}})}/></label>
        <label>Rating<select value={d.riskRating} onChange={e=>dispatch({type:'SET_FINDING_DRAFT',patch:{riskRating:e.target.value as RiskRating}})}><option value="">Select rating</option>{['Critical','High','Medium','Low'].map(v=><option key={v}>{v}</option>)}</select></label>
      </>}
      {d.step===3&&<label>Recommendation<textarea rows={7} value={d.recommendation} onChange={e=>dispatch({type:'SET_FINDING_DRAFT',patch:{recommendation:e.target.value}})} placeholder="State the control change, owner expectation and evidence of completion."/></label>}
    </div>
    <div className="sb-form-actions">
      {d.step>1&&<Button variant="quiet" onClick={()=>dispatch({type:'SET_FINDING_DRAFT',patch:{step:d.step-1}})}>Back</Button>}
      <div className="sb-toolbar__spacer"/>
      {d.step<3?<Button variant="primary" onClick={next}>Continue</Button>:<Button variant="primary" onClick={create}>Create finding</Button>}
    </div>
  </Drawer>;
}
