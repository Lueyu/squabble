import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { investmentFixture } from './investment-test.fixture';
import { InvestmentPolicyService } from './investment-policy.service';
import { investmentExecutionFence } from './investment-policy.fence';
import { SimulationExperimentsService } from './simulation-experiments.service';
import { AgentBuilderService } from './agent-builder.service';
import { PaperTradingService } from './paper-trading.service';
import { StrategyMandateService } from './strategy-mandate.service';
import { McpService } from '../mcp/mcp.service';
import { ResearchDocumentsService } from '../research-documents/research-documents.service';
import { builderProfiles, paperAccounts, paperEvents, paperOrders, paperPositions, paperSnapshots, paperTrades } from '../../database/schema';
import { investmentCycles, investmentPolicies } from '../../database/investment-policy.schema';
import { experiencePreferences } from '../../database/simple-experience.schema';
import { simulationCash } from '../../database/simulation-experiments.schema';
import { strategyMandates, strategyReservations } from '../../database/strategy-mandates.schema';
import { strategyPlans, strategySignals, strategyTasks } from '../../database/strategy.schema';
import { normalizeBuilderConfig } from './agent-builder.rules';
import { DEFAULT_ROUTE_POLICY } from './strategy-route.rules';
import { simulationMarketFixture } from './simulation-market.fixture';
import { lockMemoryOwner } from '../research-memory/research-memory.fence';
import type { StrategyMandateInput } from '../../../shared/strategy-mandate.interface';
import type { StrategyCandidate } from '../../../shared/strategy.interface';

type Db = Parameters<Parameters<typeof investmentFixture>[0]>[0];

function services(db: Db) {
  const quotes = { getQuote: async () => ({ price: '100', market: 'US', currency: 'USD', timestamp: Date.now() }) };
  const fx = { convert: async (amount: number) => amount };
  const market = { getSnapshot: async () => simulationMarketFixture(await quotes.getQuote(), true) };
  const simulations = new SimulationExperimentsService(db, quotes as never, fx as never, undefined, market as never);
  const policies = new InvestmentPolicyService(db, simulations);
  const builder = new AgentBuilderService(db, {} as never);
  const paper = new PaperTradingService(db, quotes as never, fx as never, { notifyUser: async () => undefined } as never,
    builder, {} as never, {} as never, market as never);
  const documents = new ResearchDocumentsService(db);
  const mandates = new StrategyMandateService(db, documents, builder, {} as never, market as never);
  return { simulations, policies, builder, paper, documents, mandates };
}

async function legacyAccount(db: Db, owner: string, active = true, name = 'Legacy fictional account') {
  const [account] = await db.insert(paperAccounts).values({ owner, name, isActive: active, botEnabled: active,
    initialCash: '10000', cashBalance: '9000', ledgerMode: 'native_currency' }).returning();
  const [order] = await db.insert(paperOrders).values({ owner, accountId: account.id, ticker: 'ABC', side: 'buy',
    quantity: '10', status: 'filled', source: 'agent', filledPrice: '100', filledAt: new Date() }).returning();
  await db.insert(paperTrades).values({ owner, accountId: account.id, orderId: order.id, ticker: 'ABC', side: 'buy',
    quantity: '10', price: '100', cashAfter: '9000' });
  await db.insert(paperPositions).values({ owner, accountId: account.id, ticker: 'ABC', shares: '10', avgCost: '100' });
  await db.insert(simulationCash).values({ owner, accountId: account.id, currency: 'USD', available: '9000', availabilityKnown: true });
  await db.insert(paperEvents).values({ owner, accountId: account.id, eventType: 'fixture_history', detail: { preserved: true } });
  await db.insert(paperSnapshots).values({ owner, accountId: account.id, snapshotDate: new Date().toISOString().slice(0, 10),
    equity: '10000', benchmarkEquity: '10000', cash: '9000', positionsValue: '1000', dailyPl: '0' });
  return { account, order };
}

