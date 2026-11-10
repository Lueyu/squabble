import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { investmentFixture } from '../paper-trading/investment-test.fixture';
import { paperAccounts, paperPositions, cashAccounts, holdings } from '../../database/schema';
import { simulationCash } from '../../database/simulation-experiments.schema';
import { channelSupplementRequests, channelDeferredQuestions, channelBubbles } from '../../database/channel.schema';
import { ChannelService } from './channel.service';

test('question receipts, deferred facts and ledger reads retain the selected owned account', async () => {
  await investmentFixture(async (db, _client, owner) => {
    const service = new ChannelService(db, { getQuote: async () => { throw new Error('Ledger questions must never call market data or AI'); } } as never);
    await service.onModuleInit();
    const [a, b, legacy] = await db.insert(paperAccounts).values([
      { owner, name: 'Simulation A', ledgerMode: 'native_currency', cashBalance: '999' },
      { owner, name: 'Simulation B', ledgerMode: 'native_currency', cashBalance: '888' },
      { owner, name: 'Legacy USD', cashBalance: '321' },
    ]).returning();
    await db.insert(cashAccounts).values({ owner, currency: 'USD', balance: '7777', reconciliationStatus: 'confirmed' });
    await db.insert(holdings).values({ owner, ticker: 'AAPL', shares: '77', buyPrice: '100', market: 'US', currency: 'USD' });
    await db.insert(paperPositions).values([
      { owner, accountId: a.id, ticker: 'AAPL', shares: '3', avgCost: '100' },
      { owner, accountId: b.id, ticker: 'AAPL', shares: '9', avgCost: '100' },
    ]);
    await db.insert(simulationCash).values([
      { owner, accountId: a.id, currency: 'USD', available: '100', frozen: '7', unsettled: '8', availabilityKnown: true },
      { owner, accountId: b.id, currency: 'USD', available: '200', availabilityKnown: true },
      { owner, accountId: b.id, currency: 'HKD', available: '500', availabilityKnown: false },
    ]);
    const input = { message: 'USD现金余额是多少？', requestKey: 'account-question-1', accountId: b.id };
    const first = await service.ask(owner, input);
    assert.equal(first.request.accountId, b.id);
    assert.match(first.bubble?.text ?? '', /200/);
    assert.equal(first.bubble?.accountId, b.id);
    assert.match(first.bubble?.evidence.summary ?? '', /Simulation B/);
    assert.equal(first.bubble?.evidence.sources[0].uri, `/paper/${b.id}`);
    await db.update(simulationCash).set({ available: '201' }).where(and(eq(simulationCash.accountId, b.id), eq(simulationCash.currency, 'USD')));
    const retry = await service.ask(owner, input);
    assert.equal(retry.bubble?.id, first.bubble?.id, 'retry returns the same frozen receipt after the ledger changes');
    assert.match(retry.bubble?.text ?? '', /200/);
    await assert.rejects(service.ask(owner, { ...input, accountId: a.id }), /REQUEST_KEY_CONFLICT/);
    await assert.rejects(service.ask(randomUUID(), { ...input, requestKey: 'cross-owner-question' }), /ACCOUNT_NOT_FOUND/);
    await assert.rejects(service.ask(owner, { ...input, accountId: randomUUID(), requestKey: 'missing-account-question' }), /ACCOUNT_NOT_FOUND/);
    assert.equal((await db.select().from(channelSupplementRequests)).length, 1, 'invalid scope creates no question receipt');
    const position = await service.ask(owner, { message: 'AAPL持股数量是多少？', accountId: a.id, requestKey: 'account-position-a' });
    assert.match(position.bubble?.text ?? '', /3/);
    const zero = await service.ask(owner, { message: 'MSFT持股数量是多少？', accountId: a.id, requestKey: 'account-position-zero' });
    assert.match(zero.bubble?.text ?? '', /0/);
    const unknown = await service.ask(owner, { message: 'HKD现金余额是多少？', accountId: b.id, requestKey: 'account-cash-unknown' });
    assert.equal(unknown.request.status, 'not_verified');
    assert.doesNotMatch(unknown.bubble?.text ?? '', /500|7777/);
    const legacyCash = await service.ask(owner, { message: 'USD现金余额是多少？', accountId: legacy.id, requestKey: 'legacy-cash-question' });
    assert.match(legacyCash.bubble?.text ?? '', /321/);
    const realCash = await service.ask(owner, { message: 'USD现金余额是多少？', requestKey: 'real-cash-question' });
    assert.match(realCash.bubble?.text ?? '', /7777/);
    assert.equal(realCash.bubble?.accountId, undefined, 'an explicitly unscoped question preserves real-ledger semantics');

    const scope = await service.ask(owner, { message: 'USD现金余额是多少？AAPL持股数量是多少？', accountId: a.id,
      context: { kind: 'stock', ticker: 'AAPL' }, requestKey: 'deferred-account-a' });
    assert.equal(scope.request.status, 'needs_scope');
    const deferred = (await db.select().from(channelDeferredQuestions)).filter(row => row.requestId === scope.request.id);
    assert.equal(deferred.length, 2);
    assert.ok(deferred.every(row => row.data.accountId === a.id));
    const cashQuestion = deferred.find(row => row.data.text.includes('现金'))!;
    await assert.rejects(service.ask(owner, { message: cashQuestion.data.text, selectedQuestionId: cashQuestion.id,
      accountId: b.id, requestKey: 'deferred-wrong-scope' }), /QUESTION_ACCOUNT_CHANGED/);
    await assert.rejects(service.ask(owner, { message: cashQuestion.data.text, selectedQuestionId: cashQuestion.id,
      context: { kind: 'stock', ticker: 'MSFT' }, requestKey: 'deferred-wrong-context' }), /QUESTION_CONTEXT_CHANGED/);
    const selected = await service.ask(owner, { message: cashQuestion.data.text, selectedQuestionId: cashQuestion.id,
      context: { ticker: 'AAPL', kind: 'stock' }, requestKey: 'deferred-inherit-scope' });
    assert.equal(selected.request.accountId, a.id);
    assert.deepEqual(selected.request.context, { kind: 'stock', ticker: 'AAPL' });
    assert.match(selected.bubble?.text ?? '', /100/);
    assert.match(selected.bubble?.evidence.gaps.join(' ') ?? '', /冻结 7、未结算 8/);
    const bView = await service.projection(owner, b.id);
    assert.ok(bView.deferredQuestions.every(question => question.accountId === b.id));
    assert.ok(bView.episodes.flatMap(episode => episode.bubbles).filter(bubble => bubble.episodeId.startsWith('question:')).every(bubble => bubble.accountId === b.id));
    assert.ok(!bView.userMessages.some(message => message.requestId === scope.request.id || message.requestId === realCash.request.id));
    for (const accountId of [a.id, b.id, undefined]) {
      const id = `pending:${accountId ?? 'owner-report'}`;
      await db.insert(channelBubbles).values({ owner, id, episodeId: id, semanticDeltaId: id,
        data: { ...first.bubble!, id, episodeId: id, layer: 4, accountId } });
    }
    const selectedPending = await service.pending(owner, b.id);
    assert.deepEqual(new Set(selectedPending.items.map(item => item.id)), new Set([`pending:${b.id}`, 'pending:owner-report']));
    assert.equal((await service.pending(owner)).items.length, 3, 'the explicitly owner-wide drawer remains available');
    await assert.rejects(service.pending(randomUUID(), a.id), /ACCOUNT_NOT_FOUND/);
  });
});
