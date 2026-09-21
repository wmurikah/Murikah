import { useMemo } from 'react';
import { useSandbox } from '@/sandbox/store';
import { daysBetween, formatDate } from '@/sandbox/date';
import { Panel, RatingBadge, Badge } from '../Ui';

const ratings = ['Critical','High','Medium','Low'] as const;
const stages = ['Planned','Fieldwork','Review','Reporting','Closed'] as const;

export default function DashboardScreen() {
  const { state, dispatch } = useSandbox();

  const metrics = useMemo(() => {
    const open = state.findings.filter(f => f.status !== 'Closed');
    const byRating = Object.fromEntries(ratings.map(r => [r, open.filter(f => f.riskRating === r).length])) as Record<string,number>;
    const overdueActions = state.actionPlans.filter(a => a.status === 'Overdue' || (daysBetween(a.dueDate) < 0 && !['Closed','Verified','Pending Verification'].includes(a.status))).length;
    const closed = state.actionPlans.filter(a => a.status === 'Closed');
    const onTime = closed.filter(a => daysBetween(a.dueDate, new Date(a.createdAt)) >= 0 || new Date(a.dueDate) >= new Date(a.createdAt)).length;
    const onTimeRate = closed.length ? Math.round((onTime / closed.length) * 100) : 100;
    const stageCounts = Object.fromEntries(stages.map(s => [s, state.engagements.filter(e => e.status === s).length])) as Record<string,number>;

    const ageing = [
      {label:'0–30',value:open.filter(f => Math.abs(daysBetween(f.createdAt)) <= 30).length},
      {label:'31–60',value:open.filter(f => {const d=Math.abs(daysBetween(f.createdAt)); return d>30&&d<=60;}).length},
      {label:'61–90',value:open.filter(f => {const d=Math.abs(daysBetween(f.createdAt)); return d>60&&d<=90;}).length},
      {label:'90+',value:open.filter(f => Math.abs(daysBetween(f.createdAt)) > 90).length},
    ];
    return {open,byRating,overdueActions,onTimeRate,stageCounts,ageing};
  }, [state]);

  const attention = useMemo(() => {
    const overdue = state.actionPlans.filter(a => a.status === 'Overdue').slice(0,3).map(a => ({
      id:a.actionPlanId,
      label:a.actionPlanRef + ' overdue · ' + a.actionDescription,
      meta:Math.abs(daysBetween(a.dueDate)) + ' days overdue',
      kind:'action'
    }));
    const reviews = state.workPapers.filter(w => w.status === 'Submitted').slice(0,3).map(w => ({
      id:w.workPaperId,label:w.workPaperRef + ' awaiting review · ' + w.observationTitle,meta:w.riskRating,kind:'review'
    }));
    const critical = state.findings.filter(f => f.riskRating === 'Critical' && f.status !== 'Closed').slice(0,2).map(f => ({
      id:f.id,label:f.id + ' critical finding · ' + f.observationTitle,meta:f.status,kind:'finding'
    }));
    return [...critical,...overdue,...reviews].slice(0,7);
  }, [state]);

  const maxAge = Math.max(1, ...metrics.ageing.map(x=>x.value));

  return <div className="sb-screen" data-tour="dashboard">
    <div className="sb-page-head">
      <div><h1>Dashboard</h1><p>Portfolio view for {state.organization.organizationName}.</p></div>
      <Badge tone="info">{state.activeAffiliateCode === 'HO' ? 'Head Office' : 'Nakuru Branch'}</Badge>
    </div>

    <div className="sb-kpis">
      <button className="sb-kpi" onClick={()=>dispatch({type:'NAVIGATE',screen:'findings'})}>
        <span>Open findings</span>
        <strong>{metrics.open.length}</strong>
        <small>{ratings.map(r=>r + ' ' + metrics.byRating[r]).join(' · ')}</small>
      </button>
      <button className="sb-kpi sb-kpi--attention" onClick={()=>dispatch({type:'NAVIGATE',screen:'actions'})}>
        <span>Overdue actions</span>
        <strong>{metrics.overdueActions}</strong>
        <small>Past due and not settled</small>
      </button>
      <button className="sb-kpi" onClick={()=>dispatch({type:'NAVIGATE',screen:'engagements'})}>
        <span>Engagements</span>
        <strong>{state.engagements.length}</strong>
        <small>{stages.filter(s=>metrics.stageCounts[s]).map(s=>s + ' ' + metrics.stageCounts[s]).join(' · ')}</small>
      </button>
      <div className="sb-kpi">
        <span>On-time closure rate</span>
        <strong>{metrics.onTimeRate}%</strong>
        <small>Closed actions completed to target</small>
      </div>
    </div>

    <div className="sb-grid sb-grid--2">
      <Panel title="Residual risk heat map">
        <div className="sb-heat" role="img" aria-label="5 by 5 residual risk heat map. Higher impact is shown toward the top and higher likelihood to the right.">
          {[5,4,3,2,1].map(impact => <div className="sb-heat__row" key={impact}>
            <span className="sb-heat__axis">{impact}</span>
            {[1,2,3,4,5].map(likelihood => {
              const count=state.risks.filter(r=>r.residualImpact===impact&&r.residualLikelihood===likelihood).length;
              const score=impact*likelihood;
              const tone=score>=20?'critical':score>=12?'high':score>=6?'medium':'low';
              return <button key={likelihood} className={'sb-heat__cell sb-heat__cell--'+tone} aria-label={'Impact '+impact+', likelihood '+likelihood+', '+count+' risks'} onClick={()=>dispatch({type:'NAVIGATE',screen:'risks'})}>
                {count || ''}
              </button>;
            })}
          </div>)}
          <div className="sb-heat__x"><span>Likelihood</span><span>1</span><span>2</span><span>3</span><span>4</span><span>5</span></div>
        </div>
        <p className="sb-chart-summary">Residual risk is calculated from the 25 seeded register entries. Select any cell to open the register.</p>
      </Panel>

      <Panel title="Findings ageing">
        <div className="sb-ageing" aria-label="Findings ageing chart">
          {metrics.ageing.map(item=><div className="sb-ageing__row" key={item.label}>
            <span>{item.label} days</span>
            <div><i style={{width:String(Math.max(4,(item.value/maxAge)*100))+'%'}}/></div>
            <strong>{item.value}</strong>
          </div>)}
        </div>
        <table className="sb-visually-hidden"><caption>Findings ageing data</caption><thead><tr><th>Age</th><th>Findings</th></tr></thead><tbody>{metrics.ageing.map(x=><tr key={x.label}><td>{x.label}</td><td>{x.value}</td></tr>)}</tbody></table>
      </Panel>
    </div>

    <div className="sb-grid sb-grid--2">
      <Panel title="Needs your attention">
        {attention.length===0 ? <p className="sb-muted">Nothing needs attention.</p> : <ul className="sb-attention-list">
          {attention.map(item=><li key={item.kind+'-'+item.id}>
            <button onClick={()=>{
              if(item.kind==='action') dispatch({type:'NAVIGATE',screen:'actions'});
              else if(item.kind==='finding'){dispatch({type:'NAVIGATE',screen:'findings'});dispatch({type:'SELECT_FINDING',findingId:item.id});}
              else {dispatch({type:'NAVIGATE',screen:'engagements'});dispatch({type:'SELECT_WORK_PAPER',workPaperId:item.id});}
            }}><span>{item.label}</span><small>{item.meta}</small></button>
          </li>)}
        </ul>}
      </Panel>

      <Panel title="Engagement progress">
        <div className="sb-progress-list">
          {state.engagements.slice(0,6).map(e=><button key={e.engagementId} onClick={()=>{dispatch({type:'NAVIGATE',screen:'engagements'});dispatch({type:'SELECT_ENGAGEMENT',engagementId:e.engagementId});}}>
            <div><strong>{e.title}</strong><span>{e.status} · {formatDate(e.endDate)}</span></div>
            <div className="sb-progress"><i style={{width:String(e.progress)+'%'}}/></div>
            <b>{e.progress}%</b>
          </button>)}
        </div>
      </Panel>
    </div>
  </div>;
}
