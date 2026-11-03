import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { CouncilService } from './council.service';
import { LlmBudgetService } from '../llm-budget/llm-budget.service';
import { estimateInputTokens } from '../llm-budget/llm-budget.rules';
import { ResearchToolsService } from '../research-tools/research-tools.service';
import { reviewDelivery, workflowReviewPrompt } from './council.workflow-review';
import type { ResearchDelivery, ResearchTask, ResearchTaskAttempt } from '../../../shared/research-workflow.interface';

const url = process.env.COUNCIL_TEST_DATABASE_URL;
const response = (english: boolean) => english ? {
  thesis: 'Reported growth supports a balanced view, but cash conversion and dilution still need verification before the valuation can support a stronger conclusion.',
  evidencePoints: [
    'Annual revenue was USD 100 million and net income was USD 10 million. These figures show reported profitability, but a single period does not establish that margins can persist through a demand slowdown.',
    'The filing covers a full year in one reporting currency. Comparison is therefore possible within this evidence set. It does not establish that peer accounting policies or revenue recognition are identical.',
    'The assumed multiple is a sensitivity input. The resulting equity value should be read alongside changes in margins, financing needs and share count, rather than treated as a forecast or a per-share price target.',
  ],
  risks: ['The evidence does not independently verify cash conversion or future customer retention. A profitable income statement can coexist with weaker cash generation and rising working capital.'],
  nextChecks: ['Check the next filing for operating cash flow, share count and reconciliation of reported to adjusted earnings. Revisit the conclusion if the observed financial trend changes.'],
} : {
  thesis: '已披露的收入和利润支持中性判断，但现金转化与股本稀释仍需核实。当前证据可以说明本期盈利，尚不足以证明盈利能力能够持续，也不能直接得出每股目标价。',
  evidencePoints: [
    '全年收入为一亿美元，净利润为一千万美元。两项数据来自同一完整年度，币种一致，可以用于计算该年度的净利率。单期利润改善不等于长期竞争优势，需要结合后续订单和客户留存继续观察。',
    '财报提供了可复核的期间和计量单位。比较同行时仍要核对收入确认政策、业务结构与调整项目，不能因为币种相同，就认为两个公司的利润具有完全相同的经济含义。',
    '估值倍数是情景假设，不是已发生的事实。总股权价值需要同时观察利润率、融资需求和股本变化；如果没有可靠的股数，不能将总价值换算成每股价格，也不能据此宣称上涨空间。',
  ],
  risks: ['当前资料不能独立证明现金转化质量和客户续约情况。账面盈利可能同时伴随营运资金占用上升，这会影响股东实际能够获得的现金。'],
  nextChecks: ['核对下一期经营现金流、稀释后股数和调整利润的勾稽关系。若现金流持续落后于利润，或股数明显增长，应重新审视当前判断。'],
};

