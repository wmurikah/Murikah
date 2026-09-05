import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path: string) => readFileSync(path, 'utf8');

test('CRM has an action-first overview without moving the existing Leads route', () => {
  const home = read('src/pages/cms/app/crm/home.astro');
  const leads = read('src/pages/cms/app/crm.astro');

  assert.match(home, /<CmsPageHeader\s+title="CRM"/);
  assert.match(home, /Needs your attention/);
  assert.match(home, /label="Awaiting first contact"/);
  assert.match(home, /label="Overdue activities"/);
  assert.match(home, /label="Open opportunities"/);
  assert.match(home, /label="Closing in 30 days"/);
  assert.match(home, /Overdue follow-ups/);
  assert.match(home, /Upcoming activities/);
  assert.match(home, /Closing in the next 30 days/);
  assert.match(home, /Recently active open opportunities/);

  assert.match(leads, /<CmsLayout title="Leads">/);
  assert.match(home, /href="\/app\/crm"/);
});

test('CRM local navigation promotes Overview and Analytics while settings stay configuration-only', () => {
  const nav = read('src/components/cms/CmsCrmNav.astro');

  assert.match(nav, /\{ label: 'Overview', href: '\/app\/crm\/home' \}/);
  assert.match(nav, /d\.label === 'CRM analytics'/);
  assert.match(nav, /label: 'Analytics'/);
  assert.match(nav, /d\.label !== 'CRM analytics'/);
  assert.match(nav, /CRM settings/);
});

test('the main CRM rail opens Overview but remains active across CRM child routes', () => {
  const sidebar = read('src/components/cms/CmsSidebar.astro');

  assert.match(sidebar, /label === 'CRM'/);
  assert.match(sidebar, /'\/app\/crm\/home'/);
  assert.match(sidebar, /currentPath === '\/app\/crm'/);
  assert.match(sidebar, /currentPath\.startsWith\('\/app\/crm\/'\)/);
});

test('CRM overview reuses scoped repositories and does not introduce schema or write logic', () => {
  const home = read('src/pages/cms/app/crm/home.astro');

  assert.match(home, /leadIndicators\(db, userId\)/);
  assert.match(home, /myWork\(db, userId, now\)/);
  assert.match(home, /listOpportunities\(/);
  assert.doesNotMatch(home, /INSERT\s+INTO|UPDATE\s+|DELETE\s+FROM|ALTER\s+TABLE|CREATE\s+TABLE/i);
});

test('CRM overview surfaces commercial context and next actions from existing tables', () => {
  const home = read('src/pages/cms/app/crm/home.astro');
  const repo = read('src/lib/cms/repos/crmWorkspace.ts');

  assert.match(home, /opportunityWorkspaceContext\(db, userId, ids\)/);
  assert.match(home, /Expected demand/);
  assert.match(home, /Next:/);

  assert.match(repo, /JOIN accounts a ON a\.account_id = o\.account_id/);
  assert.match(repo, /LEFT JOIN affiliates af ON af\.affiliate_id = a\.affiliate_id/);
  assert.match(repo, /JOIN opportunity_products op ON op\.opportunity_id = o\.opportunity_id/);
  assert.match(repo, /JOIN products p ON p\.product_id = op\.product_id/);
  assert.match(repo, /JOIN activities act/);
  assert.match(repo, /DUE_SQL/);
  assert.match(repo, /scopedOpportunities\(db, userId\)/);
  assert.doesNotMatch(repo, /INSERT\s+INTO|UPDATE\s+|DELETE\s+FROM|ALTER\s+TABLE|CREATE\s+TABLE/i);
});
