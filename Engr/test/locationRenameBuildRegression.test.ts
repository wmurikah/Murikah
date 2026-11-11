import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path: string) =>
  readFileSync(new URL(`../src/pages/engr/requests/${path}`, import.meta.url), 'utf8');

test('Location text does not change the station data-scope discriminator', () => {
  const queue = read('index.astro');
  assert.match(queue, /actorDataScope\(engr\.roles\) !== 'station'/);
  assert.doesNotMatch(queue, /actorDataScope\(engr\.roles\) !== 'location'/);
  assert.match(queue, /<th scope="col">Location<\/th>/);
});

test('Location text does not rename the station options variable', () => {
  const form = read('new.astro');
  assert.match(form, /let stations: StationOption\[\] = \[\]/);
  assert.match(form, /\bstations\.length === 0/);
  assert.doesNotMatch(form, /\blocations\.length === 0/);
  assert.match(form, /<label for="station">Location<\/label>/);
  assert.match(form, /name="station_id"/);
  assert.match(form, /Choose a location that belongs to your organisation/);
});
