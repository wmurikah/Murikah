import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { SandboxProvider, useSandbox } from '@/sandbox/store';
import type { ScreenId } from '@/sandbox/types';
import { canAccessScreen } from '@/sandbox/permissions';
import { Icon, type IconName } from './sandbox/Icon';
import { LoadingRows } from './sandbox/Ui';
import CommandPalette from './sandbox/CommandPalette';
import GuidedTour from './sandbox/GuidedTour';
import './sandbox/Sandbox.css';

const DashboardScreen = lazy(() => import('./sandbox/screens/DashboardScreen'));
const PlanScreen = lazy(() => import('./sandbox/screens/PlanScreen'));
const EngagementsScreen = lazy(() => import('./sandbox/screens/EngagementsScreen'));
const FindingsScreen = lazy(() => import('./sandbox/screens/FindingsScreen'));
const ActionsScreen = lazy(() => import('./sandbox/screens/ActionsScreen'));
const RisksScreen = lazy(() => import('./sandbox/screens/RisksScreen'));
const ReportsScreen = lazy(() => import('./sandbox/screens/ReportsScreen'));
const AuditLogScreen = lazy(() => import('./sandbox/screens/AuditLogScreen'));

const nav: Array<{id:ScreenId;label:string;icon:IconName}> = [
  {id:'dashboard',label:'Dashboard',icon:'dashboard'},
  {id:'plan',label:'Audit plan',icon:'calendar'},
  {id:'engagements',label:'Engagements',icon:'briefcase'},
  {id:'findings',label:'Findings',icon:'finding'},
  {id:'actions',label:'Actions',icon:'check'},
  {id:'risks',label:'Risk register',icon:'risk'},
  {id:'reports',label:'Reports',icon:'report'},
  {id:'audit-log',label:'Audit log',icon:'history'},
];

const mobileMain: ScreenId[] = ['dashboard','plan','findings','actions'];

export default function PublicSandbox(){
  return <SandboxProvider><SandboxApp/></SandboxProvider>;
}

