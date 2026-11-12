const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fixture = require('./simple-test-loader.cjs');

function navigation() {
  const source = path.resolve(__dirname, '../features/navigation/workspace-navigation.ts');
  assert.ok(fs.existsSync(source), 'workspace navigation contract must exist');
  return fixture().load('features/navigation/workspace-navigation.ts');
}

test('every primary destination remains valid as a saved return path', () => {
  const { workspaceSections, safeReturnPath } = navigation();
  for (const section of workspaceSections('zh-CN')) {
    assert.equal(safeReturnPath(section.path), section.path, section.id);
  }
  const run = '/telemetry/runs/research%3Aexample?returnTo=%2Ftelemetry';
  assert.equal(safeReturnPath(run), run);
});

test('investment and holdings are distinct primary roots while retained deep links keep ownership', () => {
  const { workspaceSections, resolveWorkspaceRoute } = navigation();
  const primary = workspaceSections('en');
  assert.ok(primary.some(row => row.path === '/' && row.id === 'overview'));
  assert.ok(primary.some(row => row.path === '/holdings' && row.id === 'assets'));
  assert.ok(primary.some(row => row.path === '/friends' && row.id === 'friends'));
  assert.equal(new Set(primary.map(row => row.path)).size, primary.length);
  assert.equal(resolveWorkspaceRoute('/telemetry/runs/research%3Aexample', 'en').section, 'telemetry');
  assert.equal(resolveWorkspaceRoute('/telemetry/runs/research%3Aexample', 'en').parent, '/telemetry?view=runs');
  assert.equal(resolveWorkspaceRoute('/paper/account-1/strategies', 'en').parent, '/paper/account-1');
  assert.equal(resolveWorkspaceRoute('/teams/team-a', 'en').section, 'teams');
  assert.equal(resolveWorkspaceRoute('/teams/team-a', 'en').parent, '/teams');
  assert.equal(resolveWorkspaceRoute('/holdings', 'zh-CN').title, '持仓');
  assert.equal(resolveWorkspaceRoute('/holdings', 'en').kind, 'root');
  assert.equal(resolveWorkspaceRoute('/holdings', 'en').parent, '/holdings');
  assert.equal(resolveWorkspaceRoute('/', 'en').section, 'overview');
  assert.equal(resolveWorkspaceRoute('/transactions', 'en').section, 'assets');
  assert.equal(resolveWorkspaceRoute('/watchlist', 'zh-CN').section, 'assets');
  assert.equal(resolveWorkspaceRoute('/analysis/reports/report-1', 'en').section, 'daily');
  assert.equal(resolveWorkspaceRoute('/council', 'en').section, 'research');
  assert.equal(resolveWorkspaceRoute('/strategies/interviews/interview-1', 'en').kind, 'flow');
  assert.equal(resolveWorkspaceRoute('/settings/models', 'en').kind, 'root', 'default settings panel cannot return to its own redirect');
});

test('hash navigation targets the section but recorded Back positions take priority, even at zero', () => {
  const { workspaceScrollTarget } = navigation();
  assert.equal(workspaceScrollTarget([], 'direct', 'POP', '#report-history').anchor, 'report-history');
  assert.equal(workspaceScrollTarget([], 'next', 'PUSH', '#report-history').anchor, 'report-history');
  assert.equal(workspaceScrollTarget([], 'next', 'REPLACE', '#section%20one').anchor, 'section one');
  const entries = [{ key: 'old', index: 0, path: '/analysis#report-history', scrollTop: 0 }];
  assert.equal(workspaceScrollTarget(entries, 'old', 'POP', '#report-history').top, 0);
  assert.equal(workspaceScrollTarget(entries, 'old', 'POP', '#report-history').anchor, null);
  assert.equal(workspaceScrollTarget([], 'bad', 'PUSH', '#%zz').top, 0);
});

test('return destinations preserve internal query context and never leave the workspace', () => {
  const { safeReturnPath, returnDestination } = navigation();
  const href = '/?period=1M&metric=return&accounts=a%2Cb#chart';
  assert.equal(safeReturnPath(href), href);
  assert.equal(safeReturnPath('/friends?returnTo=%2Fteams%3Fguided%3D1'), '/friends?returnTo=%2Fteams%3Fguided%3D1');
  for (const invalid of ['https://evil.test', '//evil.test', '/\\evil.test', 'javascript:alert(1)', '/login', null]) {
    assert.equal(safeReturnPath(invalid), null);
  }
  assert.equal(returnDestination([], 9, href, '/paper').path, href);
  assert.equal(returnDestination([], 9, '//evil.test', '/paper').path, '/paper');
  assert.equal(returnDestination([{ key: 'old', index: 8, path: href, scrollTop: 460 }], 9, null, '/paper').kind, 'back');
});

test('search reaches holdings, saved daily reports and simulation accounts in either language', () => {
  const { workspaceDestinations } = navigation();
  for (const language of ['en', 'zh-CN']) {
    const destinations = workspaceDestinations(language);
    for (const path of ['/holdings', '/daily', '/paper', '/friends'])
      assert.ok(destinations.some(row => row.path === path), `${language} search must include ${path}`);
    assert.equal(new Set(destinations.map(row => row.path)).size, destinations.length);
  }
  assert.equal(workspaceDestinations('zh-CN').find(row => row.path === '/paper').label, '模拟账户');
});

test('back restores the original page key and forward branches discard obsolete visits', () => {
  const { rememberLocation, restoredScrollPosition } = navigation();
  let entries = [{ key: 'overview', index: 0, path: '/?period=1M', scrollTop: 460 }];
  entries = rememberLocation(entries, { key: 'detail', index: 1, path: '/paper/a', scrollTop: 0 }, 'PUSH');
  assert.equal(restoredScrollPosition(entries, 'overview', 'POP'), 460);
  assert.equal(restoredScrollPosition(entries, 'overview', 'PUSH'), 0);
  entries = rememberLocation(entries, { key: 'replacement', index: 1, path: '/daily', scrollTop: 0 }, 'PUSH');
  assert.equal(entries.some(row => row.key === 'detail'), false);
  assert.equal(entries.some(row => row.key === 'overview'), true);
});

test('returning from the global watchlist restores only the matching source history entry', () => {
  const { contextReturnDestination } = navigation();
  const target = '/holdings?accountId=b&q=FICT';
  assert.equal(contextReturnDestination([{ key: 'b', index: 2, path: target, scrollTop: 640 }], 3, target).kind, 'back');
  assert.equal(contextReturnDestination([{ key: 'a', index: 2, path: '/holdings?accountId=a', scrollTop: 0 }], 3, target).path, target);
  assert.equal(contextReturnDestination([], 0, '//unsafe.example').path, '/');
});
