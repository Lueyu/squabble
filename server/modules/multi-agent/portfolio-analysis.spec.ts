import assert from 'node:assert/strict';
import test from 'node:test';
import { basicPortfolioReport, buildPortfolioReportSnapshot, PortfolioAnalysisService } from './portfolio-analysis.service';
import { cashAccounts, holdings, portfolioAnalysisRuns } from '@server/database/schema';

test('one portfolio snapshot retains missing prices and never invents weights', async () => {
  const snapshot = await buildPortfolioReportSnapshot([
    { ticker: 'AAPL', company: 'Apple', market: 'US', currency: 'USD', shares: '2', currentPrice: '100', buyPrice: '80' },
    { ticker: 'MSFT', company: 'Microsoft', market: 'US', currency: 'USD', shares: '3', currentPrice: null, buyPrice: '90' },
  ], [{ currency: 'USD', balance: '100' }], async () => 1);
  assert.equal(snapshot.holdings.length, 2);
  assert.equal(snapshot.holdings[0].marketValueUsd, 200);
  assert.equal(snapshot.holdings[1].marketValueUsd, null);
  assert.equal(snapshot.holdings[0].weightPct, null);
  assert.equal(snapshot.totalValueUsd, null);
  assert.match(snapshot.gaps.join(' '), /MSFT/);
});

test('portfolio accepts a slash-class holding symbol already supported by holdings', async () => {
  const snapshot = await buildPortfolioReportSnapshot([
    { ticker: 'BRK/B', company: 'Berkshire Hathaway', market: 'US', currency: 'USD', shares: '1', currentPrice: '500', buyPrice: '400' },
  ], [], async () => 1);
  assert.equal(snapshot.holdings[0].ticker, 'BRK/B');
});

test('Basic report includes every holding without model claims or trades', async () => {
  const snapshot = await buildPortfolioReportSnapshot([
    { ticker: 'AAPL', company: 'Apple', market: 'US', currency: 'USD', shares: '2', currentPrice: '100', buyPrice: '80' },
  ], [{ currency: 'USD', balance: '100' }], async () => 1);
  const report = basicPortfolioReport(snapshot, 'en');
  assert.equal(report.holdings.length, 1);
  assert.equal(report.holdings[0].ticker, 'AAPL');
  assert.deepEqual(report.holdings[0].evidenceRefs, ['holding:AAPL:shares', 'holding:AAPL:currentPrice', 'holding:AAPL:marketValueUsd', 'holding:AAPL:weightPct']);
  assert.match(report.dataGaps.join(' '), /freshness/);
});

function fakeDatabase() {
  let run: Record<string, unknown> | null = null;
  const holdingRows = [
    { ticker: 'AAPL', company: 'Apple', market: 'US', currency: 'USD', shares: '2', currentPrice: '100', buyPrice: '80' },
    { ticker: 'MSFT', company: 'Microsoft', market: 'US', currency: 'USD', shares: '3', currentPrice: '200', buyPrice: '180' },
  ];
  const query = (rows: () => unknown[]) => ({
    where() { return this; }, orderBy() { return this; }, limit() { return this; },
    then(resolve: (rows: unknown[]) => unknown) { return Promise.resolve(rows()).then(resolve); },
  });
  const db = {
    transaction(callback: (tx: unknown) => Promise<unknown>) { return callback(db); },
    select() { return { from(table: unknown) {
      if (table === holdings) return query(() => holdingRows);
      if (table === cashAccounts) return query(() => [{ currency: 'USD', balance: '100' }]);
      if (table === portfolioAnalysisRuns) return query(() => run ? [run] : []);
      throw new Error('Unexpected table');
    } }; },
    insert(table: unknown) {
      assert.equal(table, portfolioAnalysisRuns);
      return { values(values: Record<string, unknown>) {
        return { async returning() {
          run = { id: '88888888-8888-4888-8888-888888888888', ...values,
            usageKnown: false, tokensUsed: null, report: null, errorMessage: null,
            createdAt: new Date(), updatedAt: new Date(), completedAt: null };
          return [run];
        } };
      } };
    },
    update(table: unknown) {
      assert.equal(table, portfolioAnalysisRuns);
      return { set(patch: Record<string, unknown>) {
        const apply = () => {
          if (!run) return [];
          const current = run.status;
          if (patch.status === 'running' && current !== 'pending') return [];
          if (['completed', 'failed'].includes(String(patch.status)) && current !== 'running') return [];
          if (patch.status === 'cancelling' && current !== 'running') return [];
          if (patch.status === 'cancelled' && !['pending', 'cancelling'].includes(String(current))) return [];
          if (!patch.status && current !== 'running') return [];
          run = { ...run, ...patch };
          return [run];
        };
        return { where() { return { returning: async () => apply(), then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(apply()).then(resolve) }; } };
      } };
    },
  };
  return { db, current: () => run };
}