async function legacyAutomation(db: Db, owner: string, accountId: string, filledOrderId?: string, sourceVersionId = randomUUID()) {
  const config = normalizeBuilderConfig({ name: 'Legacy fixture', template: 'balanced', tickers: ['ABC'], minimumRating: 'Buy',
    customPrompt: '', maxOrderPct: 5, dailyLossLimitPct: 3, maxOrdersPerDay: 10, notifyOnProposal: false });
  const [profile] = await db.insert(builderProfiles).values({ owner, config, status: 'active' }).returning();
  const until = new Date(Date.now() + 3600_000);
  const rule = { id: 'legacy-buy', ticker: 'ABC', side: 'buy' as const, trigger: { kind: 'price_below' as const, value: 110 },
    referencePrice: 100, minPrice: 90, maxPrice: 110, maxPositionPct: 10, stopLossPrice: 80, expiresAt: until.toISOString(),
    evidenceIds: [sourceVersionId], rationale: 'Fictional historical evidence' };
  const mandateConfig: StrategyMandateInput = { title: 'Historical authorization', objective: 'Original decision at the time',
    period: 'day', timezone: 'UTC', startsAt: new Date().toISOString(), endsAt: until.toISOString(), accountId, profileId: profile.id,
    references: [{ versionId: sourceVersionId, excerpt: 'Frozen original reference' }], rules: [rule],
    limits: { maxPositionPct: 10, maxDailyIncreasePct: 5, maxDailyTurnoverPct: 20 }, routePolicy: DEFAULT_ROUTE_POLICY, dailyPlanMode: 'fixed_rules' };
  const [mandate] = await db.insert(strategyMandates).values({ owner, accountId, profileId: profile.id, profileVersion: 1,
    config: mandateConfig, status: 'published', publishedAt: new Date() }).returning();
  const [task] = await db.insert(strategyTasks).values({ owner, profileId: profile.id, profileVersion: 1, market: 'US',
    marketDate: new Date().toISOString().slice(0, 10) }).returning();
  const [plan] = await db.insert(strategyPlans).values({ owner, accountId, mandateId: mandate.id, mandateVersion: 1,
    profileId: profile.id, profileVersion: 1, taskId: task.id, version: 1, market: 'US', marketDate: task.marketDate,
    rules: [rule], sessionIds: [], reportIds: [sourceVersionId], summary: 'Frozen old plan', expiresAt: until }).returning();
  const signalId = randomUUID();
  const candidate: StrategyCandidate = { accountId, mandateId: mandate.id, mandateVersion: 1, signalId, planId: plan.id,
    planVersion: 1, ruleId: rule.id, ticker: 'ABC', market: 'US', side: 'buy', quantity: 1, price: 100,
    quoteAt: new Date().toISOString(), protectiveStop: false, reason: 'Legacy candidate awaiting approval' };
  await db.insert(strategySignals).values({ id: signalId, owner, profileId: profile.id, planId: plan.id, ruleId: rule.id,
    kind: 'entry', state: 'approved', candidate, reason: candidate.reason });
  await db.insert(strategyReservations).values({ owner, signalId, accountId, ticker: 'ABC', side: 'buy', currency: 'USD',
    cash: '100', shares: '0', expiresAt: until });
  const [pending] = await db.insert(paperOrders).values({ owner, accountId, ticker: 'ABC', side: 'buy', quantity: '1',
    status: 'pending_approval', source: 'agent', reason: candidate.reason }).returning();
  if (filledOrderId) await db.insert(strategySignals).values({ id: randomUUID(), owner, profileId: profile.id, planId: plan.id,
    ruleId: 'original-filled-rule', kind: 'entry', state: 'filled', candidate: { ...candidate, ruleId: 'original-filled-rule' },
    reason: 'Historical filled decision', orderId: filledOrderId });
  return { profile, mandate, plan, signalId, candidate, pending };
}

async function ledger(db: Db, accountId: string) {
  return {
    trades: await db.select().from(paperTrades).where(eq(paperTrades.accountId, accountId)),
    positions: await db.select().from(paperPositions).where(eq(paperPositions.accountId, accountId)),
    cash: await db.select().from(simulationCash).where(eq(simulationCash.accountId, accountId)),
    events: await db.select().from(paperEvents).where(eq(paperEvents.accountId, accountId)),
    snapshots: await db.select().from(paperSnapshots).where(eq(paperSnapshots.accountId, accountId)),
    filledOrders: await db.select().from(paperOrders).where(and(eq(paperOrders.accountId, accountId), eq(paperOrders.status, 'filled'))),
  };
}

