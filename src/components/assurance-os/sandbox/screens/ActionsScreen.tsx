import { useMemo, useState } from 'react';
import { useSandbox } from '@/sandbox/store';
import { can, missingPermission } from '@/sandbox/permissions';
import { daysBetween, formatDate, relativeLabel } from '@/sandbox/date';
import type { ActionPlan, ActionPlanStatus } from '@/sandbox/types';
import { Badge, Button, Drawer, EmptyState, Panel, RatingBadge, TooltipLock } from '../Ui';
import { Icon } from '../Icon';

const columns: ActionPlanStatus[] = ['Not Due','Pending','In Progress','Overdue','Pending Verification','Verified','Closed'];

function allowedTargets(state: ReturnType<typeof useSandbox>['state'], plan: ActionPlan): ActionPlanStatus[] {
  if(state.activeRoleCode==='UNIT_MANAGER' && plan.ownerIds.includes(state.activeUserId) && ['Not Due','Pending','In Progress','Overdue','Rejected'].includes(plan.status)) return ['Pending Verification'];
  if(can(state,'action.verify') && plan.status==='Pending Verification') return ['Verified','In Progress','Rejected'];
  if(can(state,'action.close') && plan.status==='Verified') return ['Closed','In Progress'];
  if(can(state,'action.update') && state.activeRoleCode!=='UNIT_MANAGER'){
    if(plan.status==='Not Due') return ['Pending','In Progress'];
    if(plan.status==='Pending') return ['In Progress','Pending Verification'];
    if(plan.status==='In Progress'||plan.status==='Overdue'||plan.status==='Rejected') return ['Pending Verification'];
  }
  return [];
}

export default function ActionsScreen(){
  const {state,dispatch}=useSandbox();
  const [mode,setMode]=useState<'list'|'kanban'>('kanban');
  const [query,setQuery]=useState('');
  const [selectedId,setSelectedId]=useState<string|null>(null);
  const [dragged,setDragged]=useState<string|null>(null);
  const rows=useMemo(()=>state.actionPlans.filter(a=>{
    if(state.activeRoleCode==='UNIT_MANAGER'&&!a.ownerIds.includes(state.activeUserId)) return false;
    const q=query.trim().toLowerCase();
    if(!q) return true;
    const finding=state.findings.find(f=>f.id===a.findingId);
    return (a.actionPlanRef+' '+a.actionDescription+' '+finding?.observationTitle).toLowerCase().includes(q);
  }),[state,query]);
  const selected=state.actionPlans.find(a=>a.actionPlanId===selectedId) ?? null;

  const move=(plan:ActionPlan,status:ActionPlanStatus)=>{
    const allowed=allowedTargets(state,plan);
    if(!allowed.includes(status)) return;
    if(status==='Pending Verification'&&plan.evidence.length===0&&state.activeRoleCode==='UNIT_MANAGER') return;
    dispatch({type:'UPDATE_ACTION_STATUS',actionPlanId:plan.actionPlanId,status});
  };

  return <div className="sb-screen" data-tour="actions">
    <div className="sb-page-head">
      <div><h1>Actions</h1><p>Remediation follow-up, evidence, reminders and escalation.</p></div>
      <div className="sb-segment"><button className={mode==='list'?'is-active':''} onClick={()=>setMode('list')}>List</button><button className={mode==='kanban'?'is-active':''} onClick={()=>setMode('kanban')}>Kanban</button></div>
    </div>

    <Panel>
      <div className="sb-toolbar">
        <label className="sb-search"><Icon name="search"/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search action plans…"/><span>{rows.length}</span></label>
        {state.activeRoleCode==='UNIT_MANAGER'&&<Badge tone="info">Showing your actions only</Badge>}
      </div>

      {rows.length===0?<EmptyState title="No actions match" body="Try a different search or role."/>:mode==='list'?<div className="sb-table-wrap"><table className="sb-table sb-table--sticky">
        <thead><tr><th>Action</th><th>Finding</th><th>Owner</th><th>Due</th><th>Priority</th><th>Status</th><th>Escalation</th></tr></thead>
        <tbody>{rows.map(a=>{
          const owner=state.users.find(u=>u.userId===a.ownerIds[0]);
          return <tr key={a.actionPlanId} onClick={()=>setSelectedId(a.actionPlanId)}>
            <td><strong>{a.actionPlanRef}</strong><small>{a.actionDescription}</small></td>
            <td>{a.findingId}</td>
            <td>{owner?.fullName}</td>
            <td className={daysBetween(a.dueDate)<0&&!['Closed','Verified','Pending Verification'].includes(a.status)?'sb-overdue':''}>{formatDate(a.dueDate)}<small>{relativeLabel(a.dueDate)}</small></td>
            <td><RatingBadge rating={a.priority}/></td>
            <td><Badge tone={a.status==='Overdue'?'warn':a.status==='Closed'?'success':'neutral'}>{a.status}</Badge></td>
            <td>{a.escalationState}</td>
          </tr>;
        })}</tbody>
      </table></div>:<div className="sb-kanban" aria-label="Action plan Kanban board">
        {columns.map(status=><section key={status} className="sb-kanban__col" onDragOver={e=>{const plan=state.actionPlans.find(a=>a.actionPlanId===dragged);if(plan&&allowedTargets(state,plan).includes(status))e.preventDefault();}} onDrop={e=>{e.preventDefault();const plan=state.actionPlans.find(a=>a.actionPlanId===dragged);if(plan)move(plan,status);setDragged(null);}}>
          <header><strong>{status}</strong><span>{rows.filter(a=>a.status===status).length}</span></header>
          <div>{rows.filter(a=>a.status===status).map(a=>{
            const owner=state.users.find(u=>u.userId===a.ownerIds[0]);
            const allowed=allowedTargets(state,a);
            return <article key={a.actionPlanId} className="sb-kanban__card" draggable={allowed.length>0} onDragStart={()=>setDragged(a.actionPlanId)} onClick={()=>setSelectedId(a.actionPlanId)}>
              <div><span>{a.actionPlanRef}</span><RatingBadge rating={a.priority}/></div>
              <strong>{a.actionDescription}</strong>
              <small>{owner?.fullName}</small>
              <small className={daysBetween(a.dueDate)<0?'sb-overdue':''}>{formatDate(a.dueDate)} · {relativeLabel(a.dueDate)}</small>
              {a.escalationState!=='None'&&<em>{a.escalationState}</em>}
            </article>;
          })}</div>
        </section>)}
      </div>}
    </Panel>

    <Drawer open={!!selected} title={selected?selected.actionPlanRef+' · Action plan':'Action plan'} onClose={()=>setSelectedId(null)} wide>
      {selected&&<ActionDetail plan={selected} move={status=>move(selected,status)}/>}
    </Drawer>
  </div>;
}

