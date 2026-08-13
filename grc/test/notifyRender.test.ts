/**
 * The notification catalogue and rendering. Both modules under test import only
 * types, so node strips them and runs them directly. These pin the per-type
 * priority and HOA copy, the {{variable}} interpolation, the branded inline
 * layout, the DB-template preference and the per-recipient digest.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NOTIFICATION_TYPES,
  TYPE_META,
  priorityOf,
  ccsHoa,
  severityOf,
  isNotificationType,
} from '../../src/lib/grc/notify/types.ts';
import {
  interpolate,
  renderInline,
  renderNotification,
  buildDigest,
  escapeHtml,
  planNormalDigests,
} from '../../src/lib/grc/notify/render.ts';

test('the catalogue has the source types plus due-soon, password-reset and the requirements loop', () => {
  assert.equal(NOTIFICATION_TYPES.length, 27);
  assert.ok(NOTIFICATION_TYPES.includes('DUE_SOON_REMINDER'));
  assert.ok(NOTIFICATION_TYPES.includes('PASSWORD_RESET'));
  // Build Prompt 58: the three events of the requirements loop. All three are
  // between the auditor and the owner, so none copies the head of audit, and
  // all three batch into the ordinary per-recipient digest.
  for (const t of ['REQUIREMENT_ASSIGNED', 'REQUIREMENT_SUBMITTED', 'REQUIREMENT_MORE_INFO']) {
    assert.ok(NOTIFICATION_TYPES.includes(t as (typeof NOTIFICATION_TYPES)[number]), t);
    const m = TYPE_META[t as (typeof NOTIFICATION_TYPES)[number]];
    assert.equal(m.entity, 'requirement', `${t} is about a requirement`);
    assert.equal(m.priority, 'normal', `${t} batches into the digest`);
    assert.equal(m.ccHoa, false, `${t} is not the head of audit's business`);
  }
  // Build Prompt 68: the four events of the auditee loop. Every one of them
  // goes to everybody named on the auditee side, which is the recipient rule
  // rather than the catalogue's business; what the catalogue must say is that
  // they are all about a finding, and that a delegation reaches the person it
  // names promptly rather than in tomorrow's digest.
  for (const t of [
    'AUDITEE_DELEGATED',
    'AUDITEE_RETURNED',
    'AUDITEE_RELEASED',
    'AUDITEE_DECIDED',
  ]) {
    const key = t as (typeof NOTIFICATION_TYPES)[number];
    assert.ok(NOTIFICATION_TYPES.includes(key), t);
    assert.equal(TYPE_META[key].entity, 'work_paper', `${t} is about a finding`);
  }
  assert.equal(
    TYPE_META.AUDITEE_DELEGATED.priority,
    'urgent',
    'being handed the drafting is not digest material: it is somebody being given work',
  );

  for (const t of NOTIFICATION_TYPES) {
    const m = TYPE_META[t];
    assert.ok(m.priority === 'normal' || m.priority === 'urgent');
    assert.ok(
      m.entity === 'work_paper' ||
        m.entity === 'action_plan' ||
        m.entity === 'requirement' ||
        m.entity === 'user',
    );
  }
});

test('an auditee reads a finding table and an instruction, not a system grid', () => {
  // These arrive at people with no audit training and no reason to know the
  // workflow (Build Prompt 68). "Open Audit System" beside a grid of Reference,
  // Status, Risk is a system talking about itself.
  const { subject, body } = renderInline('WP_SENT_TO_AUDITEE', {
    reference: 'WP/2026/002',
    title: 'Fuel reconciliations are not reviewed',
    stage: 'With the auditee',
    riskRating: 'High',
    link: 'https://grc.murikah.com/auditee-responses/WP-1',
  });
  assert.match(subject, /WP\/2026\/002/, 'the subject names the finding');
  assert.match(body, /Log in and respond/, 'the button says what to do');
  assert.ok(!body.includes('Open Audit System'), 'and not what to open');
  assert.match(body, /<th[^>]*>Reference<\/th>/, 'the finding is a table row');
  assert.match(body, /Fuel reconciliations are not reviewed/, 'named in it');
  assert.match(body, /With the auditee/, 'with where it now sits');
  assert.match(body, /grc\.murikah\.com\/auditee-responses\/WP-1/, 'and the deep link');
});

test('a delegation email carries the brief and who it went to', () => {
  const { body } = renderInline('AUDITEE_DELEGATED', {
    reference: 'WP/2026/002',
    title: 'Fuel reconciliations are not reviewed',
    stage: 'With the delegate',
    delegatedTo: 'Stella Staff',
    comment: 'Pull the March reconciliations.',
    link: 'https://grc.murikah.com/auditee-responses/WP-1',
  });
  assert.match(body, /Stella Staff/, 'the person it was handed to');
  assert.match(body, /Pull the March reconciliations/, 'and the brief they were given');
  assert.match(body, /Log in and respond/);
});

test('several findings for one auditee compile into one table, not several emails', () => {
  // The same reason submissions and reminders do: a unit manager copied on nine
  // findings wants a list to work through, not nine envelopes.
  const rows = ['WP/2026/001', 'WP/2026/002', 'WP/2026/003'].map((reference, i) => ({
    id: `N-${i}`,
    batchType: 'AUDITEE_RELEASED',
    recipientEmail: 'owner@hasspetroleum.com',
    subject: `Response released to audit: ${reference}`,
    payload: JSON.stringify({
      reference,
      title: `Finding ${i}`,
      stage: 'With internal audit',
      link: `https://grc.murikah.com/auditee-responses/WP-${i}`,
    }),
  }));
  const plans = planNormalDigests(rows, {
    review: 'https://grc.murikah.com/work-papers?status=Submitted',
    drafts: 'https://grc.murikah.com/work-papers?status=Draft',
    respond: 'https://grc.murikah.com/auditee-responses',
  });
  assert.equal(plans.length, 1, 'one recipient, one email');
  assert.equal(plans[0].rowIds.length, 3, 'settling all three queue rows');
  assert.match(plans[0].subject, /3 findings need your response/);
  for (const reference of ['WP/2026/001', 'WP/2026/002', 'WP/2026/003']) {
    assert.ok(plans[0].body.includes(reference), `${reference} must be in the table`);
  }
  assert.match(plans[0].body, /Log in and respond/, 'with one button, pointing at their queue');
  assert.match(plans[0].body, /auditee-responses/);
});

test('an owner is asked for a thing, not told about a work paper', () => {
  // The auditee sees "what is needed and upload it" and nothing else (Build
  // Prompt 69): a work paper reference is internal audit structure they have
  // never seen and cannot look up.
  const { subject, body } = renderInline('REQUIREMENT_ASSIGNED', {
    reference: 'WP/2026/002',
    title: 'The March fuel reconciliations, signed.',
    dueDate: '2026-03-31',
    status: 'Outstanding',
    link: 'https://grc.murikah.com/requirements/REQ-1',
  });
  assert.match(subject, /Internal Audit needs: The March fuel reconciliations/);
  assert.ok(!subject.includes('WP/2026/002'), 'the subject names no finding');
  assert.ok(!body.includes('WP/2026/002'), 'and neither does the body');
  assert.match(body, /<th[^>]*>Due<\/th>/, 'the table leads with when it is wanted');
  assert.match(body, /<th[^>]*>What is needed<\/th>/);
  assert.match(body, /2026-03-31/, 'carrying the date');
  assert.match(body, /Log in and upload/, 'and one instruction');
  assert.ok(!body.includes('Open Audit System'), 'not a system to open');
});

test('a request for more information says what is still missing', () => {
  const { body } = renderInline('REQUIREMENT_MORE_INFO', {
    title: 'The March fuel reconciliations, signed.',
    dueDate: '2026-03-31',
    status: 'More information needed',
    additionalInfoRequest: 'The reviewer signature is missing from page two.',
    link: 'https://grc.murikah.com/requirements/REQ-1',
  });
  assert.match(body, /reviewer signature is missing/, 'the question the owner answers next');
  assert.match(body, /Log in and upload/);
});

test('everything asked of one owner arrives as one table, not one email each', () => {
  const rows = ['Bank reconciliations', 'Fuel dip readings', 'Depot cash counts'].map(
    (title, i) => ({
      id: `N-${i}`,
      batchType: 'REQUIREMENT_ASSIGNED',
      recipientEmail: 'owner@hasspetroleum.com',
      subject: `Internal Audit needs: ${title}`,
      payload: JSON.stringify({
        title,
        dueDate: '2026-03-31',
        status: 'Outstanding',
        link: `https://grc.murikah.com/requirements/REQ-${i}`,
      }),
    }),
  );
  const plans = planNormalDigests(rows, {
    review: 'https://grc.murikah.com/work-papers?status=Submitted',
    drafts: 'https://grc.murikah.com/work-papers?status=Draft',
    respond: 'https://grc.murikah.com/auditee-responses',
    upload: 'https://grc.murikah.com/requirements',
  });
  assert.equal(plans.length, 1, 'one recipient, one email');
  assert.equal(plans[0].rowIds.length, 3, 'settling all three queue rows');
  assert.match(plans[0].subject, /asked you for 3 items/);
  for (const title of ['Bank reconciliations', 'Fuel dip readings', 'Depot cash counts']) {
    assert.ok(plans[0].body.includes(title), `${title} must be a row in the table`);
  }
  assert.match(plans[0].body, /Log in and upload/, 'with one button');
  assert.match(plans[0].body, /grc\.murikah\.com\/requirements/, 'pointing at their own list');
});

test('the password-reset email is urgent, never copies HOA, and carries the link', () => {
  assert.equal(priorityOf('PASSWORD_RESET'), 'urgent');
  assert.equal(ccsHoa('PASSWORD_RESET'), false);
  const link = 'https://grc.murikah.com/reset-password?token=abc123';
  const rendered = renderNotification(null, 'PASSWORD_RESET', { link });
  assert.ok(rendered.subject.toLowerCase().includes('reset'));
  assert.ok(rendered.body.includes(link), 'the reset link must appear in the email body');
});

test('the due-soon reminder warns without urgency and renders a fallback', () => {
  // Approaching is a warning, not an urgent overdue; the overdue mail stays urgent.
  assert.equal(priorityOf('DUE_SOON_REMINDER'), 'normal');
  assert.equal(severityOf('DUE_SOON_REMINDER'), 'warning');
  const rendered = renderNotification(null, 'DUE_SOON_REMINDER', {
    reference: 'AP-1',
    dueDate: '2026-08-08',
  });
  assert.ok(rendered.subject.includes('AP-1'));
  assert.ok(rendered.subject.toLowerCase().includes('approaching'));
});

test('priority and HOA copy match the source rules', () => {
  assert.equal(priorityOf('WP_SENT_TO_AUDITEE'), 'urgent');
  assert.equal(priorityOf('AP_OVERDUE'), 'urgent');
  assert.equal(priorityOf('WP_ASSIGNMENT'), 'normal');
  assert.equal(ccsHoa('WP_APPROVED'), true);
  assert.equal(ccsHoa('WP_ASSIGNMENT'), false);
  assert.equal(severityOf('WP_SENT_TO_AUDITEE'), 'urgent');
  assert.equal(isNotificationType('AP_ASSIGNED'), true);
  assert.equal(isNotificationType('NOPE'), false);
});

test('interpolate replaces tokens from the payload and blanks missing ones', () => {
  assert.equal(interpolate('Hi {{name}} on {{date}}', { name: 'Ann' }), 'Hi Ann on ');
  assert.equal(interpolate('{{ reference }}', { reference: 'WP-1' }), 'WP-1');
});

test('escapeHtml neutralises markup', () => {
  assert.equal(escapeHtml('<b>&"\'</b>'), '&lt;b&gt;&amp;&quot;&#39;&lt;/b&gt;');
});

test('inline rendering is branded and carries the payload details', () => {
  const r = renderInline('AP_ASSIGNED', {
    reference: 'AP-2026-000001',
    title: 'Fix the control',
    dueDate: '2026-08-01',
    link: 'https://grc.example/action-plans/1',
  });
  assert.equal(r.subject, 'Action plan assigned: AP-2026-000001');
  assert.ok(r.body.includes('#1F2D5C')); // navy header
  assert.ok(r.body.includes('Open Audit System'));
  assert.ok(r.body.includes('audit@hasspetroleum.com'));
  assert.ok(r.body.includes('Hass Petroleum Group - Internal Audit Department'));
  assert.ok(r.body.includes('AP-2026-000001'));
  assert.ok(r.body.includes('https://grc.example/action-plans/1'));
});

test('an active DB template wins over the inline layout', () => {
  const tpl = {
    subjectTemplate: 'Custom {{reference}}',
    bodyTemplate: '<p>Body {{title}}</p>',
    isActive: true,
  };
  const r = renderNotification(tpl, 'WP_APPROVED', { reference: 'WP-9', title: 'Thing' });
  assert.equal(r.subject, 'Custom WP-9');
  assert.equal(r.body, '<p>Body Thing</p>');
});

test('an inactive template falls back to the inline layout', () => {
  const tpl = { subjectTemplate: 'X', bodyTemplate: 'Y', isActive: false };
  const r = renderNotification(tpl, 'WP_APPROVED', { reference: 'WP-9' });
  assert.equal(r.subject, 'Work paper approved: WP-9');
});

test('digest groups many notifications, one keeps its own subject', () => {
  const one = buildDigest([{ subject: 'Only one', intro: 'x' }]);
  assert.equal(one.subject, 'Only one');
  const many = buildDigest([
    { subject: 'A', intro: 'a', link: 'https://x/1' },
    { subject: 'B', intro: 'b' },
  ]);
  assert.equal(many.subject, 'Audit updates: 2 notifications');
  assert.ok(many.body.includes('A'));
  assert.ok(many.body.includes('B'));
  assert.ok(many.body.includes('https://x/1'));
});
