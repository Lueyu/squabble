import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { investmentFixture, startPreUserStrategyInvestmentFixture, restorePreUserStrategyRunningPolicyFixture } from './investment-test.fixture';
import { InvestmentPolicyService } from './investment-policy.service';
import { investmentExecutionFence } from './investment-policy.fence';
import { SimulationExperimentsService } from './simulation-experiments.service';
import { simulationMarketFixture } from './simulation-market.fixture';
import { holdings, cashAccounts, builderProfiles, paperAccounts } from '../../database/schema';
import { investmentCycles } from '../../database/investment-policy.schema';
import { ResearchDocumentsService } from '../research-documents/research-documents.service';
import { lockMemoryOwner } from '../research-memory/research-memory.fence';
import { normalizeBuilderConfig } from './agent-builder.rules';
import { AutonomousPlanCompiler, compileAutonomousRules } from './autonomous-plan.compiler';

test('copied opening security can use one verified source; a novel ticker cannot spoof that exemption', async t => {
  await investmentFixture(async (db, _client, owner) => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-06T15:00:00Z') });
    await db.insert(holdings).values({ owner, ticker: 'ABC', shares: '10', buyPrice: '100', currentPrice: '100' });
    await db.insert(cashAccounts).values({ owner, currency: 'USD', balance: '10000' });
    const market = { getSnapshot: async () => simulationMarketFixture({ price: '100', market: 'US', currency: 'USD', timestamp: Date.now() }, true) };
    const policies = new InvestmentPolicyService(db, new SimulationExperimentsService(db, {} as never, {} as never, undefined, market as never));
    const preview = await policies.preview(owner, { origin: 'holdings', requestKey: 'copied-preview' });
    const start = await startPreUserStrategyInvestmentFixture(policies, db, owner, { previewId: preview.id, requestKey: 'copied-start', cashAvailable: { USD: 10000 }, sellableShares: { ABC: 10 } });
    const config = normalizeBuilderConfig({ name: 'Fixture single-source research', template: 'balanced', tickers: [], minimumRating: 'Buy', customPrompt: '', maxOrderPct: 5, dailyLossLimitPct: 3, maxOrdersPerDay: 10, notifyOnProposal: false });
    const [profile] = await db.insert(builderProfiles).values({ owner, config }).returning();
    const docs = new ResearchDocumentsService(db);
    const doc = await docs.submit(owner, { idempotencyKey: 'copied-evidence', title: 'Fictional research', kind: 'deep', ticker: 'ABC', content: 'Fictional sourced input', sections: [{ id: 'facts', title: 'Facts', content: 'Fictional input' }], dataAsOf: new Date().toISOString(), availableAt: new Date().toISOString() });
    const [cycle] = await db.select().from(investmentCycles); const token = randomUUID();
    await db.update(investmentCycles).set({ state: 'researching', leaseToken: token, leaseUntil: new Date(Date.now()+5*60000) }).where(eq(investmentCycles.id, cycle.id));
    const security = { ticker: 'ABC', market: 'US' as const, currency: 'USD' as const, assetType: 'stock' as const, sourceUrl: 'https://www.sec.gov/fixture', identitySourceUrl: 'https://www.nasdaq.com/fixture', summary: 'Fictional equity', observedAt: new Date().toISOString(), providerSymbol: 'ABC', lotSize: 1, leveraged: false as const, inverse: false as const };
    const rule = { id: 'entry', ticker: 'ABC', side: 'buy', trigger: { kind: 'price_below', value: 100 }, referencePrice: 100, minPrice: 95, maxPrice: 105, stopLossPrice: 90, maxPositionPct: 10, expiresAt: '2026-11-06T21:00:00Z', evidenceIds: [doc.id], rationale: 'Sourced input' };
    const rules = compileAutonomousRules({ config: start.policy.effectiveConfig, security, reviews: [{ memberId: 'one', executorIdentity: 'actual:provider:model', executorVerified: true, completedAt: new Date().toISOString(), conclusion: 'approve', unresolvedDisagreements: [], evidenceIds: [doc.id], rules: [rule], summary: 'Verified' }], isNew: false, marketDate: '2026-11-06', validUntil: rule.expiresAt, cycleId: cycle.id, evidenceIds: [doc.id] });
    const forgedExemption = { ...rules[0], id: 'new_entry', ticker: 'NOVEL', security: { ...security, ticker: 'NOVEL', providerSymbol: 'NOVEL' }, requiresIndependentReview: false };
    const mandate = await new AutonomousPlanCompiler(db, docs).activate(owner, cycle.id, token, profile.id, [...rules, forgedExemption]);
    const evaluate = (ticker: string, ruleId: string) => db.transaction(async tx => {
      await lockMemoryOwner(tx, owner); await tx.select().from(paperAccounts).where(eq(paperAccounts.id, start.accountId)).for('update');
      return investmentExecutionFence(tx, owner, start.accountId, { ticker, market: 'US', side: 'buy' }, 'agent', { parentPolicyId: start.policy.id, parentPolicyRevision: 1, mandateId: mandate!.id, ruleId } as never);
    });
    assert.equal((await evaluate('ABC', rules[0].id)).block, null);
    assert.equal((await evaluate('NOVEL', 'new_entry')).block, 'INVESTMENT_INDEPENDENT_REVIEW_REQUIRED');
  });
});
