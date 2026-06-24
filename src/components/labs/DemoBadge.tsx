import { DEMO_BADGE } from '@/lib/demo/config';

/** Permanent, honest label shown on every demo surface. */
export default function DemoBadge() {
  return (
    <p className="inline-flex items-center gap-2 rounded-full bg-paper-shade px-3 py-1 text-xs font-medium text-slate">
      <span aria-hidden="true" className="size-1.5 rounded-full bg-gold" />
      {DEMO_BADGE}
    </p>
  );
}
