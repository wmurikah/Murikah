import { useMemo, useRef, useState } from 'react';
import { useSandbox } from '@/sandbox/store';
import { can, missingPermission } from '@/sandbox/permissions';
import { formatDate } from '@/sandbox/date';
import { committeePdf } from '@/sandbox/pdf';
import { Badge, Button, Panel, RatingBadge, TooltipLock } from '../Ui';

export default function ReportsScreen(){
  const {state,dispatch}=useSandbox();
  const [generating,setGenerating]=useState(false);
  const [ready,setReady]=useState(false);
  const [progress,setProgress]=useState(0);
  const timerRef=useRef<number|null>(null);
  const canGenerate=can(state,'report.generate');
  const openFindings=state.findings.filter(f=>f.status!=='Closed');
  const high=openFindings.filter(f=>['Critical','High'].includes(f.riskRating));
  const actionBuckets=useMemo(()=>{
    const statuses=['Not Due','Pending','In Progress','Overdue','Pending Verification','Verified','Closed'];
    return statuses.map(status=>({status,count:state.actionPlans.filter(a=>a.status===status).length})).filter(x=>x.count>0);
  },[state.actionPlans]);

  const generate=()=>{
    if(!canGenerate||generating) return;
    setGenerating(true);setReady(false);setProgress(6);
    const started=Date.now();
    timerRef.current=window.setInterval(()=>{
      const elapsed=Date.now()-started;
      const pct=Math.min(100,Math.round((elapsed/3000)*100));
      setProgress(pct);
      if(elapsed>=3000){
        if(timerRef.current) window.clearInterval(timerRef.current);
        setGenerating(false);setReady(true);setProgress(100);
        dispatch({type:'LOG_EVENT',action:'REPORT_GENERATED',entityType:'report',entityId:'quarterly-committee-pack',details:'Quarterly committee pack generated from current sandbox state'});
      }
    },120);
  };

  const pdfLines=()=>{
    const lines=[
      'Kilima Savings and Credit Cooperative Ltd',
      'Quarterly Audit & Risk Committee Pack',
      'Fictional sample data · Assurance OS sandbox',
      '',
      'Executive summary',
      'Open findings: '+openFindings.length,
      'High and critical findings: '+high.length,
      'Overdue actions: '+state.actionPlans.filter(a=>a.status==='Overdue').length,
      'Engagements in fieldwork/review/reporting: '+state.engagements.filter(e=>['Fieldwork','Review','Reporting'].includes(e.status)).length,
      '',
      'Priority findings'
    ];
    high.slice(0,12).forEach(f=>lines.push(f.id+' · '+f.riskRating+' · '+f.observationTitle));
    lines.push('','Action status');
    actionBuckets.forEach(x=>lines.push(x.status+': '+x.count));
    lines.push('','Generated entirely in the browser. No customer data.');
    return lines;
  };

  const download=()=>{
    const blob=committeePdf(pdfLines());
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');
    a.href=url;a.download='kilima-quarterly-committee-pack.pdf';a.click();
    dispatch({type:'LOG_EVENT',action:'REPORT_EXPORTED',entityType:'report',entityId:'quarterly-committee-pack',details:'Quarterly committee pack downloaded as PDF'});
    window.setTimeout(()=>URL.revokeObjectURL(url),1000);
  };

  const print=()=>{
    dispatch({type:'LOG_EVENT',action:'REPORT_PRINTED',entityType:'report',entityId:'quarterly-committee-pack',details:'Quarterly committee pack opened for printing'});
    document.documentElement.classList.add('sandbox-print-report');
    window.print();
    window.setTimeout(()=>document.documentElement.classList.remove('sandbox-print-report'),250);
  };

  return <div className="sb-screen" data-tour="reports">
    <div className="sb-page-head">
      <div><h1>Reports</h1><p>Generate a quarterly committee pack from the same findings and action records.</p></div>
      <div className="sb-page-actions">
        {ready&&<><Button icon="download" onClick={download}>Download PDF</Button><Button icon="print" onClick={print}>Print</Button></>}
        <TooltipLock label={canGenerate?'Generate the committee pack':missingPermission('report.generate')}>
          <Button variant="primary" disabled={!canGenerate||generating} onClick={generate}>{generating?'Generating…':'Generate quarterly committee pack'}</Button>
        </TooltipLock>
      </div>
    </div>

    {generating&&<Panel>
      <div className="sb-generate"><span>Compiling reviewed findings, action plans and charts…</span><div className="sb-progress"><i style={{width:String(progress)+'%'}}/></div><strong>{progress}%</strong></div>
    </Panel>}

    {!ready&&!generating&&<Panel>
      <div className="sb-report-empty">
        <span>Q{Math.floor(new Date().getMonth()/3)+1}</span>
        <h2>Quarterly Audit & Risk Committee pack</h2>
        <p>The preview will contain a cover, executive summary, portfolio charts, priority findings and action status drawn from the current sandbox state.</p>
        {!canGenerate&&<Badge tone="info">Read-only role: switch to an audit-management role to generate a new pack.</Badge>}
      </div>
    </Panel>}

    {ready&&<div className="sb-report-preview" id="sandbox-report-preview" aria-label="Quarterly committee pack preview">
      <section className="sb-report-page sb-report-cover">
        <div><span>ASSURANCE OS</span><strong>Kilima Savings and Credit Cooperative Ltd</strong></div>
        <div><p>Quarterly Audit & Risk Committee Pack</p><h2>Q{Math.floor(new Date().getMonth()/3)+1} · {new Date().getFullYear()}</h2></div>
        <footer><span>Fictional sample data</span><span>Generated {formatDate(new Date().toISOString())}</span></footer>
      </section>

      <section className="sb-report-page">
        <header><span>02</span><h2>Executive summary</h2></header>
        <div className="sb-report-kpis">
          <div><strong>{openFindings.length}</strong><span>Open findings</span></div>
          <div><strong>{high.length}</strong><span>High / critical</span></div>
          <div><strong>{state.actionPlans.filter(a=>a.status==='Overdue').length}</strong><span>Overdue actions</span></div>
          <div><strong>{state.engagements.filter(e=>['Fieldwork','Review','Reporting'].includes(e.status)).length}</strong><span>Active engagements</span></div>
        </div>
        <h3>Committee attention</h3>
        <ul className="sb-report-bullets">
          {high.slice(0,4).map(f=><li key={f.id}><strong>{f.id}</strong> {f.observationTitle}</li>)}
          <li>{state.actionPlans.filter(a=>a.status==='Overdue').length} action plans are overdue and remain subject to follow-up escalation.</li>
        </ul>
      </section>

      <section className="sb-report-page">
        <header><span>03</span><h2>Portfolio charts</h2></header>
        <div className="sb-report-charts">
          <div><h3>Open findings by rating</h3><ReportBars data={['Critical','High','Medium','Low'].map(label=>({label,value:openFindings.filter(f=>f.riskRating===label).length}))}/></div>
          <div><h3>Action-plan status</h3><ReportBars data={actionBuckets.map(x=>({label:x.status,value:x.count}))}/></div>
        </div>
      </section>

      <section className="sb-report-page">
        <header><span>04</span><h2>Priority findings</h2></header>
        <table className="sb-report-table"><thead><tr><th>ID</th><th>Finding</th><th>Rating</th><th>Owner</th><th>Status</th></tr></thead><tbody>{high.slice(0,10).map(f=><tr key={f.id}><td>{f.id}</td><td>{f.observationTitle}</td><td><RatingBadge rating={f.riskRating}/></td><td>{state.users.find(u=>u.userId===f.ownerId)?.fullName}</td><td>{f.status}</td></tr>)}</tbody></table>
      </section>

      <section className="sb-report-page">
        <header><span>05</span><h2>Action status and follow-up</h2></header>
        <table className="sb-report-table"><thead><tr><th>Action</th><th>Finding</th><th>Owner</th><th>Due</th><th>Status</th></tr></thead><tbody>{state.actionPlans.filter(a=>a.status==='Overdue'||a.priority==='Critical').slice(0,12).map(a=><tr key={a.actionPlanId}><td>{a.actionPlanRef}</td><td>{a.findingId}</td><td>{state.users.find(u=>u.userId===a.ownerIds[0])?.fullName}</td><td>{formatDate(a.dueDate)}</td><td>{a.status}</td></tr>)}</tbody></table>
      </section>
    </div>}
  </div>;
}

function ReportBars({data}:{data:Array<{label:string;value:number}>}){
  const max=Math.max(1,...data.map(x=>x.value));
  return <div className="sb-report-bars" role="img" aria-label={data.map(x=>x.label+' '+x.value).join(', ')}>
    {data.map(x=><div key={x.label}><span>{x.label}</span><i><b style={{width:String((x.value/max)*100)+'%'}}/></i><strong>{x.value}</strong></div>)}
    <table className="sb-visually-hidden"><caption>Chart data</caption><thead><tr><th>Category</th><th>Count</th></tr></thead><tbody>{data.map(x=><tr key={x.label}><td>{x.label}</td><td>{x.value}</td></tr>)}</tbody></table>
  </div>;
}
