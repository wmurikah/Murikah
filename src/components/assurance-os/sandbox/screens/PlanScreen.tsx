import { useMemo, useState } from 'react';
import { useSandbox } from '@/sandbox/store';
import { can, missingPermission } from '@/sandbox/permissions';
import type { Engagement } from '@/sandbox/types';
import { Panel, Badge, TooltipLock } from '../Ui';

const quarters: Engagement['quarter'][] = ['Q1','Q2','Q3','Q4'];

export default function PlanScreen(){
  const {state,dispatch}=useSandbox();
  const [dragged,setDragged]=useState<string|null>(null);
  const editable=can(state,'plan.edit');
  const auditors=state.users.filter(u=>['HEAD_OF_AUDIT','AUDIT_MANAGER','SENIOR_AUDITOR','AUDITOR'].includes(u.roleCode));
  const capacity=useMemo(()=>auditors.map(user=>{
    const planned=state.engagements.filter(e=>e.leadAuditorId===user.userId).reduce((sum,e)=>sum+e.budgetDays,0);
    const capacityDays=user.roleCode==='HEAD_OF_AUDIT'?25:user.roleCode==='AUDIT_MANAGER'?35:60;
    return {user,planned,capacityDays,pct:Math.min(100,Math.round(planned/capacityDays*100))};
  }),[state,auditors]);

  return <div className="sb-screen">
    <div className="sb-page-head">
      <div><h1>Audit plan</h1><p>Risk-based annual plan · drag an engagement between quarters to reschedule it.</p></div>
      <Badge tone="info">{new Date().getFullYear()} plan</Badge>
    </div>

    <Panel title="Quarterly Gantt" actions={!editable?<span className="sb-muted">Read only for this role</span>:null}>
      <div className="sb-gantt" role="list" aria-label="Annual audit plan by quarter">
        {quarters.map(q=><section key={q} className="sb-gantt__quarter"
          onDragOver={e=>{if(editable)e.preventDefault();}}
          onDrop={e=>{e.preventDefault();if(editable&&dragged){dispatch({type:'RESCHEDULE_ENGAGEMENT',engagementId:dragged,quarter:q});setDragged(null);}}}>
          <header><strong>{q}</strong><span>{state.engagements.filter(e=>e.quarter===q).reduce((s,e)=>s+e.budgetDays,0)} audit days</span></header>
          <div className="sb-gantt__stack">
            {state.engagements.filter(e=>e.quarter===q).map(e=>
              <TooltipLock key={e.engagementId} label={editable?'Drag to another quarter':missingPermission('plan.edit')}>
                <button
                  draggable={editable}
                  onDragStart={()=>setDragged(e.engagementId)}
                  onClick={()=>{dispatch({type:'NAVIGATE',screen:'engagements'});dispatch({type:'SELECT_ENGAGEMENT',engagementId:e.engagementId});}}
                  className="sb-gantt__item"
                >
                  <span>{e.engagementId}</span>
                  <strong>{e.title}</strong>
                  <small>{e.status} · {e.budgetDays} days</small>
                </button>
              </TooltipLock>
            )}
          </div>
        </section>)}
      </div>
    </Panel>

    <div className="sb-grid sb-grid--2">
      <Panel title="Auditor capacity">
        <div className="sb-capacity">
          {capacity.map(item=><div key={item.user.userId} className="sb-capacity__row">
            <div><strong>{item.user.fullName}</strong><span>{item.user.roleLabel}</span></div>
            <div className="sb-progress"><i style={{width:String(item.pct)+'%'}}/></div>
            <b>{item.planned}/{item.capacityDays}d</b>
          </div>)}
        </div>
      </Panel>

      <Panel title="Audit universe coverage">
        <div className="sb-universe-mini">
          {state.auditUniverse.map(area=>{
            const count=state.engagements.filter(e=>e.process.toLowerCase().includes(area.areaName.split(' ')[0].toLowerCase())||area.areaCode===e.process.slice(0,3).toUpperCase()).length;
            return <div key={area.auditAreaId}><strong>{area.areaName}</strong><span>{count} planned engagement{count===1?'':'s'}</span></div>;
          })}
        </div>
      </Panel>
    </div>
  </div>;
}
