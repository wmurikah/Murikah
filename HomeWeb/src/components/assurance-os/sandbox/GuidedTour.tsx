import { useState } from 'react';
import { useSandbox } from '@/sandbox/store';
import type { ScreenId } from '@/sandbox/types';
import { Button } from './Ui';

const steps: Array<{screen:ScreenId;title:string;body:string}> = [
  {screen:'dashboard',title:'Read the portfolio',body:'Start with live KPIs, risk heat and items that need attention.'},
  {screen:'findings',title:'Open a finding',body:'Use the finding drawer to trace evidence, actions and activity.'},
  {screen:'actions',title:'Move an action',body:'Drag remediation work between permitted workflow states.'},
  {screen:'dashboard',title:'Switch role',body:'Change persona to see the permissions and scope each role receives.'},
  {screen:'reports',title:'Generate the pack',body:'Create a committee pack from the same records in the workspace.'},
  {screen:'audit-log',title:'Review the audit trail',body:'Every sandbox action writes an attributable event to the log.'},
];

export default function GuidedTour(){
  const {state,dispatch}=useSandbox();
  const [index,setIndex]=useState(0);
  if(state.tourDismissed) return null;
  const step=steps[index];
  return <>
    <div className="sb-tour-spotlight" aria-hidden="true"/>
    <aside className="sb-tour" aria-label="Sandbox guided tour">
      <small>Tour {index+1} of {steps.length}</small>
      <strong>{step.title}</strong>
      <p>{step.body}</p>
      <div>
        <Button variant="quiet" onClick={()=>dispatch({type:'DISMISS_TOUR'})}>Dismiss</Button>
        <Button variant="primary" onClick={()=>{
          dispatch({type:'NAVIGATE',screen:step.screen});
          if(index===steps.length-1) dispatch({type:'DISMISS_TOUR'}); else setIndex(i=>i+1);
        }}>{index===steps.length-1?'Finish':'Next'}</Button>
      </div>
    </aside>
  </>;
}
