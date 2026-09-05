import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path: string) => readFileSync(path, 'utf8');

test('KPI cards show zero for an absent figure without inventing a drill target', () => {
  const source = read('src/components/cms/CmsKpiCard.astro');
  assert.match(source, /const displayValue = absent \? '0' : value/);
  assert.match(source, /const drillable = href !== undefined && href !== '' && !absent/);
  assert.match(source, /\{displayValue\}/);
});

test('CRM home keeps operational copy concise and explicit zero defaults', () => {
  const source = read('src/pages/cms/app/crm/home.astro');
  assert.match(source, /value=\{String\(leads\?\.needsFirstContact \?\? 0\)\}/);
  assert.match(source, />\s*Attention\s*</);
  assert.doesNotMatch(source, /Each figure opens the records behind it/);
  assert.doesNotMatch(source, /Your commercial workspace:/);
  assert.doesNotMatch(source, /description="Close date, customer context/);
  assert.doesNotMatch(source, /description="Most recently updated open opportunities/);
});

test('notifications remain readable when the best-effort refresh sweep fails', () => {
  for (const path of [
    'src/pages/cms/app/notifications/index.astro',
    'src/pages/cms/api/notifications/index.ts',
  ]) {
    const source = read(path);
    assert.match(source, /try \{\s*await sweepDueSlas/);
    assert.match(source, /await sweepNotifications/);
    assert.match(source, /refresh skipped/);
    assert.match(source, /listNotifications/);
  }
});

test('import exception notifications resolve to the uploader history page', () => {
  const source = read('src/pages/cms/api/notifications/[id]/target.ts');
  assert.match(source, /notification\.entityType === 'IMPORT_BATCH'/);
  assert.match(source, /uploaded_by_user_id = \?/);
  assert.match(source, /'\/app\/data\/history'/);
});