async function cashPreview(policies: InvestmentPolicyService, owner: string, requestKey: string) {
  return policies.preview(owner, { origin: 'cash', cash: { amount: 10000, currency: 'USD' }, requestKey });
}

test('opening the new overview and preview exposes running legacy automation without changing it', async () => {
  await investmentFixture(async (db, _client, owner) => {
    const { account } = await legacyAccount(db, owner);
    const old = await legacyAutomation(db, owner, account.id);
    const { policies } = services(db);
    const before = { account: (await db.select().from(paperAccounts))[0], ledger: await ledger(db, account.id),
      profile: old.profile, mandate: old.mandate, signals: await db.select().from(strategySignals),
      reservations: await db.select().from(strategyReservations), orders: await db.select().from(paperOrders) };
    const overview = await policies.overview(owner);
    assert.equal(overview.status, 'needs_confirmation');
    assert.deepEqual(overview.needsInput, ['CONFIRM_LEGACY_ADOPTION']);
    assert.deepEqual(overview.legacyAccounts, [{ id: account.id, name: account.name, active: true, botEnabled: true }]);
    const preview = await cashPreview(policies, owner, 'inert-legacy-preview');
    await policies.overview(owner);
    await assert.rejects(policies.start(owner, { previewId: preview.id, requestKey: 'unconfirmed-legacy-start' }), /CONFIRM_LEGACY_ADOPTION/);
    assert.deepEqual({ account: (await db.select().from(paperAccounts))[0], ledger: await ledger(db, account.id),
      profile: (await db.select().from(builderProfiles))[0], mandate: (await db.select().from(strategyMandates))[0],
      signals: await db.select().from(strategySignals), reservations: await db.select().from(strategyReservations),
      orders: await db.select().from(paperOrders) }, before);
    assert.deepEqual(await db.select().from(investmentPolicies), []);
    assert.deepEqual(await db.select().from(investmentCycles), []);
  });
});

test('explicit legacy adoption cancels old automation and reservations while retaining the original book', async () => {
  await investmentFixture(async (db, _client, owner) => {
    const { account, order } = await legacyAccount(db, owner);
    const old = await legacyAutomation(db, owner, account.id, order.id);
    const { policies } = services(db);
    const before = await ledger(db, account.id);
    const preview = await cashPreview(policies, owner, 'adopt-legacy-preview');
    const request = { previewId: preview.id, requestKey: 'adopt-legacy-confirm', adoptAccountId: account.id };
    const [first, retry] = await Promise.all([policies.start(owner, request), policies.start(owner, request)]);
    assert.equal(first.accountId, account.id);
    assert.equal(retry.policy.id, first.policy.id);
    assert.deepEqual(await ledger(db, account.id), before, 'takeover must not reseed positions, cash, snapshots or completed fills');
    assert.equal((await db.select().from(paperAccounts)).length, 1);
    assert.equal((await db.select().from(builderProfiles))[0].status, 'paused');
    assert.equal((await db.select().from(strategyMandates))[0].status, 'paused');
    assert.equal((await db.select().from(strategySignals).where(eq(strategySignals.id, old.signalId)))[0].state, 'cancelled');
    assert.equal((await db.select().from(strategyReservations))[0].status, 'released');
    assert.equal((await db.select().from(paperOrders).where(eq(paperOrders.id, old.pending.id)))[0].status, 'cancelled');
    assert.equal((await db.select().from(experiencePreferences))[0].migrationState, 'adopted');
    assert.equal((await db.select().from(investmentPolicies)).length, 1);
    assert.equal((await db.select().from(investmentCycles)).filter(cycle => cycle.state === 'queued').length, 1);
  });
});

