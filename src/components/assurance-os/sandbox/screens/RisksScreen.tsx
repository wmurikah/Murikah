import { useMemo, useState } from 'react';
import { useSandbox } from '@/sandbox/store';
import { Badge, Drawer, Panel } from '../Ui';

function tone(score:number){return score>=20?'critical':score>=12?'high':score>=6?'medium':'low';}

export default function RisksScreen(){
  const {state}=useSandbox();
  const [cell,setCell]=useState<{impact:number;likelihood:number}|null>(null);
  const [selectedId,setSelectedId]=useState<string|null>(null);
  const selected=state.risks.find(r=>r.riskId===selectedId) ?? null;

  const filtered=useMemo(()=>cell?state.risks.filter(r=>r.residualImpact===cell.impact&&r.residualLikelihood===cell.likelihood):state.risks,[state.risks,cell]);

  return <div className="sb-screen">
    <div className="sb-page-head"><div><h1>Risk register</h1><p>25 risks with inherent and residual ratings linked to control references.</p></div>{cell&&<button className="sb-link" onClick={()=>setCell(null)}>Clear heat-map filter</button>}</div>
    <div className="sb-grid sb-grid--2">
      <Panel title="Residual risk heat map">
        <div className="sb-heat sb-heat--large" role="grid" aria-label="Residual risk matrix">
          {[5,4,3,2,1].map(impact=><div className="sb-heat__row" role="row" key={impact}>
            <span className="sb-heat__axis">{impact}</span>
            {[1,2,3,4,5].map(likelihood=>{
              const risks=state.risks.filter(r=>r.residualImpact===impact&&r.residualLikelihood===likelihood);
              return <button role="gridcell" aria-selected={cell?.impact===impact&&cell?.likelihood===likelihood} key={likelihood} className={'sb-heat__cell sb-heat__cell--'+tone(impact*likelihood)} onClick={()=>setCell({impact,likelihood})}>{risks.length||''}</button>;
            })}
          </div>)}
          <div className="sb-heat__x"><span>Likelihood</span><span>1</span><span>2</span><span>3</span><span>4</span><span>5</span></div>
        </div>
        <p className="sb-chart-summary">Impact runs 1–5 vertically; likelihood runs 1–5 horizontally. Counts show residual positions.</p>
      </Panel>
      <Panel title="Portfolio summary">
        <div className="sb-risk-summary">
          {['Outside appetite','Within appetite'].map(value=><div key={value}><strong>{state.risks.filter(r=>r.appetite===value).length}</strong><span>{value}</span></div>)}
          <div><strong>{state.risks.filter(r=>r.residualImpact*r.residualLikelihood>=12).length}</strong><span>High / critical residual</span></div>
          <div><strong>{new Set(state.risks.flatMap(r=>r.controlLinks)).size}</strong><span>Linked controls</span></div>
        </div>
      </Panel>
    </div>

    <Panel title={cell?'Risks in selected cell · '+filtered.length:'Risk register · '+filtered.length}>
      <div className="sb-table-wrap"><table className="sb-table sb-table--sticky"><thead><tr><th>Risk</th><th>Process</th><th>Owner</th><th>Inherent</th><th>Residual</th><th>Appetite</th><th>Controls</th></tr></thead>
        <tbody>{filtered.map(r=><tr key={r.riskId} onClick={()=>setSelectedId(r.riskId)}>
          <td><strong>{r.riskId}</strong><small>{r.title}</small></td><td>{r.process}</td><td>{state.users.find(u=>u.userId===r.ownerId)?.fullName}</td>
          <td><Badge tone={tone(r.inherentImpact*r.inherentLikelihood)}>{r.inherentLikelihood} × {r.inherentImpact}</Badge></td>
          <td><Badge tone={tone(r.residualImpact*r.residualLikelihood)}>{r.residualLikelihood} × {r.residualImpact}</Badge></td>
          <td>{r.appetite}</td><td>{r.controlLinks.join(', ')}</td>
        </tr>)}</tbody>
      </table></div>
    </Panel>

    <Drawer open={!!selected} title={selected?selected.riskId+' · '+selected.title:'Risk'} onClose={()=>setSelectedId(null)}>
      {selected&&<div className="sb-risk-detail">
        <dl className="sb-detail-list"><div><dt>Process</dt><dd>{selected.process}</dd></div><div><dt>Owner</dt><dd>{state.users.find(u=>u.userId===selected.ownerId)?.fullName}</dd></div><div><dt>Inherent rating</dt><dd>{selected.inherentLikelihood} likelihood × {selected.inherentImpact} impact</dd></div><div><dt>Residual rating</dt><dd>{selected.residualLikelihood} likelihood × {selected.residualImpact} impact</dd></div><div><dt>Risk appetite</dt><dd>{selected.appetite}</dd></div><div><dt>Treatment</dt><dd>{selected.treatment}</dd></div><div><dt>Linked controls</dt><dd>{selected.controlLinks.join(', ')}</dd></div></dl>
      </div>}
    </Drawer>
  </div>;
}
