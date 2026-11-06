import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { investmentFixture } from './investment-test.fixture';
import { InvestmentPolicyService } from './investment-policy.service';
import { SimulationExperimentsService } from './simulation-experiments.service';
import { UserInvestmentStrategyService } from './user-investment-strategy.service';
import { ResearchDocumentsService } from '../research-documents/research-documents.service';
import { CouncilService } from '../council/council.service';
import { AgentBuilderService } from './agent-builder.service';
import { strategyMandates, strategyRouteReviews } from '../../database/strategy-mandates.schema';
import { councilIndependentSubmissions } from '../../database/simple-council.schema';
import { investmentExecutionFence } from './investment-policy.fence';
import { AutonomousPlanCompiler } from './autonomous-plan.compiler';
import { investmentCycles } from '../../database/investment-policy.schema';

test('new-stock review counts actual blind successful submissions, never selected roles or model aliases; autonomous output cannot replace intent', async () => {
  await investmentFixture(async (db, client, owner) => {
    await client.unsafe(readFileSync('scripts/db/39_user_investment_strategies.sql', 'utf8'));
    const docs = new ResearchDocumentsService(db); const drafts = new UserInvestmentStrategyService(db, docs, {} as never);
    const members = [{ id: 'one', name: 'One', role: 'researcher', model: 'fast', instructions: '', connectionId: randomUUID() }, { id: 'two', name: 'Two', role: 'manager', model: 'fast', instructions: '', connectionId: randomUUID() }];
    const service = new InvestmentPolicyService(db, new SimulationExperimentsService(db, {} as never, {} as never), drafts, { resolveMembers: async () => ({ members, executors: [] }) } as never);
    const preview = await service.preview(owner, { origin: 'cash', cash: { amount: 10000, currency: 'USD' }, requestKey: 'review-cash-preview' });
    const account = await service.start(owner, { previewId: preview.id, requestKey: 'review-cash-create' });
    const now = new Date(); const text = 'Buy 1 AAPL below 100';
    const draft = await drafts.create(owner, { title: 'My first stock', body: text, timezone: 'Asia/Shanghai', startsAt: now.toISOString(), endsAt: new Date(now.getTime() + 86400000).toISOString(),
      limits: { maxPositionPct: 10, maxDailyIncreasePct: 5, maxDailyTurnoverPct: 20, minCashPct: 10, maxGrossExposurePct: 90, maxOrderPct: 5 },
      entries: [{ id: 'first-buy', text, sourceKeys: [], directive: { ticker: 'AAPL', side: 'buy', trigger: { kind: 'price_lte', price: 100 }, quantity: 1, reviewedText: text, numericEvidence: [{ field: 'quantity', value: 1, quote: text }, { field: 'trigger.price', value: 100, quote: text }] } }] });
    const ready = await drafts.preview(owner, draft.id, draft.revision);
    const applied = await service.applyStrategy(owner, { strategyId: draft.id, expectedRevision: draft.revision, previewHash: ready.preview!.contentHash, expectedCurrentId: null, requestKey: 'review-apply-current' });
    const [mandate] = await db.select().from(strategyMandates);
    const security = { ticker: 'AAPL', market: 'US', currency: 'USD', assetType: 'stock', identitySourceUrl: 'https://example.invalid/identity', sourceUrl: 'https://example.invalid/price', observedAt: now.toISOString(), summary: 'Offline fixture identity', providerSymbol: 'AAPL', lotSize: 1, leveraged: false, inverse: false };
    await db.update(strategyMandates).set({ config: { ...mandate.config, rules: mandate.config.rules.map(rule => ({ ...rule, security })) } as never }).where(eq(strategyMandates.id, mandate.id));
    let executionMode: 'same' | 'mixed' | 'distinct' = 'same'; const initialPrompts: string[] = [];
    const llm = { isConfigured: async () => true, validateConnectionIds: async () => undefined,
      chatFastJSON: async (messages: Array<{ content: string }>, _owner: string, options: { connectionId?: string; purpose: string; onExecuted?: (metadata: unknown) => void }) => {
        const input = JSON.parse(messages[1].content);
        if (options.purpose.includes(':opening:')) { initialPrompts.push(JSON.stringify(input)); assert.ok(!JSON.stringify(input).includes('PRIVATE_FIRST_CONCLUSION')); }
        const unknownModel = executionMode === 'mixed' && options.purpose.endsWith(':two');
        options.onExecuted?.({ provider: 'https://fixture.invalid', model: executionMode === 'distinct' ? options.connectionId : unknownModel ? 'unreported' : 'same-actual-model', identityVerified: !unknownModel });
        return { data: { content: options.purpose.endsWith(':one') ? 'PRIVATE_FIRST_CONCLUSION' : 'Public reviewed conclusion', evidenceIds: input.evidence.map((item: { id: string }) => item.id), researchStance: 'balanced', decision: 'approve', dissent: [], nextReviewCondition: 'Refresh the facts before a different action' }, tokens: 1 };
      } };
    const council = new CouncilService(db, llm as never, { collectEvidence: async () => ['price', 'financial'].map(evidenceType => ({ title: 'Fictional sourced fact', content: 'Measured fictional evidence', evidenceType, role: 'fundamental', sourceName: 'Offline fixture', sourceUrl: 'https://example.invalid/fact', relevanceScore: 1 })) } as never,
      { getPortfolioContext: async () => ({ totalValue: 10000, cash: 10000, holdings: [] }) } as never, { listRuns: async () => ({ items: [] }) } as never);
    const builder = new AgentBuilderService(db, {} as never); const profile = await builder.getActiveProfile(owner);
    const input = { ticker: 'AAPL', side: 'buy' as const, quantity: 1, price: 99, reason: 'Exact confirmed entry' };
    const candidate = { ...input, accountId: account.accountId, signalId: randomUUID(), mandateId: mandate.id, mandateVersion: mandate.version, ruleId: 'first-buy', parentPolicyId: applied.policy.id, parentPolicyRevision: applied.policy.revision, userStrategyId: draft.id, userStrategyRevision: draft.revision };
    const check = () => db.transaction(tx => investmentExecutionFence(tx, owner, account.accountId, { ticker: 'AAPL', market: 'US', side: 'buy' }, 'agent', candidate as never));
    assert.equal((await check()).block, 'INVESTMENT_INDEPENDENT_REVIEW_REQUIRED');
    const reviewed = await council.reviewCandidate(owner, profile!, input, { subject: 'first-review', requireDeliberation: true, requireIndependentReview: true });
    assert.equal(reviewed.approved, true, reviewed.reason);
    await db.insert(strategyRouteReviews).values({ owner, accountId: account.accountId, signalId: candidate.signalId, mandateId: mandate.id, councilSessionId: reviewed.sessionId, councilReportId: reviewed.reportId, decision: { route: 'council', reason: 'Independent first-buy review', postTradeExposurePct: 1, accumulatedIncreasePct: 1 } });
    assert.equal((await check()).block, 'INVESTMENT_INDEPENDENT_REVIEW_REQUIRED', 'two selected aliases returning the same actual model count as one');
    executionMode = 'mixed';
    const mixed = await council.reviewCandidate(owner, profile!, input, { subject: 'mixed-known-unknown-review', requireDeliberation: true, requireIndependentReview: true });
    assert.equal(mixed.approved, true, mixed.reason);
    await db.update(strategyRouteReviews).set({ councilSessionId: mixed.sessionId, councilReportId: mixed.reportId }).where(eq(strategyRouteReviews.signalId, candidate.signalId));
    assert.equal((await check()).block, 'INVESTMENT_INDEPENDENT_REVIEW_REQUIRED', 'a known and an unknown model at one endpoint cannot count as two verified reviewers');
    executionMode = 'distinct';
    const independent = await council.reviewCandidate(owner, profile!, input, { subject: 'second-distinct-review', requireDeliberation: true, requireIndependentReview: true });
    assert.equal(independent.approved, true, independent.reason);
    await db.update(strategyRouteReviews).set({ councilSessionId: independent.sessionId, councilReportId: independent.reportId }).where(eq(strategyRouteReviews.signalId, candidate.signalId));
    assert.equal((await check()).block, null);
    assert.equal(initialPrompts.length, 6);
    assert.equal((await db.select().from(councilIndependentSubmissions)).length, 6);
    const [cycle] = await db.insert(investmentCycles).values({ owner, policyId: applied.policy.id, accountId: account.accountId, policyRevision: applied.policy.revision, market: 'US', marketDate: '2026-11-06', trigger: 'fixture-late-result', eventKey: 'immutable-user-rule' }).returning();
    await assert.rejects(new AutonomousPlanCompiler(db, docs).activate(owner, cycle.id, randomUUID(), profile!.id, []), /USER_STRATEGY_CANNOT_BE_REPLACED/);
    assert.equal((await db.select().from(strategyMandates)).filter(item => item.status === 'published').length, 1);
  });
});
