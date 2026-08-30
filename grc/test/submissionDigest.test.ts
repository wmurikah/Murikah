/**
 * The submission digest (Build Prompt 53).
 *
 * The rule this pins is a product rule, not a formatting preference: a head of
 * audit gets one email listing every newly submitted finding, never one email
 * per finding. The builder is pure, so the table, the subject and the single
 * call to action are all testable without a mailbox.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDigest, type DigestItem } from '../../src/lib/grc/notify/render.ts';
import { digestLinks } from '../../src/lib/grc/notify/links.ts';

const submitted = (reference: string, title: string, detail = 'Treasury - High'): DigestItem => ({
  subject: `Work paper submitted for review: ${reference}`,
  intro: '',
  link: `https://grc.murikah.com/work-papers/${reference}`,
  submitted: { reference, title, detail, link: `https://grc.murikah.com/work-papers/${reference}` },
});

test('many submissions become one table, not many messages', () => {
  const digest = buildDigest(
    [
      submitted('WP/2026/001', 'Bank reconciliations not performed'),
      submitted('WP/2026/002', 'Supplier master file uncontrolled', 'Procurement - Medium'),
      submitted('WP/2026/003', 'Access reviews overdue', 'IT - Critical'),
    ],
    digestLinks(),
  );

  assert.equal(digest.subject, '3 work papers submitted for review');
  // Every finding is in the one body, with all three columns.
  for (const ref of ['WP/2026/001', 'WP/2026/002', 'WP/2026/003']) {
    assert.ok(digest.body.includes(ref), `${ref} must be listed`);
  }
  assert.ok(digest.body.includes('Bank reconciliations not performed'), 'titles are listed');
  assert.ok(
    digest.body.includes('Procurement - Medium'),
    'the detail column carries area and risk',
  );
  for (const heading of ['Reference', 'Title', 'Detail']) {
    assert.ok(digest.body.includes(`>${heading}</th>`), `the table heads ${heading}`);
  }
  assert.ok(digest.body.includes('Please log in and review them'), 'it asks them to review');
  // One call to action for the whole batch, pointing at the review queue.
  const buttons = digest.body.split('Review the queue').length - 1;
  assert.equal(buttons, 1, 'exactly one review button, whatever the number of findings');
  assert.ok(digest.body.includes('/work-papers?status=Submitted'), 'it points at the queue');
});

test('the table is Outlook-safe: a real table, no flexbox and no classes', () => {
  const digest = buildDigest([submitted('WP/2026/001', 'A finding')], digestLinks());
  assert.ok(digest.body.includes('<table'), 'a table element, which Word can render');
  assert.ok(digest.body.includes('cellpadding="0"'), 'the attributes Outlook honours');
  assert.ok(!/display:\s*flex/.test(digest.body), 'no flexbox: Outlook ignores it');
  assert.ok(!/class="/.test(digest.body), 'no CSS classes: there is no stylesheet in an email');
});

test('one submission still reads as one submission', () => {
  const digest = buildDigest([submitted('WP/2026/007', 'Single finding')], digestLinks());
  assert.equal(digest.subject, 'Work paper submitted for review: WP/2026/007');
  assert.ok(digest.body.includes('Please log in and review it'), 'singular copy');
});

test('a submission and an unrelated notification are still one email', () => {
  // The guarantee is one email per recipient per run, not one email per kind.
  const digest = buildDigest(
    [
      submitted('WP/2026/001', 'A finding'),
      { subject: 'Action plan assigned: AP-9', intro: 'An action plan has been assigned to you.' },
    ],
    digestLinks(),
  );
  assert.equal(digest.subject, 'Work paper submitted for review: WP/2026/001');
  assert.ok(digest.body.includes('WP/2026/001'), 'the submission leads');
  assert.ok(digest.body.includes('Action plan assigned: AP-9'), 'the rest follows in one body');
  assert.ok(digest.body.includes('Also waiting'), 'and is separated so neither is lost');
});

test('a finding with no area or risk still lists', () => {
  const digest = buildDigest([submitted('WP/2026/010', 'Bare finding', '')], digestLinks());
  assert.ok(digest.body.includes('WP/2026/010'), 'the reference is there');
  assert.ok(digest.body.includes('Bare finding'), 'and the title carries the meaning');
});

test('a title carrying HTML is escaped, never rendered', () => {
  const digest = buildDigest(
    [submitted('WP/2026/011', '<img src=x onerror="alert(1)">')],
    digestLinks(),
  );
  assert.ok(!digest.body.includes('<img'), 'no injected element reaches the mailbox');
  assert.ok(digest.body.includes('&lt;img'), 'it is shown as the text it is');
});

test('digests with no submissions keep the previous shape', () => {
  const digest = buildDigest([
    { subject: 'Action plan assigned: AP-1', intro: 'One' },
    { subject: 'Action plan assigned: AP-2', intro: 'Two' },
  ]);
  assert.equal(digest.subject, 'Audit updates: 2 notifications');
  assert.ok(!digest.body.includes('Review the queue'), 'no review button where none is meant');
});

// The reminder digest (Build Prompt 60). A reminder used to render as the same
// bare block as anything else, "Reminder: draft work paper WP-... [Open]", one
// line per finding. It is now the same table the submissions use, so the two
// read alike and several drafts still make exactly one email.
const reminder = (reference: string, title: string, status = 'Draft'): DigestItem => ({
  subject: `Reminder: draft work paper ${reference}`,
  intro: '',
  link: `https://grc.murikah.com/work-papers/${reference}`,
  table: 'reminder',
  submitted: {
    reference,
    title,
    detail: status,
    link: `https://grc.murikah.com/work-papers/${reference}`,
  },
});

test('several stale drafts compile into one reminder table, with one button', () => {
  const digest = buildDigest(
    [
      reminder('WP/2026/010', 'Depot stock counts not evidenced'),
      reminder('WP/2026/011', 'Petty cash reconciliations outstanding'),
    ],
    digestLinks(),
  );

  assert.equal(digest.subject, '2 draft work papers waiting');
  for (const ref of ['WP/2026/010', 'WP/2026/011']) {
    assert.ok(digest.body.includes(ref), `${ref} must be listed`);
  }
  assert.ok(digest.body.includes('Depot stock counts not evidenced'), 'titles are listed');
  for (const heading of ['Reference', 'Title', 'Status']) {
    assert.ok(digest.body.includes(`>${heading}</th>`), `the table heads ${heading}`);
  }
  assert.ok(digest.body.includes('still in draft'), 'a short lead line says what this is');
  const buttons = digest.body.split('Review the drafts').length - 1;
  assert.equal(buttons, 1, 'exactly one button, whatever the number of drafts');
  assert.ok(digest.body.includes('/work-papers?status=Draft'), 'it points at their own drafts');
  // The bare line it replaced is gone: no naked Open link beside a subject.
  assert.ok(!digest.body.includes('>Open</a>'), 'no bare Open link remains');
});

test('a submission and a reminder in one run stay one email, in two tables', () => {
  const digest = buildDigest(
    [submitted('WP/2026/001', 'A submitted finding'), reminder('WP/2026/010', 'A stale draft')],
    digestLinks(),
  );
  assert.ok(digest.body.includes('A submitted finding'), 'the submission is listed');
  assert.ok(digest.body.includes('A stale draft'), 'and the reminder beside it');
  assert.ok(digest.body.includes('Still in draft'), 'under a heading that separates them');
  assert.equal(digest.body.split('Review the queue').length - 1, 1, 'one review button');
  assert.equal(digest.body.split('Review the drafts').length - 1, 1, 'and one drafts button');
});