test('adopted accounts reject legacy activation, reset, selection, publication and old MCP trading identities', async () => {
  await investmentFixture(async (db, _client, owner) => {
    const { account } = await legacyAccount(db, owner);
    const archived = await legacyAccount(db, owner, false, 'Older archived account');
    const old = await legacyAutomation(db, owner, account.id);
    const { policies, simulations, builder, paper, mandates } = services(db);
    const mcp = new McpService(db, paper, {} as never, {} as never);
    const oldSession = await mcp.createSession(owner, { name: 'Legacy trader', permission: 'trade', approvalMode: 'auto', dailyLimitUsd: 100000 });
    const preview = await cashPreview(policies, owner, 'guard-legacy-preview');
    await policies.start(owner, { previewId: preview.id, requestKey: 'guard-legacy-adopt', adoptAccountId: account.id });
    const book = await ledger(db, account.id);
    const accounts = await db.select().from(paperAccounts);
    for (const activateExecution of [false, true]) {
      await assert.rejects(mandates.publish(owner, old.mandate.id, 1, null, activateExecution), /INVESTMENT_MANAGED_ACCOUNT/);
    }
    await assert.rejects(builder.activateProfile(owner, old.profile.id), /INVESTMENT_MANAGED_ACCOUNT/);
    await assert.rejects(simulations.select(owner, archived.account.id), /INVESTMENT_MANAGED_ACCOUNT/);
    await assert.rejects(simulations.create(owner, { previewId: preview.id, name: 'Bypass attempt', idempotencyKey: 'legacy-create-bypass' }), /INVESTMENT_MANAGED_ACCOUNT/);
    await assert.rejects(paper.resetAccount(owner, 50000), /INVESTMENT_MANAGED_ACCOUNT/);
    await assert.rejects(paper.toggleBot(owner, true), /INVESTMENT_MANAGED_ACCOUNT/);
    assert.ok(oldSession.token);
    const oldIdentity = await mcp.authenticate(oldSession.token);
    await assert.rejects(mcp.callTool(oldIdentity, 'place_paper_order', { accountId: account.id, ticker: 'ABC', side: 'buy', quantity: 1 }), /INVESTMENT_AUTHORIZATION_CHANGED/);
    assert.deepEqual(await db.select().from(paperAccounts), accounts);
    assert.deepEqual(await ledger(db, account.id), book);
    assert.equal((await db.select().from(builderProfiles))[0].status, 'paused');
  });
});

test('archived history and original strategy links stay read-only and owner-scoped when source material is missing', async () => {
  await investmentFixture(async (db, client, owner) => {
    const stranger = randomUUID();
    await client`INSERT INTO users(id,username,password_hash) VALUES(${stranger},${'stranger-' + stranger.slice(0, 16)},'fixture-only')`;
    const current = await legacyAccount(db, owner);
    const archive = await legacyAccount(db, owner, false, 'Historical account');
    const { policies, simulations, mandates, documents } = services(db);
    const material = await documents.submit(owner, { idempotencyKey: 'original-migration-material', title: 'Original material',
      kind: 'daily', ticker: 'ABC', content: 'The original analysis used at trade time.',
      sections: [{ id: 'analysis', title: 'Original analysis', content: 'The original analysis used at trade time.' }],
      source: { type: 'daily', id: randomUUID() } });
    await documents.submit(owner, { idempotencyKey: 'newer-migration-material', reportId: material.reportId, title: 'Newer material',
      kind: 'daily', ticker: 'ABC', content: 'A later analysis must not replace the old decision evidence.',
      sections: [{ id: 'analysis', title: 'Later analysis', content: 'A later analysis must not replace the old decision evidence.' }] });
    const old = await legacyAutomation(db, owner, archive.account.id, archive.order.id, material.id);
    const archivedBefore = await ledger(db, archive.account.id);
    const accounts = await db.select().from(paperAccounts);
    const historical = await mandates.viewVersion(owner, old.mandate.id);
    assert.equal(historical.accountId, archive.account.id);
    assert.equal(historical.objective, 'Original decision at the time');
    assert.deepEqual(historical.references, old.mandate.config.references);
    const decision = await policies.decision(owner, archive.order.id);
    assert.deepEqual(decision.evidence, old.mandate.config.references);
    assert.deepEqual(decision.authorization, old.mandate.config);
    assert.equal(decision.order.id, archive.order.id);
    assert.deepEqual((await policies.history(owner)).map(item => item.id), [archive.account.id]);
    assert.equal((await simulations.get(owner, archive.account.id)).active, false);
    assert.deepEqual(await policies.history(stranger), []);
    await assert.rejects(mandates.viewVersion(stranger, old.mandate.id), /Strategy not found/);
    await assert.rejects(policies.decision(stranger, archive.order.id), /Decision not found/);
    await assert.rejects(simulations.review(stranger, archive.account.id), /Experiment not found/);
    const originalMaterial = await documents.getVersion(owner, old.mandate.config.references[0].versionId);
    assert.equal(originalMaterial.content, material.content, 'the immutable old version never resolves to the newer analysis');
    assert.equal(originalMaterial.sourceStatus, 'missing', 'deleted legacy sources remain readable with their gap exposed');
    await assert.rejects(documents.getVersion(stranger, material.id), /REPORT_NOT_FOUND/);
    const fence = await db.transaction(async tx => {
      await lockMemoryOwner(tx, owner);
      return investmentExecutionFence(tx, owner, archive.account.id, { ticker: 'ABC', market: 'US', side: 'sell' }, 'agent', old.candidate);
    });
    assert.equal(fence.block, 'INVESTMENT_ARCHIVED_ACCOUNT');
    assert.deepEqual(await db.select().from(paperAccounts), accounts, 'historical reads never select an old account');
    assert.equal((await policies.overview(owner)).account?.id, current.account.id);
    assert.deepEqual(await ledger(db, archive.account.id), archivedBefore);
  });
});

