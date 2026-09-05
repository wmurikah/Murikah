import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('Home trend legends are compact and Loading Authority shows affiliate series', () => {
  const trend = readFileSync('src/lib/cms/analytics/userPerformanceTrend.ts', 'utf8');
  assert.match(trend, /compactUserName/);
  assert.match(trend, /entities: readonly \{ affiliateId: string; code: string \}\[\]/);
  assert.ok(!trend.includes('`${options.entity} Loading Authority`'));

  const home = readFileSync('src/pages/cms/app/index.astro', 'utf8');
  assert.match(home, /points: loadingTrend,/);
  assert.match(home, /entities: laCountries\.map/);
  assert.ok(!/points: loadingTrend\.filter\(/.test(home));
});

test('Home adds one response leaderboard card before Needs attention', () => {
  const home = readFileSync('src/pages/cms/app/index.astro', 'utf8');
  const leaderboardAt = home.indexOf('<CmsResponseLeaderboard');
  const attentionAt = home.indexOf('title="Needs attention"');
  assert.ok(leaderboardAt > 0 && attentionAt > leaderboardAt);

  const board = readFileSync('src/components/cms/CmsResponseLeaderboard.astro', 'utf8');
  for (const label of ['User', 'Responses', 'Avg response', 'Fastest', 'Slowest']) {
    assert.ok(board.includes(label), `${label} is missing from the response leaderboard`);
  }
});

test('Loading Authority user leaderboard never invents the milestone actor', () => {
  const repo = readFileSync('src/lib/cms/repos/homeUserLeaderboards.ts', 'utf8');
  assert.match(repo, /wsi\.assigned_user_id/);
  assert.match(repo, /FINANCE_APPROVAL/);
  assert.match(repo, /CREDIT_CHECK/);
  assert.match(repo, /LOADING_AUTHORITY/);
  assert.ok(!/loading_authority_at[\s\S]*AS user_id/.test(repo));
});
