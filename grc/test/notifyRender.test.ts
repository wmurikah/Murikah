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
} from '../../src/lib/grc/notify/render.ts';

test('the catalogue has the source types plus due-soon, password-reset and the requirements loop', () => {
  assert.equal(NOTIFICATION_TYPES.length, 23);
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
