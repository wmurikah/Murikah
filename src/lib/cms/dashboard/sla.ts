/**
 * The dashboard's SLA section: which family is selected, and what it shows.
 *
 * TWO FAMILIES, AND THEY ANSWER DIFFERENT QUESTIONS.
 *
 * INTERNAL is how long our own approvals take: finance approval on a sales
 * order, the credit decision where one was required, and the purchase order
 * approval cycle. Nobody outside the business sees any of it, and it is the
 * family a manager looks at when the question is "where is the work stuck".
 *
 * EXTERNAL is what the customer was promised: the first response on a case,
 * its resolution, and fulfilment of the order they placed. It is the family a
 * manager looks at when the question is "are we keeping our word".
 *
 * Blending them into one compliance figure was never an option: an average
 * across the two says nothing, because a business can be quick to answer the
 * phone and slow to approve credit, and the single number hides exactly the
 * half that is broken.
 *
 * THE SWITCH COSTS NOTHING. Every figure below is read from a `Dashboard` the
 * page has already loaded for its Orders and Service sections, so choosing a
 * family fetches nothing. A per-family payload would have added round trips to
 * a page already at its subrequest budget, and would have made the segmented
 * control the most expensive control on the page.
 */
import type { Dashboard } from '@/lib/cms/repos/executive';
import { formatDuration, formatRate } from '@/lib/cms/analytics/stats';

export type SlaFamilyKey = 'internal' | 'external';

export const SLA_FAMILIES: readonly { key: SlaFamilyKey; label: string }[] = [
  { key: 'internal', label: 'Internal SLA' },
  { key: 'external', label: 'External SLA' },
];

/** The parameter the choice travels in, so a view can be shared. */
export const SLA_PARAM = 'sla';

/**
 * The selected family, defaulting to internal.
 *
 * An unrecognised value is the default rather than an error: a truncated or
 * hand-edited link should land somewhere sensible, and there is nothing here
 * worth refusing a request over.
 */
export function readSlaFamily(params: URLSearchParams): SlaFamilyKey {
  return params.get(SLA_PARAM) === 'external' ? 'external' : 'internal';
}

export interface SlaMeasure {
  label: string;
  /** Already formatted, or the absent string. */
  value: string;
  /** The target, the unit or the population. One quiet line. */
  context: string;
  tone: 'neutral' | 'positive' | 'caution' | 'negative' | 'info';
  href: string;
  definition: string;
  denominator: string;
  dateBasis: string;
}

export interface SlaFamilyView {
  key: SlaFamilyKey;
  measures: SlaMeasure[];
}

/**
 * The bands a compliance percentage is read in.
 *
 * Stated once here rather than at each call site, because three copies of
 * `>= 95` drift, and the day two sections disagree about what counts as At
 * Risk is the day nobody trusts either of them. The words are the fixed SLA
 * vocabulary: Met, At Risk, Breached.
 */
export function complianceTone(percent: number | null): SlaMeasure['tone'] {
  if (percent === null) return 'neutral';
  if (percent >= 95) return 'positive';
  if (percent >= 85) return 'caution';
  return 'negative';
}

/**
 * A duration has no target in this schema, so it carries no judgement.
 *
 * Colouring a median red because it looks slow would be this system inventing
 * a threshold nobody agreed. Where there is no configured target, the measure
 * is neutral and the figure speaks for itself.
 */
const DURATION_TONE = 'neutral' as const;

export function slaFamilyView(key: SlaFamilyKey, board: Dashboard): SlaFamilyView {
  const so = board.salesOrders;
  const po = board.purchaseOrders;
  const service = board.service;
  const measures: SlaMeasure[] = [];

  if (key === 'internal') {
    if (so !== null) {
      measures.push({
        label: 'Finance approval',
        value: formatDuration(so.financeMedianElapsedMinutes),
        context: 'Median, elapsed',
        tone: DURATION_TONE,
        href: '/app/orders/sales/performance',
        definition:
          'Median wall-clock time from the finance stage opening to it being decided. Elapsed, not accountable: waiting on somebody else is still in it.',
        denominator: 'Orders that carried both finance timestamps',
        dateBasis: 'Order created at',
      });
      measures.push({
        label: 'Credit exceptions',
        value: formatRate(so.creditExceptionRatePercent),
        context: 'Of orders that needed credit',
        tone: DURATION_TONE,
        href: '/app/orders/sales/performance',
        definition: 'Orders released with a credit exception recorded.',
        denominator: 'Orders that required credit approval, never all orders',
        dateBasis: 'Order created at',
      });
    }
    if (po !== null) {
      measures.push({
        label: 'Purchase order approval',
        value: formatDuration(po.approvalCycleMedianMinutes),
        context: 'Median, completed cycles',
        tone: DURATION_TONE,
        href: '/app/orders/purchases/performance',
        definition:
          'Median time from submission for approval to the last approval stage being decided.',
        denominator: 'Purchase orders whose approval completed in this period',
        dateBasis: 'Purchase order created at',
      });
    }
    return { key, measures };
  }

  if (service !== null) {
    measures.push({
      label: 'First response',
      value: formatRate(service.firstResponseWithinSlaPercent),
      context: 'Within SLA',
      tone: complianceTone(service.firstResponseWithinSlaPercent),
      href: '/app/helpdesk/analytics',
      definition:
        'First-response SLA instances that were Met. An internal note is not a first response.',
      denominator: 'First-response SLA instances settled in this period',
      dateBasis: 'SLA settled at',
    });
    measures.push({
      label: 'Resolution',
      value: formatRate(service.resolutionWithinSlaPercent),
      context: 'Within SLA',
      tone: complianceTone(service.resolutionWithinSlaPercent),
      href: '/app/helpdesk/analytics',
      definition: 'Resolution SLA instances that were Met.',
      denominator: 'Resolution SLA instances settled in this period',
      dateBasis: 'SLA settled at',
    });
  }
  if (so !== null) {
    measures.push({
      label: 'Fulfilment',
      value: formatRate(so.slaCompliancePercent),
      context: 'Within SLA',
      tone: complianceTone(so.slaCompliancePercent),
      href: '/app/orders/sales/performance',
      definition: 'Sales order SLA instances that were Met.',
      denominator: 'Sales order SLA instances settled in this period',
      dateBasis: 'SLA settled at',
    });
  }
  return { key, measures };
}
