/**
 * Build Prompt 43: the purchase order chart, by person and product.
 *
 * THE FIXTURE IS THE REAL EXTRACT, so the thirteen rows the build was designed
 * around are re-verified against PO-Ver1.xls on every run — person, product
 * group, volume, elapsed median and over-target count, in the order the chart
 * draws them (criterion 4). The seven approver names arrive in the file's own
 * reversed display-name form and are mapped through source_identities, exactly
 * as an administrator maps them in production.
 *
 * TWO CLOCKS, PINNED SEPARATELY (criterion 9). Elapsed is wall clock; the
 * accountable clock counts only the rule's business window, 08:00–17:00. Omar
 * Saad on LPG is 451 elapsed against 446 accountable over the same 21
 * approvals, and Sulekha Abdi on LPG breaches 10 of 21 on the wall clock but 8
 * of 21 on the clock the rule measures — the engine must report FEWER breaches
 * on business hours, never more, and never blend the two into one figure.
 *
 * THE TARGET IS READ, NEVER HARD-CODED: the rule row the operator's script
 * created is asserted first, and deactivating it must take the target — and
 * every accountable figure — away without touching the elapsed ones.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createTestDb, type TestClient } from './support/db.ts';
import { seedHass, SEED } from './support/hassSeed.ts';
import { validatePoWorkbook, commitPoBatch } from '../../src/lib/cms/import/poImport.ts';
import {
  approvalRecords,
  approverGroupBoard,
  poApprovalRule,
  type ApprovalScope,
} from '../../src/lib/cms/repos/approvalSla.ts';
import {
  NATURE_GROUPS,
  PRODUCT_GROUP_LABELS,
  UNGROUPED,
  natureGroupSql,
} from '../../src/lib/cms/analytics/productGroups.ts';
import {
  resetCaseEventHandlers,
  resetLeadEventHandlers,
  resetSlaWiring,
} from '../../src/lib/cms/service/events.ts';

const here = dirname(fileURLToPath(import.meta.url));
const PO_FILE = readFileSync(join(here, 'support', 'PO-Ver1.xls'));

const NOW = new Date('2026-08-27T10:00:00Z');
const CTX = {
  actorUserId: SEED.admin,
  ip: '10.0.0.10',
  userAgent: 'HassCMS Test',
  now: NOW,
} as const;

const asClient = (c: TestClient) => c as never;

/**
 * The whole extract, which is what the section 1 table was measured over. The
 * seed's own August stage instances stay out of the way regardless: its one
 * purchase order stage has never completed, and a stage with no completion has
 * no duration to chart.
 */
const allTime: ApprovalScope = { from: null, to: null, affiliateId: null };
const person = (userId: string | null) => ({ kind: 'PERSON' as const, userId });

/**
 * The seven approvers as the extract writes them, mapped to seven people the
 * way production maps them: one source_identities row each, group-wide.
 */
const APPROVERS: readonly [string, string, string][] = [
  ['USR-P43-OMAR', 'Mr. Salim Omar Saad', 'Omar Saad'],
  ['USR-P43-SULE', 'Mrs. Musa Sulekha Abdi', 'Sulekha Abdi'],
  ['USR-P43-MUSE', 'Mr. Musembi Gabriel Musyoka', 'Gabriel Musembi'],
  ['USR-P43-LIBA', 'Mr. Abdimalik Liban Hassan', 'Liban Abdimalik'],
  ['USR-P43-OTIE', 'Mr. Onyango Paul Otieno', 'Paul Otieno'],
  ['USR-P43-OBIN', 'Mr. Obingo Michael Anyanzwa', 'Michael Obingo'],
  ['USR-P43-EDMO', 'Mr. Kiplangat Edmond', 'Edmond Kiplangat'],
];

/**
 * Section 1 of the build prompt, verbatim: thirteen rows, slowest first, with
 * the accountable figures the 08:00–17:00 window produces from the same
 * approvals. `eMed`/`eOver` are the wall clock, `aMed`/`aOver` the clock the
 * rule measures, and `risk` the approvals past the 25-minute warning but
 * within the 30-minute target.
 */
