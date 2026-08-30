/**
 * A finding, arranged as a header strip and a run of cards (Build Prompt 67).
 *
 * ONE ARRANGEMENT, THREE RENDERERS. The work paper's own screen, the report
 * preview and the Word board pack all show the same finding, and until now each
 * decided for itself what to show and in what order. So the screen led with a
 * definition list of thirty rows, the report led with a narrative paragraph, and
 * the two disagreed about where the risk sat and whether the recommendation came
 * before or after the response. This module is the arrangement, written once:
 * what the header strip carries, which cards exist, what goes in each, and in
 * what order. The renderers differ only in how they draw it.
 *
 * PURE AND IMPORT-FREE, so node strips types and unit-tests it directly, and so
 * the WordML renderer (which runs nowhere near a DOM) can use the same model as
 * the page.
 *
 * WHY CARDS. A finding is an argument in four movements: here is the control we
 * tested, here is what we found, here is what it means, here is what to do about
 * it. A single column of label-and-value rows flattens all four into one grey
 * run, and the reader has to rebuild the structure themselves. Cards are that
 * structure made visible, which is why they group: the three audit cards
 * (Finding, Risk, Recommendation) are audit's assessment and sit together, and
 * what management says back is a separate card because it is a separate voice.
 */

/** How a section's content is rendered. The renderers switch on this. */
export type CardBody =
  /** Stored markdown, through the narrative pipeline. */
  | { kind: 'rich'; text: string }
  /** A short value that is not a narrative: a date, a name, a rating. */
  | { kind: 'facts'; facts: { label: string; value: string }[] }
  /** Rows of something there may be several of: action plans, evidence. */
  | { kind: 'rows'; columns: string[]; rows: string[][] };

export interface FindingCard {
  /** A stable key, for tests and for the renderers to switch on. */
  key: string;
  heading: string;
  body: CardBody[];
  /**
   * Whether audit wrote it. The three audit cards are drawn as one group, so a
   * reader can see at a glance which half of the page is the auditor's opinion
   * and which is the auditee's answer.
   */
  group: 'audit' | 'response' | 'record';
  /**
   * What the card says when it holds nothing yet. A card with an empty state is
   * shown quietly; a card with none is dropped entirely, because an empty box
   * with a heading is a question the reader cannot answer.
   */
  emptyText?: string;
}

/** The four risk buckets the pill draws, lowest ordinal first. */
export const RISK_TONES = ['low', 'medium', 'high', 'extreme'] as const;
export type RiskTone = (typeof RISK_TONES)[number];

export interface RiskPill {
  /** The words in the pill. Never omitted: colour is not the only signal. */
  label: string;
  /** The bucket, or null when the finding carries no rating at all. */
  tone: RiskTone | null;
  /**
   * What a screen reader hears, spelled out. "High" alone beside a red shape is
   * ambiguous to somebody who cannot see the shape; "Risk rating: High" is not.
   */
  srLabel: string;
}

/**
 * The risk pill for a stored rating.
 *
 * Read tolerantly, because the rating is a dropdown value that has been typed
 * by hand in the past: 'HIGH', 'High ' and 'high' are one rating. Anything that
 * resolves to no bucket keeps its own words and gets no colour, which is honest:
 * an unrecognised rating must not be quietly drawn as low risk.
 */
export function riskPill(rating: string | null | undefined): RiskPill {
  const raw = String(rating ?? '').trim();
  const key = raw.toLowerCase();
  const tone: RiskTone | null =
    key === 'extreme' || key === 'critical'
      ? 'extreme'
      : key === 'high'
        ? 'high'
        : key === 'medium' || key === 'moderate'
          ? 'medium'
          : key === 'low'
            ? 'low'
            : null;
  const label = tone ? tone.charAt(0).toUpperCase() + tone.slice(1) : raw || 'Unrated';
  return { label, tone, srLabel: `Risk rating: ${label}` };
}

/**
 * The classes the pill wears.
 *
 * Deliberately the product's existing `.grc-pill--risk-*` family rather than a
 * second one of its own: the status badges and the requirement pills already
 * use it, and a finding whose risk pill is a different red from the risk pill
 * two screens away is two systems pretending to be one.
 */
export function riskPillClass(tone: RiskTone | null): string {
  return `grc-pill grc-pill--lg grc-pill--risk-${tone ?? 'unrated'}`;
}

/** The facts the header strip carries: what this is, and how bad it is. */
export interface FindingHeader {
  reference: string;
  title: string;
  affiliate: string;
  auditArea: string;
  subArea: string;
  /** The audit period the observation covers, as one readable span. */
  period: string;
  status: string;
  risk: RiskPill;
}

/** Everything the arrangement needs, in the words the callers already hold. */
export interface FindingSource {
  reference: string;
  /** The stored observation_title, shown as "Observation". */
  observationTitle: string;
  /** The stored observation_description, shown as "Description". */
  observationDescription: string;
  affiliate: string;
  auditArea: string;
  subArea: string;
  /** The audit period, already formatted by the caller that holds both dates. */
  period?: string;
  status: string;
  riskRating: string | null;
  riskSummary: string;
  recommendation: string;
  managementResponse: string;
  /** The agreed actions: what will be done, by whom, by when. */
  actionPlans?: { description: string; owner: string; due: string; status: string }[];
  /** Who is answerable on the auditee side, when the finding names anybody. */
  responsibility?: string;
  /** Attached documents, by name. */
  evidence?: { name: string; detail: string }[];
  /** The review and auditee history, oldest first. */
  trail?: { label: string; who: string; when: string; comment: string }[];
  /**
   * The response cycle's own state (round, deadline, final status): stored
   * facts that belong with the history rather than with the argument, so they
   * sit at the head of the trail card instead of interrupting the finding.
   */
  trailFacts?: { label: string; value: string }[];
}

