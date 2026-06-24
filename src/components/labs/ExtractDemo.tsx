import { useRef, useState } from 'react';
import type { ExtractedInvoice } from '@/lib/demo/extract';
import { postJson, downloadCsv, kes } from './demo-client';

const SAMPLES = [
  {
    id: 'inv-stationers',
    supplier: 'Sample Stationers Ltd',
    hint: 'Office supplies, 3 line items',
  },
  { id: 'inv-cloud', supplier: 'Sample Cloud Services', hint: 'Hosting, 2 line items' },
  { id: 'inv-training', supplier: 'Sample Training Partners', hint: 'Workshop, 2 line items' },
];

interface ExtractResponse {
  ok?: boolean;
  error?: string;
  fields?: ExtractedInvoice;
  csv?: string;
  filename?: string;
}

export default function ExtractDemo() {
  const [selected, setSelected] = useState<string>(SAMPLES[0].id);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ExtractResponse | null>(null);
  const [message, setMessage] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  async function extractSample() {
    setBusy(true);
    setMessage('');
    setResult(null);
    const { data } = await postJson<ExtractResponse>('/api/demo/labs/extract', {
      sampleId: selected,
    });
    setBusy(false);
    if (data.ok && data.fields) setResult(data);
    else setMessage(data.error || 'Could not extract that invoice.');
  }

  async function extractUpload() {
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setMessage('Choose a PDF, PNG or JPEG first.');
      return;
    }
    setBusy(true);
    setMessage('');
    setResult(null);
    const form = new FormData();
    form.append('file', file);
    const res = await fetch('/api/demo/labs/extract', {
      method: 'POST',
      headers: { accept: 'application/json' },
      body: form,
    });
    const data = (await res.json().catch(() => ({}))) as ExtractResponse;
    setBusy(false);
    if (data.ok && data.fields) setResult(data);
    else setMessage(data.error || 'Could not read that file.');
    if (fileRef.current) fileRef.current.value = '';
  }

  const fields = result?.fields;

  return (
    <div>
      <p className="text-slate">
        Pick a sample invoice and extract its fields. The samples work here with no setup.
      </p>

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        {SAMPLES.map((s) => (
          <button
            key={s.id}
            aria-pressed={selected === s.id}
            onClick={() => setSelected(s.id)}
            className={`rounded-card p-4 text-left ring-1 transition-colors ${
              selected === s.id
                ? 'bg-paper ring-blue'
                : 'bg-paper ring-hairline/70 hover:ring-hairline'
            }`}
          >
            <span className="block font-medium text-navy">{s.supplier}</span>
            <span className="mt-1 block text-sm text-slate">{s.hint}</span>
          </button>
        ))}
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button
          onClick={() => void extractSample()}
          disabled={busy}
          className="inline-flex min-h-[2.75rem] items-center justify-center rounded-btn bg-gold px-5 font-medium text-navy hover:bg-gold-deep disabled:opacity-60"
        >
          {busy ? 'Extracting...' : 'Extract'}
        </button>
        <span className="text-sm text-slate">or</span>
        <input
          ref={fileRef}
          type="file"
          accept="application/pdf,image/png,image/jpeg"
          aria-label="Upload your own document (PDF, PNG or JPEG, under 2MB)"
          className="text-sm text-slate file:mr-3 file:rounded-btn file:border-0 file:bg-paper-shade file:px-3 file:py-2 file:text-sm file:font-medium file:text-navy"
        />
        <button
          onClick={() => void extractUpload()}
          disabled={busy}
          className="inline-flex min-h-[2.75rem] items-center justify-center rounded-btn px-4 text-sm font-medium text-navy ring-1 ring-hairline ring-inset hover:bg-paper-shade disabled:opacity-60"
        >
          Extract upload
        </button>
      </div>
      <p className="mt-2 text-xs text-slate">
        Uploads are limited to 2MB, processed in the moment, and never stored.
      </p>

      {message && <p className="mt-4 text-sm text-status-high">{message}</p>}

      {fields && (
        <div className="mt-6 rounded-card bg-paper p-5 ring-1 ring-hairline/70">
          <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
            <Row label="Supplier" value={fields.supplier} />
            <Row label="Invoice number" value={fields.number} />
            <Row label="Date" value={fields.date} />
            <Row label="Currency" value={fields.currency} />
          </dl>

          <table className="mt-5 w-full text-sm">
            <thead>
              <tr className="border-b border-hairline text-left text-slate">
                <th className="py-2 font-medium">Description</th>
                <th className="py-2 text-right font-medium">Qty</th>
                <th className="py-2 text-right font-medium">Unit price</th>
                <th className="py-2 text-right font-medium">Amount</th>
              </tr>
            </thead>
            <tbody>
              {fields.lineItems.map((li, i) => (
                <tr key={i} className="border-b border-hairline/60">
                  <td className="py-2 text-ink">{li.description}</td>
                  <td className="py-2 text-right text-ink">{li.qty}</td>
                  <td className="py-2 text-right text-ink">{kes(li.unitPrice)}</td>
                  <td className="py-2 text-right text-ink">{kes(li.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-ink">
              Subtotal {kes(fields.subtotal)} · Tax {kes(fields.tax)} ·{' '}
              <span className="font-semibold">Total {kes(fields.total)}</span>
            </p>
            {result?.csv && (
              <button
                onClick={() => downloadCsv(result.filename || 'invoice.csv', result.csv!)}
                className="text-sm font-medium text-blue hover:text-blue-deep"
              >
                Download CSV
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 border-b border-hairline/60 py-1.5 sm:border-0">
      <dt className="text-slate">{label}</dt>
      <dd className="font-medium text-navy">{value}</dd>
    </div>
  );
}
