import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { investmentFixture } from './investment-test.fixture';
import { InvestmentPolicyService } from './investment-policy.service';
import { SimulationExperimentsService } from './simulation-experiments.service';
import { UserInvestmentStrategyService } from './user-investment-strategy.service';
import { ResearchDocumentsService } from '../research-documents/research-documents.service';
import { CouncilService } from '../council/council.service';
import { newCheckpoint } from '../council/council.dialogue';
import { normalizeBuilderConfig } from './agent-builder.rules';
import { investmentExecutionFence } from './investment-policy.fence';
import { lockMemoryOwner } from '../research-memory/research-memory.fence';
import { councilMessages, councilReports, councilSessions } from '../../database/council.schema';
import { councilIndependentSubmissions } from '../../database/simple-council.schema';
import { paperAccounts } from '../../database/schema';
import { strategyMandates, strategyRouteReviews } from '../../database/strategy-mandates.schema';
import type { StrategyCandidate } from '../../../shared/strategy.interface';

/** All providers are absent: the fixture exercises saved authority and the real final transaction only. */
for (const sourceKind of ['message', 'review'] as const) {
  test(`deleted ${sourceKind} session cannot authorize the same previously valid execution candidate`, async () => {
    await investmentFixture(async (db, _client, owner) => {
      const docs = new ResearchDocumentsService(db);
      const drafts = new UserInvestmentStrategyService(db, docs, {} as never);
      const policies = new InvestmentPolicyService(db, new SimulationExperimentsService(db, {} as never, {} as never), drafts);
      const preview = await policies.preview(owner, { origin: 'cash', cash: { amount: 10000, currency: 'USD' }, requestKey: 'fictional-cash-preview' });
      const account = await policies.start(owner, { previewId: preview.id, requestKey: 'fictional-cash-create' });
      const config = normalizeBuilderConfig({ name: 'Fictional source', template: 'guard', tickers: ['FICT'], minimumRating: 'Buy',
        customPrompt: '', maxOrderPct: 5, dailyLossLimitPct: 3, maxOrdersPerDay: 1, notifyOnProposal: false, priceRules: [], language: 'en' });
      const checkpoint = newCheckpoint([], { independent: true });
      const [session] = await db.insert(councilSessions).values({ owner, ticker: 'FICT', title: 'Offline fictional research',
        status: 'completed', profileVersion: 1, profileSnapshot: config, checkpoint }).returning();
      const now = new Date();
      const side = sourceKind === 'message' ? 'sell' : 'buy';
      const text = `${side === 'sell' ? 'Sell' : 'Buy'} 1 FICT at or below 100`;
      const [message] = await db.insert(councilMessages).values({ owner, sessionId: session.id, role: 'researcher',
        memberName: 'Fictional researcher', revision: session.revision, content: text }).returning();
      let draft = sourceKind === 'message'
        ? await drafts.importSource(owner, { kind: 'message', messageId: message.id })
        : await drafts.create(owner, { title: 'Fictional draft', body: '', timezone: 'Asia/Shanghai',
          startsAt: now.toISOString(), endsAt: new Date(now.getTime() + 86400000).toISOString(), entries: [] });
      draft = await drafts.update(owner, draft.id, draft.revision, {
        title: 'Explicit fictional instruction', body: text, timezone: 'Asia/Shanghai', startsAt: now.toISOString(),
        endsAt: new Date(now.getTime() + 86400000).toISOString(),
        limits: { maxPositionPct: 10, maxDailyIncreasePct: 5, maxDailyTurnoverPct: 20, minCashPct: 10, maxGrossExposurePct: 90, maxOrderPct: 5 },
        entries: [{ id: 'fictional-entry', text, sourceKeys: draft.sources.map(source => source.key),
          directive: { ticker: 'FICT', side, trigger: { kind: 'price_lte', price: 100 }, quantity: 1, reviewedText: text,
            numericEvidence: [{ field: 'quantity', value: 1, quote: text }, { field: 'trigger.price', value: 100, quote: text }] } }],
      });
      const ready = await drafts.preview(owner, draft.id, draft.revision);
      const applied = await policies.applyStrategy(owner, { strategyId: draft.id, expectedRevision: draft.revision,
        previewHash: ready.preview!.contentHash, expectedCurrentId: null, requestKey: 'fictional-apply' });
      const [mandate] = await db.select().from(strategyMandates);
      const security = { ticker: 'FICT', market: 'US' as const, currency: 'USD' as const, assetType: 'stock' as const,
        identitySourceUrl: 'https://example.invalid/identity', sourceUrl: 'https://example.invalid/price', observedAt: now.toISOString(),
        summary: 'Offline fictional identity', providerSymbol: 'FICT', lotSize: 1, leveraged: false, inverse: false };
      await db.update(strategyMandates).set({ config: { ...mandate.config,
        rules: mandate.config.rules.map(rule => ({ ...rule, security })) } }).where(eq(strategyMandates.id, mandate.id));
      const candidate = { ticker: 'FICT', market: 'US', side, quantity: 1, price: 99, quoteAt: now.toISOString(),
        accountId: account.accountId, signalId: randomUUID(), mandateId: mandate.id, mandateVersion: mandate.version,
        ruleId: mandate.config.rules[0].id, userEntryId: 'fictional-entry', parentPolicyId: applied.policy.id,
        parentPolicyRevision: applied.policy.revision, userStrategyId: draft.id, userStrategyRevision: draft.revision } as StrategyCandidate;
      if (sourceKind === 'review') {
        const [report] = await db.insert(councilReports).values({ owner, sessionId: session.id, version: 1, revision: session.revision,
          decision: 'approve', summary: 'Fictional independent review', dissent: [], nextReviewCondition: 'Check new facts',
          evidence: [], tokensUsed: 0, engine: 'llm', publicationOutcome: 'succeeded' }).returning();
        for (const memberId of ['fictional-one', 'fictional-two']) {
          await db.insert(councilIndependentSubmissions).values({ owner, sessionId: session.id, cycleId: checkpoint.cycleId, memberId,
            executorIdentity: { identity: memberId, connection: 'offline-fixture', provider: 'offline-fixture', model: memberId, memberId, identityVerified: true },
            contribution: { content: 'Fictional accepted opinion', evidenceIds: [], researchStance: 'balanced' }, evidence: [],
            tokensUsed: 0, releasedAt: now });
        }
        await db.insert(strategyRouteReviews).values({ owner, accountId: account.accountId, signalId: candidate.signalId,
          mandateId: mandate.id, councilSessionId: session.id, councilReportId: report.id,
          decision: { route: 'council', reason: 'Offline independent review', postTradeExposurePct: 1, accumulatedIncreasePct: 1 } });
      }
      const check = () => db.transaction(async tx => {
        await lockMemoryOwner(tx, owner);
        await tx.select().from(paperAccounts).where(eq(paperAccounts.id, account.accountId)).for('update');
        return investmentExecutionFence(tx, owner, account.accountId, { ticker: 'FICT', market: 'US', side }, 'agent', candidate, now);
      });
      assert.equal((await check()).block, null, 'the fixture must pass every other final authorization check before deletion');
      const council = new CouncilService(db, {} as never, {} as never, {} as never, {} as never);
      await council.deleteSession(owner, session.id, { expectedRevision: session.revision, requestKey: randomUUID() });
      assert.equal((await db.select().from(councilMessages).where(eq(councilMessages.id, message.id)))[0].content, text,
        'the content hash remains identical; deletion itself must revoke the authority');
      assert.equal((await check()).block, sourceKind === 'message' ? 'USER_STRATEGY_SOURCE_CHANGED' : 'INVESTMENT_INDEPENDENT_REVIEW_REQUIRED');
      if (sourceKind === 'review') assert.equal((await db.select().from(councilIndependentSubmissions)).length, 2,
        'retained historical reviewer receipts must not authorize another order');
    });
  });
}
