/**
 * The finding's card arrangement (Build Prompt 67).
 *
 * The module under test is pure and import-free, so these run against the real
 * arrangement rather than a copy. What they are guarding is that the work
 * paper's screen, the report preview and the Word board pack cannot drift
 * apart: all three read this, so an order or a heading asserted here is an
 * order or a heading all three have.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cardIsEmpty,
  findingCards,
  findingHeader,
  contextChips,
  riskPill,
  riskPillClass,
  visibleCards,
  type FindingSource,
} from '../../src/lib/grc/reports/findingCards.ts';

const FULL: FindingSource = {
  reference: 'WP/2026/002',
  observationTitle: 'Fuel reconciliations are not reviewed',
  observationDescription: 'Nobody signs them off.\n\n- March\n- April',
  affiliate: 'Hass Mombasa',
  auditArea: 'Treasury',
  subArea: 'Reconciliations',
  status: 'Sent to Auditee',
  riskRating: 'High',
  riskSummary: 'Unreviewed reconciliations hide loss.',
  recommendation: '1. Introduce a monthly review.',
  managementResponse: 'We accept the finding.',
  responsibility: 'Otieno Owner',
  actionPlans: [
    { description: 'Monthly sign-off', owner: 'Otieno Owner', due: '2026-04-30', status: 'Open' },
  ],
  evidence: [{ name: 'march-recs.pdf', detail: 'Amina Auditor, 2026-03-02' }],
  trail: [{ label: 'Approved', who: 'Head of Audit', when: '2026-03-05', comment: '' }],
};

const bare: FindingSource = {
  reference: 'WP/2026/003',
  observationTitle: 'A finding nobody has answered',
  observationDescription: 'The body.',
  affiliate: '',
  auditArea: '',
  subArea: '',
  status: 'Approved',
  riskRating: null,
  riskSummary: '',
  recommendation: '',
  managementResponse: '',
};

test('the header strip names the record and rates it', () => {
  const h = findingHeader(FULL);
  assert.equal(h.reference, 'WP/2026/002');
  assert.equal(h.title, 'Fuel reconciliations are not reviewed');
  assert.equal(h.affiliate, 'Hass Mombasa');
  assert.equal(h.auditArea, 'Treasury');
  assert.equal(h.subArea, 'Reconciliations');
  assert.equal(h.status, 'Sent to Auditee');
  assert.equal(h.risk.tone, 'high');
});

test('a header with nothing in it says so rather than showing blanks', () => {
  const h = findingHeader(bare);
  for (const value of [h.affiliate, h.auditArea, h.subArea]) assert.equal(value, '-');
  assert.equal(findingHeader({ ...bare, observationTitle: '' }).title, 'Untitled observation');
});

test('the risk pill reads a rating however it was typed', () => {
  for (const raw of ['High', 'HIGH', ' high ']) {
    assert.equal(riskPill(raw).tone, 'high', `"${raw}" is one rating`);
  }
  assert.equal(riskPill('Extreme').tone, 'extreme');
  assert.equal(riskPill('Critical').tone, 'extreme', 'the worst rating by either name');
  assert.equal(riskPill('Moderate').tone, 'medium');
  assert.equal(riskPill('Low').tone, 'low');
});

test('an unrecognised rating keeps its own words and is never drawn as low risk', () => {
  const pill = riskPill('Catastrophic');
  assert.equal(pill.tone, null, 'no bucket is invented for it');
  assert.equal(pill.label, 'Catastrophic', 'and its own words survive');
  assert.match(riskPillClass(pill.tone), /grc-pill--risk-unrated/);
  assert.equal(riskPill(null).label, 'Unrated');
  assert.equal(riskPill('').label, 'Unrated');
});

test('colour is never the only signal', () => {
  // Every pill carries its word, and the screen reader is told what the word
  // means: "High" beside a red shape is ambiguous to somebody who cannot see
  // the shape.
  for (const raw of ['Extreme', 'High', 'Medium', 'Low', null, 'Nonsense']) {
    const pill = riskPill(raw);
    assert.ok(pill.label.length > 0, `${raw} must have words`);
    assert.equal(pill.srLabel, `Risk rating: ${pill.label}`);
  }
});

test('the pill uses the product is own pill classes, not a second set', () => {
  // A finding whose risk pill is a different red from the risk pill two screens
  // away is two systems pretending to be one.
  assert.equal(riskPillClass('high'), 'grc-pill grc-pill--lg grc-pill--risk-high');
  assert.equal(riskPillClass('extreme'), 'grc-pill grc-pill--lg grc-pill--risk-extreme');
});

test('the cards run in the order the argument runs', () => {
  const keys = visibleCards(FULL).map((c) => c.key);
  assert.deepEqual(keys, [
    'description',
    'risk',
    'recommendation',
    'response',
    'evidence',
    'trail',
  ]);
});

test('audit is three cards are one group, and management is answer is not', () => {
  const cards = findingCards(FULL);
  const audit = cards.filter((c) => c.group === 'audit').map((c) => c.key);
  assert.deepEqual(audit, ['description', 'risk', 'recommendation'], "audit's own account");
  assert.equal(cards.find((c) => c.key === 'response')?.group, 'response', 'a separate voice');
});

test('the title is the snapshot is anchor, and never repeated as a section', () => {
  // The title is read first, at the top of the panel, so the first section is
  // the description rather than the title again (Build Prompt 72): a reader who
  // has to read the same sentence twice before reaching anything new has been
  // made to work for nothing.
  assert.equal(findingHeader(FULL).title, 'Fuel reconciliations are not reviewed');
  const section = findingCards(FULL).find((c) => c.key === 'description');
  assert.equal(section?.heading, 'Description');
  assert.deepEqual(
    section?.body.map((b) => b.kind),
    ['rich'],
  );
  const titles = findingCards(FULL).flatMap((c) =>
    c.body.filter((b) => b.kind === 'rich' && b.text === FULL.observationTitle),
  );
  assert.deepEqual(titles, [], 'no section repeats the title');
});

test('the context chips place the observation, and drop what is blank', () => {
  assert.deepEqual(contextChips({ ...FULL, period: '2026-01-01 to 2026-03-31' }), [
    'Hass Mombasa',
    'Treasury',
    'Reconciliations',
    '2026-01-01 to 2026-03-31',
  ]);
  // A chip reading "-" is a box that says nothing and still costs the reader a
  // glance to dismiss.
  assert.deepEqual(contextChips(bare), []);
});

test('the management response card carries the response, the owner and the actions', () => {
  const card = findingCards(FULL).find((c) => c.key === 'response');
  const kinds = card?.body.map((b) => b.kind);
  assert.deepEqual(
    kinds,
    ['facts', 'rich', 'rows'],
    'who owns it, what they said, what they will do',
  );
  const rows = card?.body.find((b) => b.kind === 'rows');
  assert.deepEqual(
    rows?.kind === 'rows' ? rows.columns : [],
    ['Agreed action', 'Owner', 'Target date', 'Status'],
    'with the target dates the prompt asks for',
  );
});

test('a card with nothing in it is quiet, not an empty box', () => {
  const cards = visibleCards(bare);
  const response = cards.find((c) => c.key === 'response');
  assert.ok(response, 'the response card is kept, because its absence is a fact');
  assert.equal(cardIsEmpty(response!), true);
  assert.match(String(response!.emptyText), /Awaiting response/);
  // And a card with nothing to say about its own absence is dropped entirely.
  assert.equal(
    cards.some((c) => c.key === 'evidence'),
    false,
    'an evidence card on a finding with no evidence is just a box',
  );
  assert.equal(
    cards.some((c) => c.key === 'trail'),
    false,
  );
});

test('a finding still being written keeps its cards and says what is missing', () => {
  const cards = visibleCards(bare);
  assert.deepEqual(
    cards.map((c) => c.key),
    ['description', 'risk', 'recommendation', 'response'],
    'the four that always exist',
  );
  for (const key of ['risk', 'recommendation']) {
    const card = cards.find((c) => c.key === key);
    assert.equal(cardIsEmpty(card!), true, `${key} is empty`);
    // Short, because the empty state is a note and not an apology: "Not yet
    // rated." tells the reader everything the absence means.
    assert.ok(String(card!.emptyText).length > 8, `${key} says what is not there yet`);
    assert.match(String(card!.emptyText), /^Not yet/, `${key} says it in the design's voice`);
  }
});

test('the risk card shows the rating the strip shows, not a second reading of it', () => {
  const card = findingCards(FULL).find((c) => c.key === 'risk');
  const facts = card?.body[0].kind === 'facts' ? card.body[0].facts : [];
  assert.deepEqual(facts, [{ label: 'Rating', value: 'High' }]);
  assert.equal(findingHeader(FULL).risk.label, 'High', 'the same words as the pill');
});

test('the trail card carries the response cycle state beside the steps', () => {
  const cards = findingCards({
    ...FULL,
    trailFacts: [
      { label: 'Response round', value: '2' },
      { label: 'Response deadline', value: '' },
    ],
  });
  const trail = cards.find((c) => c.key === 'trail');
  const facts = trail?.body[0].kind === 'facts' ? trail.body[0].facts : [];
  assert.deepEqual(facts, [{ label: 'Response round', value: '2' }], 'blank facts are dropped');
  assert.equal(trail?.body[1].kind, 'rows', 'and the steps follow them');
});