test('with multiple archived accounts and no active book, explicit selection adopts only that book and cancels its old candidates', async () => {
  await investmentFixture(async (db, client, owner) => {
    const first = await legacyAccount(db, owner, false, 'First archive');
    const chosen = await legacyAccount(db, owner, false, 'Chosen archive');
    const old = await legacyAutomation(db, owner, chosen.account.id);
    const stranger = randomUUID();
    await client`INSERT INTO users(id,username,password_hash) VALUES(${stranger},${'stranger-' + stranger.slice(0, 16)},'fixture-only')`;
    const foreign = await legacyAccount(db, stranger, false, 'Another owner archive');
    const { policies } = services(db);
    const before = await ledger(db, chosen.account.id);
    const otherBook = await ledger(db, first.account.id);
    const overview = await policies.overview(owner);
    assert.equal(overview.account, null);
    assert.deepEqual(new Set(overview.legacyAccounts.map(account => account.id)), new Set([first.account.id, chosen.account.id]));
    assert.equal((await db.select().from(paperAccounts).where(and(eq(paperAccounts.owner, owner), eq(paperAccounts.isActive, true)))).length, 0);
    const preview = await cashPreview(policies, owner, 'archive-selection-preview');
    await assert.rejects(policies.start(owner, { previewId: preview.id, requestKey: 'archive-foreign-selection', adoptAccountId: foreign.account.id }), /Adoption account not found/);
    const adopted = await policies.start(owner, { previewId: preview.id, requestKey: 'archive-selection-adopt', adoptAccountId: chosen.account.id });
    assert.equal(adopted.accountId, chosen.account.id);
    assert.deepEqual(await ledger(db, chosen.account.id), before);
    assert.deepEqual(await ledger(db, first.account.id), otherBook, 'archived assets are never merged');
    assert.equal((await db.select().from(paperAccounts).where(eq(paperAccounts.owner, owner))).length, 2);
    assert.deepEqual((await db.select().from(paperAccounts).where(and(eq(paperAccounts.owner, owner), eq(paperAccounts.isActive, true)))).map(account => account.id), [chosen.account.id]);
    assert.equal((await db.select().from(strategyMandates).where(eq(strategyMandates.id, old.mandate.id)))[0].status, 'paused');
    assert.equal((await db.select().from(strategySignals).where(eq(strategySignals.id, old.signalId)))[0].state, 'cancelled');
    assert.equal((await db.select().from(strategyReservations).where(eq(strategyReservations.signalId, old.signalId)))[0].status, 'released');
    assert.equal((await db.select().from(paperOrders).where(eq(paperOrders.id, old.pending.id)))[0].status, 'cancelled');
  });
});
