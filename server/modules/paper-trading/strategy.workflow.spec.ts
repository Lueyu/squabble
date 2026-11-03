import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { StrategyService } from './strategy.service';
import { normalizeBuilderConfig } from './agent-builder.rules';
import { tradingMarketSchedule } from './trading-market.calendar';
import type { BuilderProfile } from '../../../shared/api.interface';
import type { CouncilReport, CouncilSession } from '../../../shared/council.interface';
import type { TradingMarketSnapshot } from '../../../shared/trading-market.interface';
import type { StrategyTaskRow } from './strategy.store';

test('a changed dynamic universe cannot pair old-company research with a different ticker quote', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-03T14:00:00Z') });
  try {
    const profile: BuilderProfile = { id: randomUUID(), version: 1, status: 'active', createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(), config: normalizeBuilderConfig({ name: 'Dynamic universe', template: 'balanced', tickers: [],
        minimumRating: 'Buy', customPrompt: '', maxOrderPct: 5, dailyLossLimitPct: 3, maxOrdersPerDay: 3, notifyOnProposal: false }) };
    const sessions = ['AAPL', 'MSFT'].map((ticker): CouncilSession => {
      const report: CouncilReport = { id: `${ticker}-report`, version: 1, revision: 1, decision: 'wait', summary: `${ticker} facts`, dissent: [],
        nextReviewCondition: '', evidence: [{ id: `${ticker}-evidence`, title: ticker, content: `${ticker} evidence`, sourceUrl: null,
          fetchedAt: new Date().toISOString() }], sourceRunId: null, candidate: null, paperOrderId: null, tokensUsed: 0,
        engine: 'llm', createdAt: new Date().toISOString() };
      return { id: ticker, profileId: profile.id, profileVersion: 1, ticker, language: 'en', status: 'completed', revision: 1,
        messages: [], reports: [report], error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    });
    const calls: string[] = [];
    let published = false;
    const market = { getSnapshot: async (ticker: string): Promise<TradingMarketSnapshot> => {
      calls.push(ticker);
      return { ticker, providerSymbol: ticker, market: 'US', currency: 'USD', usable: false, reason: 'market_closed',
        quoteUsable: false, quoteReason: 'market_closed', source: 'yahoo-chart', sourceUrl: null,
        fetchedAt: new Date().toISOString(), quoteTimestamp: new Date().toISOString(), price: 100,
        delay: 'possibly-delayed', maxQuoteAgeSeconds: 1200, timeframe: '1d', candles: [], schedule: tradingMarketSchedule('US', new Date()),
        indicators: { sma20: 99, sma50: 98, rsi14: 40, atr14: 2, volumeRatio: 1, asOf: new Date().toISOString(), sampleSize: 60, timeframe: '1d' } };
    } };
    const store = { claimExtraction: async () => true,
      publish: async (_task: unknown, _rules: unknown, reportIds: string[]) => { assert.deepEqual(reportIds, ['MSFT-report']); published = true; },
      updateTask: async () => { throw new Error('Research identity unexpectedly failed'); } };
    const model = { json: async (_owner: string, _member: unknown, _id: string, _purpose: string, prompt: string) => {
      assert.ok(prompt.includes('MSFT-evidence'));
      assert.ok(!prompt.includes('AAPL-evidence'));
      assert.ok(!prompt.includes('NVDA'));
      return { summary: 'No supported trade', rules: [] };
    } };
    const service = new StrategyService({} as never, {} as never, {} as never,
      { getSession: async (_owner: string, id: string) => sessions.find((session) => session.id === id)! } as never,
      market as never, model as never, store as never, {} as never);
    const task: StrategyTaskRow = { id: randomUUID(), owner: 'owner', profileId: profile.id, profileVersion: 1, market: 'US', marketDate: '2026-11-03',
      attempt: 0, state: 'discussing', sessionIds: ['AAPL', 'MSFT'], reason: null, createdAt: new Date(), updatedAt: new Date() };
    const advance = Reflect.get(service, 'advanceDiscussion') as (
      owner: string, profile: BuilderProfile, task: StrategyTaskRow, tickers: string[], schedule: ReturnType<typeof tradingMarketSchedule>,
    ) => Promise<void>;
    await advance.call(service, 'owner', profile, task, ['MSFT', 'NVDA'], tradingMarketSchedule('US', new Date()));
    assert.deepEqual(calls, ['MSFT']); assert.equal(published, true);
  } finally { t.mock.timers.reset(); }
});
