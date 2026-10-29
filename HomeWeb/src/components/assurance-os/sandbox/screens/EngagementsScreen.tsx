import { useMemo, useState } from 'react';
import { useSandbox } from '@/sandbox/store';
import { can, missingPermission } from '@/sandbox/permissions';
import { formatDate } from '@/sandbox/date';
import { Badge, Button, Drawer, EmptyState, Panel, RatingBadge, TooltipLock } from '../Ui';
import AiAssistant from '../AiAssistant';

type DetailTab='Scope'|'Work papers'|'Evidence'|'Findings'|'Review notes'|'Report';

export default function EngagementsScreen(){
  const {state,dispatch}=useSandbox();
  const [tab,setTab]=useState<DetailTab>('Scope');
  const [evidenceId,setEvidenceId]=useState<string|null>(null);
  const [note,setNote]=useState('');
  const [aiOpen,setAiOpen]=useState(false);

  const engagement=state.engagements.find(e=>e.engagementId===state.selectedEngagementId) ?? null;
  const workPapers=useMemo(()=>engagement?state.workPapers.filter(w=>w.engagementId===engagement.engagementId):[],[engagement,state.workPapers]);
  const findings=useMemo(()=>engagement?state.findings.filter(f=>f.engagementId===engagement.engagementId):[],[engagement,state.findings]);
  const selectedWp=state.workPapers.find(w=>w.workPaperId===state.selectedWorkPaperId) ?? null;
  const selectedEvidence=selectedWp?.evidence.find(e=>e.attachmentId===evidenceId) ?? workPapers.flatMap(w=>w.evidence).find(e=>e.attachmentId===evidenceId) ?? null;

  if(selectedWp){
    const prepare=can(state,'workpaper.prepare');
    const review=can(state,'workpaper.review');
    const approve=can(state,'workpaper.approve');
    return <div className="sb-screen sb-detail-full">
      <div className="sb-page-head">
        <div>
          <button className="sb-back" onClick={()=>dispatch({type:'SELECT_WORK_PAPER',workPaperId:null})}>← Back to engagement</button>
          <h1>{selectedWp.workPaperRef} · {selectedWp.observationTitle}</h1>
          <p>{selectedWp.status} · {selectedWp.assignedAuditorName} · {selectedWp.riskRating} risk</p>
        </div>
        <Button icon="sparkles" onClick={()=>setAiOpen(true)}>AI assistant</Button>
      </div>

      <div className="sb-progress-steps" aria-label="Work-paper sign-off">
        {['Open','Prepared','Reviewed','Approved'].map((s,i)=><div key={s} className={['Open','Prepared','Reviewed','Approved'].indexOf(selectedWp.signOffState)>=i?'is-done':''}><span>{i+1}</span><strong>{s}</strong></div>)}
      </div>

      <div className="sb-grid sb-grid--2 sb-grid--workpaper">
        <Panel title="Procedure and test result">
          <dl className="sb-detail-list">
            <div><dt>Control objective</dt><dd>{selectedWp.controlObjectives}</dd></div>
            <div><dt>Test objective</dt><dd>{selectedWp.testObjective}</dd></div>
            <div><dt>Testing steps</dt><dd><ol>{selectedWp.testingSteps.map(step=><li key={step}>{step}</li>)}</ol></dd></div>
            <div><dt>Result</dt><dd>{selectedWp.observationDescription}</dd></div>
            <div><dt>Criteria</dt><dd>{selectedWp.standards}</dd></div>
          </dl>
        </Panel>

        <Panel title={'Evidence · '+selectedWp.evidence.length}>
          <div className="sb-file-list">
            {selectedWp.evidence.map(file=><button key={file.attachmentId} onClick={()=>setEvidenceId(file.attachmentId)}>
              <span className="sb-file-mark">FILE</span>
              <span><strong>{file.fileName}</strong><small>{file.mimeType} · {file.sizeKb} KB · {formatDate(file.uploadedAt)}</small></span>
            </button>)}
          </div>
        </Panel>
      </div>

      <Panel title="Review notes">
        <ol className="sb-thread">
          {selectedWp.reviewNotes.map(item=>{
            const user=state.users.find(u=>u.userId===item.authorId);
            return <li key={item.id}><span>{user?.avatar ?? 'AU'}</span><div><strong>{user?.fullName ?? item.authorId}</strong><small>{formatDate(item.createdAt)}</small><p>{item.text}</p></div></li>;
          })}
        </ol>
        {review && <form className="sb-note-form" onSubmit={e=>{e.preventDefault();dispatch({type:'ADD_REVIEW_NOTE',workPaperId:selectedWp.workPaperId,text:note});setNote('');}}>
          <label htmlFor="review-note">Add review note</label>
          <textarea id="review-note" value={note} onChange={e=>setNote(e.target.value)} rows={3}/>
          <Button type="submit" variant="primary">Add note</Button>
        </form>}
      </Panel>

      <div className="sb-signoff">
        <TooltipLock label={prepare?'Prepare this work paper':missingPermission('workpaper.prepare')}>
          <Button disabled={!prepare} onClick={()=>dispatch({type:'SIGN_OFF_WORK_PAPER',workPaperId:selectedWp.workPaperId,state:'Prepared'})}>Prepare</Button>
        </TooltipLock>
        <TooltipLock label={review?'Review this work paper':missingPermission('workpaper.review')}>
          <Button disabled={!review} onClick={()=>dispatch({type:'SIGN_OFF_WORK_PAPER',workPaperId:selectedWp.workPaperId,state:'Reviewed'})}>Review</Button>
        </TooltipLock>
        <TooltipLock label={approve?'Approve this work paper':missingPermission('workpaper.approve')}>
          <Button variant="primary" disabled={!approve} onClick={()=>dispatch({type:'SIGN_OFF_WORK_PAPER',workPaperId:selectedWp.workPaperId,state:'Approved'})}>Approve</Button>
        </TooltipLock>
      </div>

      <Drawer open={!!selectedEvidence} title={selectedEvidence?.fileName ?? 'Evidence'} onClose={()=>setEvidenceId(null)}>
        {selectedEvidence && <div className="sb-evidence-preview">
          <div className="sb-evidence-preview__page">
            <strong>{selectedEvidence.fileName}</strong>
            <p>{selectedEvidence.preview}</p>
            <dl><div><dt>Type</dt><dd>{selectedEvidence.mimeType}</dd></div><div><dt>Size</dt><dd>{selectedEvidence.sizeKb} KB</dd></div><div><dt>Uploaded</dt><dd>{formatDate(selectedEvidence.uploadedAt)}</dd></div></dl>
            <p className="sb-muted">Generated preview. No real document is stored in this sandbox.</p>
          </div>
        </div>}
      </Drawer>
      <AiAssistant open={aiOpen} onClose={()=>setAiOpen(false)} entityType="work_paper" entityId={selectedWp.workPaperId}/>
    </div>;
  }

  if(engagement){
    const tabs:DetailTab[]=['Scope','Work papers','Evidence','Findings','Review notes','Report'];
    const evidence=workPapers.flatMap(w=>w.evidence);
    const notes=workPapers.flatMap(w=>w.reviewNotes.map(n=>({...n,workPaperRef:w.workPaperRef})));
    return <div className="sb-screen sb-detail-full">
      <div className="sb-page-head">
        <div><button className="sb-back" onClick={()=>dispatch({type:'SELECT_ENGAGEMENT',engagementId:null})}>← All engagements</button><h1>{engagement.title}</h1><p>{engagement.engagementId} · {engagement.process} · {engagement.status}</p></div>
        <div className="sb-progress-ring"><strong>{engagement.progress}%</strong><span>complete</span></div>
      </div>
      <div className="sb-team-strip">
        <span><b>Lead</b>{state.users.find(u=>u.userId===engagement.leadAuditorId)?.fullName}</span>
        <span><b>Reviewer</b>{state.users.find(u=>u.userId===engagement.reviewerId)?.fullName}</span>
        <span><b>Entity</b>{engagement.affiliateCode==='HO'?'Head Office':'Nakuru Branch'}</span>
        <span><b>Dates</b>{formatDate(engagement.startDate)} – {formatDate(engagement.endDate)}</span>
      </div>
      <div className="sb-tabs" role="tablist">{tabs.map(item=><button role="tab" aria-selected={tab===item} className={tab===item?'is-active':''} key={item} onClick={()=>setTab(item)}>{item}</button>)}</div>
      <div className="sb-tab-panel">
        {tab==='Scope' && <Panel title="Engagement scope"><p className="sb-lead">{engagement.objectives}</p><ul className="sb-bullet-list">{engagement.scope.map(s=><li key={s}>{s}</li>)}</ul></Panel>}
        {tab==='Work papers' && <Panel title={'Work papers · '+workPapers.length}><div className="sb-table-wrap"><table className="sb-table"><thead><tr><th>Reference</th><th>Observation</th><th>Risk</th><th>Status</th><th>Sign-off</th></tr></thead><tbody>{workPapers.map(w=><tr key={w.workPaperId} onClick={()=>dispatch({type:'SELECT_WORK_PAPER',workPaperId:w.workPaperId})} tabIndex={0} onKeyDown={e=>{if(e.key==='Enter')dispatch({type:'SELECT_WORK_PAPER',workPaperId:w.workPaperId});}}><td>{w.workPaperRef}</td><td>{w.observationTitle}</td><td><RatingBadge rating={w.riskRating}/></td><td><Badge>{w.status}</Badge></td><td>{w.signOffState}</td></tr>)}</tbody></table></div></Panel>}
        {tab==='Evidence' && <Panel title={'Evidence · '+evidence.length}><div className="sb-file-grid">{evidence.map(file=><button key={file.attachmentId} onClick={()=>setEvidenceId(file.attachmentId)}><span className="sb-file-mark">FILE</span><strong>{file.fileName}</strong><small>{file.sizeKb} KB</small></button>)}</div></Panel>}
        {tab==='Findings' && <Panel title={'Findings · '+findings.length}>{findings.length===0?<EmptyState title="No findings" body="No findings are linked to this engagement."/>:<div className="sb-table-wrap"><table className="sb-table"><thead><tr><th>ID</th><th>Finding</th><th>Risk</th><th>Status</th></tr></thead><tbody>{findings.map(f=><tr key={f.id} onClick={()=>{dispatch({type:'NAVIGATE',screen:'findings'});dispatch({type:'SELECT_FINDING',findingId:f.id});}}><td>{f.id}</td><td>{f.observationTitle}</td><td><RatingBadge rating={f.riskRating}/></td><td><Badge>{f.status}</Badge></td></tr>)}</tbody></table></div>}</Panel>}
        {tab==='Review notes' && <Panel title={'Review notes · '+notes.length}><ol className="sb-thread">{notes.map(n=><li key={n.id}><span>RN</span><div><strong>{n.workPaperRef}</strong><small>{formatDate(n.createdAt)}</small><p>{n.text}</p></div></li>)}</ol></Panel>}
        {tab==='Report' && <Panel title="Engagement report"><div className="sb-report-mini"><h2>{engagement.title}</h2><p>Internal Audit · {engagement.engagementId}</p><hr/><strong>Executive summary</strong><p>{findings.length} findings were raised from {workPapers.length} work papers. {findings.filter(f=>['Critical','High'].includes(f.riskRating)).length} are high or critical risk.</p><strong>Overall conclusion</strong><p>Control design is generally present, with specific exceptions requiring evidenced remediation and management follow-up.</p></div></Panel>}
      </div>
      <Drawer open={!!selectedEvidence} title={selectedEvidence?.fileName ?? 'Evidence'} onClose={()=>setEvidenceId(null)}>{selectedEvidence && <div className="sb-evidence-preview"><div className="sb-evidence-preview__page"><strong>{selectedEvidence.fileName}</strong><p>{selectedEvidence.preview}</p><p className="sb-muted">Generated sandbox preview. No real document.</p></div></div>}</Drawer>
    </div>;
  }

  return <div className="sb-screen">
    <div className="sb-page-head"><div><h1>Engagements</h1><p>12 engagements across planning, fieldwork, review, reporting and closure.</p></div></div>
    <Panel>
      <div className="sb-table-wrap"><table className="sb-table sb-table--sticky">
        <thead><tr><th>Engagement</th><th>Process</th><th>Entity</th><th>Lead</th><th>Status</th><th>Progress</th><th>End date</th></tr></thead>
        <tbody>{state.engagements.map(e=><tr key={e.engagementId} tabIndex={0} onClick={()=>dispatch({type:'SELECT_ENGAGEMENT',engagementId:e.engagementId})} onKeyDown={ev=>{if(ev.key==='Enter')dispatch({type:'SELECT_ENGAGEMENT',engagementId:e.engagementId});}}>
          <td><strong>{e.title}</strong><small>{e.engagementId}</small></td><td>{e.process}</td><td>{e.affiliateCode==='HO'?'Head Office':'Nakuru Branch'}</td><td>{state.users.find(u=>u.userId===e.leadAuditorId)?.fullName}</td><td><Badge>{e.status}</Badge></td><td><span className="sb-inline-progress"><i style={{width:String(e.progress)+'%'}}/></span>{e.progress}%</td><td>{formatDate(e.endDate)}</td>
        </tr>)}</tbody>
      </table></div>
    </Panel>
  </div>;
}