test('ordinary Chinese and English workflows fit default request budgets with real reservations', { skip: !url }, async () => {
  const namespace = `workflow_budget_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(url!, { max: 1, onnotice: () => {} });
  const client = postgres(url!, { max: 8, onnotice: () => {}, connection: { search_path: namespace } });
  await admin`CREATE SCHEMA ${admin(namespace)}`;
  try {
    for (const name of ['01_schema.sql', '03_agent_builder.sql', '07_llm_budget.sql', '08_investment_council.sql',
      '12_council_dialogue.sql', '13_budget_toggle.sql', '14_a2a_agents.sql', '15_native_agents.sql', '18_research_workflow.sql', '19_atomic_research_theses.sql']) {
      await client.unsafe(readFileSync(`scripts/db/${name}`, 'utf8'));
    }
    const db = drizzle(client), budget = new LlmBudgetService(db);
    for (const language of ['zh-CN', 'en'] as const) {
      const owner = randomUUID(), sizes: Array<{ key: string; bytes: number }> = [];
      await client`INSERT INTO users(id, username, password_hash) VALUES (${owner}, ${language}, 'test-only')`;
      const model = async (messages: { role: string; content: string }[], userId: string, options: { taskId: string; purpose: string; maxOutputTokens: number }) => {
        const input = JSON.parse(messages[1].content);
        sizes.push({ key: `${input.task.key}:${input.submitted ? 'review' : 'work'}`, bytes: estimateInputTokens(messages) });
        const reservation = await budget.reserve(userId, { ...options, model: 'fixture', messages });
        const content = response(language === 'en');
        const data = input.submitted ? Array.isArray(input.submitted)
          ? { reviews: input.submitted.map((item: { taskId: string; submittedAttemptId: string }) => ({ ...item, delivery: undefined, requirement: undefined, accepted: true, feedback: 'Source period and scope checked.' })) }
          : { accepted: true, feedback: 'Source period and scope checked.' }
          : { conclusion: content.thesis, response: content, evidenceIds: input.evidence.slice(0, 1).map((e: { id: string }) => e.id),
            asOf: '2026-11-03', currency: 'USD', units: 'USD million', assumptions: [], gaps: [],
            skillVersions: input.skills.map(({ id, version, hash }: { id: string; version: string; hash: string }) => ({ id, version, hash })),
            ...(input.task.key === 'valuation' ? { valuationScenario: { metric: 'earnings', multiples: { bear: 10, base: 15, bull: 20 } } } : {}) };
        // Fixture accounting only; no provider/network requests. Reservation uses the production byte estimator and limits.
        await budget.settle(userId, reservation.id, { prompt_tokens: 500, completion_tokens: 800 });
        return { data, tokens: 1300 };
      };
      const tools = new ResearchToolsService(db, { getQuote: async (ticker: string) => ({ symbol: ticker,
        price: '100', currency: 'USD', market: 'US', timestamp: Date.now() }) } as never,
      { collectResearch: async () => [{ role: 'fundamental', evidenceType: 'financial', title: 'Annual financials',
        content: 'Period: 2025-01-01 to 2025-12-31. Net income: USD 100; Revenue: USD 1000;',
        sourceName: 'SEC EDGAR', sourceUrl: 'https://www.sec.gov/Archives/fixture', relevanceScore: 1 }] } as never, {} as never);
      const service = new CouncilService(db, { validateConnectionIds: async () => undefined, isConfigured: async () => true,
        chatFastJSON: model, chatSlowJSON: model } as never,
      { collectEvidence: async () => [{ role: 'fundamental', evidenceType: 'other', title: 'Annual filing',
        content: 'Annual revenue 100 USD million; net income 10 USD million. Full year ended 2025-12-31.',
        sourceName: 'Filing', sourceUrl: 'https://example.test/filing', relevanceScore: 1 }] } as never,
      { getPortfolioContext: async () => ({ totalValue: 1000, holdings: [], cash: 1000 }) } as never,
      { listRuns: async () => ({ items: [] }) } as never, undefined, budget, undefined, tools);
      const session = await service.createSession(owner, { ticker: 'AAPL', language, goal: 'comprehensive', recallEnabled: false });
      await service.runSession(owner, session.id);
      let result = await service.getSession(owner, session.id);
      for (let i = 0; i < 500 && result.status === 'running'; i++) {
        await new Promise(resolve => setTimeout(resolve, 10)); result = await service.getSession(owner, session.id);
      }
      assert.equal(result.status, 'completed', JSON.stringify({ error: result.error, sizes }));
      assert.equal(result.reports.at(-1)?.coverage?.complete, true, JSON.stringify(sizes));
      assert.equal(result.reports.at(-1)?.thesisCandidates, null, 'older model output remains unstructured without breaking the workflow');
      assert.equal(sizes.length, 8);
      assert.ok(sizes.every(size => size.bytes <= 6000), JSON.stringify(sizes));
      assert.equal((await budget.getUsage(owner)).dayCalls, 8);
      const delivery = result.workflow!.tasks[0].delivery!;
      const oversized = { ...result.workflow!.tasks[0], delivery: { ...delivery,
        conclusion: 'A distinct conclusion', response: { ...delivery.response, details: 'Do not hide this material evidence. '.repeat(400) } } };
      const packed = workflowReviewPrompt(oversized, { id: randomUUID(), revision: 1 } as ResearchTaskAttempt, [],
        { financials: 'Check the filing' } as Record<ResearchTask['key'], string>, 'AAPL', language, ['Keep user steering intact'], [], 'Reject drafts without cash-flow reconciliation.');
      assert.equal(packed.input.moderatorInstructions, 'Reject drafts without cash-flow reconciliation.');
      assert.deepEqual(packed.input.submitted, oversized.delivery, 'oversized submissions cannot be silently truncated to gain acceptance');
      await assert.rejects(budget.reserve(owner, { model: 'fixture', taskId: randomUUID(),
        messages: [{ role: 'system', content: packed.system }, { role: 'user', content: JSON.stringify(packed.input) }] }),
      (error: unknown) => (error as { reason: string }).reason === 'input_tokens');
      assert.equal((await budget.getUsage(owner)).dayCalls, 8, 'an oversized review is stopped before a billable reservation');
    }
  } finally { await client.end(); await admin`DROP SCHEMA ${admin(namespace)} CASCADE`; await admin.end(); }
});

test('review packing removes only identical conclusions and preserves every other delivery field', () => {
  const delivery: ResearchDelivery = { conclusion: 'Same thesis', response: { thesis: 'Same thesis',
    evidencePoints: ['Exact numeric claim: 123.45'], risks: ['Contradiction'], nextChecks: ['Verify period'], details: 'Full details' },
  asOf: '2026-11-03', currency: 'USD', units: 'millions', assumptions: ['Assumed 12x'], gaps: ['Missing cash flow'],
  evidenceIds: ['source'], skillVersions: [{ id: 'skill', version: '1.0.0', hash: 'pin' }] };
  const packed = reviewDelivery(delivery)!;
  assert.equal('conclusionIsThesis' in packed && packed.conclusionIsThesis, true);
  const restored = { ...packed, conclusion: packed.response.thesis } as ResearchDelivery & { conclusionIsThesis?: boolean };
  delete restored.conclusionIsThesis;
  assert.deepEqual(restored, delivery);
  assert.deepEqual(reviewDelivery({ ...delivery, conclusion: 'Distinct assertion' }), { ...delivery, conclusion: 'Distinct assertion' });
});
