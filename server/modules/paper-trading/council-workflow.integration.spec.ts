import 'reflect-metadata';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import axios from 'axios';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { builderProposals, paperAccounts, paperOrders, paperPositions, paperTrades } from '../../database/schema';
import { councilMessages, councilReports, councilSessions } from '../../database/council.schema';
import { llmBudgetUsage } from '../../database/llm-budget.schema';
import { LlmBudgetService } from '../llm-budget/llm-budget.service';
import { LlmService } from '../multi-agent/llm.service';
import { CouncilService } from '../council/council.service';
import { AgentBuilderService } from './agent-builder.service';
import { BuilderCadenceService } from './builder-cadence.service';
import { PaperTradingService } from './paper-trading.service';
import { normalizeBuilderConfig, normalizeCouncil } from './agent-builder.rules';
import type { SettingsService } from '../settings/settings.service';

test('a full Builder scan uses four budgeted council calls, fills once, and reuses no approval on rescan', {
  skip: !process.env.COUNCIL_TEST_DATABASE_URL,
}, async (t) => {
  const connection = process.env.COUNCIL_TEST_DATABASE_URL!;
  const namespace = `council_workflow_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(connection, { max: 1, onnotice: () => {} });
  const client = postgres(connection, { max: 8, onnotice: () => {}, connection: { search_path: namespace } });
  const originalAdapter = axios.defaults.adapter;
  const owner = randomUUID();
  const instant = new Date('2026-10-30T14:00:00Z');
  const calls: Array<{ role: string; model: string; evidenceIds: string[] }> = [];
  let createdSchema = false;
  try {
    await admin`CREATE SCHEMA ${admin(namespace)}`;
    createdSchema = true;
    for (const file of ['01_schema.sql', '03_agent_builder.sql', '07_llm_budget.sql',
      '08_investment_council.sql', '09_builder_cadence.sql', '12_council_dialogue.sql', '13_budget_toggle.sql', '14_a2a_agents.sql', '18_research_workflow.sql', '19_atomic_research_theses.sql']) {
      await client.unsafe(readFileSync(`scripts/db/${file}`, 'utf8'));
    }
    // JS time fixes the US market-open window. Align report freshness in this
    // private fixture schema; budget timestamps keep the real database UTC clock.
    await client.unsafe("ALTER TABLE council_reports ALTER COLUMN created_at SET DEFAULT '2026-10-30T14:00:00Z'::timestamptz");
    await client`INSERT INTO users (id, username, password_hash) VALUES (${owner}, 'workflow-investor', 'test-only')`;
    t.mock.timers.enable({ apis: ['Date'], now: instant });
    const db = drizzle(client);
    const budget = new LlmBudgetService(db);
    const settings = {
      getSettings: async (userId: string) => {
        assert.equal(userId, owner);
        return { llm: { engine: 'llm' } };
      },
      getLlmConfig: async (userId: string) => {
        assert.equal(userId, owner);
        return { source: 'server', baseUrl: 'https://workflow-model.invalid/v1',
          fastModel: 'workflow-fast', slowModel: 'workflow-slow', apiKey: 'test-only-model-key' };
      },
    } as unknown as SettingsService;
    const llm = new LlmService(settings, budget);
    const builder = new AgentBuilderService(db, llm);
    const cadence = new BuilderCadenceService(db);
    const council = new CouncilService(db, llm, {
      collectEvidence: async (ticker: string, userId: string, _portfolio: unknown, language: string) => {
        assert.equal(ticker, 'AAPL'); assert.equal(userId, owner); assert.equal(language, 'en');
        return [{ role: 'technical', evidenceType: 'price', title: 'Test price quote',
          content: 'AAPL USD 100; retrieved at the current scan.', sourceName: 'Test quote source', relevanceScore: 1 }];
      },
    } as never, {
      getPortfolioContext: async (userId: string) => {
        assert.equal(userId, owner);
        return { totalValue: 10000, cash: 10000, holdings: [] };
      },
    } as never, {
      listRuns: async (userId: string) => { assert.equal(userId, owner); return { items: [] }; },
    } as never);
    const paper = new PaperTradingService(db, {
      getQuote: async (ticker: string) => {
        assert.equal(ticker, 'AAPL');
        return { symbol: ticker, price: '100', market: 'US', currency: 'USD',
          companyName: 'Apple test fixture', timestamp: Date.now(), delayed: true };
      },
    } as never, { convert: async (amount: number) => amount } as never, {
      notifyUser: async () => { throw new Error('This workflow must not send external notifications'); },
    } as never, builder, cadence, council);
    const config = normalizeBuilderConfig({ name: 'Workflow investor', language: 'en', template: 'balanced',
      tickers: ['AAPL'], priceRules: [{ ticker: 'AAPL', buyAtOrBelow: 100 }], minimumRating: 'Buy',
      customPrompt: '', maxOrderPct: 5, dailyLossLimitPct: 3, maxOrdersPerDay: 2, notifyOnProposal: false,
      council: { ...normalizeCouncil(), enabled: true } });
    const profile = await builder.createProfile(owner, config);
    const account = await paper.ensureAccount(owner);
    await db.update(paperAccounts).set({ initialCash: '10000', cashBalance: '10000' })
      .where(eq(paperAccounts.id, account.id));
    await paper.updateGuardrails(owner, config);
    await builder.activateProfile(owner, profile.id);
    await paper.toggleBot(owner, true);

    axios.defaults.adapter = async (request) => {
      assert.equal(request.url, 'https://workflow-model.invalid/v1/chat/completions');
      const body = JSON.parse(String(request.data)) as { model: string; max_tokens: number;
        messages: Array<{ role: string; content: string }> };
      assert.equal(body.max_tokens, 1000, 'the default account output budget caps the expanded council response allowance');
      const system = body.messages.filter(message => message.role === 'system').map(message => message.content).join('\n');
      assert.match(system, /Write for the reader in English/);
      const data = JSON.parse(body.messages.find(message => message.role === 'user')!.content) as {
        candidate: { ticker: string; side: string; price: number; quantity: number };
        ruleOnly: boolean; evidence: Array<{ id: string }>; conversation: unknown[]; member: { role: string }; phase: string;
      };
      const role = data.member.role;
      assert.ok(['researcher', 'challenger', 'manager'].includes(role));
      assert.equal(data.candidate.ticker, 'AAPL');
      assert.equal(data.candidate.side, 'buy');
      assert.equal(data.candidate.quantity, 5);
      assert.equal(data.candidate.price, 100);
      assert.equal(data.ruleOnly, true);
      assert.ok(data.evidence.length >= 2);
      assert.equal(data.conversation.length, calls.length);
      const evidenceIds = data.evidence.slice(0, 2).map(item => item.id);
      calls.push({ role, model: body.model, evidenceIds });
      return { status: 200, statusText: 'OK', headers: {}, config: request, data: {
        choices: [{ message: { content: JSON.stringify({ decision: 'approve',
          summary: `${role}: approve this bounded investor-authored price rule.`,
          dissent: ['Financial research remains incomplete; this is a price-rule simulation.'],
          nextReviewCondition: 'Review again only on a material change and within cadence limits.', evidenceIds }) } }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      } };
    };

    const scan = await paper.runBotScan(owner);
    assert.equal(scan.scanned, 1);
    assert.equal(scan.placed, 1, JSON.stringify({ scan, calls }));
    assert.equal(scan.rejected, 0);
    assert.equal(calls.length, 4);
    assert.deepEqual(new Set(calls.map(call => call.role)), new Set(['researcher', 'challenger', 'manager']));
    assert.equal(calls.find(call => call.role === 'manager')?.model, 'workflow-slow');

    const [session] = await db.select().from(councilSessions).where(eq(councilSessions.owner, owner));
    assert.equal(session.status, 'completed');
    assert.equal(session.language, 'en');
    const messages = await db.select().from(councilMessages).where(eq(councilMessages.owner, owner));
    assert.equal(messages.filter(message => message.metadata?.phase !== 'progress').length, 4);
    const activity = messages.filter(message => message.metadata?.researchEvent);
    assert.equal(activity.length, 12, 'each of four paid turns records queued, running and completed public activity');
    assert.ok(activity.every(message => message.tokensUsed === 0), 'activity is not an extra model call');
    assert.equal(messages.reduce((sum, message) => sum + message.tokensUsed, 0), 600);
    const [report] = await db.select().from(councilReports).where(eq(councilReports.owner, owner));
    const [order] = await db.select().from(paperOrders).where(eq(paperOrders.owner, owner));
    const [position] = await db.select().from(paperPositions).where(eq(paperPositions.owner, owner));
    const [trade] = await db.select().from(paperTrades).where(eq(paperTrades.owner, owner));
    const [proposal] = await db.select().from(builderProposals).where(eq(builderProposals.owner, owner));
    const [balance] = await db.select().from(paperAccounts).where(eq(paperAccounts.owner, owner));
    assert.equal(report.decision, 'approve'); assert.equal(report.engine, 'llm');
    assert.equal(report.tokensUsed, 600); assert.equal(report.paperOrderId, order.id);
    assert.equal(order.status, 'filled'); assert.equal(order.source, 'agent');
    assert.equal(Number(order.quantity), 5); assert.equal(Number(order.filledPrice), 100);
    assert.equal(Number(balance.cashBalance), 9500);
    assert.equal(Number(position.shares), 5); assert.equal(Number(position.avgCost), 100);
    assert.equal(trade.orderId, order.id); assert.equal(Number(trade.cashAfter), 9500);
    assert.equal(proposal.paperOrderId, order.id);
    const usageRows = await db.select().from(llmBudgetUsage).where(eq(llmBudgetUsage.owner, owner));
    assert.equal(usageRows.length, 4);
    assert.ok(usageRows.every(row => row.taskId === session.taskId && row.status === 'completed'));
    assert.equal(usageRows.reduce((sum, row) => sum + row.chargedTokens, 0), 600);
    const usage = await budget.getUsage(owner);
    assert.equal(usage.dayCalls, 4); assert.equal(usage.dayTokens, 600); assert.equal(usage.reservedTokens, 0);

    const repeated = await paper.runBotScan(owner);
    assert.equal(repeated.placed, 0);
    assert.equal(calls.length, 4, 'rescan must not repeat paid council work');
    assert.equal((await db.select().from(paperOrders).where(eq(paperOrders.owner, owner))).length, 1);
    assert.equal((await db.select().from(councilReports).where(eq(councilReports.owner, owner))).length, 1);
    assert.equal((await budget.getUsage(owner)).dayCalls, 4);
  } finally {
    axios.defaults.adapter = originalAdapter;
    t.mock.timers.reset();
    await client.end();
    if (createdSchema) await admin`DROP SCHEMA ${admin(namespace)} CASCADE`;
    await admin.end();
  }
});
