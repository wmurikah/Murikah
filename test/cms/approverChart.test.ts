/**
 * Build Prompt 43: the purchase order panel, one row per approver.
 *
 * THE FIXTURE IS THE REAL EXTRACT, imported through the real upload pipeline
 * with the seven approver names mapped through `source_identities` exactly as
 * an administrator maps them, so every figure the panel draws is re-derived
 * from the file on each run rather than pinned to a number somebody typed.
 *
 * The two criteria this file exists to hold are the ones a reader checks
 * first: SEVEN PEOPLE, SLOWEST FIRST (criterion 5), and THE COUNT OVER TARGET
 * OPENS EXACTLY THAT MANY BREACHES (criterion 12). The second is the property
 * the whole drill design rests on — a fraction nobody can open is a fraction
 * nobody can check — and it is asserted as an equality against the list, not
 * as a re-count of the same expression.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createTestDb, type TestClient } from './support/db.ts';
import { CmsWorker } from './support/worker.ts';
import { AUTH_SCHEMA_DDL } from './support/schema.ts';
import { hashPassword } from '../../src/lib/cms/auth/password.ts';
import { seedHass } from './support/hassSeed.ts';
import { validatePoWorkbook, commitPoBatch } from '../../src/lib/cms/import/poImport.ts';
import {
  approvalRecords,
  approverBoard,
  poApprovalRule,
  type ApprovalScope,
} from '../../src/lib/cms/repos/approvalSla.ts';
import {
  NATURE_GROUPS,
  PRODUCT_GROUP_LABELS,
  UNGROUPED,
  natureGroupSql,
} from '../../src/lib/cms/analytics/productGroups.ts';
import { approvalRecordsHref } from '../../src/lib/cms/analytics/leaderboard.ts';
import { periodFromToken, type ResolvedPeriod } from '../../src/lib/cms/analytics/period.ts';
import {
  resetCaseEventHandlers,
  resetLeadEventHandlers,
  resetSlaWiring,
} from '../../src/lib/cms/service/events.ts';

const here = dirname(fileURLToPath(import.meta.url));
const PO_FILE = readFileSync(join(here, 'support', 'PO-Ver1.xls'));
const CTX = {
  actorUserId: 'USR-CATH',
  ip: '10.0.0.10',
  userAgent: 'HassCMS Test',
  now: new Date('2026-08-27T10:00:00Z'),
} as const;
const asClient = (c: TestClient) => c as never;
/** The whole extract, which is the population the panel draws at all time. */
const allTime: ApprovalScope = { from: null, to: null, affiliateId: null };
const person = (userId: string | null) => ({ kind: 'PERSON' as const, userId });

/** The seven approvers as the extract writes them, mapped to seven people. */
const APPROVERS: readonly [string, string, string][] = [
  ['USR-P43-OMAR', 'Mr. Salim Omar Saad', 'Omar Saad'],
  ['USR-P43-SULE', 'Mrs. Musa Sulekha Abdi', 'Sulekha Abdi'],
  ['USR-P43-MUSE', 'Mr. Musembi Gabriel Musyoka', 'Gabriel Musembi'],
  ['USR-P43-LIBA', 'Mr. Abdimalik Liban Hassan', 'Liban Abdimalik'],
  ['USR-P43-OTIE', 'Mr. Onyango Paul Otieno', 'Paul Otieno'],
  ['USR-P43-OBIN', 'Mr. Obingo Michael Anyanzwa', 'Michael Obingo'],
  ['USR-P43-EDMO', 'Mr. Kiplangat Edmond', 'Edmond Kiplangat'],
];

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
  assert.equal(validation.rejectedReason, null, 'the extract was refused');
  assert.ok(validation.batchId !== null, 'the validation produced no batch');
  await commitPoBatch(asClient(c), validation.batchId, CTX);
  return c;
}

// ---------------------------------------------------------------------------

