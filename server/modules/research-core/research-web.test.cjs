const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
function load() {
  const filename = path.join(__dirname, 'research-web.service.ts');
  if (!fs.existsSync(filename)) return {};
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true,
  } }).outputText;
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', compiled)((id) => {
    if (id === '@nestjs/common') return { Injectable: () => (target) => target };
    if (id === '../settings/settings.service') return { SettingsService: class {} };
    if (id === './research-tools-budget.service') return { ResearchToolsBudgetService: class {} };
    throw new Error(`Unexpected import ${id}`);
  }, mod, mod.exports);
  return mod.exports;
}

test('web search is explicitly gated and uses one reserved fixed-host request with safe bounded source excerpts', async () => {
  const { ResearchWebService } = load();
  assert.equal(typeof ResearchWebService, 'function', 'A bounded web research adapter must exist');
  const events = [];
  let reserved = 0;
  let settled;
  let request;
  const service = new ResearchWebService({ getResearchSearchConfig: async (owner) => {
    assert.equal(owner, 'alice');
    return { baseUrl: 'https://api.deepseek.com', apiKey: 'alice-secret' };
  } }, { reserve: async (owner, task) => {
    assert.equal(owner, 'alice'); assert.equal(task, 'task-1'); reserved++; return 'reservation-1';
  }, settle: async (...args) => { settled = args; } });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.equal(reserved, 1);
    request = { url, options };
    return Response.json({ results: [
      { title: 'Annual report', url: 'https://www.sec.gov/Archives/report.html', summary: 'Verified source excerpt '.repeat(100), date: '2026-10-29' },
      { title: 'Secret', url: 'https://user:secret@example.com/private', summary: 'ignore' },
      { title: 'Local', url: 'https://127.0.0.1/private', summary: 'ignore' },
    ] });
  };
  try {
    assert.deepEqual(await service.search('alice', 'AAPL', 'en', { webResearch: false }), []);
    assert.equal(reserved, 0);
    const items = await service.search('alice', 'AAPL', 'en', { webResearch: true, taskId: 'task-1',
      query: 'filing risks '.repeat(30), onAcquisition: (event) => events.push(event) });
    assert.equal(request.url, 'https://api.deepseek.com/v1/tools/search');
    assert.equal(request.options.redirect, 'error');
    assert.equal(request.options.headers.Authorization, 'Bearer alice-secret');
    const body = JSON.parse(request.options.body);
    assert.equal(body.count, 3);
    assert.equal(body.need_content, true);
    assert.ok(body.query.startsWith('AAPL '));
    assert.ok([...body.query].length <= 128);
    assert.equal(items.length, 1);
    assert.equal(items[0].evidenceType, 'other');
    assert.match(items[0].content, /not a verified financial statement/i);
    assert.ok(items[0].content.length < 850);
    assert.doesNotMatch(JSON.stringify({ items, events }), /alice-secret/);
    assert.deepEqual(settled, ['alice', 'reservation-1', 'succeeded']);
    assert.deepEqual(events.map((event) => event.status), ['started', 'succeeded']);
  } finally { globalThis.fetch = originalFetch; }
});

test('web search requires a task, stops before spending when cancelled and never retries provider errors', async () => {
  const { ResearchWebService } = load();
  assert.equal(typeof ResearchWebService, 'function');
  let reservations = 0;
  let calls = 0;
  const events = [];
  const service = new ResearchWebService({ getResearchSearchConfig: async () => ({ baseUrl: 'https://api.deepseek.com', apiKey: 'key' }) }, {
    reserve: async () => { reservations++; return 'id'; }, settle: async () => undefined,
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { calls++; throw new Error('key=key internal URL'); };
  try {
    await assert.rejects(service.search('alice', 'AAPL', 'en', { webResearch: true }), /task/i);
    await assert.rejects(service.search('alice', 'AAPL', 'en', { webResearch: true, taskId: 'task', shouldContinue: async () => false }), /stopped/i);
    assert.equal(reservations, 0);
    await assert.rejects(service.search('alice', 'AAPL', 'en', { webResearch: true, taskId: 'task',
      onAcquisition: (event) => events.push(event) }), /network_error/);
    assert.equal(reservations, 1);
    assert.equal(calls, 1);
    assert.doesNotMatch(JSON.stringify(events), /key=|internal URL/);
    assert.equal(events.at(-1).status, 'failed');
  } finally { globalThis.fetch = originalFetch; }
});

test('search budget rejection happens before any external request', async () => {
  const { ResearchWebService } = load();
  assert.equal(typeof ResearchWebService, 'function');
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('must not call'); };
  try {
    const service = new ResearchWebService({ getResearchSearchConfig: async () => ({ baseUrl: 'https://api.deepseek.com', apiKey: 'key' }) }, {
      reserve: async () => { throw new Error('RESEARCH_TASK_LIMIT'); }, settle: async () => undefined,
    });
    await assert.rejects(service.search('alice', 'AAPL', 'en', { webResearch: true, taskId: 'task' }), /TASK_LIMIT/);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test('a pause while publishing tool progress prevents the reserved paid request', async () => {
  const { ResearchWebService } = load();
  let active = true;
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { calls++; return Response.json({ results: [] }); };
  try {
    const service = new ResearchWebService({ getResearchSearchConfig: async () => ({ baseUrl: 'https://api.deepseek.com', apiKey: 'key' }) }, {
      reserve: async () => 'id', settle: async () => undefined,
    });
    await assert.rejects(service.search('alice', 'AAPL', 'en', { webResearch: true, taskId: 'task',
      shouldContinue: async () => active, onAcquisition: (event) => { if (event.status === 'started') active = false; },
    }), /stopped/i);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = originalFetch; }
});
