import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { displayLocationTerminology } from '../src/lib/engr/format.ts';

const file = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('the three primary sidebar groups start expanded independently', () => {
  const layout = file('src/layouts/EngrLayout.astro');
  assert.match(layout, /open=\{\['Overview', 'Operations', 'Procurement'\]\.includes\(group\.label\)\}/);
  assert.doesNotMatch(layout, /name="engr-nav"/);
  assert.match(layout, /label: 'Locations', icon: 'stations'/);
  assert.match(layout, /href: '\/admin\/stations'/);
  assert.match(layout, /has\('stations\.view'\)/);
});

test('all create/edit setup forms reuse uniform responsive field dimensions', () => {
  const css = file('src/styles/engr.css');
  assert.match(css, /\.engr-formgrid--setup,/);
  assert.match(css, /repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(css, /repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /grid-template-rows: minmax\(1\.5rem, auto\) minmax\(2\.75rem, auto\) auto/);
  assert.match(css, /min-height: 2\.75rem/);
  assert.match(css, /max-height: 2\.75rem/);
  assert.match(css, /\.engr-formgrid--setup > \.engr-formgrid__full/);

  const forms = [
    'affiliates', 'asset-categories', 'assets', 'contractors',
    'rate-cards', 'regions', 'slas', 'stations', 'technicians', 'users',
  ];
  for (const name of forms) {
    const page = file(`src/pages/engr/admin/${name}/[id].astro`);
    assert.match(page, /engr-formgrid--setup/, name + ' form missing shared grid');
  }
  const engineers = file('src/pages/engr/admin/engineers/index.astro');
  assert.match(engineers, /engr-formgrid--setup/);

  const locations = file('src/pages/engr/admin/stations/[id].astro');
  const regions = file('src/pages/engr/admin/regions/[id].astro');
  for (const page of [locations, regions]) {
    assert.match(page, /class="engr-static-control"/);
    assert.match(page, /aria-readonly="true"/);
  }
  assert.match(locations, /Location manager/);
  assert.match(locations, /Base location/);
});

test('Location is presentation-only and never renames stored station relationships', () => {
  assert.equal(displayLocationTerminology('Station Manager'), 'Location Manager');
  assert.equal(displayLocationTerminology('Stations covered'), 'Locations covered');
  assert.equal(displayLocationTerminology('From station'), 'From location');
  const stationPage = file('src/pages/engr/admin/stations/[id].astro');
  assert.match(stationPage, /action="\/api\/admin\/stations"/);
  assert.match(stationPage, /name="station_manager_id"/);
  const assetPage = file('src/pages/engr/admin/assets/[id].astro');
  assert.match(assetPage, /name="station_id"/);
  const layout = file('src/layouts/EngrLayout.astro');
  assert.match(layout, /href: '\/admin\/stations'/);
  const guide = file('docs/ENGINEERING_RHYTHM_USER_GUIDE.md');
  assert.match(guide, /foreign keys \(`station_id`\)/);
});
