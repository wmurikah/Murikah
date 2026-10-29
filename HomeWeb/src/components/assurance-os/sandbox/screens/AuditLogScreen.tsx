import { useMemo, useState } from 'react';
import { useSandbox } from '@/sandbox/store';
import { can } from '@/sandbox/permissions';
import { formatDate } from '@/sandbox/date';
import { Badge, Button, EmptyState, Panel } from '../Ui';
import { Icon } from '../Icon';

function csvCell(value: unknown){
  const text=typeof value==='string'?value:JSON.stringify(value ?? '');
  return '"' + text.replaceAll('"','""') + '"';
}

export default function AuditLogScreen(){
  const {state}=useSandbox();
  const [query,setQuery]=useState('');
  const [actor,setActor]=useState('');
  const [action,setAction]=useState('');
  const [entityType,setEntityType]=useState('');
  const allowed=can(state,'auditlog.read');

  const rows=useMemo(()=>{
    if(!allowed) return [];
    const q=query.trim().toLowerCase();
    return state.auditLog.filter(item=>{
      if(q && !(item.action+' '+item.details+' '+item.entityId).toLowerCase().includes(q)) return false;
      if(actor&&item.actorUserId!==actor) return false;
      if(action&&item.action!==action) return false;
      if(entityType&&item.entityType!==entityType) return false;
      return true;
    });
  },[state,query,actor,action,entityType,allowed]);

  const actions=Array.from(new Set(state.auditLog.map(x=>x.action))).sort();
  const entities=Array.from(new Set(state.auditLog.map(x=>x.entityType))).sort();

  const exportCsv=()=>{
    const header=['Audit ID','When','Actor','Role','Action','Entity type','Entity ID','Before','After','Details'];
    const body=rows.map(r=>[
      r.auditId,r.createdAt,state.users.find(u=>u.userId===r.actorUserId)?.fullName??r.actorUserId,r.actorRole,r.action,r.entityType,r.entityId,r.before,r.after,r.details
    ].map(csvCell).join(','));
    const blob=new Blob([[header.map(csvCell).join(','),...body].join('\n')],{type:'text/csv;charset=utf-8'});
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');a.href=url;a.download='assurance-os-sandbox-audit-log.csv';a.click();
    window.setTimeout(()=>URL.revokeObjectURL(url),1000);
  };

  return <div className="sb-screen" data-tour="audit-log">
    <div className="sb-page-head">
      <div><h1>Audit log</h1><p>Attributable history across work papers, findings, actions, reports and role changes.</p></div>
      {allowed&&<Button icon="download" onClick={exportCsv}>Export CSV</Button>}
    </div>
    {!allowed?<Panel><EmptyState title="Audit log restricted" body="This role does not have audit-log read permission. Switch to an audit-management role to inspect the trail."/></Panel>:<Panel>
      <div className="sb-toolbar">
        <label className="sb-search"><Icon name="search"/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search action, entity or detail…"/><span>{rows.length}</span></label>
        <select value={actor} onChange={e=>setActor(e.target.value)}><option value="">All actors</option>{state.users.map(u=><option key={u.userId} value={u.userId}>{u.fullName}</option>)}</select>
        <select value={action} onChange={e=>setAction(e.target.value)}><option value="">All actions</option>{actions.map(v=><option key={v}>{v}</option>)}</select>
        <select value={entityType} onChange={e=>setEntityType(e.target.value)}><option value="">All entities</option>{entities.map(v=><option key={v}>{v}</option>)}</select>
      </div>
      {rows.length===0?<EmptyState title="No audit events match" body="Clear a filter to return to the seeded audit trail."/>:<div className="sb-table-wrap sb-log-table"><table className="sb-table sb-table--sticky">
        <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Entity</th><th>Change</th></tr></thead>
        <tbody>{rows.slice(0,160).map(item=><tr key={item.auditId}>
          <td><strong>{formatDate(item.createdAt)}</strong><small>{new Date(item.createdAt).toLocaleTimeString('en-KE',{hour:'2-digit',minute:'2-digit'})}</small></td>
          <td>{state.users.find(u=>u.userId===item.actorUserId)?.fullName??item.actorUserId}<small>{item.actorRole}</small></td>
          <td><Badge>{item.action.replaceAll('_',' ')}</Badge><small>{item.details}</small></td>
          <td>{item.entityType}<small>{item.entityId}</small></td>
          <td><code>{item.before?JSON.stringify(item.before):'—'}</code><span aria-hidden="true"> → </span><code>{item.after?JSON.stringify(item.after):'—'}</code></td>
        </tr>)}</tbody>
      </table>{rows.length>160&&<p className="sb-virtual-note">Showing the newest 160 of {rows.length} matching events. The list is windowed to keep interaction fast.</p>}</div>}
    </Panel>}
  </div>;
}