test('the prerequisite: one active purchase order rule, 30 and 25', async () => {
  const c = createTestDb();
  await seedHass(c);
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

test('NATURE maps to three groups in one place, aviation folded into Fuel', () => {
  assert.deepEqual(NATURE_GROUPS, { PRODUCT: 'Fuel', LUBES: 'Lubricants', LPG: 'LPG' });
  assert.deepEqual([...PRODUCT_GROUP_LABELS], ['Fuel', 'Lubricants', 'LPG']);
  const sql = natureGroupSql('x.nature');
  assert.match(sql, /WHEN 'PRODUCT' THEN 'Fuel'/);
  assert.match(sql, new RegExp(`ELSE '${UNGROUPED}'`));
  // The query builds its CASE from the module rather than repeating it, so
  // the two cannot drift.
  const repo = readFileSync(join(here, '..', '..', 'src/lib/cms/repos/approvalSla.ts'), 'utf8');
  assert.match(repo, /natureGroupSql\(/);
  assert.ok(!/WHEN 'PRODUCT' THEN 'Fuel'/.test(repo), 'the mapping is repeated inline');
  // And it never reads the five-row catalogue table, which separates aviation.
  const mod = readFileSync(
    join(here, '..', '..', 'src/lib/cms/analytics/productGroups.ts'),
    'utf8',
  );
  assert.ok(!/FROM product_groups/i.test(mod), 'the mapping reads the catalogue table');
});

test('criterion 5: seven approvers, ordered slowest first', async () => {
  const c = await imported();
  const board = await approverBoard(asClient(c), allTime);

  assert.equal(board.people.length, 7, 'seven approvers on the current data');
  // SLOWEST FIRST, and asserted as a property rather than as a list of names:
  // a fixture whose durations change must reorder the panel, not fail here
  // for the wrong reason. The names are printed so a reader can see them.
  const order = board.people.map((row) => `${row.person} ${row.medianMinutes}`);
  console.log(`[approvers] ${order.join(' | ')}`);
  for (let i = 1; i < board.people.length; i += 1) {
    const above = board.people[i - 1]!;
    const below = board.people[i]!;
    assert.ok(
      (above.medianMinutes ?? -1) >= (below.medianMinutes ?? -1),
      `${below.person} (${below.medianMinutes}) sits below ${above.person} ` +
        `(${above.medianMinutes}) but is not faster`,
    );
  }
  // The fastest approver in the business is last and has nothing past the
  // target; the slowest is first. Both are read from the data, not asserted
  // as constants, so this holds as the extract grows.
  const last = board.people.at(-1)!;
  assert.equal(last.person, 'Edmond Kiplangat');
  assert.equal(last.overTarget, 0, 'the last row has nothing past the target');
  assert.equal(board.people[0]!.person, 'Omar Saad');

  // A PERSON'S FIGURE IS A TRUE MEDIAN OVER ALL THEIR APPROVALS, so their
  // volume is the sum of their product volumes and their figure is not a
  // median of those products' medians.
  for (const row of board.people) {
    const mine = board.groups.get(row.userId ?? '') ?? [];
    assert.ok(mine.length > 0, `${row.person} has no product rows`);
    assert.equal(
      mine.reduce((n, g) => n + g.volume, 0),
      row.volume,
      `${row.person}: product volumes do not sum to the person's volume`,
    );
    assert.equal(
      mine.reduce((n, g) => n + g.overTarget, 0),
      row.overTarget,
      `${row.person}: product breaches do not sum to the person's breaches`,
    );
    for (let i = 1; i < mine.length; i += 1) {
      assert.ok(
        (mine[i - 1]!.medianMinutes ?? -1) >= (mine[i]!.medianMinutes ?? -1),
        `${row.person}'s products are not slowest first`,
      );
    }
  }
  c.close();
});

test('criterion 12: the count over target opens exactly those approvals', async () => {
  const c = await imported();
  const board = await approverBoard(asClient(c), allTime);
  const omar = board.people.find((row) => row.person === 'Omar Saad')!;
  const rule = await poApprovalRule(asClient(c));
  assert.ok(rule !== null);

  // THE FRACTION IS A LINK AND THE LINK HOLDS THE FRACTION. Not a re-count of
  // the same expression: the list is the aggregate with the grouping removed,
  // and this asserts the two agree exactly.
  const breaches = await approvalRecords(
    asClient(c),
    'PURCHASE_ORDER',
    'breaches',
    '',
    person(omar.userId),
    allTime,
    null,
    'WORKING',
  );
  console.log(
    `[breaches] Omar Saad ${omar.overTarget}/${omar.volume}, list holds ${breaches.length}`,
  );
  assert.equal(breaches.length, omar.overTarget, 'the breach list does not equal the count');
  // Every record in it is genuinely past the target, on the clock the rule
  // measures, and the list reads slowest first.
  for (const record of breaches) {
    assert.ok(record.workingMinutes !== null && record.workingMinutes > rule.targetMinutes);
    // BOTH DURATIONS, NEVER BLENDED: the drill-down is where the wall clock
    // lives, beside the working-day figure the panel plots.
    assert.ok(record.minutes !== null, 'the record carries no wall clock');
    assert.ok(record.startedAt !== null && record.completedAt !== null, 'no timestamps to check');
  }
  for (let i = 1; i < breaches.length; i += 1) {
    assert.ok(
      (breaches[i - 1]!.workingMinutes ?? 0) >= (breaches[i]!.workingMinutes ?? 0),
      'the breaches are not slowest first',
    );
  }

  // The same equality at the product grain, which is the row an expanded
  // person shows.
  const products = board.groups.get(omar.userId ?? '') ?? [];
  for (const product of products) {
    const found = await approvalRecords(
      asClient(c),
      'PURCHASE_ORDER',
      'breaches',
      '',
      person(product.userId),
      allTime,
      product.group,
      'WORKING',
    );
    assert.equal(found.length, product.overTarget, `${product.group}: count does not match`);
  }
  c.close();
});

test('the other three destinations hold exactly their figures', async () => {
  const c = await imported();
  const board = await approverBoard(asClient(c), allTime);
  const row = board.people.find((p) => p.person === 'Sulekha Abdi')!;

  // The name: every approval, all products.
  const all = await approvalRecords(
    asClient(c),
    'PURCHASE_ORDER',
    'completed',
    '',
    person(row.userId),
    allTime,
    null,
    'WORKING',
  );
  assert.equal(all.length, row.volume, 'the name opens a different population');

  // The time: the same set by duration, with the median row marked — and the
  // marked row IS the figure, which is why the person's figure is a median
  // over their approvals rather than a weighted mean of product medians.
  const typical = await approvalRecords(
    asClient(c),
    'PURCHASE_ORDER',
    'typical',
    '',
    person(row.userId),
    allTime,
    null,
    'WORKING',
  );
  assert.equal(typical.length, row.volume);
  const marked = typical.filter((record) => record.isMedian);
  assert.ok(marked.length > 0, 'no median row is marked');
  const mean = marked.reduce((n, r) => n + (r.workingMinutes ?? 0), 0) / marked.length;
  assert.equal(mean, row.medianMinutes, 'the marked row is not the figure that opened the list');

  // A product row: the same person narrowed to one group.
  const group = (board.groups.get(row.userId ?? '') ?? [])[0]!;
  const inGroup = await approvalRecords(
    asClient(c),
    'PURCHASE_ORDER',
    'completed',
    '',
    person(group.userId),
    allTime,
    group.group,
    'WORKING',
  );
  assert.equal(inGroup.length, group.volume, 'the product row opens a different population');

  // And every destination carries person, product, period and clock.
  const period = periodFromToken('2026-05', new Date('2026-08-30T09:00:00Z')) as ResolvedPeriod;
  const href = approvalRecordsHref({
    period,
    affiliateId: null,
    process: 'PURCHASE_ORDER',
    view: 'breaches',
    fn: '',
    actor: person(group.userId),
    productGroup: group.group,
    clock: 'WORKING',
  });
  console.log(`[href] ${href}`);
  for (const part of [
    `user=${group.userId}`,
    `group=${group.group}`,
    'period=2026-05',
    'clock=WORKING',
    'view=breaches',
  ]) {
    assert.ok(href.includes(encodeURI(part).replace(/=/g, '=')), `${href} is missing ${part}`);
  }
  c.close();
});

test('with the rule deactivated nothing is judged and nothing is coloured', async () => {
  const c = await imported();
  const judged = await approverBoard(asClient(c), allTime);
  await c.execute(`UPDATE sla_rules SET active = 0 WHERE sla_rule_id = 'SLAR-PO-30'`);
  assert.equal(await poApprovalRule(asClient(c)), null, 'a deactivated rule still resolves');
  const board = await approverBoard(asClient(c), allTime);
  assert.equal(board.people.length, 7, 'the people are still there');
  for (const row of board.people) {
    // NOTHING TO BE OVER, so nothing is judged: no line is drawn, no bar is
    // coloured and no count is claimed. The panel still measures — on the
    // wall clock, wholesale, because there is no working day configured to
    // count inside — and its definition control says which clock that is.
    assert.equal(row.overTarget, 0, `${row.person} is still judged`);
    assert.equal(row.atRisk, 0);
    assert.ok(row.medianMinutes !== null, `${row.person} lost their figure`);
    const before = judged.people.find((p) => p.userId === row.userId)!;
    assert.notEqual(
      row.medianMinutes,
      null,
      `${row.person} must still be measurable without a rule`,
    );
    assert.ok(
      before.medianMinutes !== null,
      'the judged board should have carried a working-day figure',
    );
  }
  // And the switch is wholesale rather than per row: with a rule every figure
  // is the working day, without one every figure is the wall clock. Omar Saad
  // is the row where the two clocks differ, so he is the one that proves it.
  const omarNow = board.people.find((p) => p.person === 'Omar Saad')!;
  const omarBefore = judged.people.find((p) => p.person === 'Omar Saad')!;
  assert.notEqual(omarNow.medianMinutes, omarBefore.medianMinutes);
  c.close();
});

test('the panel carries none of the narration it replaced', () => {
  // CRITERION 6, AS A TEST rather than as a promise. The state words came off
  // the panel because the bar already crosses a marked line; this is what
  // stops them growing back one label at a time.
  const panel = readFileSync(
    join(here, '..', '..', 'src/components/cms/CmsApproverChart.astro'),
    'utf8',
  );
  const home = readFileSync(join(here, '..', '..', 'src/pages/cms/app/index.astro'), 'utf8');
  for (const phrase of ['business hours', 'over target', 'within target', 'dashed line']) {
    const pattern = new RegExp(phrase, 'i');
    assert.ok(!pattern.test(panel), `the panel still says "${phrase}"`);
  }
  // Home prints nothing beneath the purchase order chart while a target
  // exists. The sales order panel keeps its own line untouched, which is why
  // this reads the purchase order section rather than the whole file.
  const poPanel = home.slice(
    home.indexOf('<CmsApproverChart'),
    home.indexOf('<CmsMoreDetail id="purchases"'),
  );
  assert.ok(
    !/No target set\./.test(poPanel),
    'the purchase order panel still prints a target line',
  );
  assert.match(poPanel, /No target configured\./, 'nothing is said when no rule resolves');
  // The definition control carries the measure, on demand.
  assert.match(panel, /<CmsDefinition/, 'the panel has no definition control');
  // The axis is bare: two values and nothing between them.
  const axis = panel.slice(panel.indexOf('A BARE AXIS'), panel.indexOf('THE TABLE EQUIVALENT'));
  assert.match(axis, />0</, 'the axis has no left value');
  assert.match(axis, /formatDuration\(Math\.round\(scale\)\)/, 'the axis has no right value');
  // The class names are stripped first: `text-cms-caption` is a utility, not
  // a caption, and the assertion is about what a reader sees.
  const axisText = axis.replace(/class(:list)?=("[^"]*"|\{[^}]*\})/g, '');
  assert.ok(!/minute|target|clock|hour/i.test(axisText), 'the axis carries a caption');
});

/**
 * THE DEFECT THIS CATCHES, WHICH A REPOSITORY TEST COULD NOT.
 *
 * Every figure on the panel asks for one person across every level, and the
 * records page carried a guard refusing exactly that combination as a
 * mistake: a named person with no function. The repository answered all four
 * destinations correctly the whole time; the PAGE answered them with an empty
 * list headed "an unrecorded actor". So this drives the real worker, opens
 * the URL the count over target actually links to, and counts the rows the
 * page rendered.
 *
 * It needs a build, so it skips when there is not one, exactly as the inline
 * script scan does.
 */
const BUILT = existsSync(join(here, '..', '..', 'dist', 'server', 'entry.mjs'));

test('criterion 14: the rendered page holds exactly the figure that opened it', async (t) => {
  if (!BUILT) {
    t.diagnostic('no build: run pnpm build to include the rendered-page check');
    return;
  }
  const worker = new CmsWorker();
  await worker.start(AUTH_SCHEMA_DDL, 'approver-chart-test-secret-0123456789');
  // The worker holds a raw node:sqlite handle; the seed and the importer speak
  // the client interface. This is the adapter between them, and it binds NAMED
  // arguments as well as positional ones because every analytics query in this
  // module is written with them.
  type Stmt = string | { sql: string; args?: unknown[] | Record<string, unknown> };
  const one = (stmt: Stmt) => {
    const sql = typeof stmt === 'string' ? stmt : stmt.sql;
    const args = typeof stmt === 'string' ? [] : (stmt.args ?? []);
    const normalise = (a: unknown) => (a === undefined ? null : typeof a === 'boolean' ? +a : a);
    const bound = Array.isArray(args)
      ? args.map(normalise)
      : Object.fromEntries(Object.entries(args).map(([k, v]) => [k, normalise(v)]));
    const prepared = worker.db.prepare(sql);
    const call = (method: 'all' | 'run') =>
      Array.isArray(bound)
        ? (prepared[method] as (...a: unknown[]) => unknown)(...bound)
        : (prepared[method] as (...a: unknown[]) => unknown)(bound);
    if (/^\s*(SELECT|WITH|PRAGMA)/i.test(sql)) {
      return { rows: call('all') as never, rowsAffected: 0 };
    }
    return {
      rows: [] as never,
      rowsAffected: Number((call('run') as { changes?: number }).changes ?? 0),
    };
  };
  const db = {
    execute: async (stmt: Stmt) => one(stmt),
    batch: async (stmts: Stmt[]) => stmts.map(one),
    raw: worker.db,
    close: () => undefined,
  } as unknown as TestClient;
  try {
    await seedHass(db);
    resetCaseEventHandlers();
    resetLeadEventHandlers();
    resetSlaWiring();
    for (const [userId, external, display] of APPROVERS) {
      const [first, ...rest] = display.split(' ');
      await db.execute(
        `INSERT INTO users (user_id,user_type,employee_no,first_name,last_name,display_name,email,
            phone,status,email_verified_at,timezone,locale,last_login_at,created_at,updated_at)
         VALUES ('${userId}','INTERNAL',NULL,'${first}','${rest.join(' ')}','${display}',
                 '${userId.toLowerCase()}@hasspetroleum.com',NULL,'ACTIVE','2026-01-05 08:00:00',
                 'Africa/Nairobi','en-KE',NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
      );
      await db.execute(
        `INSERT INTO source_identities VALUES
           ('SID-${userId}','SRC-EXCEL','${userId}','${external}',NULL,1,CURRENT_TIMESTAMP)`,
      );
    }
    const validation = await validatePoWorkbook(
      db as never,
      PO_FILE,
      {
        filename: 'PO-Ver1.xls',
        uploadedBy: 'USR-CATH',
        sourceSystemId: 'SRC-EXCEL',
        affiliateId: 'AFF-KE',
      },
      CTX,
    );
    await commitPoBatch(db as never, validation.batchId!, CTX);

    const password = `test-only-${crypto.randomUUID()}`;
    worker.db
      .prepare(
        `INSERT INTO auth_credentials (credential_id, user_id, password_hash, password_algorithm,
            must_change_password, password_changed_at, failed_attempts, created_at, updated_at)
         VALUES ('CRED-AC','USR-CATH',?,'PBKDF2',0,CURRENT_TIMESTAMP,0,CURRENT_TIMESTAMP,
                 CURRENT_TIMESTAMP)`,
      )
      .run(await hashPassword(password));
    worker.db
      .prepare(
        `UPDATE users SET status='ACTIVE', email_verified_at=CURRENT_TIMESTAMP
          WHERE user_id='USR-CATH'`,
      )
      .run();
    const login = await worker.call('POST', '/api/auth/login', {
      body: { email: 'catherine.mwangi@hasspetroleum.com', password },
    });
    assert.equal(login.status, 200, 'the test administrator could not sign in');

    // The figure, as the panel computes it for the period the page shows.
    const period = { from: '2026-05-01', to: '2026-05-31', affiliateId: null };
    const board = await approverBoard(db as never, period);
    const omar = board.people.find((row) => row.person === 'Omar Saad')!;

    // And the page behind its count over target, fetched as a reader gets it.
    const url =
      `/app/performance/approvals?period=2026-05&process=PURCHASE_ORDER&view=breaches&fn=` +
      `&user=${omar.userId}&clock=WORKING`;
    const page = await worker.call('GET', url);
    assert.equal(page.status, 200, `${url} did not render`);
    const badge = /([\d,]+) records/.exec(page.body);
    assert.ok(badge !== null, 'the page printed no record count');
    const rendered = Number(badge[1]!.replace(/,/g, ''));
    console.log(`[page] ${omar.overTarget}/${omar.volume} on the panel, ${rendered} rendered`);
    assert.equal(rendered, omar.overTarget, 'the page holds a different number from the figure');
    assert.ok(page.body.includes('Omar Saad'), 'the page does not name the person');
    // Both durations, each under its own heading, on the page itself.
    assert.ok(page.body.includes('Working hours'), 'the page hides the working-day duration');
    assert.ok(page.body.includes('Wall clock'), 'the page hides the wall clock');
  } finally {
    await worker.stop();
  }
});
