import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTestDb } from './support/db.ts';
import { seedHass } from './support/hassSeed.ts';

const migration = readFileSync(
  new URL('../../db/migrations/007_signed_sla_targets.sql', import.meta.url),
  'utf8',
);

test('signed SLA migration repairs drift and is idempotent', async () => {
  const db = createTestDb();
  await seedHass(db);
  db.raw.exec(`
    UPDATE sla_rules
       SET target_minutes = 30, warning_minutes = 25,
           escalation_after_minutes = 30, active = 1
     WHERE sla_rule_id IN ('SLAR-003', 'SLAR-004', 'SLAR-SO-LA');
  `);

  db.raw.exec(migration);
  db.raw.exec(migration);

  const rows = db.raw
    .prepare(
      `SELECT sla_rule_id, target_minutes, warning_minutes,
                    escalation_after_minutes, active
               FROM sla_rules
              WHERE sla_rule_id IN
                    ('SLAR-003','SLAR-004','SLAR-SO-LA','SLAR-PO-30')
              ORDER BY sla_rule_id`,
    )
    .all();
  assert.deepEqual(
    rows.map((row) => [
      row.sla_rule_id,
      row.target_minutes,
      row.warning_minutes,
      row.escalation_after_minutes,
      row.active,
    ]),
    [
      ['SLAR-003', 15, 10, 15, 1],
      ['SLAR-004', 15, 10, 15, 1],
      ['SLAR-PO-30', 30, 25, 30, 1],
      ['SLAR-SO-LA', 10, 5, 10, 0],
    ],
  );

  const unrelated = db.raw
    .prepare(
      `SELECT target_minutes, warning_minutes, active
                FROM sla_rules WHERE sla_rule_id = 'SLAR-001'`,
    )
    .get();
  assert.deepEqual({ ...unrelated }, { target_minutes: 60, warning_minutes: 45, active: 1 });
  db.close();
});

test('the UI explains why the signed LA target is unavailable', () => {
  const panel = readFileSync(
    new URL('../../src/components/cms/CmsLoadingAuthorityChart.astro', import.meta.url),
    'utf8',
  );
  assert.match(panel, /signed 10-minute LA-generation target/);
  assert.match(panel, /funds or an LPO are received/);
  assert.match(panel, /start timestamp is absent from the extract/);
});
