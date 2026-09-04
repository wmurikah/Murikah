/**
 * Build Prompt 44: the Loading Authority panel.
 *
 * THE FIXTURE IS THE REAL EXTRACT, imported through the real upload pipeline
 * with the four approver names the file carries mapped through
 * `source_identities`, so every figure is re-derived from SO-Ver1.xls on each
 * run rather than pinned to a number somebody typed.
 *
 * The three criteria this file exists to hold: EACH FUNCTION IS JUDGED BY ITS
 * OWN TARGET (9), A FUNCTION WITH NO RULE IS GREY AND UNJUDGED (10), and THE
 * COUNT OVER TARGET OPENS EXACTLY THOSE ORDERS (14) — the last asserted as an
 * equality against the list and against the page a reader actually lands on.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createTestDb, type TestClient } from './support/db.ts';
import { CmsWorker } from './support/worker.ts';
import { AUTH_SCHEMA_DDL } from './support/schema.ts';
import { seedHass } from './support/hassSeed.ts';
import { hashPassword } from '../../src/lib/cms/auth/password.ts';
import { validateSoWorkbook, commitSoBatch } from '../../src/lib/cms/import/soImport.ts';
import {
  approvalRecords,
  loadingAuthorityBoard,
  LOADING_AUTHORITY_FUNCTIONS,
  EVERYONE,
  type ApprovalScope,
  type LaStat,
} from '../../src/lib/cms/repos/approvalSla.ts';
import { approvalRecordsHref } from '../../src/lib/cms/analytics/leaderboard.ts';
import { periodFromToken, type ResolvedPeriod } from '../../src/lib/cms/analytics/period.ts';
import {
  resetCaseEventHandlers,
  resetLeadEventHandlers,
  resetSlaWiring,
} from '../../src/lib/cms/service/events.ts';

const here = dirname(fileURLToPath(import.meta.url));
const SO_FILE = readFileSync(join(here, 'support', 'SO-Ver1.xls'));
const CTX = {
  actorUserId: 'USR-CATH',
  ip: '10.0.0.10',
  userAgent: 'HassCMS Test',
  now: new Date('2026-08-27T10:00:00Z'),
} as const;
const asClient = (c: TestClient) => c as never;
const allTime: ApprovalScope = { from: null, to: null, affiliateId: null };
const KENYA = 'AFF-KE';

/** The four names the extract carries, mapped as an administrator maps them. */
const APPROVERS: readonly [string, string, string][] = [
  ['USR-SO-SULE', 'SULEKHA', 'Sulekha Abdi'],
  ['USR-SO-ALAW', 'ALAWI.MOHAMED', 'Alawi Mohamed'],
  ['USR-SO-SAMI', 'SAMIRA.HAMZA', 'Samira Hamza'],
  ['USR-SO-VICM', 'VICTOR.MUSEMBI', 'Victor Musembi'],
];

