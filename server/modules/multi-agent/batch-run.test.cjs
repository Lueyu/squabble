const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function load(name) {
  const compiled = ts.transpileModule(fs.readFileSync(path.join(__dirname, name), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true },
  }).outputText;
  const exported = { exports: {} };
  const dependencies = {
    '@nestjs/common': { Injectable: () => target => target, Inject: () => () => undefined, Optional: () => () => undefined,
      Logger: class { log() {} }, BadRequestException: Error },
    '../../common/platform': { DRIZZLE_DATABASE: 'db' },
    'drizzle-orm': { eq: () => true, and: () => true },
    '@server/database/schema': { holdings: { name: 'holdings' }, watchlist: { name: 'watchlist' }, agentRuns: {} },
    '../settings/settings.service': { SettingsService: class {} },
    '../research-core/llm.service': { LlmService: class {} },
    './analysis-report': () => load('analysis-report.ts'),
  };
  new Function('require', 'module', 'exports', compiled)(id => {
    if (id === '../research-core/research-errors') return load('../research-core/research-errors.ts');
    const dependency = dependencies[id];
    if (typeof dependency === 'function') return dependency();
    if (dependency) return dependency;
    throw new Error(`Unexpected dependency ${id}`);
  }, exported, exported.exports);
  return exported.exports;
}

test('batch language reaches every run and active targets are deduplicated per owner', async () => {
  const { BatchService } = load('batch.service.ts');
  const created = [];
  let completed;
  const service = new BatchService({}, {
    createRun: async (owner, input) => {
      created.push({ owner, input });
      return { id: String(created.length), ticker: input.ticker, runMode: input.runMode, status: 'pending' };
    },
  }, { startPipeline() {}, onRunComplete(callback) { completed = callback; } }, {});
  service.resolveTargets = async () => [{ ticker: 'AAPL', company: null, market: 'US', runMode: 'full' }];
  service.onModuleInit();
  const request = { scope: 'custom', tickers: ['AAPL'], language: 'en' };
  assert.equal((await service.createBatch('alice', request)).created, 1);
  assert.equal((await service.createBatch('alice', request)).errors.length, 1);
  assert.equal((await service.createBatch('bob', request)).created, 1);
  assert.equal(created[0].input.language, 'en');
  completed('1', 'alice', 'full');
  assert.equal((await service.createBatch('alice', request)).created, 1);
});

test('daily batch snapshots one selected local route across holdings and watchlist runs', async () => {
  const { BatchService } = load('batch.service.ts');
  const route = { mode: 'local', agentId: 'native-codex', agentSettings: { model: 'gpt-5' } };
  const created = [];
  const service = new BatchService({}, {
    createRun: async (_owner, input) => {
      created.push(input);
      return { id: String(created.length), ticker: input.ticker, runMode: input.runMode, status: 'pending' };
    },
  }, { startPipeline() {}, onRunComplete() {} }, {},
  { getDefaultModelRoute: async () => route }, { validateRoute: async () => undefined });
  service.resolveTargets = async (_owner, req) => [{ ticker: req.scope === 'holdings' ? 'AAPL' : 'MSFT',
    company: null, market: 'US', runMode: 'full' }];
  service.getWatchlistTargets = async () => [{ ticker: 'MSFT', signal: 'Buy' }];
  const result = await service.createDailyBatch('alice', 'en');
  assert.equal(result.totalCreated, 2);
  assert.deepEqual(created.map(run => run.modelRoute), [route, route]);
});

test('one local Agent runs one analysis at a time while API work can use another slot', async () => {
  const { BatchService } = load('batch.service.ts');
  const started = [];
  let completed;
  let nextId = 0;
  const service = new BatchService({}, {
    createRun: async (_owner, input) => ({ id: String(++nextId), ticker: input.ticker,
      runMode: input.runMode, status: 'pending' }),
  }, { startPipeline(id) { started.push(id); }, onRunComplete(callback) { completed = callback; } }, {},
  undefined, { validateRoute: async () => undefined });
  service.resolveTargets = async (_owner, req) => req.tickers.map(ticker => ({ ticker,
    company: null, market: 'US', runMode: 'full' }));
  service.onModuleInit();
  const local = { mode: 'local', agentId: 'native-codex' };
  const batch = await service.createBatch('alice', { scope: 'custom', tickers: ['A', 'B'], route: local });
  assert.equal(batch.running, 1);
  assert.equal(batch.queued, 1);
  const api = await service.createBatch('alice', { scope: 'custom', tickers: ['C'], route: { mode: 'api' } });
  assert.equal(api.running, 1);
  assert.deepEqual(started, ['1', '3']);
  completed('1', 'alice', 'full');
  assert.deepEqual(started, ['1', '3', '2']);
});

