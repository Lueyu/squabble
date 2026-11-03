const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');
const exportsForTest = {};
const filename = path.join(__dirname, 'strategy-state.ts');
if (fs.existsSync(filename)) vm.runInNewContext(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports: exportsForTest });
const state = (...args) => exportsForTest.strategyDisplayState?.(...args);
const now = Date.parse('2026-11-03T15:00:00Z');
const profile = { status: 'active', version: 2, config: { automation: { enabled: true, monitorSeconds: 60 } } };
const market = { state: 'monitoring', lastCheckAt: new Date(now - 15000).toISOString() };

test('paused profiles never display a cached monitoring status', () => {
  assert.equal(state({ ...profile, status: 'paused' }, market, 2, now), 'stopped');
});
test('old version and stale heartbeats cannot claim live monitoring', () => {
  assert.equal(state(profile, market, 1, now), 'outdated');
  assert.equal(state(profile, { ...market, lastCheckAt: new Date(now - 300000).toISOString() }, 2, now), 'offline');
  assert.equal(state(profile, { ...market, lastCheckAt: null }, 2, now), 'offline');
  assert.equal(state(profile, market, 2, now), 'monitoring');
});
test('closed-market waiting and actionable failures remain distinguishable', () => {
  assert.equal(state(profile, { state: 'waiting', lastCheckAt: null }, 2, now), 'waiting');
  assert.equal(state(profile, { state: 'blocked', lastCheckAt: null }, 2, now), 'blocked');
});
test('pre-existing profiles remain opt-out when no automation is configured', () => {
  assert.equal(state({ ...profile, config: {} }, market, 2, now), 'disabled');
});