const blank = (v: string | null | undefined): boolean => String(v ?? '').trim() === '';

export function findingHeader(source: FindingSource): FindingHeader {
  return {
    reference: source.reference || 'Observation',
    title: source.observationTitle || 'Untitled observation',
    affiliate: source.affiliate || '-',
    auditArea: source.auditArea || '-',
    subArea: source.subArea || '-',
    period: source.period || '-',
    status: source.status || '-',
    risk: riskPill(source.riskRating),
  };
}

/**
 * The context chips under the title: where in the audit this sits.
 *
 * Blanks are dropped rather than drawn as "-", because a chip reading "-" is a
 * box that says nothing and still takes the reader's attention to dismiss.
 */
export function contextChips(source: FindingSource): string[] {
  return [source.affiliate, source.auditArea, source.subArea, source.period ?? '']
    .map((v) => String(v ?? '').trim())
    .filter((v) => v !== '' && v !== '-');
}

/**
 * The sections, in the order the argument runs.
 *
 * A card whose content is entirely absent is dropped when there is nothing
 * useful to say about the absence, and kept with a quiet line when the absence
 * is itself worth knowing. "No management response yet" is a fact a reader
 * wants; an empty Evidence card on a finding nobody has attached anything to is
 * just a box.
 */
export function findingCards(source: FindingSource): FindingCard[] {
  const cards: FindingCard[] = [];

  // 1. What we found, written out. The title is not here: it is the snapshot's
  // own anchor at the top of the panel, read before anything else (Build Prompt
  // 72). Repeating it as the first section would make the reader read the same
  // sentence twice before reaching anything new.
  cards.push({
    key: 'description',
    heading: 'Description',
    group: 'audit',
    body: [{ kind: 'rich', text: source.observationDescription }],
    emptyText: 'Not yet written.',
  });

  // 2. What it means. The rating is shown only when the finding actually
  // carries one: "Rating: Unrated" over an empty summary is a card telling the
  // reader nothing in two lines instead of saying so in one.
  const risk = riskPill(source.riskRating);
  cards.push({
    key: 'risk',
    heading: 'Risk',
    group: 'audit',
    body: [
      {
        kind: 'facts',
        facts: [{ label: 'Rating', value: blank(source.riskRating) ? '' : risk.label }],
      },
      { kind: 'rich', text: source.riskSummary },
    ],
    emptyText: 'Not yet rated.',
  });

  // 3. What to do about it.
  cards.push({
    key: 'recommendation',
    heading: 'Recommendation',
    group: 'audit',
    body: [{ kind: 'rich', text: source.recommendation }],
    emptyText: 'Not yet recommended.',
  });

  // 4. What management says back, with what they have agreed to do and who owns
  // it. One card, because a response that promises action and the actions it
  // promises are one answer read together.
  const plans = source.actionPlans ?? [];
  const responseBody: CardBody[] = [];
  if (!blank(source.responsibility)) {
    responseBody.push({
      kind: 'facts',
      facts: [{ label: 'Primary responsibility', value: source.responsibility as string }],
    });
  }
  if (!blank(source.managementResponse)) {
    responseBody.push({ kind: 'rich', text: source.managementResponse });
  }
  if (plans.length > 0) {
    responseBody.push({
      kind: 'rows',
      columns: ['Agreed action', 'Owner', 'Target date', 'Status'],
      rows: plans.map((p) => [p.description, p.owner, p.due, p.status]),
    });
  }
  cards.push({
    key: 'response',
    heading: 'Management response',
    group: 'response',
    body: responseBody,
    // Worth saying: a finding with no response is a finding still waiting on
    // somebody, and the reader should be told that rather than left to infer it.
    emptyText: 'Awaiting response.',
  });

  // 5. What supports it.
  const evidence = source.evidence ?? [];
  if (evidence.length > 0) {
    cards.push({
      key: 'evidence',
      heading: 'Evidence',
      group: 'record',
      body: [
        {
          kind: 'rows',
          columns: ['Document', 'Detail'],
          rows: evidence.map((e) => [e.name, e.detail]),
        },
      ],
    });
  }

  // 6. How it got here.
  const trail = source.trail ?? [];
  const trailFacts = (source.trailFacts ?? []).filter((f) => !blank(f.value));
  if (trail.length > 0 || trailFacts.length > 0) {
    const body: CardBody[] = [];
    if (trailFacts.length > 0) body.push({ kind: 'facts', facts: trailFacts });
    if (trail.length > 0) {
      body.push({
        kind: 'rows',
        columns: ['Step', 'By', 'When', 'Comment'],
        rows: trail.map((t) => [t.label, t.who, t.when, t.comment]),
      });
    }
    cards.push({ key: 'trail', heading: 'Trail', group: 'record', body });
  }

  return cards;
}

/** Whether a card holds anything at all, so a renderer knows to draw its empty state. */
export function cardIsEmpty(card: FindingCard): boolean {
  return card.body.every((b) => {
    if (b.kind === 'rich') return blank(b.text);
    if (b.kind === 'facts') return b.facts.every((f) => blank(f.value));
    return b.rows.length === 0;
  });
}

/** The cards a renderer should actually draw: everything with content, plus the ones worth an empty line. */
export function visibleCards(source: FindingSource): FindingCard[] {
  return findingCards(source).filter((c) => !cardIsEmpty(c) || c.emptyText != null);
}