test('invalid language and invalid ticker payloads fail before creating work', async () => {
  const { BatchService } = load('batch.service.ts');
  const service = new BatchService({}, {}, {}, {});
  await assert.rejects(service.createBatch('alice', { scope: 'custom', language: 'fr' }), /language/);
  await assert.rejects(service.createBatch('alice', { scope: 'custom', tickers: [42] }), /ticker/);
});

test('queued cancellation allows a fresh request without releasing another live slot', async () => {
  const { BatchService } = load('batch.service.ts');
  let sequence = 0;
  const started = [];
  const service = new BatchService({}, {
    createRun: async (_owner, input) => ({ id: String(++sequence), ticker: input.ticker, runMode: 'full', status: 'pending' }),
  }, { startPipeline(id) { started.push(id); }, onRunComplete() {} }, {});
  service.resolveTargets = async (_user, request) => request.tickers.map(ticker => ({ ticker, company: null, market: 'US', runMode: 'full' }));
  const first = await service.createBatch('alice', { scope: 'custom', tickers: ['A', 'B', 'C', 'D'], language: 'en' });
  assert.equal(first.running, 3);
  assert.equal(first.queued, 1);
  service.cancelQueuedRun('4', 'alice');
  const retry = await service.createBatch('alice', { scope: 'custom', tickers: ['D'], language: 'en' });
  assert.equal(retry.created, 1);
  assert.equal(retry.queued, 1);
  assert.deepEqual(started, ['1', '2', '3']);
});

test('a batch resolves each ticker once even after an earlier duplicate completes', async () => {
  const { BatchService } = load('batch.service.ts');
  let completed;
  const created = [];
  const service = new BatchService({
    select: () => ({ from: table => ({ where: async () => table.name === 'holdings'
      ? [{ ticker: 'AAPL', company: 'Apple', market: 'US' }]
      : [{ ticker: 'aapl', company: 'Apple', market: 'US', signal: '买入' }] }) }),
  }, {
    createRun: async (_owner, input) => {
      created.push(input);
      return { id: String(created.length), ticker: input.ticker, runMode: input.runMode, status: 'pending' };
    },
  }, {
    startPipeline(id, owner, mode) { completed(id, owner, mode); },
    onRunComplete(callback) { completed = callback; },
  }, { getPortfolioContext: async () => ({ holdings: [{ ticker: 'AAPL', weightPct: 1 }] }) });
  service.onModuleInit();
  const result = await service.createBatch('alice', { scope: 'all', tiered: true, language: 'en' });
  assert.equal(result.created, 1);
  assert.equal(result.errors.length, 0);
  assert.equal(created[0].runMode, 'full', 'overlapping sources retain the deeper analysis mode');
});

test('daily analysis excludes holdings from buy-signal watchlist work even when already finished', async () => {
  const { BatchService } = load('batch.service.ts');
  const requests = [];
  const service = new BatchService({}, {}, {}, {});
  service.createBatch = async (_owner, request) => {
    requests.push(request);
    return { created: 1, runs: [{ ticker: request.scope === 'holdings' ? 'AAPL' : 'MSFT' }], errors: [] };
  };
  service.getWatchlistTargets = async () => [
    { ticker: 'aapl', signal: 'Buy' }, { ticker: 'MSFT', signal: '买入' },
  ];
  const result = await service.createDailyBatch('alice', 'en');
  assert.deepEqual(requests[1].tickers, ['MSFT']);
  assert.equal(result.totalCreated, 2);
});

test('queued work preserves the known mode when started after a completion', async () => {
  const { BatchService } = load('batch.service.ts');
  let completed;
  const started = [];
  let sequence = 0;
  const service = new BatchService({}, {
    createRun: async (_owner, input) => ({ id: String(++sequence), ticker: input.ticker, runMode: input.runMode, status: 'pending' }),
  }, {
    startPipeline(...args) { started.push(args); },
    onRunComplete(callback) { completed = callback; },
  }, {});
  service.resolveTargets = async () => ['A', 'B', 'C', 'D'].map(ticker => ({ ticker, runMode: 'full' }));
  service.onModuleInit();
  await service.createBatch('alice', { scope: 'holdings' });
  completed('1', 'alice', 'full');
  assert.equal(started.length, 4);
  assert.ok(started.every(([, , mode]) => mode === 'full'));
});