function SandboxApp(){
  const {state,dispatch,reset}=useSandbox();
  const [palette,setPalette]=useState(false);
  const [notificationsOpen,setNotificationsOpen]=useState(false);
  const [avatarOpen,setAvatarOpen]=useState(false);
  const [shortcutsOpen,setShortcutsOpen]=useState(false);
  const [mobileMore,setMobileMore]=useState(false);
  const [fullScreen,setFullScreen]=useState(false);
  const [hydrated,setHydrated]=useState(false);

  useEffect(()=>{
    const timer=window.setTimeout(()=>setHydrated(true),180);
    return()=>window.clearTimeout(timer);
  },[]);

  useEffect(()=>{
    const handler=(event:KeyboardEvent)=>{
      const target=event.target as HTMLElement | null;
      const typing=target && ['INPUT','TEXTAREA','SELECT'].includes(target.tagName);
      if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'){event.preventDefault();setPalette(true);return;}
      if(!typing&&event.key==='?'){event.preventDefault();setShortcutsOpen(true);}
    };
    window.addEventListener('keydown',handler);
    return()=>window.removeEventListener('keydown',handler);
  },[]);

  useEffect(()=>{
    document.documentElement.classList.toggle('sandbox-fullscreen',fullScreen);
    return()=>document.documentElement.classList.remove('sandbox-fullscreen');
  },[fullScreen]);

  useEffect(()=>{
    const exit=()=>setFullScreen(false);
    window.addEventListener('murikah:sandbox-exit-fullscreen',exit);
    return()=>window.removeEventListener('murikah:sandbox-exit-fullscreen',exit);
  },[]);

  useEffect(()=>{
    if(!state.undo) return;
    const timer=window.setTimeout(()=>dispatch({type:'CLEAR_UNDO'}),7000);
    return()=>window.clearTimeout(timer);
  },[state.undo,dispatch]);

  const counts=useMemo(()=>({
    plan:state.engagements.length,
    engagements:state.engagements.filter(e=>e.status!=='Closed').length,
    findings:state.findings.filter(f=>f.status!=='Closed').length,
    actions:state.actionPlans.filter(a=>!['Closed','Verified'].includes(a.status)).length,
    risks:state.risks.length,
    reports:1,
    'audit-log':state.auditLog.length,
  }),[state]);

  const activeUser=state.users.find(u=>u.userId===state.activeUserId) ?? state.users[0];
  const visibleNav = nav.filter(item => canAccessScreen(state.activeRoleCode, item.id));
  const unread=state.notifications.filter(n=>!n.read).length;
  const activeNav=nav.find(item=>item.id===state.screen);
  const entity=state.organization.entities.find(e=>e.affiliateCode===state.activeAffiliateCode);

  const screen=<Suspense fallback={<div className="sb-screen"><LoadingRows rows={9}/></div>}>
    {state.screen==='dashboard'&&<DashboardScreen/>}
    {state.screen==='plan'&&<PlanScreen/>}
    {state.screen==='engagements'&&<EngagementsScreen/>}
    {state.screen==='findings'&&<FindingsScreen/>}
    {state.screen==='actions'&&<ActionsScreen/>}
    {state.screen==='risks'&&<RisksScreen/>}
    {state.screen==='reports'&&<ReportsScreen/>}
    {state.screen==='audit-log'&&<AuditLogScreen/>}
  </Suspense>;

  return <div className="sb-root" data-nosnippet>
    <div className="sb-demo-banner">
      <span>Fictional sample data. Changes stay in your browser.</span>
      <span className="sb-demo-banner__privacy">Nothing you type leaves your browser.</span>
      <button onClick={()=>{if(window.confirm('Reset all sandbox changes to the original sample data?')) reset();}}>Reset</button>
      <a href="/contact?intent=call">Book a call</a>
    </div>

    <div className="sb-app" aria-label="Assurance OS sample workspace">
      <aside className="sb-sidebar">
        <div className="sb-sidebar__brand">
          <img src="/brand/murikah-header-lockup.svg" alt="Murikah" width="875" height="155"/>
          <span>Assurance OS</span>
        </div>

        <label className="sb-workspace">
          <span>Workspace</span>
          <select value={state.activeAffiliateCode} onChange={e=>dispatch({type:'SWITCH_ENTITY',affiliateCode:e.target.value})}>
            {state.organization.entities.map(item=><option key={item.affiliateCode} value={item.affiliateCode}>{item.affiliateName}</option>)}
          </select>
        </label>

        <nav className="sb-nav" aria-label="Assurance OS sandbox">
          {visibleNav.map(item=>{
            const count=(counts as Record<string,number>)[item.id];
            return <button key={item.id} className={state.screen===item.id?'is-active':''} onClick={()=>dispatch({type:'NAVIGATE',screen:item.id})} data-tour={item.id}>
              <Icon name={item.icon}/><span>{item.label}</span>{count!=null&&<b>{count>999?'999+':count}</b>}
            </button>;
          })}
        </nav>

        <div className="sb-sidebar__foot">
          <button onClick={()=>setFullScreen(v=>!v)}><Icon name="expand"/><span>{fullScreen?'Exit full screen':'Open full screen'}</span></button>
          <button onClick={()=>setShortcutsOpen(true)}><span className="sb-key">?</span><span>Keyboard shortcuts</span></button>
        </div>
      </aside>

      <section className="sb-main">
        <header className="sb-topbar">
          <div className="sb-breadcrumb"><span>Assurance OS</span><i>/</i><strong>{activeNav?.label}</strong>{entity&&<><i>/</i><span>{entity.affiliateName}</span></>}</div>

          <button className="sb-global-search" onClick={()=>setPalette(true)} aria-label="Search and command palette">
            <Icon name="search"/><span>Search or jump to…</span><kbd>⌘K</kbd>
          </button>

          <div className="sb-topbar__actions">
            <div className="sb-popover-wrap">
              <button className="sb-icon-btn" aria-label={'Notifications, '+unread+' unread'} onClick={()=>setNotificationsOpen(v=>!v)}>
                <Icon name="bell"/>{unread>0&&<b className="sb-notification-dot">{unread}</b>}
              </button>
              {notificationsOpen&&<div className="sb-popover sb-notifications">
                <header><strong>Notifications</strong><span>{unread} unread</span></header>
                {state.notifications.map(n=><button key={n.id} onClick={()=>dispatch({type:'MARK_NOTIFICATION',id:n.id})} className={n.read?'is-read':''}><span>{n.title}</span><small>{n.read?'Read':'New'}</small></button>)}
              </div>}
            </div>

            <label className="sb-role-switch" data-tour="roles">
              <span className="sb-visually-hidden">Acting role</span>
              <select value={state.activeUserId} onChange={e=>dispatch({type:'SWITCH_ROLE',userId:e.target.value})}>
                {state.users.map(user=><option value={user.userId} key={user.userId}>{user.roleLabel}</option>)}
              </select>
            </label>

            <div className="sb-popover-wrap">
              <button className="sb-avatar" onClick={()=>setAvatarOpen(v=>!v)} aria-label="User menu">{activeUser.avatar}</button>
              {avatarOpen&&<div className="sb-popover sb-user-menu"><strong>{activeUser.fullName}</strong><span>{activeUser.roleLabel}</span><span>{activeUser.email}</span><hr/><span>Browser-only sandbox session</span></div>}
            </div>
          </div>
        </header>

        <main className="sb-content">
          {!hydrated?<div className="sb-screen"><div className="sb-page-head"><div className="sb-skeleton sb-skeleton--title"/><div className="sb-skeleton sb-skeleton--small"/></div><LoadingRows rows={9}/></div>:screen}
        </main>
      </section>

      <nav className="sb-mobile-tabs" aria-label="Sandbox mobile navigation">
        {visibleNav.filter(item=>mobileMain.includes(item.id)).map(item=><button key={item.id} className={state.screen===item.id?'is-active':''} onClick={()=>dispatch({type:'NAVIGATE',screen:item.id})}><Icon name={item.icon}/><span>{item.label.replace('Audit ','')}</span></button>)}
        <div className="sb-popover-wrap"><button className={mobileMain.includes(state.screen)?'':'is-active'} onClick={()=>setMobileMore(v=>!v)}><Icon name="more"/><span>More</span></button>{mobileMore&&<div className="sb-popover sb-mobile-more">{visibleNav.filter(item=>!mobileMain.includes(item.id)).map(item=><button key={item.id} onClick={()=>{dispatch({type:'NAVIGATE',screen:item.id});setMobileMore(false);}}><Icon name={item.icon}/><span>{item.label}</span></button>)}</div>}</div>
      </nav>
    </div>

    <CommandPalette open={palette} onClose={()=>setPalette(false)}/>
    <GuidedTour/>

    {shortcutsOpen&&<div className="sb-overlay" onMouseDown={e=>{if(e.target===e.currentTarget)setShortcutsOpen(false);}}>
      <div className="sb-shortcuts" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
        <header><strong>Keyboard shortcuts</strong><button className="sb-icon-btn" onClick={()=>setShortcutsOpen(false)} aria-label="Close"><Icon name="x"/></button></header>
        <dl><div><dt>Search / command palette</dt><dd><kbd>⌘/Ctrl</kbd> + <kbd>K</kbd></dd></div><div><dt>Move in findings list</dt><dd><kbd>J</kbd> / <kbd>K</kbd></dd></div><div><dt>Open selected row</dt><dd><kbd>Enter</kbd></dd></div><div><dt>Close drawer / dialog</dt><dd><kbd>Esc</kbd></dd></div><div><dt>Show shortcuts</dt><dd><kbd>?</kbd></dd></div></dl>
      </div>
    </div>}

    {state.undo&&<div className="sb-toast" role="status" aria-live="polite"><span>{state.undo.label}</span><button onClick={()=>dispatch({type:'UNDO_LAST'})}>Undo</button><button aria-label="Dismiss" onClick={()=>dispatch({type:'CLEAR_UNDO'})}><Icon name="x" size={14}/></button></div>}
  </div>;
}
