import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { cashAccounts, holdings, paperAccounts, paperPositions, paperSnapshots } from '../../database/schema';
import { portfolioHistoryFetches, portfolioHistoryFx, portfolioHistoryPrices } from '../../database/portfolio-history.schema';
import { PortfolioHistoryHoldings } from './portfolio-history.holdings';
import { PortfolioHistoryCache } from './portfolio-history.cache';
import { PortfolioHistoryService } from './portfolio-history.service';
import { PortfolioCurrentMarksService } from './portfolio-current-marks.service';
import { PortfolioComparisonService } from '../paper-trading/portfolio-comparison.service';
import type { PortfolioHistoryProvider } from './portfolio-history.provider';
import { historySymbol, utcDay } from './portfolio-history.rules';
import { ImportService } from '../import/import.service';

test('saved imports immediately expose scoped marks and asynchronously fill reference history once without rewriting NAV', async t => {
  assert.ok(process.env.HISTORY_TEST_DATABASE_URL, 'Use a verified disposable HISTORY_TEST_DATABASE_URL');
  const namespace = `portfolio_history_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(process.env.HISTORY_TEST_DATABASE_URL!, { max: 1, onnotice: () => {} });
  const client = postgres(process.env.HISTORY_TEST_DATABASE_URL!, { max: 6, onnotice: () => {}, connection: { search_path: namespace } });
  await admin`CREATE SCHEMA ${admin(namespace)}`;
  try {
    await client.unsafe(readFileSync('scripts/db/01_schema.sql', 'utf8'));
    await client.unsafe(readFileSync('scripts/db/48_portfolio_history.sql', 'utf8'));
    const db = drizzle(client), owner = randomUUID(), foreign = randomUUID(), at = new Date();
    const prior = utcDay(new Date(at.getTime() - 2 * 86_400_000));
    const earlier = utcDay(new Date(at.getTime() - 3 * 86_400_000));
    await db.insert(holdings).values([
      { owner, ticker: 'FICT', market: 'US', currency: 'USD', shares: '2', currentPrice: '30' },
      { owner: foreign, ticker: 'PRIVATE', market: 'US', currency: 'USD', shares: '999', currentPrice: '999' },
    ]);
    await db.insert(cashAccounts).values({ owner, currency: 'USD', balance: '9999', reconciliationStatus: 'unconfirmed' });
    const [legacy, other] = await db.insert(paperAccounts).values([
      { owner, name: 'Fictional legacy', cashBalance: '100', ledgerMode: 'legacy_usd' },
      { owner: foreign, name: 'Private account', cashBalance: '999999' },
    ]).returning();
    await db.insert(paperPositions).values({ owner, accountId: legacy.id, ticker: 'FICT', market: 'US', currency: 'USD', shares: '3', avgCost: '1' });
    await db.insert(paperSnapshots).values({ owner, accountId: legacy.id, snapshotDate: prior, cash: '100', equity: '160', valuedAt: null });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const calls: string[] = [];
    const provider: Pick<PortfolioHistoryProvider, 'prices' | 'fx'> = {
      prices: async (ticker, market) => {
        calls.push(ticker); await gate;
        const identity = historySymbol(ticker, market)!;
        return [{ ...identity, priceDate: earlier, close: '18', source: 'fixture' }, { ...identity, priceDate: prior, close: '20', source: 'fixture' }];
      },
      fx: async () => { calls.push('fx'); await gate; return [{ currency: 'HKD', rateDate: earlier, usdRate: '0.125', source: 'fixture' }]; },
    };
    const source = new PortfolioHistoryHoldings(db), cache = new PortfolioHistoryCache(db, provider as PortfolioHistoryProvider);
    const history = new PortfolioHistoryService(source, cache), marks = new PortfolioCurrentMarksService(db, source, cache);
    const comparison = new PortfolioComparisonService(db, marks);

    await t.test('foreground marks remain available with unknown cash and untrusted legacy NAV', async () => {
      const view = await comparison.read(owner, '1M', undefined, at);
      const real = view.series.find(row => row.accountId === 'real')!;
      assert.equal(real.equityUsd, null); assert.equal(real.currentMark?.valueUsd, 60);
      assert.equal(real.currentMark?.basis, 'holdings_market_value'); assert.equal(real.currentMark?.cashValueUsd, null);
      const simulated = view.series.find(row => row.accountId === legacy.id)!;
      assert.equal(simulated.currentMark?.valueUsd, 190); assert.equal(simulated.currentMark?.basis, 'total_assets');
      assert.equal(simulated.equityUsd, null); assert.equal(simulated.returnPct, null);
      assert.equal(JSON.stringify(view).includes('PRIVATE'), false);
    });
    await t.test('quick GET starts a deduplicated background request and old imports gain history without reimport', async () => {
      const first = await history.read(owner, '1M', undefined, at);
      assert.equal(first.refreshing, true); assert.equal(first.series[0].points.some(row => row.valueUsd !== null), false);
      const duplicate = new PortfolioHistoryCache(db, provider as PortfolioHistoryProvider);
      const positions = (await source.read(owner)).flatMap(row => row.positions);
      const otherWorker = duplicate.prefetch(positions, at);
      for (let i = 0; i < 50 && !calls.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
      release(); await Promise.all([otherWorker, cache.prefetch(positions, at)]);
      const filled = await history.read(owner, '1M', undefined, at);
      assert.equal(calls.filter(ticker => ticker === 'FICT').length, 1, 'two service instances share the persisted lease');
      assert.equal(filled.refreshing, false);
      assert.equal(filled.series[0].points.find(row => row.date === earlier)?.valueUsd, 36);
      assert.equal(filled.series[0].points.find(row => row.date === prior)?.valueUsd, 40);
      assert.equal(filled.series.find(row => row.accountId === legacy.id)!.points.find(row => row.date === prior)?.valueUsd, 60, 'cash is excluded');
      assert.equal(filled.basis, 'current_positions_historical_prices'); assert.equal(filled.includesCash, false);
      assert.equal('returnPct' in filled.series[0].points.at(-1)!, false);
      await history.prefetch(owner); assert.equal(calls.length, 1, 'import/background replay reuses a completed durable cache');
      const restarted = new PortfolioHistoryService(source, new PortfolioHistoryCache(db, provider as PortfolioHistoryProvider));
      assert.equal((await restarted.read(owner, '1W', 'real', at)).series[0].points.find(row => row.date === prior)?.valueUsd, 40);
      await assert.rejects(history.read(owner, '1M', other.id, at), /ACCOUNT_NOT_FOUND/);
      await assert.rejects(history.read(owner, 'BAD', undefined, at), /PERIOD_INVALID/);
      assert.equal((await history.read(owner, 'ALL', 'real', at)).series[0].points.length, 366);
    });
    await t.test('provider failure retains gaps and backs off without synthetic prices or NAV writes', async () => {
      await db.insert(holdings).values({ owner, ticker: 'FAIL', market: 'US', currency: 'USD', shares: '2', currentPrice: null });
      let failedCalls = 0;
      const failed = new PortfolioHistoryCache(db, { prices: async () => { failedCalls++; throw Error('fixture failure'); }, fx: provider.fx } as PortfolioHistoryProvider);
      const failingHistory = new PortfolioHistoryService(source, failed);
      await failingHistory.prefetch(owner); await failingHistory.prefetch(owner);
      assert.equal(failedCalls, 1);
      const view = await failingHistory.read(owner, '1M', 'real', at);
      assert.equal(view.series[0].points.every(row => row.valueUsd === null), true);
      assert.ok(view.gaps.some(gap => gap.includes('price:FAIL')));
      const [fetch] = await db.select().from(portfolioHistoryFetches).where(eq(portfolioHistoryFetches.resource, 'price:FAIL'));
      assert.equal(fetch.error, 'PROVIDER_UNAVAILABLE');
      assert.equal((await client`SELECT count(*)::int AS count FROM portfolio_value_points`)[0].count, 0);
      assert.equal((await client`SELECT count(*)::int AS count FROM paper_trades`)[0].count, 0);
      assert.equal((await client`SELECT valued_at FROM paper_snapshots WHERE account_id=${legacy.id}`)[0].valued_at, null);
      assert.equal((await client`SELECT current_price FROM holdings WHERE owner=${owner} AND ticker='FICT'`)[0].current_price, '30');
    });
    await t.test('HK and CN need their own historical FX and a new dated close replaces an undated saved price', async () => {
      const multi = randomUUID();
      await db.insert(holdings).values([
        { owner: multi, ticker: '0700', market: 'HK', currency: 'HKD', shares: '2', currentPrice: '999' },
        { owner: multi, ticker: '600519.SH', market: 'CN', currency: 'CNY', shares: '3', currentPrice: '999' },
      ]);
      await history.prefetch(multi);
      const missing = await history.read(multi, '1W', 'real', at);
      assert.equal(missing.series[0].points.find(row => row.date === prior)?.valueUsd, null);
      assert.ok(missing.series[0].points.find(row => row.date === prior)?.gaps.includes('FX_MISSING:CNY'));
      await db.insert(portfolioHistoryFx).values({ currency: 'CNY', rateDate: utcDay(new Date(at.getTime() + 86_400_000)), usdRate: '999', source: 'fixture-future' });
      assert.equal((await history.read(multi, '1W', 'real', at)).series[0].points.find(row => row.date === prior)?.valueUsd, null);
      await db.insert(portfolioHistoryFx).values({ currency: 'CNY', rateDate: earlier, usdRate: '0.2', source: 'fixture' });
      const complete = await history.read(multi, '1W', 'real', at);
      assert.equal(complete.series[0].points.find(row => row.date === prior)?.valueUsd, 17);
      const current = (await marks.read(multi, ['real'], at)).real;
      assert.equal(current.valueUsd, 17); assert.equal(current.basis, 'holdings_market_value');
      assert.equal(current.pricing, 'cached_close'); assert.equal(current.asOf, prior);
    });
    await t.test('an expired lease can be taken over and a late former worker cannot overwrite the winner', async () => {
      const position = { ticker: 'LATE', market: 'US', currency: 'USD', shares: '1' };
      let releaseOld!: () => void, dispatched = false;
      const oldGate = new Promise<void>(resolve => { releaseOld = resolve; });
      const old = new PortfolioHistoryCache(db, { prices: async () => {
        dispatched = true; await oldGate;
        return [{ symbol: 'LATE', market: 'US', currency: 'USD', priceDate: prior, close: '1', source: 'old-fixture' }];
      }, fx: provider.fx } as PortfolioHistoryProvider);
      const pending = old.prefetch([position], at);
      for (let i = 0; i < 100 && !dispatched; i++) await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(dispatched, true);
      await db.update(portfolioHistoryFetches).set({ leaseUntil: new Date(0), nextAttemptAt: new Date(0) }).where(eq(portfolioHistoryFetches.resource, 'price:LATE'));
      const next = new PortfolioHistoryCache(db, { prices: async () => [{ symbol: 'LATE', market: 'US', currency: 'USD', priceDate: prior, close: '20', source: 'winner-fixture' }], fx: provider.fx } as PortfolioHistoryProvider);
      await next.prefetch([position], at); releaseOld(); await pending;
      const [winner] = await db.select().from(portfolioHistoryPrices).where(eq(portfolioHistoryPrices.symbol, 'LATE'));
      assert.equal(winner.close, '20'); assert.equal(winner.source, 'winner-fixture');
      const [receipt] = await db.select().from(portfolioHistoryFetches).where(eq(portfolioHistoryFetches.resource, 'price:LATE'));
      assert.equal(receipt.error, null); assert.equal(receipt.leaseToken, null); assert.ok(receipt.completedAt);
    });
    await t.test('provider work is limited to four concurrent resources', async () => {
      let active = 0, maximum = 0, total = 0;
      const limited = new PortfolioHistoryCache(db, { prices: async (ticker: string) => {
        active++; total++; maximum = Math.max(maximum, active);
        await new Promise(resolve => setTimeout(resolve, 15)); active--;
        return [{ symbol: ticker, market: 'US', currency: 'USD', priceDate: prior, close: '20', source: 'fixture' }];
      }, fx: provider.fx } as PortfolioHistoryProvider);
      await limited.prefetch(Array.from({ length: 8 }, (_, i) => ({ ticker: `QUEUE${i}`, market: 'US', currency: 'USD', shares: '1' })), at);
      assert.equal(total, 8); assert.ok(maximum <= 4);
    });
    await t.test('a real import commit schedules history after commit and returns while its provider is still blocked', async () => {
      const importedOwner = randomUUID();
      let providerCalls = 0, gateOpen = false, unblock!: () => void, started!: () => void;
      const blocked = new Promise<void>(resolve => { unblock = () => { gateOpen = true; resolve(); }; });
      const dispatched = new Promise<void>(resolve => { started = resolve; });
      const importCache = new PortfolioHistoryCache(db, { prices: async (ticker: string, market: string) => {
        providerCalls++; started(); await blocked;
        return [{ ...historySymbol(ticker, market)!, priceDate: earlier, close: '18', source: 'fixture-import' },
          { ...historySymbol(ticker, market)!, priceDate: prior, close: '20', source: 'fixture-import' }];
      }, fx: provider.fx } as PortfolioHistoryProvider);
      const importedHistory = new PortfolioHistoryService(source, importCache);
      const importer = new ImportService(db, { getQuote: () => { throw Error('Import must not wait for live quotes'); } } as never, undefined, importedHistory);
      const input = { source: 'csv' as const, requestKey: 'history-after-commit', rows: [{ ticker: 'IMPORTED', shares: 4, avgCost: 5, currency: 'USD' as const }] };
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const receipt = await Promise.race([importer.commit(importedOwner, input), new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(Error('Import response waited for the blocked history provider')), 3000);
        })]);
        if (timeout) clearTimeout(timeout);
        assert.equal(receipt.created, 1); assert.equal(gateOpen, false);
        await Promise.race([dispatched, new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(Error('Successful import did not automatically dispatch history')), 3000);
        })]);
        if (timeout) clearTimeout(timeout);
        assert.equal(providerCalls, 1, 'the commit hook alone schedules work before any history GET');
        const [saved] = await db.select().from(holdings).where(eq(holdings.owner, importedOwner));
        assert.equal(saved.ticker, 'IMPORTED'); assert.equal(saved.shares, '4');
        assert.equal(saved.currentPrice, null, 'imported cost is not fabricated as a quote');
        const pending = await importedHistory.read(importedOwner, '1M', 'real', at);
        assert.equal(pending.refreshing, true); assert.equal(pending.series[0].points.every(point => point.valueUsd === null), true);
        unblock();
        let completed = await importedHistory.read(importedOwner, '1M', 'real', at);
        for (let i = 0; i < 100 && completed.refreshing; i++) {
          await new Promise(resolve => setTimeout(resolve, 10)); completed = await importedHistory.read(importedOwner, '1M', 'real', at);
        }
        assert.equal(completed.refreshing, false);
        assert.equal(completed.series[0].points.find(point => point.date === prior)?.valueUsd, 80);
        const importedMarks = await new PortfolioCurrentMarksService(db, source, importCache).read(importedOwner, ['real'], at);
        assert.equal(importedMarks.real.valueUsd, 80); assert.equal(importedMarks.real.basis, 'holdings_market_value');
        assert.equal((await importer.commit(importedOwner, input)).receiptId, receipt.receiptId);
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.equal(providerCalls, 1, 'import receipt replay and page reads do not duplicate the public fetch');
      } finally { if (timeout) clearTimeout(timeout); unblock(); }
    });
    // Drain read-triggered no-op claims before dropping this fictional schema.
    await Promise.all([cache.prefetch((await source.read(owner)).flatMap(row => row.positions), at)]);
  } finally {
    await client.end(); await admin`DROP SCHEMA IF EXISTS ${admin(namespace)} CASCADE`; await admin.end();
  }
});