function ActionDetail({plan,move}:{plan:ActionPlan;move:(status:ActionPlanStatus)=>void}){
  const {state,dispatch}=useSandbox();
  const finding=state.findings.find(f=>f.id===plan.findingId);
  const owner=state.users.find(u=>u.userId===plan.ownerIds[0]);
  const targets=allowedTargets(state,plan);
  const canUpload=can(state,'action.update',plan.ownerIds);

  return <div className="sb-action-detail">
    <div className="sb-detail-meta"><RatingBadge rating={plan.priority}/><Badge>{plan.status}</Badge><span>Owner: {owner?.fullName}</span><span>Due {formatDate(plan.dueDate)}</span></div>
    <section><h3>Action</h3><p>{plan.actionDescription}</p></section>
    {finding&&<section><h3>Linked finding</h3><button className="sb-link-block" onClick={()=>{dispatch({type:'NAVIGATE',screen:'findings'});dispatch({type:'SELECT_FINDING',findingId:finding.id});}}><strong>{finding.id}</strong><span>{finding.observationTitle}</span></button></section>}

    <section><h3>Implementation evidence</h3>
      {plan.evidence.length?<ul className="sb-compact-list">{plan.evidence.map((file,index)=><li key={file.name+'-'+index}><Icon name="file"/><span>{file.name}</span><small>{file.sizeKb} KB</small></li>)}</ul>:<p className="sb-muted">No implementation evidence uploaded yet.</p>}
      <TooltipLock label={canUpload?'Attach a local sandbox file':missingPermission('action.update')}>
        <label className={'sb-file-input '+(!canUpload?'is-disabled':'')}>
          <input type="file" disabled={!canUpload} onChange={e=>{
            const file=e.target.files?.[0];
            if(file) dispatch({type:'ADD_ACTION_EVIDENCE',actionPlanId:plan.actionPlanId,name:file.name,typeName:file.type||'application/octet-stream',sizeKb:Math.max(1,Math.round(file.size/1024))});
            e.currentTarget.value='';
          }}/>
          <Icon name="plus"/><span>Upload evidence</span>
        </label>
      </TooltipLock>
      <p className="sb-privacy-inline">The selected file is represented by name, type and size only. It is not uploaded anywhere.</p>
    </section>

    <section><h3>Workflow</h3>
      <div className="sb-action-targets">{targets.length===0?<p className="sb-muted">No permitted transition from this status for the active role.</p>:targets.map(status=>{
        const needsEvidence=status==='Pending Verification'&&plan.evidence.length===0&&state.activeRoleCode==='UNIT_MANAGER';
        return <TooltipLock key={status} label={needsEvidence?'Attach implementation evidence before submitting for verification':'Move action to '+status}>
          <Button variant={status==='Closed'?'primary':'secondary'} disabled={needsEvidence} onClick={()=>move(status)}>{status}</Button>
        </TooltipLock>;
      })}</div>
    </section>

    <section><h3>Timeline</h3><ol className="sb-timeline">{plan.activity.map(item=><li key={item.id}><i/><div><strong>{item.label}</strong><small>{formatDate(item.createdAt)}{item.actor?' · '+item.actor:''}</small></div></li>)}</ol></section>
    <section><h3>Follow-up</h3><dl className="sb-detail-list"><div><dt>Reminder</dt><dd>{formatDate(plan.reminderDate)} · {relativeLabel(plan.reminderDate)}</dd></div><div><dt>Escalation</dt><dd>{plan.escalationState}</dd></div></dl></section>
  </div>;
}
