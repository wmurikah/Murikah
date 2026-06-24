import { useState } from 'react';
import { TRIGGERS, CONDITIONS, ACTIONS, type WorkflowResult } from '@/lib/demo/workflow';
import { postJson, clock } from './demo-client';

export default function WorkflowDemo() {
  const [trigger, setTrigger] = useState(TRIGGERS[0].id);
  const [condition, setCondition] = useState(CONDITIONS[0].id);
  const [threshold, setThreshold] = useState(50000);
  const [actions, setActions] = useState<string[]>([ACTIONS[0].id]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<WorkflowResult | null>(null);
  const [message, setMessage] = useState('');

  function toggleAction(id: string) {
    setActions((prev) => (prev.includes(id) ? prev.filter((a) => a !== id) : [...prev, id]));
  }

  async function run() {
    setBusy(true);
    setMessage('');
    setResult(null);
    const definition = {
      trigger,
      condition: { id: condition, threshold: condition === 'amount_over' ? threshold : undefined },
      actions,
    };
    const { data } = await postJson<{ ok?: boolean; error?: string; result?: WorkflowResult }>(
      '/api/demo/labs/workflow',
      { definition },
    );
    setBusy(false);
    if (data.ok && data.result) setResult(data.result);
    else setMessage(data.error || 'Could not run the workflow.');
  }

  return (
    <div>
      <p className="text-slate">
        Compose a flow from preset blocks, then run it against a sample event. Only whitelisted
        blocks are allowed, and the server evaluates it and returns an audit log.
      </p>

      <div className="mt-5 grid gap-5 lg:grid-cols-3">
        <fieldset>
          <legend className="text-sm font-semibold tracking-wide text-slate uppercase">
            Trigger
          </legend>
          <select
            value={trigger}
            onChange={(e) => setTrigger(e.target.value)}
            className="mt-2 min-h-[2.75rem] w-full rounded-btn border border-hairline bg-surface px-3 text-ink"
          >
            {TRIGGERS.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </fieldset>

        <fieldset>
          <legend className="text-sm font-semibold tracking-wide text-slate uppercase">
            Condition
          </legend>
          <select
            value={condition}
            onChange={(e) => setCondition(e.target.value)}
            className="mt-2 min-h-[2.75rem] w-full rounded-btn border border-hairline bg-surface px-3 text-ink"
          >
            {CONDITIONS.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
          {condition === 'amount_over' && (
            <label className="mt-2 block text-sm text-slate">
              Threshold (KES)
              <input
                type="number"
                min={0}
                value={threshold}
                onChange={(e) => setThreshold(Number(e.target.value))}
                className="mt-1 min-h-[2.5rem] w-full rounded-btn border border-hairline bg-surface px-3 text-ink"
              />
            </label>
          )}
        </fieldset>

        <fieldset>
          <legend className="text-sm font-semibold tracking-wide text-slate uppercase">
            Actions
          </legend>
          <div className="mt-2 space-y-1.5">
            {ACTIONS.map((a) => (
              <label key={a.id} className="flex items-center gap-2.5 text-ink">
                <input
                  type="checkbox"
                  checked={actions.includes(a.id)}
                  onChange={() => toggleAction(a.id)}
                  className="size-4 rounded border-hairline text-blue"
                />
                {a.label}
              </label>
            ))}
          </div>
        </fieldset>
      </div>

      <button
        onClick={() => void run()}
        disabled={busy || actions.length === 0}
        className="mt-5 inline-flex min-h-[2.75rem] items-center justify-center rounded-btn bg-gold px-5 font-medium text-navy hover:bg-gold-deep disabled:opacity-60"
      >
        {busy ? 'Running...' : 'Run with a sample event'}
      </button>

      {message && <p className="mt-4 text-sm text-status-high">{message}</p>}

      {result && (
        <div className="mt-6 grid gap-5 lg:grid-cols-2">
          <div className="rounded-card bg-paper p-5 ring-1 ring-hairline/70">
            <h4 className="font-medium text-navy">Outcome</h4>
            <p className="mt-2 text-sm text-ink">
              Condition {result.conditionMet ? 'met' : 'not met'}.
            </p>
            {result.firedActions.length > 0 ? (
              <ul className="mt-2 space-y-1 text-sm text-ink">
                {result.firedActions.map((a, i) => (
                  <li key={i} className="flex items-center gap-2">
                    <span aria-hidden="true" className="size-1.5 rounded-full bg-status-low" />
                    {a}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-slate">No actions fired.</p>
            )}
          </div>

          <div className="rounded-card bg-navy-deep p-5 text-paper">
            <h4 className="font-medium text-white">Audit log</h4>
            <ol className="mt-2 space-y-1.5 text-sm">
              {result.log.map((s, i) => (
                <li key={i} className="flex gap-3">
                  <span className="shrink-0 font-mono text-xs text-paper/60">{clock(s.at)}</span>
                  <span className="text-paper/90">
                    <span className="font-medium text-white">{s.step}.</span> {s.detail}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        </div>
      )}
    </div>
  );
}
