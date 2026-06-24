import { useState } from 'react';
import DemoBadge from './DemoBadge';
import AuditOsDemo from './AuditOsDemo';
import ExtractDemo from './ExtractDemo';
import WorkflowDemo from './WorkflowDemo';
import CrmDemo from './CrmDemo';

interface Cta {
  text: string;
  secondaryLabel: string;
  secondaryHref: string;
}

const TABS: { id: string; label: string; cta: Cta }[] = [
  {
    id: 'auditos',
    label: 'Audit OS',
    cta: {
      text: 'This is Audit OS with sample data. Book a live demo and we will load a scenario from your world.',
      secondaryLabel: 'See Audit OS',
      secondaryHref: '/audit-os',
    },
  },
  {
    id: 'extract',
    label: 'Document extraction',
    cta: {
      text: 'We build automations like this against your real documents and systems. Talk to Labs.',
      secondaryLabel: 'See Murikah Labs',
      secondaryHref: '/labs',
    },
  },
  {
    id: 'workflow',
    label: 'Workflow engine',
    cta: {
      text: 'This is a sketch of what we engineer for finance, operations and compliance. Talk to Labs.',
      secondaryLabel: 'See Murikah Labs',
      secondaryHref: '/labs',
    },
  },
  {
    id: 'crm',
    label: 'Mini-CRM',
    cta: {
      text: 'We build CRMs and the automations behind them. Talk to Labs.',
      secondaryLabel: 'See Murikah Labs',
      secondaryHref: '/labs',
    },
  },
];

export default function LabsSandbox() {
  const [active, setActive] = useState('auditos');
  const tab = TABS.find((t) => t.id === active) ?? TABS[0];

  return (
    <div className="rounded-card bg-surface p-5 ring-1 ring-hairline/70 sm:p-7">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div role="tablist" aria-label="Labs demos" className="flex flex-wrap gap-1.5">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              id={`tab-${t.id}`}
              aria-selected={active === t.id}
              aria-controls={`panel-${t.id}`}
              onClick={() => setActive(t.id)}
              className={`min-h-[2.75rem] rounded-md px-4 text-sm font-medium transition-colors ${
                active === t.id
                  ? 'bg-navy text-white'
                  : 'bg-paper-shade text-ink hover:bg-hairline/60'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <DemoBadge />
      </div>

      <div
        id={`panel-${tab.id}`}
        role="tabpanel"
        aria-labelledby={`tab-${tab.id}`}
        className="mt-7"
      >
        {active === 'auditos' && <AuditOsDemo />}
        {active === 'extract' && <ExtractDemo />}
        {active === 'workflow' && <WorkflowDemo />}
        {active === 'crm' && <CrmDemo />}
      </div>

      <div className="mt-8 flex flex-col gap-3 border-t border-hairline pt-6 sm:flex-row sm:items-center sm:justify-between">
        <p className="max-w-xl text-sm text-slate">{tab.cta.text}</p>
        <div className="flex shrink-0 gap-3">
          <a
            href="/contact"
            className="inline-flex min-h-[2.75rem] items-center justify-center rounded-btn bg-gold px-5 font-medium text-navy hover:bg-gold-deep"
          >
            Book a demo
          </a>
          <a
            href={tab.cta.secondaryHref}
            className="inline-flex min-h-[2.75rem] items-center justify-center rounded-btn px-4 text-sm font-medium text-navy ring-1 ring-hairline ring-inset hover:bg-paper-shade"
          >
            {tab.cta.secondaryLabel}
          </a>
        </div>
      </div>
    </div>
  );
}
