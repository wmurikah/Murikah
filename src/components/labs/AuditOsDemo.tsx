import { useEffect, useRef, useState } from 'react';
import type { BoardItem, Finding, Metric, Workpaper } from '@/lib/demo/sample-data';
import { getJson } from './demo-client';

type View = 'dashboard' | 'findings' | 'board';

const riskTone: Record<string, string> = {
  High: 'bg-status-high/10 text-status-high ring-status-high/30',
  Medium: 'bg-status-med/10 text-status-med ring-status-med/30',
  Low: 'bg-status-low/10 text-status-low ring-status-low/30',
};
const statusTone: Record<string, string> = {
  Overdue: 'bg-status-high/10 text-status-high',
  'In progress': 'bg-status-med/10 text-status-med',
  Open: 'bg-paper-shade text-ink',
  Closed: 'bg-status-low/10 text-status-low',
};

function Chip({ label, tone }: { label: string; tone: string }) {
  return (
    <span
      className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${tone}`}
    >
      {label}
    </span>
  );
}

export default function AuditOsDemo() {
  const [view, setView] = useState<View>('dashboard');
  const [metrics, setMetrics] = useState<Metric[]>([]);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [board, setBoard] = useState<BoardItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [statusFilter, setStatusFilter] = useState('All');
  const [riskFilter, setRiskFilter] = useState('All');
  const [selected, setSelected] = useState<Finding | null>(null);
  const [workpaper, setWorkpaper] = useState<Workpaper | null>(null);
  const drawerRef = useRef<HTMLDivElement>(null);

  async function load() {
    setLoading(true);
    setError('');
    const [d, f, b] = await Promise.all([
      getJson<{ metrics: Metric[] }>('/api/demo/auditos/dashboard'),
      getJson<{ findings: Finding[] }>('/api/demo/auditos/findings'),
      getJson<{ items: BoardItem[] }>('/api/demo/auditos/board'),
    ]);
    if (d.data.ok && f.data.ok && b.data.ok) {
      setMetrics(d.data.metrics);
      setFindings(f.data.findings);
      setBoard(b.data.items);
    } else {
      setError(d.data.error || f.data.error || b.data.error || 'Could not load the sandbox.');
    }
    setLoading(false);
  }

  useEffect(() => {
    void load();
  }, []);

  async function openFinding(finding: Finding) {
    setSelected(finding);
    setWorkpaper(null);
    const res = await getJson<{ workpaper: Workpaper | null }>(
      `/api/demo/auditos/finding/${encodeURIComponent(finding.ref)}`,
    );
    if (res.data.ok) setWorkpaper(res.data.workpaper);
    requestAnimationFrame(() => drawerRef.current?.focus());
  }

  const filtered = findings.filter(
    (f) =>
      (statusFilter === 'All' || f.status === statusFilter) &&
      (riskFilter === 'All' || f.risk === riskFilter),
  );

  if (loading) return <p className="text-slate">Loading the sandbox...</p>;
  if (error) return <p className="text-status-high">{error}</p>;

  return (
    <div>
      <div role="tablist" aria-label="Audit OS views" className="flex flex-wrap gap-1.5">
        {(['dashboard', 'findings', 'board'] as View[]).map((v) => (
          <button
            key={v}
            role="tab"
            aria-selected={view === v}
            onClick={() => setView(v)}
            className={`min-h-[2.5rem] rounded-md px-3.5 text-sm font-medium capitalize transition-colors ${
              view === v ? 'bg-navy text-white' : 'bg-paper-shade text-ink hover:bg-hairline/60'
            }`}
          >
            {v === 'board' ? 'Board pack' : v}
          </button>
        ))}
      </div>

      {view === 'dashboard' && (
        <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {metrics.map((m) => (
            <div key={m.key} className="rounded-card bg-paper p-5 ring-1 ring-hairline/70">
              <p
                className={`text-3xl font-semibold ${
                  m.tone === 'high'
                    ? 'text-status-high'
                    : m.tone === 'med'
                      ? 'text-status-med'
                      : m.tone === 'low'
                        ? 'text-status-low'
                        : 'text-navy'
                }`}
              >
                {m.value}
              </p>
              <p className="mt-1 text-sm text-slate">{m.label}</p>
            </div>
          ))}
        </div>
      )}

      {view === 'findings' && (
        <div className="mt-5">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
            <Filter
              label="Status"
              value={statusFilter}
              setValue={setStatusFilter}
              options={['All', 'Open', 'In progress', 'Overdue', 'Closed']}
            />
            <Filter
              label="Risk"
              value={riskFilter}
              setValue={setRiskFilter}
              options={['All', 'High', 'Medium', 'Low']}
            />
          </div>

          <ul className="mt-4 divide-y divide-hairline rounded-card ring-1 ring-hairline/70">
            {filtered.map((f) => (
              <li key={f.ref}>
                <button
                  onClick={() => void openFinding(f)}
                  className="flex w-full items-start justify-between gap-4 p-4 text-left hover:bg-paper"
                >
                  <span>
                    <span className="font-medium text-navy">{f.title}</span>
                    <span className="mt-1 block text-sm text-slate">
                      {f.ref} · {f.area} · Owner {f.owner}
                    </span>
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-1.5">
                    <Chip label={f.risk} tone={riskTone[f.risk]} />
                    <Chip
                      label={f.status}
                      tone={statusTone[f.status] ?? 'bg-paper-shade text-ink'}
                    />
                  </span>
                </button>
              </li>
            ))}
            {filtered.length === 0 && (
              <li className="p-4 text-sm text-slate">No findings match those filters.</li>
            )}
          </ul>

          {selected && (
            <div
              ref={drawerRef}
              tabIndex={-1}
              className="mt-5 rounded-card bg-paper p-5 ring-1 ring-hairline/70 sm:p-6"
              aria-label={`Finding ${selected.ref}`}
            >
              <div className="flex items-start justify-between gap-4">
                <h4 className="text-lg text-navy">{selected.title}</h4>
                <button
                  onClick={() => setSelected(null)}
                  className="text-sm font-medium text-blue hover:text-blue-deep"
                >
                  Close
                </button>
              </div>
              <p className="mt-1 text-sm text-slate">
                {selected.ref} · {selected.area} · Due {selected.dueDate}
              </p>
              <p className="mt-3 text-ink">{selected.summary}</p>

              <h5 className="mt-5 text-sm font-semibold tracking-wide text-slate uppercase">
                Work paper
              </h5>
              {workpaper ? (
                <div className="mt-1.5">
                  <p className="font-medium text-navy">{workpaper.title}</p>
                  <p className="mt-1 text-sm text-ink">{workpaper.body}</p>
                </div>
              ) : (
                <p className="mt-1.5 text-sm text-slate">No work paper for this sample finding.</p>
              )}

              <h5 className="mt-5 text-sm font-semibold tracking-wide text-slate uppercase">
                Action plan
              </h5>
              <p className="mt-1.5 text-sm text-ink">{selected.actionPlan}</p>
            </div>
          )}
        </div>
      )}

      {view === 'board' && (
        <ul className="mt-5 grid gap-4 sm:grid-cols-2">
          {board.map((item) => (
            <li key={item.title} className="rounded-card bg-paper p-5 ring-1 ring-hairline/70">
              <div className="flex items-center justify-between gap-3">
                <h4 className="font-medium text-navy">{item.title}</h4>
                <Chip label={item.status} tone="bg-paper-shade text-ink" />
              </div>
              <p className="mt-2 text-sm text-slate">{item.note}</p>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-6 flex flex-wrap items-center gap-4">
        <button
          onClick={() => void load()}
          className="text-sm font-medium text-blue hover:text-blue-deep"
        >
          Reset this demo
        </button>
      </div>
    </div>
  );
}

function Filter({
  label,
  value,
  setValue,
  options,
}: {
  label: string;
  value: string;
  setValue: (v: string) => void;
  options: string[];
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-slate">{label}</span>
      <div className="flex flex-wrap gap-1">
        {options.map((o) => (
          <button
            key={o}
            aria-pressed={value === o}
            onClick={() => setValue(o)}
            className={`min-h-[2rem] rounded-md px-2.5 text-sm transition-colors ${
              value === o ? 'bg-navy text-white' : 'bg-paper-shade text-ink hover:bg-hairline/60'
            }`}
          >
            {o}
          </button>
        ))}
      </div>
    </div>
  );
}