const EXPECTED: readonly {
  person: string;
  group: string;
  volume: number;
  eMed: number;
  eOver: number;
  aMed: number;
  aOver: number;
  risk: number;
}[] = [
  {
    person: 'Omar Saad',
    group: 'LPG',
    volume: 21,
    eMed: 451,
    eOver: 16,
    aMed: 446,
    aOver: 16,
    risk: 0,
  },
  {
    person: 'Sulekha Abdi',
    group: 'Fuel',
    volume: 11,
    eMed: 63,
    eOver: 8,
    aMed: 62,
    aOver: 8,
    risk: 0,
  },
  {
    person: 'Gabriel Musembi',
    group: 'Fuel',
    volume: 11,
    eMed: 38,
    eOver: 7,
    aMed: 39,
    aOver: 7,
    risk: 2,
  },
  {
    person: 'Liban Abdimalik',
    group: 'Lubricants',
    volume: 13,
    eMed: 37,
    eOver: 7,
    aMed: 26,
    aOver: 6,
    risk: 1,
  },
  {
    person: 'Paul Otieno',
    group: 'LPG',
    volume: 5,
    eMed: 36,
    eOver: 5,
    aMed: 36,
    aOver: 5,
    risk: 0,
  },
  {
    person: 'Sulekha Abdi',
    group: 'LPG',
    volume: 21,
    eMed: 30,
    eOver: 10,
    aMed: 29,
    aOver: 8,
    risk: 3,
  },
  {
    person: 'Gabriel Musembi',
    group: 'LPG',
    volume: 16,
    eMed: 26,
    eOver: 8,
    aMed: 27,
    aOver: 8,
    risk: 0,
  },
  {
    person: 'Sulekha Abdi',
    group: 'Lubricants',
    volume: 13,
    eMed: 23,
    eOver: 4,
    aMed: 23,
    aOver: 4,
    risk: 1,
  },
  {
    person: 'Liban Abdimalik',
    group: 'LPG',
    volume: 21,
    eMed: 22,
    eOver: 9,
    aMed: 22,
    aOver: 9,
    risk: 1,
  },
  {
    person: 'Gabriel Musembi',
    group: 'Lubricants',
    volume: 13,
    eMed: 18,
    eOver: 5,
    aMed: 18,
    aOver: 5,
    risk: 1,
  },
  {
    person: 'Michael Obingo',
    group: 'Lubricants',
    volume: 13,
    eMed: 18,
    eOver: 3,
    aMed: 18,
    aOver: 3,
    risk: 1,
  },
  {
    person: 'Edmond Kiplangat',
    group: 'Fuel',
    volume: 11,
    eMed: 9,
    eOver: 0,
    aMed: 8,
    aOver: 0,
    risk: 0,
  },
  {
    person: 'Liban Abdimalik',
    group: 'Fuel',
    volume: 11,
    eMed: 5,
    eOver: 3,
    aMed: 4,
    aOver: 3,
    risk: 0,
  },
];

