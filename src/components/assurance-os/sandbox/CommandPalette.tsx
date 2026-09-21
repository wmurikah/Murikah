import { useEffect, useMemo, useState } from 'react';
import { useSandbox } from '@/sandbox/store';
import type { ScreenId } from '@/sandbox/types';
import { Icon } from './Icon';
import { useFocusTrap } from './Ui';

const screenCommands: Array<{label:string;screen:ScreenId;keywords:string}> = [
  {label:'Dashboard',screen:'dashboard',keywords:'overview kpi attention'},
  {label:'Audit plan',screen:'plan',keywords:'annual plan gantt capacity'},
  {label:'Engagements',screen:'engagements',keywords:'scope work papers evidence review'},
  {label:'Findings',screen:'findings',keywords:'issues observations risks'},
  {label:'Actions',screen:'actions',keywords:'remediation follow up kanban'},
  {label:'Risk register',screen:'risks',keywords:'heat map controls'},
  {label:'Reports',screen:'reports',keywords:'committee pack board'},
  {label:'Audit log',screen:'audit-log',keywords:'history activity csv'},
];

export default function CommandPalette({ open, onClose }: { open:boolean; onClose:()=>void }) {
  const { state, dispatch } = useSandbox();
  const [query,setQuery]=useState('');
  const ref=useFocusTrap(open,onClose);

  useEffect(()=>{ if(open) setQuery(''); },[open]);

  const results=useMemo(()=>{
    const q=query.trim().toLowerCase();
    const screens=screenCommands
      .filter(x=>!q || (x.label + ' ' + x.keywords).toLowerCase().includes(q))
      .map(x=>({kind:'screen' as const,id:x.screen,label:x.label,detail:'Open screen'}));
    const findings=state.findings
      .filter(f=>!q || (f.id + ' ' + f.observationTitle + ' ' + f.process).toLowerCase().includes(q))
      .slice(0,6)
      .map(f=>({kind:'finding' as const,id:f.id,label:f.id + ' · ' + f.observationTitle,detail:f.riskRating}));
    const engagements=state.engagements
      .filter(e=>!q || (e.engagementId + ' ' + e.title + ' ' + e.process).toLowerCase().includes(q))
      .slice(0,4)
      .map(e=>({kind:'engagement' as const,id:e.engagementId,label:e.title,detail:e.status}));
    return [...screens,...findings,...engagements].slice(0,14);
  },[query,state]);

  if(!open) return null;

  return <div className="sb-overlay sb-overlay--palette" onMouseDown={(e)=>{if(e.target===e.currentTarget) onClose();}}>
    <div ref={ref} className="sb-command" role="dialog" aria-modal="true" aria-label="Command palette">
      <div className="sb-command__search">
        <Icon name="search"/>
        <input autoFocus value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search screens, engagements and findings…"/>
        <kbd>Esc</kbd>
      </div>
      <div className="sb-command__list">
        {results.length===0 ? <p className="sb-command__empty">No matching sandbox records.</p> : results.map(item=>
          <button key={item.kind + '-' + item.id} onClick={()=>{
            if(item.kind==='screen') dispatch({type:'NAVIGATE',screen:item.id as ScreenId});
            if(item.kind==='finding'){ dispatch({type:'NAVIGATE',screen:'findings'}); dispatch({type:'SELECT_FINDING',findingId:item.id}); }
            if(item.kind==='engagement'){ dispatch({type:'NAVIGATE',screen:'engagements'}); dispatch({type:'SELECT_ENGAGEMENT',engagementId:item.id}); }
            onClose();
          }}>
            <span>{item.label}</span>
            <small>{item.detail}</small>
          </button>
        )}
      </div>
    </div>
  </div>;
}
