/**
 * Static route-coverage test. Unlike the data-layer smoke test, this needs no
 * database: it guards the route manifest (cms/scripts/routes.mjs) that the
 * app-level crawl and the demo recorder consume, so those tools cannot silently
 * fall behind the app. It asserts three invariants:
 *
 *   1. every manifest route maps to a page file that exists;
 *   2. every CMS page the app serves is represented in the manifest (a new page
 *      with no manifest entry fails here, keeping the crawl target set complete);
 *   3. every data-driven page renders behind the CmsError boundary, so a query
 *      fault degrades in place instead of a blank 500.
 *
 * It runs in `pnpm test` on every commit, with or without a seeded database.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
// The manifest is plain ESM shared with the .mjs tools.
import { ROUTES } from '../scripts/routes.mjs';

const CMS_PAGES = 'src/pages/cms';
// Public auth pages are intentionally boundary-free (nothing to load) and the
// api directory holds endpoints, not pages.
const NON_PAGE = new Set([
  'src/pages/cms/login.astro',
  'src/pages/cms/mfa.astro',
  'src/pages/cms/portal/login.astro',
]);

/** Every .astro file under src/pages/cms (endpoints under api/ are excluded). */
function cmsPageFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'api') continue;
      cmsPageFiles(full, acc);
    } else if (entry.endsWith('.astro')) {
      acc.push(full);
    }
  }
  return acc;
}

test('routes: every manifest route maps to a page file that exists', () => {
  for (const r of ROUTES) {
    assert.ok(existsSync(r.file), `route ${r.path} points at a missing file ${r.file}`);
  }
});

test('routes: every CMS page is represented in the crawl manifest', () => {
  const manifestFiles = new Set(ROUTES.map((r) => r.file));
  const pages = cmsPageFiles(CMS_PAGES).map((f) => relative(process.cwd(), f));
  for (const page of pages) {
    assert.ok(
      manifestFiles.has(page),
      `page ${page} is not in the crawl manifest (add it to cms/scripts/routes.mjs)`,
    );
  }
});

test('routes: every data-driven page renders behind the CmsError boundary', () => {
  const pages = cmsPageFiles(CMS_PAGES).map((f) => relative(process.cwd(), f));
  for (const page of pages) {
    if (NON_PAGE.has(page)) continue;
    const src = readFileSync(page, 'utf8');
    assert.ok(src.includes('CmsError'), `page ${page} has no CmsError boundary`);
  }
});
