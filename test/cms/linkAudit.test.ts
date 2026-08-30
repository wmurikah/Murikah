/**
 * Build Prompt 40, section 2: the links that go nowhere.
 *
 * "Go and fix it" on System health led to "Page not found. That page does not
 * exist. This platform is being rebuilt." from two checks — workflow roles with
 * no eligible approver, and active teams with no active manager. A control that
 * promises to take you to the fix and delivers a 404 is worse than no control,
 * because it costs the trust of every other control on the page.
 *
 * A DEAD LINK IS INVISIBLE UNTIL SOMEBODY CLICKS IT, which is exactly why it
 * survived: the page renders without error, nothing throws, and no test that
 * reads a page's output can see where its links point. So this walks them.
 *
 * Every internal destination in the CMS — every href, every action target,
 * every breadcrumb, every empty-state action, and the `href` a health check
 * carries — is resolved against the real route tree under src/pages/cms,
 * dynamic segments included. Anything that does not resolve fails here rather
 * than in front of an operator.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const PAGES_ROOT = 'src/pages/cms';

function walk(dir: string, ext: string[]): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path, ext));
    else if (ext.some((e) => entry.endsWith(e))) out.push(path);
  }
  return out;
}

/**
 * The routes the CMS host actually serves, from the file tree.
 *
 * Read from disk rather than from a hand-kept list, because a hand-kept list is
 * a second thing to forget: the whole fault here was a destination that named a
 * page nobody had built.
 */
function routes(): { pattern: string; match: RegExp }[] {
  return walk(PAGES_ROOT, ['.astro', '.ts']).map((path) => {
    let rel = relative(PAGES_ROOT, path).replace(/\.(astro|ts)$/, '');
    if (rel.endsWith('/index')) rel = rel.slice(0, -'/index'.length);
    if (rel === 'index') rel = '';
    const pattern = `/${rel}`;
    const source = pattern
      .split('/')
      .map((segment) =>
        /^\[\.\.\..+\]$/.test(segment)
          ? '.*'
          : /^\[.+\]$/.test(segment)
            ? '[^/]+'
            : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      )
      .join('/');
    return { pattern, match: new RegExp(`^${source}/?$`) };
  });
}

/** Files that can carry a CMS destination. */
function sources(): string[] {
  return [
    ...walk('src/pages/cms', ['.astro']),
    ...walk('src/components/cms', ['.astro', '.ts']),
    ...walk('src/lib/cms', ['.ts']),
    'src/layouts/CmsLayout.astro',
    'src/layouts/CmsAuthLayout.astro',
    'src/layouts/CmsPortalLayout.astro',
  ];
}

/** Served from `public/`, so they have no route file and are not dead. */
const STATIC = new Set(['/favicon.svg', '/apple-touch-icon.png', '/favicon.ico', '/robots.txt']);

/**
 * Paths that exist to be REDIRECTED rather than visited.
 *
 * `/app/service` is the old Service path. `routes.ts` names it so the
 * middleware and the catch-all stub can send it to `/app/helpdesk` with a 301.
 * It is a redirect source, never a link, and nothing renders it as an href.
 */
const REDIRECT_SOURCES = new Set(['/app/service', '/portal/service']);

function destinations(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const patterns = [
    /href[=:]\s*["'`](\/[^"'`${}\s]*)["'`]/g,
    /href:\s*['"](\/[^'"${}\s]*)['"]/g,
    /["'`](\/app\/[a-z0-9/?=-]+)["'`]/g,
  ];
  for (const path of sources()) {
    const source = readFileSync(path, 'utf8');
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) {
        const target = match[1]!;
        found.set(target, [...(found.get(target) ?? []), path]);
      }
    }
  }
  return found;
}

test('every internal destination in the CMS resolves to a real route', () => {
  const known = routes();
  const resolves = (path: string) => known.some((route) => route.match.test(path));

  const dead: string[] = [];
  let checked = 0;
  for (const [target, where] of [...destinations()].sort()) {
    const clean = target.split('?')[0]!.split('#')[0]!.replace(/\/$/, '') || '/';
    // API routes are resolved by the same tree; static assets are served from
    // public/ and have no route file.
    if (STATIC.has(clean) || REDIRECT_SOURCES.has(clean)) continue;
    checked += 1;
    if (!resolves(clean)) dead.push(`${target}  <-  ${[...new Set(where)].join(', ')}`);
  }

  console.log(`[links] ${checked} internal destinations resolved, ${dead.length} dead`);
  assert.deepEqual(dead, [], `destinations that 404:\n${dead.join('\n')}`);
});

test('every System health check points at a page that can fix it', () => {
  // THE TWO THAT 404ED, PINNED BY NAME. Both named a path that had only an
  // [id] route and no index, so the button rendered, looked live, and led to
  // "Page not found".
  const source = readFileSync('src/lib/cms/repos/controlCentre.ts', 'utf8');
  const known = routes();
  const hrefs = [...source.matchAll(/href:\s*'(\/[^']+)'/g)].map((m) => m[1]!);
  assert.ok(hrefs.length >= 8, `expected the health check destinations, found ${hrefs.length}`);

  for (const href of hrefs) {
    const clean = href.split('?')[0]!;
    assert.ok(
      known.some((route) => route.match.test(clean)),
      `a health check sends the operator to ${href}, which does not exist`,
    );
  }

  // And they land somewhere that can actually fix the thing, not merely
  // somewhere that resolves.
  assert.ok(
    source.includes("href: '/app/administration/workflows?tab=roles'"),
    'the approver check must open the workflow roles tab',
  );
  assert.ok(
    source.includes("href: '/app/administration/organisation?tab=teams'"),
    'the unmanaged team check must open the teams tab',
  );
  // The tabs those two name have to be real tabs.
  const workflows = readFileSync('src/lib/cms/admin/workflowWorkspace.ts', 'utf8');
  assert.match(workflows, /key: 'roles'/, 'the workflows page has no roles tab');
  const organisation = readFileSync('src/lib/cms/admin/workspace.ts', 'utf8');
  assert.match(organisation, /key: 'teams'/, 'the organisation page has no teams tab');
});
