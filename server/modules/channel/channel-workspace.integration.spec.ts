import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { investmentFixture } from '../paper-trading/investment-test.fixture';
import { DEFAULT_INVESTMENT_CONFIG } from '../paper-trading/investment-policy.rules';
import { previewStrategy } from '../paper-trading/user-investment-strategy.rules';
import { paperAccounts, paperOrders, paperPositions, paperTrades } from '../../database/schema';
import { investmentPolicies } from '../../database/investment-policy.schema';
import { strategySignals } from '../../database/strategy.schema';
import * as channel from '../../database/channel.schema';
import { ChannelService } from './channel.service';
import { readChannelRuntime } from './channel-runtime';
import type { ConfirmedInvestmentStrategy, StrategyDraftInput } from '../../../shared/user-investment-strategy.interface';

function snapshot(ticker: string): ConfirmedInvestmentStrategy {
  const id = randomUUID(); const now = new Date().toISOString(); const text = `${ticker} buy 1 at 110, stop 100`;
  const content: StrategyDraftInput = { title: `${ticker} fixture`, body: text, timezone: 'UTC',
    startsAt: new Date(Date.now() - 3600000).toISOString(), endsAt: new Date(Date.now() + 86400000).toISOString(),
    limits: { maxPositionPct: 10, maxDailyIncreasePct: 5, maxDailyTurnoverPct: 20 },
    entries: [{ id: 'original-entry', ticker, text, sourceKeys: [], directive: { ticker, side: 'buy', trigger: { kind: 'price_lte', price: 110 },
      quantity: 1, stopLossPrice: 100, reviewedText: text, numericEvidence: [{ field: 'trigger.price', value: 110, quote: '110' },
        { field: 'quantity', value: 1, quote: '1' }, { field: 'stopLossPrice', value: 100, quote: '100' }] } }] };
  return { id, revision: 1, parentId: null, status: 'confirmed', content, sources: [],
    preview: previewStrategy(content, [], 1), confirmedAt: now, createdAt: now, updatedAt: now };
}
test('channel reads require account selection and monitor shared strategy sources independently per account', async () => {
  await investmentFixture(async (db, _client, owner) => {
    let calls = 0;
    const service = new ChannelService(db, { getQuote: async (symbol: string) => {
      calls++; return { symbol, price: '100.5', currency: 'USD', source: 'fixture', quoteAt: new Date().toISOString() };
    } } as never);
    await service.onModuleInit();
    const [a, b] = await db.insert(paperAccounts).values([
      { owner, name: 'Account A', botEnabled: true }, { owner, name: 'Account B', botEnabled: true },
    ]).returning();
    const apple = snapshot('AAPL'); const microsoft = snapshot('MSFT'); const disabled = snapshot('TSLA');
    const assignment = (strategy: ConfirmedInvestmentStrategy, enabled = true) => ({ strategyId: strategy.id,
      strategyRevision: strategy.revision, allocationPct: 50, enabled, snapshot: strategy });
    const configA = { ...DEFAULT_INVESTMENT_CONFIG, portfolio: [assignment(apple), assignment(microsoft), assignment(disabled, false)] };
    const configB = { ...DEFAULT_INVESTMENT_CONFIG, portfolio: [assignment(apple)] };
    await db.insert(investmentPolicies).values([
      { owner, accountId: a.id, status: 'running', baseConfig: configA, effectiveConfig: configA },
      { owner, accountId: b.id, status: 'running', baseConfig: configB, effectiveConfig: configB },
    ]);
    await db.insert(paperPositions).values([
      { owner, accountId: a.id, ticker: 'AAPL', shares: '10', avgCost: '100' },
      { owner, accountId: a.id, ticker: 'MSFT', shares: '5', avgCost: '100' },
      { owner, accountId: a.id, ticker: 'TSLA', shares: '5', avgCost: '100' },
      { owner, accountId: b.id, ticker: 'AAPL', shares: '20', avgCost: '100' },
    ]);
    const unselected = await service.projection(owner);
    assert.equal(unselected.runtime.selectionRequired, true);
    assert.equal(unselected.runtime.monitoringReason, 'ACCOUNT_SELECTION_REQUIRED');
    assert.equal(unselected.runtime.accountId, null);
    assert.deepEqual(unselected.runtime.current.rules, []);
    assert.deepEqual(unselected.runtime.current.positions, []);
    assert.equal(unselected.runtime.accounts?.length, 2);
    assert.equal((await db.select().from(channel.channelPreferences).where(eq(channel.channelPreferences.owner, owner))).length, 0,
      'GET projection does not create preferences, memories or recover work');
    const selected = await service.projection(owner, a.id);
    assert.equal(calls, 0, 'projection never fetches quotes or starts research');
    assert.equal(selected.runtime.accountName, 'Account A');
    assert.equal(selected.runtime.current.strategyId, null, 'a combination is not one editable strategy');
    assert.equal(selected.runtime.current.rules.length, 2);
    assert.deepEqual(selected.runtime.current.rules.map(r => r.entryId), ['original-entry', 'original-entry']);
    assert.equal(new Set(selected.runtime.current.rules.map(r => r.id)).size, 2);
    assert.ok(selected.runtime.current.rules.every(r => r.accountId === a.id));
    assert.equal((await readChannelRuntime(db, owner, b.id)).current.positions[0].quantity, '20');
    await assert.rejects(readChannelRuntime(db, randomUUID(), a.id), /ACCOUNT_NOT_FOUND/);
    await service.monitorOwner(owner); await service.monitorOwner(owner);
    const episodes = await db.select().from(channel.channelEpisodes).where(eq(channel.channelEpisodes.owner, owner));
    assert.equal(episodes.length, 3, 'two accounts sharing AAPL authority have independent monitor episodes');
    assert.equal(episodes.filter(e => e.data.entityId.startsWith(`account:${a.id}:`)).length, 2);
    assert.equal(episodes.filter(e => e.data.entityId.startsWith(`account:${b.id}:`)).length, 1);
    const selectedA = await service.projection(owner, a.id); const selectedB = await service.projection(owner, b.id);
    assert.ok(selectedA.visibleTaps.every(bubble => bubble.accountId === a.id));
    assert.ok(selectedB.visibleTaps.every(bubble => bubble.accountId === b.id));
    assert.equal((await service.projection(owner)).visibleTaps.length, 0, 'unselected view cannot imply an arbitrary account');

    const [orderA, orderB] = await db.insert(paperOrders).values([
      { owner, accountId: a.id, ticker: 'AAPL', side: 'buy', quantity: '1', status: 'filled', filledPrice: '100', filledAt: new Date() },
      { owner, accountId: b.id, ticker: 'AAPL', side: 'buy', quantity: '2', status: 'filled', filledPrice: '100', filledAt: new Date() },
    ]).returning();
    for (const order of [orderA, orderB]) {
      await db.insert(paperTrades).values({ owner, accountId: order.accountId, orderId: order.id, ticker: 'AAPL', side: 'buy', quantity: order.quantity, price: '100', cashAfter: '1000' });
      await db.insert(strategySignals).values({ id: randomUUID(), owner, profileId: randomUUID(), planId: randomUUID(), ruleId: `${apple.id}:original-entry`, kind: 'entry', state: 'executed', orderId: order.id, reason: 'Fictional fixture',
        candidate: { accountId: order.accountId, userStrategyId: apple.id, userStrategyRevision: 1, userEntryId: 'original-entry' } as never });
    }
    await service.syncExecutions(owner); await service.syncExecutions(owner);
    const fills = (await db.select().from(channel.channelBubbles).where(eq(channel.channelBubbles.owner, owner)))
      .filter(row => row.data.templateId === 'channel.paper.completed');
    assert.equal(fills.length, 2);
    assert.deepEqual(new Set(fills.map(f => f.data.accountId)), new Set([a.id, b.id]));
    assert.equal((await readChannelRuntime(db, owner, a.id)).executions[0].entryId, 'original-entry');
    assert.ok((await service.projection(owner, a.id)).episodes.flatMap(e => e.bubbles).every(bubble => !bubble.accountId || bubble.accountId === a.id));
  });
});
