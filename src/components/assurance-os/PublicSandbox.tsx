import { useMemo, useState } from 'react';

type Tab = 'overview' | 'findings' | 'actions' | 'report';
type ActionStatus = 'Open' | 'In progress' | 'Closed';

const findings = [
  {
    id: 'F-014',
    title: 'User access reviews need documented approval',
    risk: 'High',
    area: 'Identity & access',
    owner: 'Head of ICT',
  },
  {
    id: 'F-021',
    title: 'Backup restore evidence is not retained consistently',
    risk: 'Medium',
    area: 'Resilience',
    owner: 'Infrastructure Lead',
  },
  {
    id: 'F-027',
    title: 'Vendor access recertification is overdue',
    risk: 'Medium',
    area: 'Third-party access',
    owner: 'Application Owner',
  },
];

const actionSeed = [
  {
    id: 'A-041',
    finding: 'F-014',
    action: 'Complete the quarterly access review and retain signed approval.',
    owner: 'Head of ICT',
    due: '30 Sep 2026',
    status: 'In progress' as ActionStatus,
  },
  {
    id: 'A-052',
    finding: 'F-021',
    action: 'Run a restore test and retain the recovery evidence.',
    owner: 'Infrastructure Lead',
    due: '15 Oct 2026',
    status: 'Open' as ActionStatus,
  },
  {
    id: 'A-063',
    finding: 'F-027',
    action: 'Recertify vendor accounts and remove access no longer required.',
    owner: 'Application Owner',
    due: '20 Sep 2026',
    status: 'Open' as ActionStatus,
  },
];

const tabs: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'findings', label: 'Findings' },
  { id: 'actions', label: 'Actions' },
  { id: 'report', label: 'Board pack' },
];

function StatusPill({ status }: { status: ActionStatus }) {
  return (
    <span className="inline-flex rounded-full bg-paper px-2.5 py-1 text-xs font-medium text-navy ring-1 ring-hairline">
      {status}
    </span>
  );
}

