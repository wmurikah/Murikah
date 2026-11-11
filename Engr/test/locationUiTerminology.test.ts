import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { locationDisplayLabel } from '../src/lib/engr/format.ts';

const file = (path: string): string =>
  readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('Location is a view-layer label; existing IDs, route paths and permission keys remain stable', () => {
  assert.equal(locationDisplayLabel('Station Manager'), 'Location Manager');
  assert.equal(locationDisplayLabel('Stations covered'), 'Locations covered');
  assert.equal(locationDisplayLabel('A station'), 'A location');
  assert.equal(locationDisplayLabel('STATION_MANAGER'), 'STATION_MANAGER');

  const layout = file('src/layouts/EngrLayout.astro');
  assert.match(layout, /href: '\/admin\/stations', label: 'Locations'/);
  assert.match(layout, /open=\{\['Overview', 'Operations', 'Procurement'\]\.includes\(group\.label\)\}/);
  assert.doesNotMatch(layout, /name="engr-nav"/, 'independent collapsibles must be able to open together');

  const location = file('src/pages/engr/admin/stations/[id].astro');
  const locations = file('src/pages/engr/admin/stations/index.astro');
  assert.match(location, /action="\/api\/admin\/stations"/);
  assert.match(location, /name="station_manager_id"/);
  assert.match(location, /<EngrLayout title=\{isNew \? 'New location' : 'Edit location'\}>/);
  assert.match(locations, /<EngrLayout title="Locations">/);
  assert.match(location, /Location code/);
  assert.match(location, /readonly aria-readonly="true"/);
  assert.match(location, /name="station_id"|name="affiliate_org_id"/);

  const regions = file('src/pages/engr/admin/regions/[id].astro');
  assert.match(regions, /Region code/);
  assert.match(regions, /readonly aria-readonly="true"/);
});

test('Setup forms use a shared three-column grid with aligned labels, controls and hints', () => {
  const css = file('src/styles/engr.css');
  const rules = css.slice(css.indexOf('/* Shared Setup form alignment:'),
    css.indexOf('/* Affiliate edit:', css.indexOf('/* Shared Setup form alignment:')));
  assert.match(rules, /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(rules, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(rules, /grid-template-rows: minmax\(1\.4rem, max-content\) 2\.75rem auto/);
  assert.match(rules, /height: 2\.75rem/);
  for (const path of [
    'admin/affiliates/[id].astro',
    'admin/regions/[id].astro',
    'admin/stations/[id].astro',
    'admin/technicians/[id].astro',
    'admin/contractors/[id].astro',
    'admin/slas/[id].astro',
    'admin/rate-cards/[id].astro',
    'admin/users/[id].astro',
    'admin/assets/[id].astro',
    'admin/notifications/index.astro',
  ]) {
    assert.match(file('src/pages/engr/' + path), /engr-formgrid--setup/,
      path + ' should use the shared alignment');
  }
  const station = file('src/pages/engr/admin/stations/[id].astro');
  const form = station.slice(station.indexOf('<form'), station.indexOf('</form>'));
  const columns = ['display_location_code','name','affiliate_org_id','region_id','station_manager_id','status','address'];
  const offsets = columns.map(id=>form.indexOf(`for="${id}"`));
  assert.ok(offsets.every(x=>x>=0));
  assert.deepEqual(offsets,[...offsets].sort((a,b)=>a-b), 'location status must precede full-width address');
});

test('UI labels use Locations while technical data contracts keep stations identifiers', () => {
  const files = [
    'admin/contractors/[id].astro', 'admin/engineers/index.astro',
    'admin/assets/index.astro', 'admin/assets/transfers/index.astro',
    'requests/new.astro', 'requests/index.astro', 'rfqs/index.astro',
    'lpos/index.astro', 'pm/index.astro',
  ];
  for (const path of files) {
    const content = file('src/pages/engr/' + path);
    const uiAttributes = [...content.matchAll(/\b(?:title|message|hint|actionLabel|aria-label|placeholder)="([^"\n]+)"/g)]
      .map(x=>x[1]);
    assert.ok(uiAttributes.every(x=>!/\bstations?\b/i.test(x)),path+' has a legacy UI string');
  }
  const guide = file('docs/ENGINEERING_RHYTHM_USER_GUIDE.md');
  assert.match(guide, /Service Setup → Locations/);
  assert.match(guide, /Location Manager/);
  assert.match(guide, /STN-000001/, 'codes are preserved');
  assert.match(file('src/pages/engr/admin/engineers/index.astro'), /value="STATION"/,
    'stored engineer scope must not be renamed');
});
