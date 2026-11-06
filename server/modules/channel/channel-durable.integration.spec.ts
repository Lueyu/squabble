import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq } from 'drizzle-orm';
import { ChannelService } from './channel.service';
import type { QuoteService } from '../quote/quote.service';
import * as channel from '../../database/channel.schema';
import { paperAccounts, paperOrders, paperTrades } from '../../database/schema';
import { strategySignals } from '../../database/strategy.schema';
import { investmentPolicies } from '../../database/investment-policy.schema';
import { DEFAULT_INVESTMENT_CONFIG } from '../paper-trading/investment-policy.rules';
import { readChannelRuntime, sumChannelDecimals } from './channel-runtime';
import { ChannelMemoryService } from './channel-memory.service';
import type { ChannelEvidenceCard, ChannelFact, FindingCandidate } from '../../../shared/channel.interface';

const url = process.env.CHANNEL_TEST_DATABASE_URL ?? process.env.STRATEGY_TEST_DATABASE_URL;
test('durable channel publishes once, reseals across compiler versions and preserves one-tool claims', { skip: !url }, async () => {
  const namespace = `channel_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(url!, { max: 1, onnotice: () => {} });
  const client = postgres(url!, { max: 8, onnotice: () => {}, connection: { search_path: namespace } });
  await admin`CREATE SCHEMA ${admin(namespace)}`;
  try {
    for (const file of readdirSync('scripts/db').filter(f => /^\d\d_.*\.sql$/u.test(f) && !f.startsWith('02_')).sort()) await client.unsafe(readFileSync(`scripts/db/${file}`, 'utf8'));
    const db = drizzle(client), owner = randomUUID(), stranger = randomUUID();
    let quoteCalls = 0;
    const quotes = { getQuote: async (symbol: string) => { quoteCalls++; return { symbol, price: '123.45', currency: 'USD', market: 'US', source: 'fixture', quoteAt: new Date().toISOString(), timestamp: Date.now(), delayed: false }; } } as unknown as QuoteService;
    const service = new ChannelService(db, quotes, 'compiler-v1'); await service.onModuleInit();
    const now = new Date().toISOString();
    const fact: ChannelFact = { id: 'fixture-fact', revision: 1, ownerId: owner, key: 'finding.discrepancy', value: 1, observedAt: now, subject: 'verified_fact' };
    const card: ChannelEvidenceCard = { id: 'fixture-card', kind: 'evidence', summary: 'Fictional filing discrepancy', sources: [{ id: 'fictional-source', kind: 'filing', title: 'Fictional filing', uri: 'https://example.com/filing', publishedAt: now, observedAt: now, verification: 'checked' }], asOf: now, gaps: [], supports: [{ factId: fact.id, scope: 'The supplied filing comparison' }] };
    await service.ingestFact(owner, fact, card);
    const finding: FindingCandidate = { id: 'finding-one', ownerId: owner, episodeId: 'episode-one', researchRunId: 'run-one', createdAt: now,
      kind: 'verified_discrepancy', anchor: { kind: 'fact', factId: fact.id, factRevision: 1 }, affectedPremiseIds: ['premise-one'], evidenceCardId: card.id,
      semanticDeltaId: 'semantic-one', template: { templateId: 'channel.finding.discrepancy', templateRevision: 1 }, slots: {}, weight: 'nudge' };
    const first = await service.ingestFinding(owner, finding);
    assert.ok(first, 'a checked background finding is published without a human review queue');
    assert.equal(first.deliveryCause, 'background_finding');
    await Promise.all([1, 2, 3].map(() => service.ingestFinding(owner, finding)));
    assert.equal((await db.select().from(channel.channelBubbles)).length, 1);
    assert.equal((await db.select().from(channel.channelOutbox)).length, 1);
    const upgraded = new ChannelService(db, quotes, 'compiler-v2');
    assert.equal(await upgraded.ingestFinding(owner, finding), null);
    const [storedFinding] = await db.select().from(channel.channelFindings);
    assert.equal(storedFinding.seal?.compilerVersion, 'compiler-v2');
    assert.equal((await db.select().from(channel.channelOutbox)).length, 1, 'a new compiler seal does not create a second outbox event');

    // Both candidate paths are validated after reloading current persisted registry state.
    const [template] = await db.select().from(channel.channelTemplateRegistry).where(eq(channel.channelTemplateRegistry.id, 'channel.finding.discrepancy'));
    await db.update(channel.channelTemplateRegistry).set({ data: { ...template.data, status: 'retired', retiredAt: new Date().toISOString() } }).where(eq(channel.channelTemplateRegistry.id, template.id));
    const retiredFinding = { ...finding, id: 'retired-finding', episodeId: 'retired-episode', semanticDeltaId: 'retired-delta' };
    assert.equal(await service.ingestFinding(owner, retiredFinding), null);
    assert.equal(await service.publishTemplate(owner, { episodeId: retiredFinding.episodeId, entityId: 'run-one', title: 'Fictional Brief', eventKind: 'thesis.changed', semanticDeltaId: retiredFinding.semanticDeltaId,
      facts: [{ fact, card }], templateId: template.id, stance: 'plain_fact', weight: 'nudge', layer: 3, posture: 'standalone', evidence: card }), null);
    assert.equal((await db.select().from(channel.channelOutbox)).length, 1, 'neither path publishes a retired template');

    const question = { message: 'ACME 现价是多少？', requestKey: 'one-tool' };
    await Promise.all([1, 2, 3].map(() => service.ask(owner, question)));
    assert.equal(quoteCalls, 1, 'network retries never dispatch a second tool call');
    const [request] = await db.select().from(channel.channelSupplementRequests).where(eq(channel.channelSupplementRequests.requestKey, 'one-tool'));
    assert.equal(request.data.claimedToolCalls, 1);
    assert.equal(request.data.status, 'answered');
    assert.equal((await service.projection(stranger)).episodes.length, 0);
    await assert.rejects(service.bubble(stranger, first.id), /UNAVAILABLE/);

    await service.ask(owner, { message: 'ACME 现价是多少？现金是多少？', requestKey: 'multi' });
    const deferred = await db.select().from(channel.channelDeferredQuestions).where(eq(channel.channelDeferredQuestions.owner, owner));
    assert.equal(deferred.length, 2);
    assert.equal(quoteCalls, 1, 'unselected questions are durable but never execute');
    const sourceRequest = await db.select().from(channel.channelSupplementRequests).where(and(eq(channel.channelSupplementRequests.owner, owner), eq(channel.channelSupplementRequests.requestKey, 'multi')));
    assert.equal(sourceRequest[0].data.originalQuestions.length, 2);
    const scopeFact = (await db.select().from(channel.channelFacts).where(eq(channel.channelFacts.owner, owner))).find(f => f.data.key === 'supplement.scope.originalQuestionCount')!;
    const choice = await service.publishTemplate(owner, { episodeId: 'explicit-choice', entityId: 'choice', title: '选择一个事实', eventKind: 'user.question', semanticDeltaId: 'choice-delta', facts: [{ fact: scopeFact.data, card: scopeFact.card }], templateId: 'channel.supplement.scope_needed', stance: 'plain_fact', weight: 'nudge', layer: 3, posture: 'standalone', evidence: scopeFact.card, deliveryCause: 'user_reply', action: [{ id: 'choose-first', label: '核查第1项', kind: 'ask_one_fact', targetId: deferred[0].id, expectedRevision: 1 }] });
    assert.ok(choice);
    const choicePayload = { actionId: 'choose-first', bubbleId: choice.id, expectedRevision: 1, requestKey: 'choose-retry' };
    const chosenOnce = await service.action(owner, choicePayload), chosenTwice = await service.action(owner, choicePayload);
    assert.deepEqual(chosenOnce, chosenTwice);
    assert.equal(chosenOnce.questionId, deferred[0].id);
    const compound = await service.ask(owner, { message: '查 FICT 现价和我的现金余额', requestKey: 'compound-intents' }) as { request: { status: string; originalQuestions: Array<{ text: string }> } };
    assert.equal(compound.request.status, 'needs_scope');
    assert.equal(compound.request.originalQuestions.length, 2, 'a conjunction cannot silently discard the second fact intent');
    assert.equal(quoteCalls, 1);
    const memory = new ChannelMemoryService(db);
    const preference = await memory.preference(owner, { sourceMessageId: request.data.userMessageId, requestKey: 'remember-real-message' });
    assert.equal(preference.exactUserQuote, question.message);
    await assert.rejects(db.update(channel.channelMemories).set({ data: { ...preference, content: 'rewritten' } }).where(eq(channel.channelMemories.id, preference.id)), error => String((error as { cause?: unknown }).cause ?? error).includes('CHANNEL_APPEND_ONLY'));
    await assert.rejects(memory.preference(stranger, { sourceMessageId: request.data.userMessageId, requestKey: 'foreign-message' }), /USER_MESSAGE/);
    await service.recordDecisionSnapshot(owner, 'actual-test-decision');
    const reflection = await memory.userReflection(owner, { decisionId: 'actual-test-decision', kind: 'later_reflection', text: '这是本人填写的复盘理由。', requestKey: 'real-reflection' });
    assert.equal(reflection.author, 'user');
    await assert.rejects(memory.userReflection(owner, { decisionId: 'actual-test-decision', kind: 'later_reflection', author: 'system_snapshot', text: '伪造的心理解释', requestKey: 'fake' }), /INVALID_USER_REFLECTION/);
    assert.equal((await memory.list(owner)).decisions.length, 1);
    await assert.rejects(db.delete(channel.channelDecisionReflections).where(eq(channel.channelDecisionReflections.owner, owner)), error => String((error as { cause?: unknown }).cause ?? error).includes('CHANNEL_APPEND_ONLY'));
    await service.ingestReport(owner, { id: 'single-fact-report', revision: 1, title: 'Fictional facts', content: 'ACME 本季度毛利率为 42%。', sections: [{ id: 'financial', content: 'ACME 本季度毛利率为 42%。' }], createdAt: new Date().toISOString() });
    const reportAnswer = await service.ask(owner, { message: '报告里 ACME 毛利率是多少？', requestKey: 'report-fact' }) as { request: { status: string }; bubble: { evidence: ChannelEvidenceCard } };
    assert.equal(reportAnswer.request.status, 'answered');
    assert.match(reportAnswer.bubble.evidence.sources[0].locator ?? '', /42%/);
    const [quoteFact] = (await db.select().from(channel.channelFacts).where(eq(channel.channelFacts.owner, owner))).filter(f => f.data.key === 'supplement.price');
    const correctionFact = { ...quoteFact.data, revision: 2, value: '124.45', sourceId: 'verified-amendment' };
    const correctionCard: ChannelEvidenceCard = { ...quoteFact.card, id: 'verified-amendment-card', summary: 'Fictional provider explicitly corrected the same quote observation', sources: quoteFact.card.sources.map(s => ({ ...s, id: 'verified-amendment', originId: quoteFact.data.sourceId, verification: 'checked' as const })) };
    const corrected = await service.ingestSourceCorrection(owner, { previousFactId: quoteFact.id, previousRevision: 1, fact: correctionFact, card: correctionCard });
    assert.equal(corrected.length, 1);
    assert.equal(corrected[0].stance, 'admit_wrong');
    assert.ok(corrected[0].anchors.priorOwnBubbleId);
    assert.ok(corrected[0].anchors.relationshipMemoryIds?.length);
    await assert.rejects(service.ingestSourceCorrection(owner, { previousFactId: quoteFact.id, previousRevision: 1, fact: { ...correctionFact, revision: 3, observedAt: new Date(Date.now() + 1000).toISOString() }, card: { ...correctionCard, id: 'new-observation-card' } }), /OBSERVATION_MISMATCH/);
    await service.ingestReport(owner, { id: 'old-family-report', revision: 1, title: 'Older fictional source', content: 'Older report', sections: [{ id: 'summary', content: 'Older report' }], source: { documentId: 'logical-report-family' }, createdAt: new Date().toISOString() });
    const oldReportFinding = { ...finding, id: 'old-report-finding', episodeId: 'old-report-episode', semanticDeltaId: 'old-report-delta', weight: 'poke' as const,
      kind: 'critical_counterevidence' as const, template: { templateId: 'channel.finding.refuted', templateRevision: 1 }, anchor: { kind: 'report_section' as const, reportId: 'old-family-report', reportRevision: 1, sectionId: 'summary' } };
    const oldBubble = await service.ingestFinding(owner, oldReportFinding);
    assert.ok(oldBubble);
    await service.ingestReport(owner, { id: 'new-family-report', revision: 1, title: 'New fictional source', content: 'New report', sections: [{ id: 'summary', content: 'New report' }], source: { documentId: 'logical-report-family' }, createdAt: new Date().toISOString() });
    const oldProjection = await service.projection(owner);
    assert.equal(oldProjection.episodes.flatMap(e => e.bubbles).find(b => b.id === oldBubble.id)?.sourceState, 'superseded');
    assert.ok(!oldProjection.notifications.some(n => n.bubbleId === oldBubble.id), 'superseded source cannot deliver an old pending notification');
    assert.equal(await service.ingestFinding(owner, oldReportFinding), null);

    // Changes in wording/report identifiers do not make an old material gap new.
    const gap = { ...finding, id: 'gap-one', episodeId: 'gap-episode', semanticDeltaId: 'gap-delta', kind: 'material_gap' as const, reverseCheckOutcome: 'unable_to_verify' as const,
      template: { templateId: 'channel.finding.gap', templateRevision: 1 } };
    assert.ok(await service.ingestFinding(owner, gap));
    assert.equal(await service.ingestFinding(owner, { ...gap, id: 'gap-two', researchRunId: 'another-report', episodeId: 'another-episode', semanticDeltaId: 'wording-changed-delta' }), null);

    const runtimeOwner = randomUUID();
    const [account] = await db.insert(paperAccounts).values({ owner: runtimeOwner }).returning();
    const [order] = await db.insert(paperOrders).values({ owner: runtimeOwner, accountId: account.id, ticker: 'FICT', side: 'buy', quantity: '100', status: 'pending' }).returning();
    await db.insert(paperTrades).values({ owner: runtimeOwner, accountId: account.id, orderId: order.id, ticker: 'FICT', side: 'buy', quantity: '40', price: '12', cashAfter: '999520' });
    await db.insert(strategySignals).values({ id: randomUUID(), owner: runtimeOwner, profileId: randomUUID(), planId: randomUUID(), ruleId: 'old-rule', kind: 'entry', state: 'executed', orderId: order.id, reason: 'fictional fixture',
      candidate: { accountId: account.id, userStrategyId: randomUUID(), userStrategyRevision: 2 } as never });
    const runtime = await readChannelRuntime(db, runtimeOwner);
    assert.equal(runtime.current.strategyId, null);
    assert.equal(runtime.executions[0].status, 'partially_filled');
    assert.equal(runtime.executions[0].filledQuantity, '40');
    assert.equal(runtime.executions[0].remainingQuantity, '60');
    assert.equal(runtime.executions[0].strategyRevision, 2, 'execution provenance comes from its original signal, not a current strategy');
    const validAt = new Date().toISOString(), future = new Date(Date.now() + 86400000).toISOString();
    const userStrategy = { id: randomUUID(), revision: 7, status: 'confirmed', content: { title: 'Fictional active config', body: 'Fixture', timezone: 'Asia/Shanghai', startsAt: validAt, endsAt: future, entries: [{ id: 'fixture-entry', text: 'Fixture rule', ticker: 'FICT', sourceKeys: [], startsAt: validAt, endsAt: future }] }, sources: [], preview: null, createdAt: validAt, updatedAt: validAt, confirmedAt: validAt, parentId: null };
    const config = { ...DEFAULT_INVESTMENT_CONFIG, userStrategy };
    await db.update(paperAccounts).set({ botEnabled: true }).where(eq(paperAccounts.id, account.id));
    await db.insert(investmentPolicies).values({ owner: runtimeOwner, accountId: account.id, status: 'paused', baseConfig: config as never, effectiveConfig: config as never });
    const paused = await readChannelRuntime(db, runtimeOwner);
    assert.equal(paused.monitoringStatus, 'paused');
    assert.equal(paused.current.rules[0].effective, false);
    assert.equal(paused.current.rules[0].effectiveReason, 'paused');
    assert.equal(paused.executions[0].strategyRevision, 2, 'a current revision 7 does not replace the original execution revision 2');
    const expiredConfig = { ...config, userStrategy: { ...userStrategy, content: { ...userStrategy.content, entries: [{ ...userStrategy.content.entries[0], endsAt: new Date(Date.now() - 1000).toISOString() }] } } };
    await db.update(investmentPolicies).set({ status: 'running', baseConfig: expiredConfig as never, effectiveConfig: expiredConfig as never }).where(eq(investmentPolicies.owner, runtimeOwner));
    const expiredRuntime = await readChannelRuntime(db, runtimeOwner);
    assert.equal(expiredRuntime.monitoringStatus, 'stopped');
    assert.equal(expiredRuntime.current.rules[0].effectiveReason, 'expired');
    assert.equal(expiredRuntime.current.rules[0].effective, false);
    const outboxBeforeFill = (await db.select().from(channel.channelOutbox).where(eq(channel.channelOutbox.owner, runtimeOwner))).length;
    await service.syncExecutions(runtimeOwner); await service.syncExecutions(runtimeOwner);
    assert.equal((await db.select().from(channel.channelBubbles).where(eq(channel.channelBubbles.owner, runtimeOwner))).length, 1, 'actual partial-fill producer is idempotent');
    await db.insert(paperTrades).values({ owner: runtimeOwner, accountId: account.id, orderId: order.id, ticker: 'FICT', side: 'buy', quantity: '60', price: '12', cashAfter: '998800' });
    await db.update(paperOrders).set({ status: 'filled', filledAt: new Date(), filledPrice: '12' }).where(eq(paperOrders.id, order.id));
    await service.syncExecutions(runtimeOwner);
    assert.equal((await db.select().from(channel.channelOutbox).where(eq(channel.channelOutbox.owner, runtimeOwner))).length, outboxBeforeFill + 1, 'completed quiet_win updates audit state without an unsolicited bubble');
    assert.equal(sumChannelDecimals(['0.1', '0.2']), '0.3');
    assert.equal(sumChannelDecimals(['100.00', '-0.01']), '99.99');
    const watchFact: ChannelFact = { id: 'watch-distance', revision: 1, ownerId: runtimeOwner, key: 'monitor.distance', value: '1', observedAt: new Date().toISOString(), subject: 'verified_fact' };
    const watchCard: ChannelEvidenceCard = { ...card, id: 'watch-card', summary: 'FICT fictional watch distance', asOf: watchFact.observedAt, supports: [{ factId: watchFact.id, scope: 'Fictional confirmed watch distance' }] };
    const reminder = await service.publishTemplate(runtimeOwner, { episodeId: 'watch-episode', entityId: 'FICT', title: 'FICT保护线观察', eventKind: 'monitor.near', semanticDeltaId: 'watch-delta', facts: [{ fact: watchFact, card: watchCard }], templateId: 'channel.monitor.near', stance: 'watchful', weight: 'tap', layer: 2, posture: 'alarm', evidence: watchCard });
    assert.ok(reminder);
    const recall = await service.ask(runtimeOwner, { message: '你上次怎么提醒保护线的？', requestKey: 'recall-real-reminder' }) as { bubble: { stance: string; anchors: { priorOwnBubbleId?: string } } };
    assert.equal(recall.bubble.stance, 'I_told_you');
    assert.equal(recall.bubble.anchors.priorOwnBubbleId, reminder.id);
    const unrelatedRecall = await service.ask(runtimeOwner, { message: '你之前对 F 怎么提醒的？', context:{ticker:'F'}, requestKey:'recall-short-symbol-must-not-match-fict' }) as { bubble:{stance:string} };
    assert.equal(unrelatedRecall.bubble.stance,'unsure_honest','a short ticker must not match another symbol or prose');
    const callsBeforeRecovery = quoteCalls;
    await db.insert(channel.channelSupplementRequests).values({ id: 'interrupted-request', owner, requestKey: 'interrupted-request', inputHash: 'fixture', message: 'ACME 现价是多少', leaseUntil: new Date(Date.now() - 1000), data: { ...request.data, id: 'interrupted-request', userMessageId: randomUUID(), requestKey: 'interrupted-request', status: 'running', claimedToolCalls: 1 }, result: null });
    await service.onModuleInit();
    assert.equal(quoteCalls, callsBeforeRecovery, 'restart recovery does not replay the previously claimed tool');
    const [interrupted] = await db.select().from(channel.channelSupplementRequests).where(eq(channel.channelSupplementRequests.id, 'interrupted-request'));
    assert.equal(interrupted.data.status, 'not_verified');
    assert.ok((await service.projection(owner)).episodes.some(e => e.bubbles.some(b => b.episodeId === 'question:interrupted-request')));
  } finally {
    await client.end();
    await admin`DROP SCHEMA ${admin(namespace)} CASCADE`;
    await admin.end();
  }
});