export default function PublicSandbox() {
  const [active, setActive] = useState<Tab>('overview');
  const [statuses, setStatuses] = useState<Record<string, ActionStatus>>(
    Object.fromEntries(actionSeed.map((item) => [item.id, item.status])),
  );

  const closed = useMemo(
    () => Object.values(statuses).filter((status) => status === 'Closed').length,
    [statuses],
  );
  const openActions = actionSeed.length - closed;

  const rotateStatus = (id: string) => {
    setStatuses((current) => {
      const next: Record<ActionStatus, ActionStatus> = {
        Open: 'In progress',
        'In progress': 'Closed',
        Closed: 'Open',
      };
      return { ...current, [id]: next[current[id] ?? 'Open'] };
    });
  };

  return (
    <div className="overflow-hidden rounded-[1.5rem] bg-surface shadow-card ring-1 ring-hairline">
      <div className="flex flex-col gap-3 border-b border-hairline bg-paper px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-semibold text-navy">Assurance OS public sandbox</p>
          <p className="mt-1 text-xs text-slate">
            Fictional sample data only. Changes stay in this browser session and reset on refresh.
          </p>
        </div>
        <span className="w-fit rounded-full bg-surface px-3 py-1 text-xs font-semibold text-gold ring-1 ring-hairline">
          No sign-in
        </span>
      </div>

      <div
        role="tablist"
        aria-label="Assurance OS sample workspace"
        className="flex gap-1 overflow-x-auto border-b border-hairline bg-paper px-3 py-2"
      >
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active === tab.id}
            aria-controls={`sandbox-panel-${tab.id}`}
            id={`sandbox-tab-${tab.id}`}
            onClick={() => setActive(tab.id)}
            className={[
              'min-h-11 shrink-0 rounded-btn px-4 text-sm font-medium transition-colors',
              active === tab.id
                ? 'bg-navy text-paper'
                : 'bg-transparent text-navy hover:bg-surface',
            ].join(' ')}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="p-5 sm:p-6">
        {active === 'overview' && (
          <section
            id="sandbox-panel-overview"
            role="tabpanel"
            aria-labelledby="sandbox-tab-overview"
          >
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="rounded-card bg-paper p-5 ring-1 ring-hairline">
                <p className="text-xs font-semibold tracking-[0.1em] text-slate uppercase">
                  Engagements
                </p>
                <p className="mt-2 text-3xl font-semibold text-navy">6</p>
                <p className="mt-2 text-sm text-slate">2 fieldwork · 1 review · 3 planned</p>
              </div>
              <div className="rounded-card bg-paper p-5 ring-1 ring-hairline">
                <p className="text-xs font-semibold tracking-[0.1em] text-slate uppercase">
                  Open findings
                </p>
                <p className="mt-2 text-3xl font-semibold text-navy">{findings.length}</p>
                <p className="mt-2 text-sm text-slate">1 high · 2 medium</p>
              </div>
              <div className="rounded-card bg-paper p-5 ring-1 ring-hairline">
                <p className="text-xs font-semibold tracking-[0.1em] text-slate uppercase">
                  Open actions
                </p>
                <p className="mt-2 text-3xl font-semibold text-navy">{openActions}</p>
                <p className="mt-2 text-sm text-slate">{closed} closed in this sandbox session</p>
              </div>
            </div>

            <div className="mt-5 rounded-card bg-paper p-5 ring-1 ring-hairline">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold tracking-[0.1em] text-gold uppercase">
                    Current engagement
                  </p>
                  <h3 className="mt-2 text-xl text-navy">Identity and access management review</h3>
                  <p className="mt-2 max-w-2xl text-sm text-slate">
                    The sample shows the evidence chain from fieldwork through finding, owned action
                    and committee reporting.
                  </p>
                </div>
                <span className="rounded-full bg-surface px-3 py-1 text-xs font-medium text-navy ring-1 ring-hairline">
                  Review
                </span>
              </div>
              <ol className="mt-5 grid gap-3 sm:grid-cols-4">
                {['Scope agreed', 'Evidence tested', 'Finding reviewed', 'Action tracked'].map(
                  (step, index) => (
                    <li key={step} className="flex items-center gap-2 text-sm text-navy">
                      <span className="inline-flex size-6 items-center justify-center rounded-full bg-surface text-xs font-semibold text-gold ring-1 ring-hairline">
                        {index + 1}
                      </span>
                      {step}
                    </li>
                  ),
                )}
              </ol>
            </div>
          </section>
        )}

        {active === 'findings' && (
          <section
            id="sandbox-panel-findings"
            role="tabpanel"
            aria-labelledby="sandbox-tab-findings"
          >
            <div className="overflow-x-auto">
              <table className="min-w-[46rem] w-full border-collapse text-left">
                <thead>
                  <tr className="border-b border-hairline">
                    <th className="px-3 py-3 text-xs font-semibold tracking-[0.08em] text-slate uppercase">
                      Finding
                    </th>
                    <th className="px-3 py-3 text-xs font-semibold tracking-[0.08em] text-slate uppercase">
                      Area
                    </th>
                    <th className="px-3 py-3 text-xs font-semibold tracking-[0.08em] text-slate uppercase">
                      Risk
                    </th>
                    <th className="px-3 py-3 text-xs font-semibold tracking-[0.08em] text-slate uppercase">
                      Owner
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {findings.map((finding) => (
                    <tr key={finding.id} className="border-b border-hairline last:border-0">
                      <td className="px-3 py-4">
                        <p className="text-xs font-medium text-gold">{finding.id}</p>
                        <p className="mt-1 font-medium text-navy">{finding.title}</p>
                      </td>
                      <td className="px-3 py-4 text-sm text-slate">{finding.area}</td>
                      <td className="px-3 py-4">
                        <span className="rounded-full bg-paper px-2.5 py-1 text-xs font-semibold text-navy ring-1 ring-hairline">
                          {finding.risk}
                        </span>
                      </td>
                      <td className="px-3 py-4 text-sm text-slate">{finding.owner}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {active === 'actions' && (
          <section
            id="sandbox-panel-actions"
            role="tabpanel"
            aria-labelledby="sandbox-tab-actions"
          >
            <p className="mb-4 text-sm text-slate">
              Select a status button to move a sample action through Open → In progress → Closed.
            </p>
            <div className="grid gap-4">
              {actionSeed.map((item) => (
                <article key={item.id} className="rounded-card bg-paper p-5 ring-1 ring-hairline">
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <p className="text-xs font-semibold text-gold">
                        {item.id} · linked to {item.finding}
                      </p>
                      <h3 className="mt-2 text-lg text-navy">{item.action}</h3>
                      <p className="mt-2 text-sm text-slate">
                        {item.owner} · Due {item.due}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => rotateStatus(item.id)}
                      className="min-h-11 shrink-0 rounded-btn bg-surface px-4 text-sm font-medium text-navy ring-1 ring-hairline hover:bg-paper-shade"
                      aria-label={`Change status for ${item.id}. Current status ${statuses[item.id]}`}
                    >
                      <StatusPill status={statuses[item.id] ?? 'Open'} />
                    </button>
                  </div>
                </article>
              ))}
            </div>
            <p className="mt-4 text-sm text-slate" aria-live="polite">
              {closed} of {actionSeed.length} sample actions closed.
            </p>
          </section>
        )}

        {active === 'report' && (
          <section
            id="sandbox-panel-report"
            role="tabpanel"
            aria-labelledby="sandbox-tab-report"
          >
            <div className="rounded-card bg-paper p-5 ring-1 ring-hairline">
              <p className="text-xs font-semibold tracking-[0.1em] text-gold uppercase">
                Audit & Risk Committee · sample pack
              </p>
              <h3 className="mt-3 text-2xl text-navy">Q3 assurance summary</h3>
              <div className="mt-5 grid gap-5 sm:grid-cols-2">
                <div>
                  <p className="text-sm font-semibold text-navy">What changed</p>
                  <ul className="mt-2 grid gap-2 text-sm text-slate">
                    <li>• Identity and access review moved to reviewer sign-off.</li>
                    <li>• Three findings remain open in the sample portfolio.</li>
                    <li>• {closed} remediation action{closed === 1 ? '' : 's'} closed in this session.</li>
                  </ul>
                </div>
                <div>
                  <p className="text-sm font-semibold text-navy">Committee attention</p>
                  <ul className="mt-2 grid gap-2 text-sm text-slate">
                    <li>• High-risk access-review finding remains open.</li>
                    <li>• One action is at its sample due date.</li>
                    <li>• Follow-up status is generated from the same action records.</li>
                  </ul>
                </div>
              </div>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
