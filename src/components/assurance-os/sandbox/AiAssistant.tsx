import { useEffect, useMemo, useState } from 'react';
import { useSandbox } from '@/sandbox/store';
import { Button, Badge, Drawer } from './Ui';

type PromptKind = 'root'|'evidence'|'action'|'criteria';

function scripted(kind: PromptKind, record: { title: string; criteria?: string; evidence?: string[] }) {
  if(kind==='root') return 'A likely root cause is that the control depends on manual follow-up without a required completion record, so exceptions can remain unresolved when ownership or timing changes.';
  if(kind==='evidence') return 'The available evidence supports the exception described in “' + record.title + '”. The sample contains ' + String(record.evidence?.length ?? 0) + ' linked files. Reviewer attention should focus on whether the population is complete, the sample is traceable and each exception is corroborated.';
  if(kind==='action') return 'Implement a named control owner, a defined review frequency and an evidence-retention step. Configure a reminder before the due date and escalate unresolved exceptions to the accountable manager.';
  return 'The finding is directionally aligned to ' + (record.criteria || 'the stated control criteria') + '. Before issue, confirm that the condition is supported by retained evidence, the cause is distinct from the effect, and the recommendation directly addresses the cause.';
}

export default function AiAssistant({ open, onClose, entityType, entityId }: { open:boolean; onClose:()=>void; entityType:'finding'|'work_paper'; entityId:string }) {
  const {state,dispatch}=useSandbox();
  const finding=entityType==='finding'?state.findings.find(f=>f.id===entityId):state.findings.find(f=>f.workPaperId===entityId);
  const wp=entityType==='work_paper'?state.workPapers.find(w=>w.workPaperId===entityId):state.workPapers.find(w=>w.workPaperId===finding?.workPaperId);
  const record=useMemo(()=>({title:finding?.observationTitle ?? wp?.observationTitle ?? 'current record',criteria:finding?.criteria ?? wp?.standards,evidence:wp?.evidence.map(e=>e.fileName) ?? []}),[finding,wp]);
  const [kind,setKind]=useState<PromptKind>('root');
  const [output,setOutput]=useState('');
  const [full,setFull]=useState('');
  const [streaming,setStreaming]=useState(false);
  const [editing,setEditing]=useState(false);

  const run=(next:PromptKind)=>{
    setKind(next);
    setOutput('');
    setEditing(false);
    const text=scripted(next,record);
    setFull(text);
    setStreaming(true);
  };

  useEffect(()=>{
    if(!streaming) return;
    const tokens=full.split(' ');
    let i=0;
    const timer=window.setInterval(()=>{
      i+=1;
      setOutput(tokens.slice(0,i).join(' '));
      if(i>=tokens.length){window.clearInterval(timer);setStreaming(false);}
    },36);
    return()=>window.clearInterval(timer);
  },[full,streaming]);

  const field=kind==='root'?'rootCause':kind==='action'?'recommendation':entityType==='work_paper'?'observationDescription':'rootCause';

  return <Drawer open={open} onClose={onClose} title="AI assistant" wide>
    <div className="sb-ai">
      <div className="sb-ai__prompts">
        <button onClick={()=>run('root')}>Draft root cause</button>
        <button onClick={()=>run('evidence')}>Summarise evidence</button>
        <button onClick={()=>run('action')}>Suggest action plan</button>
        <button onClick={()=>run('criteria')}>Check finding against criteria</button>
      </div>
      <div className="sb-ai__result">
        <div className="sb-ai__label"><Badge tone="info">Draft for reviewer</Badge><span>Sandbox responses are pre-written examples.</span></div>
        {output ? (editing?<textarea value={output} onChange={e=>setOutput(e.target.value)} rows={10}/>:<p>{output}{streaming && <span className="sb-caret">▋</span>}</p>) : <div className="sb-empty"><strong>Choose an assistant action</strong><span>No live model is called. The response is selected from scripted examples using this record.</span></div>}
      </div>
      {output && !streaming && <div className="sb-ai__actions">
        <Button variant="primary" onClick={()=>{dispatch({type:'ACCEPT_AI_DRAFT',entityType,entityId,field,text:output});onClose();}}>Accept</Button>
        <Button onClick={()=>setEditing(v=>!v)}>{editing?'Finish edit':'Edit'}</Button>
        <Button variant="quiet" onClick={()=>{setOutput('');setFull('');}}>Discard</Button>
      </div>}
    </div>
  </Drawer>;
}
