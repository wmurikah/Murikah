import { useEffect, useState } from 'react';
import type { CrmContact, CrmStage } from '@/lib/demo/sample-data';
import { getJson, postJson, kes, clock } from './demo-client';

const COLUMNS: CrmStage[] = ['Lead', 'Qualified', 'Proposal', 'Won'];

interface ActivityEvent {
  type: 'email' | 'task' | 'audit';
  detail: string;
  at: string;
}

export default function CrmDemo() {
  const [deals, setDeals] = useState<CrmContact[]>([]);
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState('');

  async function load() {
    setLoading(true);
    setActivity([]);
    const { data } = await getJson<{ contacts: CrmContact[] }>('/api/demo/labs/crm');
    if (data.ok) setDeals(data.contacts.map((c) => ({ ...c })));
    setLoading(false);
  }

  useEffect(() => {
    void load();
  }, []);

  async function markWon(deal: CrmContact) {
    if (deal.stage === 'Won') return;
    setBusyId(deal.id);
    const { data } = await postJson<{ ok?: boolean; events?: ActivityEvent[] }>(
      '/api/demo/labs/crm',
      {
        dealId: deal.id,
        name: deal.name,
        company: deal.company,
        toStage: 'Won',
      },
    );
    setBusyId('');
    if (data.ok && data.events) {
      setDeals((prev) => prev.map((d) => (d.id === deal.id ? { ...d, stage: 'Won' } : d)));
      setActivity((prev) => [...data.events!, ...prev].slice(0, 30));
    }
  }

  if (loading) return <p className="text-slate">Loading the pipeline...</p>;

  return (
    <div>
      <p className="text-slate">
        A seeded sample pipeline. Mark a deal Won and a bounded automation fires: a simulated email,
        a task, and an audit-log entry.
      </p>

      <div className="mt-5 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {COLUMNS.map((stage) => (
          <div key={stage} className="rounded-card bg-paper p-3 ring-1 ring-hairline/70">
            <p className="px-1 pb-2 text-sm font-semibold text-navy">{stage}</p>
            <ul className="space-y-2">
              {deals
                .filter((d) => d.stage === stage)
                .map((d) => (
                  <li key={d.id} className="rounded-lg bg-surface p-3 ring-1 ring-hairline/70">
                    <p className="font-medium text-navy">{d.company}</p>
                    <p className="text-sm text-slate">{d.name}</p>
                    <p className="mt-1 text-sm text-ink">{kes(d.value)} / month</p>
                    {stage !== 'Won' && (
                      <button
                        onClick={() => void markWon(d)}
                        disabled={busyId === d.id}
                        className="mt-2 inline-flex min-h-[2.25rem] items-center justify-center rounded-btn bg-gold px-3 text-sm font-medium text-navy hover:bg-gold-deep disabled:opacity-60"
                      >
                        {busyId === d.id ? 'Working...' : 'Mark Won'}
                      </button>
                    )}
                  </li>
                ))}
              {deals.filter((d) => d.stage === stage).length === 0 && (
                <li className="px-1 pb-1 text-xs text-slate">No deals here.</li>
              )}
            </ul>
          </div>
        ))}
      </div>

      <div className="mt-6 rounded-card bg-navy-deep p-5 text-paper">
        <h4 className="font-medium text-white">Activity and audit log</h4>
        {activity.length === 0 ? (
          <p className="mt-2 text-sm text-paper/70">Mark a deal Won to see the automation fire.</p>
        ) : (
          <ol className="mt-2 space-y-1.5 text-sm">
            {activity.map((e, i) => (
              <li key={i} className="flex gap-3">
                <span className="shrink-0 font-mono text-xs text-paper/60">{clock(e.at)}</span>
                <span className="text-paper/90">
                  <span className="font-medium text-white capitalize">{e.type}.</span> {e.detail}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>

      <button
        onClick={() => void load()}
        className="mt-6 text-sm font-medium text-blue hover:text-blue-deep"
      >
        Reset this demo
      </button>
    </div>
  );
}
