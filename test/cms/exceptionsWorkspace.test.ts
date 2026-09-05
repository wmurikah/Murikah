import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path: string) => readFileSync(path, 'utf8');

test('performance workspace is user-facing Exceptions rather than SLA Monitor', () => {
  const page = read('src/pages/cms/app/performance.astro');
  assert.match(page, /title="Exceptions"/);
  assert.match(page, /All exceptions/);
  assert.match(page, /At risk/);
  assert.match(page, /Breached/);
  assert.match(page, /Unassigned/);
  assert.match(page, /Escalated/);
  assert.doesNotMatch(page, /title="SLA Monitor"/);
  assert.doesNotMatch(page, /Completed/);
});

test('Exceptions table is action-oriented', () => {
  const page = read('src/pages/cms/app/performance.astro');
  for (const label of ['Process', 'Record', 'Customer', 'Issue', 'Owner', 'Due / overdue', 'Status']) {
    assert.ok(page.includes(`label: '${label}'`), `missing ${label} column`);
  }
  assert.match(page, /recordHref/);
  assert.match(page, />Open</);
});

test('sidebar presents Exceptions and Reports as separate Insights destinations', () => {
  const sidebar = read('src/components/cms/CmsSidebar.astro');
  assert.match(sidebar, /items: \['Exceptions', 'Reports'\]/);
  assert.match(sidebar, /label === 'Exceptions'/);
  assert.match(sidebar, /!currentPath\.startsWith\('\/app\/performance\/reports'\)/);
});

test('navigation and page search expose Exceptions terminology', () => {
  const nav = read('src/lib/cms/nav.ts');
  const search = read('src/lib/cms/search/pageSearch.ts');
  assert.match(nav, /label === 'SLA Monitor' \? 'Exceptions'/);
  assert.match(search, /destination\.label === 'SLA Monitor' \? 'Exceptions'/);
  assert.match(search, /destination\.area === 'SLA Monitor'\) return 'Insights'/);
});

test('exception repository excludes healthy completed SLA rows from the default view', () => {
  const repo = read('src/lib/cms/repos/exceptionAdmin.ts');
  assert.match(repo, /type ExceptionBucket = 'all' \| 'at-risk' \| 'breached' \| 'unassigned' \| 'escalated'/);
  assert.match(repo, /i\.status = 'BREACHED'/);
  assert.match(repo, /i\.warning_at IS NOT NULL/);
  assert.match(repo, /i\.accountable_user_id IS NULL AND i\.accountable_team_id IS NULL/);
  assert.match(repo, /sla_escalation_events/);
  assert.doesNotMatch(repo, /i\.status IN \('MET','BREACHED','CANCELLED'\)/);
});