/** Seed, map the seven approvers, and import the real extract. */
async function imported(): Promise<TestClient> {
  const c = createTestDb();
  await seedHass(c);
  resetCaseEventHandlers();
  resetLeadEventHandlers();
  resetSlaWiring();
  for (const [userId, external, display] of APPROVERS) {
    const [first, ...rest] = display.split(' ');
    await c.execute(
      `INSERT INTO users
         (user_id,user_type,employee_no,first_name,last_name,display_name,email,phone,status,
          email_verified_at,timezone,locale,last_login_at,created_at,updated_at)
       VALUES ('${userId}','INTERNAL',NULL,'${first}','${rest.join(' ')}','${display}',
               '${userId.toLowerCase()}@hasspetroleum.com',NULL,'ACTIVE','2026-01-05 08:00:00',
               'Africa/Nairobi','en-KE',NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    );
    await c.execute(
      `INSERT INTO source_identities VALUES
         ('SID-${userId}','SRC-EXCEL','${userId}','${external}',NULL,1,CURRENT_TIMESTAMP)`,
    );
  }
  const validation = await validatePoWorkbook(
    asClient(c),
    PO_FILE,
    {
      filename: 'PO-Ver1.xls',
      uploadedBy: 'USR-CATH',
      sourceSystemId: 'SRC-EXCEL',
      affiliateId: 'AFF-KE',
    },
    CTX,
  );
  assert.equal(
    validation.rejectedReason,
    null,
    `the upload was refused: ${validation.rejectedReason}`,
  );
  assert.ok(validation.batchId !== null, 'the validation produced a batch');
  await commitPoBatch(asClient(c), validation.batchId, CTX);
  return c;
}

// ---------------------------------------------------------------------------

test('the prerequisite: the operator’s SLA rule exists, active, exactly once', async () => {
  const c = createTestDb();
  await seedHass(c);
  // The build prompt's own check, verbatim in shape: one row, SLAR-PO-30,
  // 30-minute target, 25-minute warning, active.
  const rows = (
    await c.execute(
      `SELECT sla_rule_id, target_minutes, warning_minutes, active FROM sla_rules
        WHERE entity_type = 'PURCHASE_ORDER' AND active = 1`,
    )
  ).rows as Record<string, unknown>[];
  assert.equal(rows.length, 1, 'exactly one active purchase order rule');
  assert.equal(rows[0]!.sla_rule_id, 'SLAR-PO-30');
  assert.equal(rows[0]!.target_minutes, 30);
  assert.equal(rows[0]!.warning_minutes, 25);
  c.close();
});

test('the NATURE mapping is three groups in one place, aviation folded into Fuel', () => {
  // The one place (criterion 5): PRODUCT is the merged fuels view — AGO, PMS
  // and Jet A1 together — so no aviation group exists to chart separately.
  assert.deepEqual(NATURE_GROUPS, { PRODUCT: 'Fuel', LUBES: 'Lubricants', LPG: 'LPG' });
  assert.deepEqual([...PRODUCT_GROUP_LABELS], ['Fuel', 'Lubricants', 'LPG']);
  // The SQL arm of the mapping is BUILT from the same object, so the query
  // cannot drift from the module; anything unmapped falls out as Ungrouped
  // rather than being folded into a group it never claimed.
  const sql = natureGroupSql('x.nature');
  assert.match(sql, /WHEN 'PRODUCT' THEN 'Fuel'/);
  assert.match(sql, /WHEN 'LPG' THEN 'LPG'/);
  assert.match(sql, new RegExp(`ELSE '${UNGROUPED}'`));
  // And the repository consumes it rather than repeating it inline: the CASE
  // is compiled in from the module, so the mapping exists exactly once.
  const repo = readFileSync(
    join(here, '..', '..', 'src', 'lib', 'cms', 'repos', 'approvalSla.ts'),
    'utf8',
  );
  assert.match(repo, /natureGroupSql\(/, 'the query builds its CASE from the module');
  assert.ok(
    !/WHEN 'PRODUCT' THEN 'Fuel'/.test(repo),
    'the mapping is not repeated inline in the query',
  );
  // Deliberately NOT the five-row product_groups table.
  const mod = readFileSync(
    join(here, '..', '..', 'src', 'lib', 'cms', 'analytics', 'productGroups.ts'),
    'utf8',
  );
  assert.ok(!/FROM product_groups/i.test(mod), 'the mapping never reads product_groups');
});

test('criterion 4: thirteen rows, matching the section 1 table, slowest first', async () => {
  const c = await imported();
  const board = await approverGroupBoard(asClient(c), allTime);

  assert.equal(board.rows.length, EXPECTED.length, 'thirteen person-and-group rows');
  for (const [i, want] of EXPECTED.entries()) {
    const got = board.rows[i]!;
    const at = `row ${i + 1} (${want.person}, ${want.group})`;
    assert.equal(got.person, want.person, `${at}: person`);
    assert.equal(got.group, want.group, `${at}: group`);
    assert.equal(got.volume, want.volume, `${at}: volume`);
    assert.equal(got.elapsedMedianMinutes, want.eMed, `${at}: elapsed median`);
    assert.equal(got.elapsedOverTarget, want.eOver, `${at}: elapsed over target`);
  }

  // Criterion 14, said in the prompt's own words: Omar Saad at the top,
  // Liban Abdimalik on fuel at the bottom — ordered by median, slowest
  // first, never alphabetically and never name-then-group.
  assert.equal(board.rows[0]!.person, 'Omar Saad');
  assert.equal(board.rows[0]!.group, 'LPG');
  assert.equal(board.rows.at(-1)!.person, 'Liban Abdimalik');
  assert.equal(board.rows.at(-1)!.group, 'Fuel');

  // The levels behind a row are the same population regrouped, so their
  // volumes sum to the row's own — the drill-down invents and loses nothing.
  for (const row of board.rows) {
    const levels = board.levels.get(`${row.userId ?? ''}|${row.group}`) ?? [];
    assert.ok(levels.length > 0, `${row.person} ${row.group} has level rows behind it`);
    assert.equal(
      levels.reduce((n, l) => n + l.volume, 0),
      row.volume,
      `${row.person} ${row.group}: level volumes sum to the row volume`,
    );
    for (const level of levels) {
      assert.ok(level.levelOrder !== null && level.levelName !== null, 'levels are named');
    }
  }
  c.close();
});

test('criterion 9: elapsed and accountable are different clocks, never blended', async () => {
  const c = await imported();
  const board = await approverGroupBoard(asClient(c), allTime);
  const at = (p: string, g: string) =>
    board.rows.find((row) => row.person === p && row.group === g)!;

  // Every row carries BOTH clocks, each its own field — there is no single
  // blended figure anywhere in the shape.
  for (const [i, want] of EXPECTED.entries()) {
    const got = board.rows[i]!;
    const label = `row ${i + 1} (${want.person}, ${want.group})`;
    assert.equal(got.accountableMedianMinutes, want.aMed, `${label}: accountable median`);
    assert.equal(got.accountableOverTarget, want.aOver, `${label}: accountable over target`);
    assert.equal(got.accountableAtRisk, want.risk, `${label}: at risk`);
  }

  // The pair the prompt names: Omar Saad on LPG is 451 elapsed and 446
  // accountable over the same 21 approvals — the long holds span nights the
  // business window does not count, so the clocks differ without either
  // being wrong.
  const omar = at('Omar Saad', 'LPG');
  assert.equal(omar.elapsedMedianMinutes, 451);
  assert.equal(omar.accountableMedianMinutes, 446);
  assert.equal(omar.volume, 21);
  assert.equal(omar.elapsedOverTarget, 16);
  assert.equal(omar.accountableOverTarget, 16);

  // And the row where the clock CHANGES the verdict: Sulekha Abdi on LPG
  // breaches 10 of 21 on the wall clock but 8 of 21 on business hours. The
  // rule sets business_hours_only, so the engine reports fewer breaches than
  // the elapsed table — never more.
  const sulekha = at('Sulekha Abdi', 'LPG');
  assert.equal(sulekha.elapsedOverTarget, 10);
  assert.equal(sulekha.accountableOverTarget, 8);
  for (const row of board.rows) {
    assert.ok(
      row.accountableOverTarget <= row.elapsedOverTarget,
      `${row.person} ${row.group}: business hours can only remove breaches, never add them`,
    );
  }
  c.close();
});

test('the target is read from the rule, and deactivating it takes the line away', async () => {
  const c = await imported();
  // Criterion 6: the 30 arrives from sla_rules with the calendar window it
  // counts — nothing here or in the component holds a 30 of its own.
  const rule = await poApprovalRule(asClient(c));
  assert.ok(rule !== null, 'the active rule resolves');
  assert.equal(rule.ruleId, 'SLAR-PO-30');
  assert.equal(rule.targetMinutes, 30);
  assert.equal(rule.warningMinutes, 25);
  assert.equal(rule.businessHoursOnly, true);
  assert.equal(rule.workdayStart, '08:00');
  assert.equal(rule.workdayEnd, '17:00');

  // Criterion 7: deactivate the rule and the target is GONE — no rule row,
  // and no accountable figure either, because a business window nobody
  // configured cannot be counted. The elapsed clock survives untouched.
  await c.execute(`UPDATE sla_rules SET active = 0 WHERE sla_rule_id = 'SLAR-PO-30'`);
  assert.equal(await poApprovalRule(asClient(c)), null);
  const board = await approverGroupBoard(asClient(c), allTime);
  assert.equal(board.rows.length, EXPECTED.length);
  for (const [i, want] of EXPECTED.entries()) {
    const got = board.rows[i]!;
    assert.equal(got.elapsedMedianMinutes, want.eMed, 'elapsed is not the rule’s to take');
    assert.equal(got.accountableMedianMinutes, null, 'no rule, no accountable clock');
    assert.equal(got.elapsedOverTarget, 0, 'no target, no over-target count');
    assert.equal(got.accountableOverTarget, 0);
  }
  c.close();
});

test('criterion 13: a figure’s destination holds exactly that many records', async () => {
  const c = await imported();
  const board = await approverGroupBoard(asClient(c), allTime);

  // The group-grain figure: Omar Saad's 21 LPG approvals, as the list the
  // bar's figure opens — same person, same product group, same period.
  const omar = board.rows.find((row) => row.person === 'Omar Saad' && row.group === 'LPG')!;
  const records = await approvalRecords(
    asClient(c),
    'PURCHASE_ORDER',
    'completed',
    '',
    person(omar.userId),
    allTime,
    'LPG',
  );
  assert.equal(records.length, omar.volume, 'the destination count equals the figure');

  // And the level grain, which is the figure an expanded row shows: the
  // same list narrowed to one level, cut by the same three predicates.
  const levels = board.levels.get(`${omar.userId ?? ''}|LPG`) ?? [];
  assert.ok(levels.length > 0);
  for (const level of levels) {
    const levelRecords = await approvalRecords(
      asClient(c),
      'PURCHASE_ORDER',
      'completed',
      level.levelName ?? '',
      person(level.userId),
      allTime,
      'LPG',
    );
    assert.equal(
      levelRecords.length,
      level.volume,
      `level ${level.levelOrder}: destination count equals the figure`,
    );
  }

  // A group the person never touched holds nothing — the predicate narrows,
  // it does not leak.
  const edmond = board.rows.find((row) => row.person === 'Edmond Kiplangat')!;
  const none = await approvalRecords(
    asClient(c),
    'PURCHASE_ORDER',
    'completed',
    '',
    person(edmond.userId),
    allTime,
    'LPG',
  );
  assert.equal(none.length, 0, 'Edmond Kiplangat approves fuel, not LPG');
  c.close();
});
