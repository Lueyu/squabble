'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

test('fixture serves built SPA, fictional data and rejects unmapped API requests', async t => {
  let fixture;
  assert.doesNotThrow(() => { fixture = require('./fixture-server.cjs'); });
  const dist = await fs.mkdtemp(path.join(os.tmpdir(), 'ui-fixture-'));
  await fs.writeFile(path.join(dist, 'index.html'), '<html>fictional UI</html>');
  const running = await fixture.start({ port: 0, dist });
  t.after(async () => {
    await new Promise(resolve => running.server.close(resolve));
    await fs.rm(dist, { recursive: true });
  });
  assert.match(await (await fetch(running.url + '/friends')).text(), /fictional UI/);
  const agents = await (await fetch(running.url + '/api/agent-roster')).json();
  assert.equal(agents.items.length, 5);
  assert.equal(agents.items[0].currentVersion.config.executor.executionMode, 'model');
  const missing = await fetch(running.url + '/api/never-forward-this');
  assert.equal(missing.status, 404);
  const state = await (await fetch(running.url + '/__fixture__/state')).json();
  assert.deepEqual(state.unknown, [{ method: 'GET', path: '/api/never-forward-this' }]);
  assert.equal((await fetch(running.url + '/api/research-conversations', { method: 'POST' })).status, 405);
});

test('fixture starts independently with isolated state and fixed fictional timestamps', async t => {
  const fixture = require('./fixture-server.cjs');
  const servers = await Promise.all([fixture.start({ port: 0 }), fixture.start({ port: 0 })]);
  t.after(() => Promise.all(servers.map(({ server }) => new Promise(resolve => server.close(resolve)))));
  const payloads = await Promise.all(servers.map(async ({ url }) => (await fetch(url + '/api/agent-roster')).json()));
  assert.deepEqual(payloads[0], payloads[1]);
  assert.equal(payloads[0].items[0].createdAt, '2026-11-13T01:00:00.000Z');
});

test('holdings GET fixtures match client collection and dashboard response contracts', async t => {
  const { start } = require('./fixture-server.cjs');
  const { server, url } = await start({ port: 0 });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const read = async resource => (await fetch(url + resource)).json();
  for (const resource of ['/api/portfolio/groups', '/api/multi-agent/latest-ratings', '/api/multi-agent/runs', '/api/quote/batch']) {
    const data = await read(resource);
    assert.ok(Array.isArray(data.items), resource + ' must expose data.items to its client consumer');
  }
  const overview = await read('/api/portfolio/dashboard/overview');
  assert.ok(Array.isArray(overview.groups));
  assert.equal(typeof overview.accountValue, 'string');
  assert.equal(typeof overview.totalMvByCurrency, 'object');
});

test('memory preferences and default settings provide the nested fields read by their panels', async t => {
  const { start } = require('./fixture-server.cjs');
  const { server, url } = await start({ port: 0 });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const preferenceResponse = await fetch(url + '/api/research-memory/preferences');
  assert.equal(preferenceResponse.status, 200);
  assert.deepEqual(await preferenceResponse.json(), { autoArchive: false, recallEnabled: false });
  const settings = await (await fetch(url + '/api/settings/integrations')).json();
  assert.equal(settings.llm.route.mode, 'basic');
  assert.equal(settings.llm.engine, 'basic');
  assert.equal(settings.llm.source, 'builtin');
  for (const key of ['baseUrl', 'fastModel', 'slowModel', 'maskedApiKey']) assert.equal(typeof settings.llm[key], 'string');
  assert.equal(typeof settings.financial, 'object');
});