test('one selected Agent analyzes all holdings in one call and persists public progress', async () => {
  const { db, current } = fakeDatabase();
  const route = { mode: 'local' as const, agentId: 'native-codex' };
  const calls: Array<{ route: unknown; holdings: number }> = [];
  const service = new PortfolioAnalysisService(db as never, { convert: async (value: number) => value } as never,
    { getDefaultModelRoute: async () => route } as never,
    { validateRoute: async () => undefined, chatSlowJSON: async (messages: Array<{ content: string }>, _owner: string, options: { route: unknown; onProgress: (text: string) => Promise<void> }) => {
      calls.push({ route: options.route, holdings: JSON.parse(messages[1].content.split('Snapshot: ')[1]).holdings.length });
      await options.onProgress('Searching sources…');
      return { data: { summary: 'Diversified holdings need review.', allocationRisks: [], actions: ['Review weights.'],
        uncertainties: ['Quote freshness is unknown.'], holdings: [
          { ticker: 'AAPL', stance: 'hold', rationale: 'Position is material.', evidenceRefs: ['holding:AAPL:weightPct'], triggers: ['Review allocation.'] },
          { ticker: 'MSFT', stance: 'watch', rationale: 'Recheck thesis.', evidenceRefs: ['holding:MSFT:shares'], triggers: ['Review thesis.'] },
        ] }, tokens: 0, tokensKnown: false };
    } } as never);
  const created = await service.create('owner-1', 'en');
  assert.deepEqual(created.route, route);
  for (let index = 0; index < 20 && current()?.status !== 'completed'; index += 1) await new Promise(resolve => setImmediate(resolve));
  assert.equal(current()?.status, 'completed');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].holdings, 2);
  assert.equal(current()?.usageKnown, false);
  assert.equal(current()?.tokensUsed, null);
  assert.deepEqual((current()?.report as { holdings: Array<{ ticker: string }> }).holdings.map(item => item.ticker), ['AAPL', 'MSFT']);
});

test('cancelled portfolio task cannot publish a later model result', async () => {
  const { db, current } = fakeDatabase();
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const service = new PortfolioAnalysisService(db as never, { convert: async (value: number) => value } as never,
    { getDefaultModelRoute: async () => ({ mode: 'api' }) } as never,
    { validateRoute: async () => undefined, chatSlowJSON: async () => { calls += 1; await waiting;
      throw new Error('LLM request cancelled'); } } as never);
  const created = await service.create('owner-1', 'en');
  const stopping = await service.cancel('owner-1', created.id);
  assert.equal(stopping.status, 'cancelling');
  const repeat = await service.create('owner-1', 'en');
  assert.equal(repeat.id, created.id);
  release();
  for (let index = 0; index < 10; index += 1) await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(current()?.status, 'cancelled');
  assert.equal(current()?.report, null);
});

test('a failed model call is never retried automatically', async () => {
  const { db, current } = fakeDatabase();
  let calls = 0;
  const service = new PortfolioAnalysisService(db as never, { convert: async (value: number) => value } as never,
    { getDefaultModelRoute: async () => ({ mode: 'api' }) } as never,
    { validateRoute: async () => undefined, chatSlowJSON: async () => { calls += 1; throw new Error('LLM_REQUEST_TIMEOUT'); } } as never);
  await service.create('owner-1', 'en');
  for (let index = 0; index < 20 && current()?.status !== 'failed'; index += 1) await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(current()?.status, 'failed');
  assert.match(String(current()?.errorMessage), /timed out/i);
});

test('Basic route completes one combined report without calling a model', async () => {
  const { db, current } = fakeDatabase();
  let calls = 0;
  const service = new PortfolioAnalysisService(db as never, { convert: async (value: number) => value } as never,
    { getDefaultModelRoute: async () => ({ mode: 'basic' }) } as never,
    { validateRoute: async () => undefined, chatSlowJSON: async () => { calls += 1; throw new Error('Unexpected model call'); } } as never);
  await service.create('owner-1', 'en');
  for (let index = 0; index < 20 && current()?.status !== 'completed'; index += 1) await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 0);
  assert.equal(current()?.status, 'completed');
  assert.equal((current()?.report as { holdings: unknown[] }).holdings.length, 2);
  assert.equal(current()?.tokensUsed, 0);
});