async function seedPeople(run: (sql: string) => Promise<unknown>): Promise<void> {
  for (const [userId, external, display] of APPROVERS) {
    const [first, ...rest] = display.split(' ');
    await run(
      `INSERT OR IGNORE INTO users
         (user_id,user_type,employee_no,first_name,last_name,display_name,email,phone,status,
          email_verified_at,timezone,locale,last_login_at,created_at,updated_at)
       VALUES ('${userId}','INTERNAL',NULL,'${first}','${rest.join(' ')}','${display}',
               '${userId.toLowerCase()}@hasspetroleum.com',NULL,'ACTIVE','2026-01-05 08:00:00',
               'Africa/Nairobi','en-KE',NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    );
    await run(
      `INSERT OR IGNORE INTO source_identities VALUES
         ('SID-${userId}','SRC-EXCEL','${userId}','${external}',NULL,1,CURRENT_TIMESTAMP)`,
    );
  }
}

async function imported(): Promise<TestClient> {
  const c = createTestDb();
  await seedHass(c);
  resetCaseEventHandlers();
  resetLeadEventHandlers();
  resetSlaWiring();
  await seedPeople((sql) => c.execute(sql));
  const validation = await validateSoWorkbook(
    asClient(c),
    SO_FILE,
    { filename: 'SO-Ver1.xls', uploadedBy: 'USR-CATH', sourceSystemId: 'SRC-EXCEL' },
    CTX,
  );
  assert.equal(validation.rejectedReason, null, 'the extract was refused');
  assert.ok(validation.batchId !== null, 'the validation produced no batch');
  await commitSoBatch(asClient(c), validation.batchId, CTX);
  return c;
}

const kenya = (board: Awaited<ReturnType<typeof loadingAuthorityBoard>>) => {
  const found = board.byCountry.get(KENYA);
  assert.ok(found !== undefined, 'Kenya has no board');
  return found;
};
const fnOf = (rows: LaStat[], key: string): LaStat => {
  const found = rows.find((row) => row.fn === key);
  assert.ok(found !== undefined, `${key} is missing from the panel`);
  return found;
};

// ---------------------------------------------------------------------------

test('the prerequisite: three active sales order rules, 30, 30 and 90', async () => {
  const c = createTestDb();
  await seedHass(c);
  const rows = (
    await c.execute(
      `SELECT sla_rule_id, stage_code, target_minutes, warning_minutes, active FROM sla_rules
        WHERE entity_type = 'SALES_ORDER' AND active = 1 ORDER BY stage_code`,
    )
  ).rows as Record<string, unknown>[];
  assert.deepEqual(
    rows.map((row) => [row.sla_rule_id, row.stage_code, row.target_minutes, row.warning_minutes]),
    [
      ['SLAR-004', 'CREDIT_APPROVAL', 30, 25],
      ['SLAR-003', 'FINANCE_APPROVAL', 30, 25],
      ['SLAR-SO-LA', 'LOADING_AUTHORITY', 90, 75],
    ],
  );
  c.close();
});

test('criterion 9: each function carries its own target, and its people with it', async () => {
  const c = await imported();
  const board = kenya(await loadingAuthorityBoard(asClient(c), allTime));

  // Three functions, in the journey's own order, each with its own rule.
  assert.deepEqual(
    board.functions.map((f) => f.fn),
    LOADING_AUTHORITY_FUNCTIONS.map((f) => f.key),
  );
  const finance = fnOf(board.functions, 'Finance approval');
  const credit = fnOf(board.functions, 'Credit release');
  const loading = fnOf(board.functions, 'Loading authority');
  console.log(
    `[targets] finance ${finance.targetMinutes} credit ${credit.targetMinutes} ` +
      `loading ${loading.targetMinutes}`,
  );
  // READ, NEVER HARD-CODED, and read SEPARATELY: finance and credit share a
  // value today, and the next test proves that is configuration rather than
  // one target standing in for the other.
  assert.equal(finance.targetMinutes, 30);
  assert.equal(credit.targetMinutes, 30);
  assert.equal(loading.targetMinutes, 90);
  assert.equal(loading.warningMinutes, 75);

  // A person is judged against THEIR function's target, not the panel's
  // loudest one: every approver row carries the target of the function it
  // sits under, which is what puts three lines at three positions.
  for (const f of board.functions) {
    for (const person of board.people.get(f.fn) ?? []) {
      assert.equal(
        person.targetMinutes,
        f.targetMinutes,
        `${person.person} is judged against the wrong target`,
      );
      assert.ok(person.volume > 0);
    }
  }

  // The people sum to their function, so nothing is invented or lost.
  for (const f of board.functions) {
    const mine = board.people.get(f.fn) ?? [];
    assert.equal(
      mine.reduce((n, p) => n + p.volume, 0),
      f.volume,
      `${f.fn}: approver volumes do not sum to the function`,
    );
    assert.equal(
      mine.reduce((n, p) => n + p.overTarget, 0),
      f.overTarget,
      `${f.fn}: approver breaches do not sum to the function`,
    );
  }
  c.close();
});

test('criteria 10 and 11: no rule means grey, unjudged, and only that function', async () => {
  const c = await imported();
  const before = kenya(await loadingAuthorityBoard(asClient(c), allTime));
  const creditBefore = fnOf(before.functions, 'Credit release');

  await c.execute(`UPDATE sla_rules SET active = 0 WHERE sla_rule_id = 'SLAR-003'`);
  const board = await loadingAuthorityBoard(asClient(c), allTime);
  const after = kenya(board);
  const finance = fnOf(after.functions, 'Finance approval');
  const credit = fnOf(after.functions, 'Credit release');
  const loading = fnOf(after.functions, 'Loading authority');

  // NOTHING TO BE OVER, SO NOTHING IS CLAIMED. No target, no count, no
  // colour — the panel renders an em dash where the fraction would be.
  assert.equal(finance.targetMinutes, null, 'finance still carries a target');
  assert.equal(finance.overTarget, 0, 'finance is still judged');
  assert.equal(finance.atRisk, 0);
  assert.ok(finance.volume > 0, 'finance lost its orders as well as its target');
  assert.ok(finance.medianMinutes !== null, 'finance lost its duration');
  for (const person of after.people.get('Finance approval') ?? []) {
    assert.equal(person.targetMinutes, null);
    assert.equal(person.overTarget, 0);
  }
  // And the page is told, so it can offer to set the missing one.
  assert.deepEqual(board.missingTargets, ['Finance approval']);

  // WITHOUT TOUCHING THE OTHERS. Deactivating one rule must not move another,
  // which is the whole reason each is read separately.
  assert.equal(credit.targetMinutes, 30);
  assert.equal(credit.overTarget, creditBefore.overTarget);
  assert.equal(loading.targetMinutes, 90);
  c.close();
});

test('criterion 14: the count over target opens exactly those orders', async () => {
  const c = await imported();
  const board = kenya(await loadingAuthorityBoard(asClient(c), allTime));
  const scope: ApprovalScope = { from: null, to: null, affiliateId: KENYA };

  for (const f of board.functions) {
    if (f.volume === 0) continue;
    const breaches = await approvalRecords(
      asClient(c),
      'SALES_ORDER',
      'breaches',
      f.fn,
      EVERYONE,
      scope,
      null,
      'WORKING',
    );
    console.log(`[breaches] ${f.fn} ${f.overTarget}/${f.volume}, list holds ${breaches.length}`);
    assert.equal(breaches.length, f.overTarget, `${f.fn}: the list does not equal the count`);
    // Slowest first, and every record genuinely past THIS function's target.
    for (const record of breaches) {
      assert.ok((record.workingMinutes ?? 0) > (f.targetMinutes ?? 0));
      // Both durations, never blended: the wall clock lives here, beside the
      // working-day figure the panel plots.
      assert.ok(record.minutes !== null, 'the record carries no wall clock');
      assert.ok(record.startedAt !== null && record.completedAt !== null);
    }
    for (let i = 1; i < breaches.length; i += 1) {
      assert.ok(
        (breaches[i - 1]!.workingMinutes ?? 0) >= (breaches[i]!.workingMinutes ?? 0),
        `${f.fn}: the breaches are not slowest first`,
      );
    }

    // The same equality one level down, on an approver's own fraction.
    for (const person of board.people.get(f.fn) ?? []) {
      const found = await approvalRecords(
        asClient(c),
        'SALES_ORDER',
        'breaches',
        f.fn,
        { kind: 'PERSON', userId: person.userId },
        scope,
        null,
        'WORKING',
      );
      assert.equal(
        found.length,
        person.overTarget,
        `${person.person ?? 'Not recorded'}: the list does not equal the count`,
      );
    }
  }
  c.close();
});

test('the other three destinations hold exactly their figures', async () => {
  const c = await imported();
  const board = kenya(await loadingAuthorityBoard(asClient(c), allTime));
  const scope: ApprovalScope = { from: null, to: null, affiliateId: KENYA };
  const credit = fnOf(board.functions, 'Credit release');

  const all = await approvalRecords(
    asClient(c),
    'SALES_ORDER',
    'completed',
    credit.fn,
    EVERYONE,
    scope,
    null,
    'WORKING',
  );
  assert.equal(all.length, credit.volume, 'the function name opens a different population');

  const typical = await approvalRecords(
    asClient(c),
    'SALES_ORDER',
    'typical',
    credit.fn,
    EVERYONE,
    scope,
    null,
    'WORKING',
  );
  const marked = typical.filter((record) => record.isMedian);
  assert.ok(marked.length > 0, 'no median row is marked');
  const mean = marked.reduce((n, r) => n + (r.workingMinutes ?? 0), 0) / marked.length;
  assert.equal(mean, credit.medianMinutes, 'the marked row is not the figure that opened it');

  const person = (board.people.get(credit.fn) ?? [])[0]!;
  const mine = await approvalRecords(
    asClient(c),
    'SALES_ORDER',
    'completed',
    credit.fn,
    { kind: 'PERSON', userId: person.userId },
    scope,
    null,
    'WORKING',
  );
  assert.equal(mine.length, person.volume, 'a person opens a different population');

  // Every destination carries the country, the function, the person and the
  // period, which is what makes a shared link show what the sender saw.
  const period = periodFromToken('2026-05', new Date('2026-08-30T09:00:00Z')) as ResolvedPeriod;
  const href = approvalRecordsHref({
    period,
    affiliateId: KENYA,
    process: 'SALES_ORDER',
    view: 'breaches',
    fn: credit.fn,
    actor: { kind: 'PERSON', userId: person.userId },
    clock: 'WORKING',
  });
  console.log(`[href] ${href}`);
  for (const part of ['period=2026-05', 'affiliateId=AFF-KE', 'view=breaches', 'clock=WORKING']) {
    assert.ok(href.includes(part), `${href} is missing ${part}`);
  }
  assert.ok(href.includes('fn=Credit+release'), `${href} does not carry the function`);
  assert.ok(href.includes(`user=${person.userId}`), `${href} does not carry the person`);
  c.close();
});

test('the tabs: every country, one selectable, none hidden', async () => {
  const c = await imported();
  const board = await loadingAuthorityBoard(asClient(c), allTime);
  // EIGHT COUNTRIES, NOT ONE. Seven have nothing this period and are greyed
  // rather than removed: that they exist and are empty is the information.
  assert.equal(board.countries.length, 8, 'a country was dropped from the tabs');
  const withData = board.countries.filter((country) => country.volume > 0);
  assert.deepEqual(
    withData.map((country) => country.affiliateId),
    [KENYA],
  );
  assert.equal(board.countries.filter((country) => country.volume === 0).length, 7);
  // Every country has a board, so selecting an empty tab renders an empty
  // panel rather than a missing one.
  for (const country of board.countries) {
    const own = board.byCountry.get(country.affiliateId);
    assert.ok(own !== undefined, `${country.name} has no board`);
    assert.equal(own.functions.length, 3, `${country.name} lost a function`);
  }
  // And the empty ones really are empty, rather than showing everybody's data.
  const uganda = board.byCountry.get('AFF-UG')!;
  assert.equal(
    uganda.functions.reduce((n, f) => n + f.volume, 0),
    0,
    'an empty country is showing another country',
  );
  c.close();
});

test('loading authority records no person, and still carries its target', async () => {
  const c = await imported();
  const board = kenya(await loadingAuthorityBoard(asClient(c), allTime));
  const loading = fnOf(board.functions, 'Loading authority');
  const rows = board.people.get('Loading authority') ?? [];
  assert.equal(rows.length, 1, 'loading authority should have exactly one row');
  // THE EXTRACT NAMES NOBODY, so the row names nobody. The work is not
  // attributed to whoever last touched the order.
  assert.equal(rows[0]!.person, null);
  assert.equal(rows[0]!.userId, null);
  // The duration is real even though the person is not, so the row keeps its
  // own target and its own colour.
  assert.equal(rows[0]!.targetMinutes, 90);
  assert.ok((rows[0]!.medianMinutes ?? 0) > 0);
  assert.equal(rows[0]!.volume, loading.volume);
  // And the panel prints it as "Not recorded" rather than as a blank.
  const panel = readFileSync(
    join(here, '..', '..', 'src/components/cms/CmsLoadingAuthorityChart.astro'),
    'utf8',
  );
  assert.match(panel, /'Not recorded'/, 'the panel has no words for an unrecorded actor');
  c.close();
});

test('the rename is presentation only, and the panel carries no narration', () => {
  const panel = readFileSync(
    join(here, '..', '..', 'src/components/cms/CmsLoadingAuthorityChart.astro'),
    'utf8',
  );
  const home = readFileSync(join(here, '..', '..', 'src/pages/cms/app/index.astro'), 'utf8');
  // CRITERION 12, AS A TEST. The bar's position against its own line already
  // says what these words would.
  for (const phrase of ['business hours', 'over target', 'within target', 'elapsed']) {
    assert.ok(!new RegExp(phrase, 'i').test(panel), `the panel still says "${phrase}"`);
  }
  // The panel is named for what it measures, everywhere a person sees it.
  assert.match(panel, /Loading Authority/);
  assert.ok(!/Sales order approval/.test(home), 'Home still calls the panel by its old name');
  // THE DATABASE WAS NOT RENAMED WITH IT. The tables and the entity type are
  // untouched, which is what keeps every existing link and query working.
  const repo = readFileSync(join(here, '..', '..', 'src/lib/cms/repos/approvalSla.ts'), 'utf8');
  assert.match(repo, /FROM sales_orders so/, 'the sales_orders table was renamed');
  assert.match(repo, /wi\.entity_type = 'SALES_ORDER'/, 'the entity type was renamed');
  assert.ok(
    !/loading_authority_orders|FROM loading_authority/i.test(repo),
    'a table was invented for the new name',
  );
  // THE ONLY SENTENCE THE PANEL IS ALLOWED is the offer to set a missing
  // target, and it lives on the page rather than in the panel — so every
  // paragraph inside the panel is either the screen-reader alternative, the
  // empty state, or the axis naming what its lines are. Nothing explains a
  // figure to a reader who can see it.
  const template = panel.slice(panel.indexOf('---', 3) + 3);
  // The offer to set a missing target is the one sentence permitted, and it
  // renders only when a function has no rule.
  const allowed = [
    /class="sr-only"/,
    /No completions this month/,
    /target per function/,
    /No target for \{missingTargets/,
  ];
  for (const match of template.matchAll(/<p\b[\s\S]*?<\/p>/g)) {
    assert.ok(
      allowed.some((pattern) => pattern.test(match[0])),
      `the panel carries prose: ${match[0].slice(0, 80)}`,
    );
  }
  assert.match(panel, /missingTargets\.length > 0/, 'the offer is not conditional');
  assert.match(home, /missingTargets=\{laMissingTargets\}/, 'the page never names what is missing');
});

/**
 * The page a reader lands on, not the repository behind it.
 *
 * Needs a build, so it skips without one — exactly as the inline script scan
 * does. It is what proves the count on the panel and the count on the
 * destination are the same number end to end.
 */
const BUILT = existsSync(join(here, '..', '..', 'dist', 'server', 'entry.mjs'));

test('criterion 16: the rendered destination holds exactly the figure', async (t) => {
  if (!BUILT) {
    t.diagnostic('no build: run pnpm build to include the rendered-page check');
    return;
  }
  const worker = new CmsWorker();
  await worker.start(AUTH_SCHEMA_DDL, 'loading-authority-test-secret-0123456789');
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
    if (/^\s*(SELECT|WITH|PRAGMA)/i.test(sql))
      return { rows: call('all') as never, rowsAffected: 0 };
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
    await seedPeople((sql) => db.execute(sql));
    const validation = await validateSoWorkbook(
      asClient(db),
      SO_FILE,
      { filename: 'SO-Ver1.xls', uploadedBy: 'USR-CATH', sourceSystemId: 'SRC-EXCEL' },
      CTX,
    );
    await commitSoBatch(asClient(db), validation.batchId!, CTX);

    const password = `test-only-${crypto.randomUUID()}`;
    worker.db
      .prepare(
        `INSERT INTO auth_credentials (credential_id, user_id, password_hash, password_algorithm,
            must_change_password, password_changed_at, failed_attempts, created_at, updated_at)
         VALUES ('CRED-LA','USR-CATH',?,'PBKDF2',0,CURRENT_TIMESTAMP,0,CURRENT_TIMESTAMP,
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

    const scope: ApprovalScope = { from: '2026-05-01', to: '2026-05-31', affiliateId: null };
    const board = kenya(await loadingAuthorityBoard(db as never, scope));
    const finance = fnOf(board.functions, 'Finance approval');

    // THE OLD NAME STILL WORKS, and so does the new one: both reach the same
    // list, so no existing link was broken by the rename.
    const query = `period=2026-05&view=breaches&fn=Finance+approval&all=1&affiliateId=AFF-KE&clock=WORKING`;
    for (const name of ['SALES_ORDER', 'LOADING_AUTHORITY']) {
      const page = await worker.call('GET', `/app/performance/approvals?process=${name}&${query}`);
      assert.equal(page.status, 200, `process=${name} did not render`);
      const badge = /([\d,]+) records/.exec(page.body);
      assert.ok(badge !== null, `process=${name} printed no record count`);
      const rendered = Number(badge[1]!.replace(/,/g, ''));
      console.log(
        `[page] process=${name}: ${finance.overTarget} on the panel, ${rendered} rendered`,
      );
      assert.equal(rendered, finance.overTarget, `process=${name} holds a different number`);
      assert.ok(page.body.includes('Loading Authority'), 'the destination uses the old name');
      assert.ok(page.body.includes('Working hours'), 'the destination hides the working day');
      assert.ok(page.body.includes('Wall clock'), 'the destination hides the wall clock');
    }
  } finally {
    await worker.stop();
  }
});
